// Builds a sourced industry map for a validation-stage founder from Cala's knowledge graph.
// Input is an idea ("carbon accounting for Nordic SMEs"), optionally with the founder's company name.
import * as cala from "./cala";
import type { Acquirer, Evidence, Investor, MarketMap, Momentum, MoatSignal, Peer, Round, Source } from "./types";
import { field, median, norm, parseIntLoose, parseMoneyEur, pool } from "./util";
import { demoMap } from "./demo";
import { writeSummary } from "./summary";
import { findGaps } from "./standout";

const MAX_PEERS = 15;
const PARENT_IN = ["IS_DIRECT_PARENT_OF", "IS_ULTIMATE_PARENT_OF"];
const PARENT_OUT = ["IS_SUBSIDIARY_OF"];
const EVENTS_OUT = ["PARTICIPATES_IN_CORPORATE_EVENT"];
const YEARS = 5;
const EARLY = /pre[- ]?seed|seed|angel|grant/i;

export type MapInput = { idea?: string; company?: string };
type Soft = <T>(label: string, p: Promise<T>, fallback: T) => Promise<T>;
const EMPTY_SEARCH: cala.SearchResult = { content: "", context: [], entities: [] };
const EMPTY_QUERY: cala.QueryResult = { results: [], entities: [] };

export async function buildMarketMap(input: MapInput): Promise<MarketMap> {
  const idea = input.idea?.trim() || undefined;
  const company = input.company?.trim() || undefined;
  if (!idea && !company) throw new Error("Describe your idea or name your company.");
  if (!cala.hasCalaKey()) return demoMap(input);

  const warnings: string[] = [];
  const soft: Soft = async (label, p, fallback) => {
    try {
      return await p;
    } catch (e) {
      warnings.push(`${label}: ${(e as Error).message.slice(0, 160)}`);
      return fallback;
    }
  };

  // 1. The founder's company, if they gave one and Cala knows it.
  let target: cala.Entity | undefined;
  if (company) {
    const hit = (await soft("Find your company", cala.searchEntities(company, ["Company"], 3), []))[0];
    if (hit) {
      target = await soft(
        "Retrieve your company",
        cala.retrieve(hit.id, {
          properties: ["name", "founding_date", "employee_count"],
          outgoing: ["OPERATES_IN_INDUSTRY", "HAS_HEADQUARTERS_IN"],
        }),
        undefined,
      );
    } else warnings.push(`Cala doesn't know "${company}" yet, so the map is built from your idea only.`);
  }

  // 2. Seed companies: similar to the idea, and direct competitors of the founder's company.
  const peers = new Map<string, Peer>();
  const targetKey = target ? norm(target.name) : "";
  const addPeer = (p: Peer) => {
    const k = norm(p.name);
    if (!k || k === targetKey) return;
    const e = peers.get(k);
    if (!e) return void peers.set(k, p);
    e.via = [...new Set([...e.via, ...p.via])];
    e.id ??= p.id;
    e.fundingEur ??= p.fundingEur;
    e.fundingLabel ??= p.fundingLabel;
    e.employees ??= p.employees;
    e.foundedYear ??= p.foundedYear;
    e.lastRound ??= p.lastRound;
    e.sources.push(...p.sources);
  };

  const [similar, competitors] = await Promise.all([
    idea ? soft("Similar companies", cala.search(`Which startups and companies are building ${idea}?`), EMPTY_SEARCH) : EMPTY_SEARCH,
    target ? soft("Competitor search", cala.search(`Who are the main direct competitors of ${target.name}?`), EMPTY_SEARCH) : EMPTY_SEARCH,
  ]);
  for (const [res, via] of [[similar, "similar-search"], [competitors, "competitor-search"]] as const) {
    const srcs = cala.knowBitSources(res.context);
    for (const e of res.entities) if (e.entity_type === "Company") addPeer({ id: e.id, name: e.name, via: [via], sources: srcs });
  }

  // 3. Industry: the founder's company's, else the most common one among the closest matches.
  let industry = target?.relationships.outgoing.OPERATES_IN_INDUSTRY?.[0]?.name;
  if (!industry) {
    const firsts = [...peers.values()].filter((p) => p.id).slice(0, 4);
    const inds = await pool(firsts, 4, (p) =>
      soft(`Industry of ${p.name}`, cala.retrieve(p.id!, { outgoing: ["OPERATES_IN_INDUSTRY"], limit: 3 }), undefined),
    );
    const counts = new Map<string, number>();
    for (const e of inds) for (const r of e?.relationships.outgoing.OPERATES_IN_INDUSTRY ?? []) counts.set(r.name, (counts.get(r.name) ?? 0) + 1);
    industry = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  }
  if (!industry) warnings.push("Cala lists no industry for these companies, so the peer set comes from search only.");

  // 4. Industry peers (structured query) on top of the search results.
  if (industry) {
    const rows = await soft(
      "Industry peers",
      cala.query(
        `companies.industry=${industry}.founded_year>=${new Date().getFullYear() - 12} return(name, total_funding, last_funding_round, employee_count, founded_year) order_by=total_funding DESC limit=25`,
      ),
      EMPTY_QUERY,
    );
    const ids = new Map(rows.entities.map((e) => [norm(e.name), e.id]));
    for (const row of rows.results) {
      const name = String(field(row, "name", "company", "company_name") ?? "");
      if (!name) continue;
      const funding = field(row, "total_funding", "funding", "funding_amount", "total_raised");
      addPeer({
        id: ids.get(norm(name)),
        name,
        foundedYear: parseIntLoose(field(row, "founded_year", "founding_year", "year")),
        employees: parseIntLoose(field(row, "employee_count", "employees")),
        fundingEur: parseMoneyEur(funding),
        fundingLabel: funding ? String(funding) : undefined,
        lastRound: (field(row, "last_funding_round", "round_type", "last_round") as string) ?? undefined,
        via: ["industry"],
        sources: [cala.calaSource(`companies in ${industry}`)],
      });
    }
  }

  // Closest matches first (found by search), then by funding.
  const peerList = [...peers.values()]
    .sort((a, b) => Number(b.via.includes("industry") === false) - Number(a.via.includes("industry") === false) || b.via.length - a.via.length || (b.fundingEur ?? 0) - (a.fundingEur ?? 0))
    .slice(0, MAX_PEERS);
  if (!peerList.length) throw new Error("Cala found no companies close to this idea. Try describing it with the customer and the product, e.g. \"payroll software for restaurants\".");

  // 5. Enrich: entity data, HQ, ownership and corporate events, plus dated funding rounds.
  const enriched = await pool(peerList, 5, async (p) => {
    if (!p.id) p.id = (await soft(`Resolve ${p.name}`, cala.searchEntities(p.name, ["Company"], 1), []))[0]?.id;
    if (!p.id) return { peer: p, entity: undefined };
    const [entity, rounds] = await Promise.all([
      soft(
        `Retrieve ${p.name}`,
        cala.retrieve(p.id, {
          properties: ["employee_count", "founding_date"],
          outgoing: ["HAS_HEADQUARTERS_IN", ...EVENTS_OUT, ...PARENT_OUT],
          incoming: PARENT_IN,
          limit: 10,
        }),
        undefined,
      ),
      fundingRounds(p.name, soft),
    ]);
    if (entity) {
      const emp = entity.properties.employee_count;
      if (p.employees === undefined && emp) {
        p.employees = parseIntLoose(emp.value);
        p.sources.push(...cala.toSources(emp.sources));
      }
      const fd = entity.properties.founding_date?.value;
      if (p.foundedYear === undefined && fd) p.foundedYear = parseIntLoose(String(fd).slice(0, 4));
      p.country = entity.relationships.outgoing.HAS_HEADQUARTERS_IN?.[0]?.name;
      p.description ??= entity.description;
    }
    p.rounds = rounds;
    if (rounds.length) {
      const sum = rounds.reduce((s, r) => s + (r.amountEur ?? 0), 0);
      if (p.fundingEur === undefined && sum) {
        p.fundingEur = sum;
        p.fundingLabel = `${rounds.length} round(s)`;
      }
      p.lastRound ??= [...rounds].sort((a, b) => (a.year ?? 0) - (b.year ?? 0)).at(-1)?.type;
    }
    return { peer: p, entity };
  });

  // The founder's own company as a row, so they see themselves in the table.
  const all: Peer[] = [...peerList];
  if (target) {
    const rounds = await fundingRounds(target.name, soft);
    const sum = rounds.reduce((s, r) => s + (r.amountEur ?? 0), 0);
    all.unshift({
      id: target.id,
      name: target.name,
      isTarget: true,
      description: target.description,
      employees: parseIntLoose(target.properties.employee_count?.value),
      foundedYear: parseIntLoose(String(target.properties.founding_date?.value ?? "").slice(0, 4)),
      fundingEur: sum || undefined,
      fundingLabel: rounds.length ? `${rounds.length} round(s)` : undefined,
      lastRound: rounds.at(-1)?.type,
      rounds,
      via: [],
      sources: [...cala.toSources(target.properties.employee_count?.sources), cala.calaSource(`${target.name} funding rounds`)],
    });
  }

  // 6. Capital share and momentum.
  const totalEur = all.reduce((s, p) => s + (p.fundingEur ?? 0), 0);
  for (const p of all) p.share = totalEur && p.fundingEur ? p.fundingEur / totalEur : undefined;
  const top3Share = all.map((p) => p.share ?? 0).sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0);
  const momentum = buildMomentum(peerList, top3Share);
  if (!momentum.years.some((y) => y.rounds)) warnings.push("Cala returned no dated funding rounds for these peers, so the funding trend is empty.");

  // 7. Early investors, gaps, founder position, acquirers.
  const investors = buildInvestors(peerList);
  const [gaps, position, acquirers] = await Promise.all([
    findGaps({ idea, industry, peers: peerList, soft }),
    all[0]?.isTarget ? buildPosition(all[0], peerList) : Promise.resolve([] as MoatSignal[]),
    buildAcquirers(enriched, target?.name, industry, soft),
  ]);

  const map: MarketMap = {
    input: { idea, company },
    mode: "live",
    target: target ? { id: target.id, name: target.name, description: target.description } : undefined,
    industry,
    peers: all,
    capital: { totalEur, peersWithFunding: all.filter((p) => p.fundingEur).length, top3Share },
    momentum,
    investors: { available: peerList.some((p) => p.rounds?.some((r) => r.investors.length)), list: investors },
    standout: { gaps: gaps.gaps, position, generatedBy: gaps.by },
    acquirers,
    summary: "",
    warnings,
    generatedAt: new Date().toISOString(),
  };
  map.summary = await writeSummary(map);
  return map;
}

// ---------- Funding rounds ----------

function asList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x : String((x as { name?: string })?.name ?? ""))).filter(Boolean);
  if (typeof v === "string") return v.split(/,|;| and /).map((s) => s.trim()).filter(Boolean);
  return [];
}

async function fundingRounds(name: string, soft: Soft): Promise<Round[]> {
  const r = await soft(`Funding rounds for ${name}`, cala.query(`${name}.funding_rounds return(round_type, amount, date, investors)`), EMPTY_QUERY);
  const src = [cala.calaSource(`${name} funding rounds`)];
  return r.results.map((x) => {
    const date = field(x, "date", "announced_date", "announced_on", "year");
    return {
      type: (field(x, "round_type", "type", "funding_type", "stage") as string) ?? undefined,
      amountEur: parseMoneyEur(field(x, "amount", "funding_amount", "money_raised", "amount_raised")),
      year: parseIntLoose(String(date ?? "").match(/\d{4}/)?.[0]),
      investors: asList(field(x, "investors", "lead_investors", "lead_investor", "participants")),
      sources: src,
    };
  });
}

export function buildMomentum(peers: Peer[], top3Share: number): Momentum {
  const now = new Date().getFullYear();
  const years = Array.from({ length: YEARS }, (_, i) => ({ year: now - YEARS + 1 + i, rounds: 0, capitalEur: 0, early: 0, later: 0 }));
  for (const p of peers)
    for (const r of p.rounds ?? []) {
      const b = years.find((y) => y.year === r.year);
      if (!b) continue;
      b.rounds++;
      b.capitalEur += r.amountEur ?? 0;
      if (r.type && EARLY.test(r.type)) b.early++;
      else b.later++;
    }
  const total = years.reduce((s, y) => s + y.rounds, 0);
  // Compare the last two full years with the two before them (the current year is partial).
  const recent = years[YEARS - 2].rounds + years[YEARS - 3].rounds;
  const before = years[YEARS - 4].rounds + years[YEARS - 5].rounds;
  const trend: Momentum["trend"] = total < 3 ? "unknown" : recent > before * 1.25 ? "rising" : recent < before * 0.8 ? "falling" : "flat";
  const fundedPeers = peers.filter((p) => p.fundingEur).length;
  const crowding: Momentum["crowding"] =
    fundedPeers < 5 ? "unknown" : top3Share > 0.75 ? "crowded" : fundedPeers >= 8 ? "contested" : "open";
  return {
    years,
    trend,
    earlyShare: total ? years.reduce((s, y) => s + y.early, 0) / total : undefined,
    top3Share,
    crowding,
    sources: [cala.calaSource("funding rounds of peers")],
  };
}

function buildInvestors(peers: Peer[]): Investor[] {
  const m = new Map<string, Investor>();
  for (const p of peers)
    for (const r of p.rounds ?? []) {
      if (r.type && !EARLY.test(r.type)) continue; // early-stage rounds only (or unknown type)
      for (const name of r.investors) {
        const k = norm(name);
        if (!k) continue;
        const inv = m.get(k) ?? { name, rounds: 0, peers: [], sources: [] };
        inv.rounds++;
        if (!inv.peers.includes(p.name)) inv.peers.push(p.name);
        inv.sources.push(...r.sources);
        m.set(k, inv);
      }
    }
  return [...m.values()].sort((a, b) => b.peers.length - a.peers.length || b.rounds - a.rounds).slice(0, 10);
}

// ---------- Founder position (only when they gave a company) ----------

function compare(t: number | undefined, m: number | undefined): MoatSignal["verdict"] {
  if (t === undefined || m === undefined || m === 0) return "unknown";
  const r = t / m;
  return r >= 1.5 ? "stronger" : r <= 0.67 ? "weaker" : "similar";
}

async function buildPosition(t: Peer, peers: Peer[]): Promise<MoatSignal[]> {
  const fundMed = median(peers.map((p) => p.fundingEur ?? NaN));
  const empMed = median(peers.map((p) => p.employees ?? NaN));
  return [
    { key: "capital", label: "Capital raised", target: t.fundingEur, peerMedian: fundMed, verdict: compare(t.fundingEur, fundMed), sources: t.sources },
    { key: "team-size", label: "Headcount", target: t.employees, peerMedian: empMed, verdict: compare(t.employees, empMed), sources: t.sources },
  ];
}

// ---------- Acquirers ----------

async function buildAcquirers(
  enriched: { peer: Peer; entity?: cala.Entity }[],
  targetName: string | undefined,
  industry: string | undefined,
  soft: Soft,
): Promise<Acquirer[]> {
  const acq = new Map<string, Acquirer>();
  const peerNames = new Set(enriched.map((e) => norm(e.peer.name)).concat(targetName ? [norm(targetName)] : []));
  const add = (name: string, id: string | undefined, weight: number, ev: Evidence) => {
    const k = norm(name);
    if (!k || peerNames.has(k)) return;
    const a = acq.get(k) ?? { id, name, score: 0, evidence: [] };
    a.score += weight;
    a.evidence.push(ev);
    acq.set(k, a);
  };

  // a) Who already owns one of the peers.
  for (const { peer, entity } of enriched) {
    if (!entity) continue;
    const parents = [
      ...PARENT_IN.flatMap((r) => entity.relationships.incoming[r] ?? []),
      ...PARENT_OUT.flatMap((r) => entity.relationships.outgoing[r] ?? []),
    ];
    for (const p of parents)
      add(p.name, p.id, 3, {
        kind: "owns_peer",
        text: `Owns ${peer.name}${p.properties?.valid_since ? ` (since ${p.properties.valid_since.slice(0, 7)})` : ""}`,
        sources: cala.toSources(p.properties?.sources),
      });
  }

  // b) Counterparties in the peers' corporate events (acquisitions, mergers, stakes).
  const events = enriched.flatMap(({ peer, entity }) =>
    (entity?.relationships.outgoing.PARTICIPATES_IN_CORPORATE_EVENT ?? []).slice(0, 5).map((ev) => ({ peer, ev })),
  );
  await pool(events.slice(0, 30), 5, async ({ peer, ev }) => {
    const e = await soft(`Event ${ev.name}`, cala.retrieve(ev.id, { incoming: EVENTS_OUT, limit: 10 }), undefined);
    if (!e) return;
    const isDeal = /acqui|merg|takeover|buyout|purchase|stake/i.test(`${ev.name} ${e.description ?? ""}`);
    for (const party of e.relationships.incoming.PARTICIPATES_IN_CORPORATE_EVENT ?? []) {
      if (party.entity_type !== "Company") continue;
      add(party.name, party.id, isDeal ? 2 : 0.5, {
        kind: "deal_with_peer",
        text: `${isDeal ? "Deal" : "Corporate event"} with ${peer.name}: ${ev.name}`,
        sources: cala.toSources(party.properties?.sources ?? ev.properties?.sources),
      });
    }
  });

  // c) Sector-level acquisitions Cala can cite.
  if (industry) {
    const s = await soft("Sector acquisitions", cala.search(`Which companies acquired startups in ${industry} in the last 5 years?`), EMPTY_SEARCH);
    const srcs = cala.knowBitSources(s.context, 4);
    for (const e of s.entities) if (e.entity_type === "Company") add(e.name, e.id, 1, { kind: "sector_deal", text: `Cited as an acquirer in ${industry}`, sources: srcs });
  }

  return [...acq.values()].filter((a) => a.score >= 1).sort((a, b) => b.score - a.score).slice(0, 8);
}

export type { Source };
