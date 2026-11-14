// Builds a sourced industry map for a validation-stage founder from Cala's knowledge graph.
// Input is an idea ("carbon accounting for Nordic SMEs"), optionally with the founder's company name.
import * as cala from "./cala";
import type { Acquirer, Evidence, Investor, MarketMap, Momentum, MoatSignal, Peer, Round, Source } from "./types";
import { field, median, norm, parseIntLoose, parseMoneyEur, pool } from "./util";
import { demoMap } from "./demo";
import { fixtureFor } from "./fixtures";
import { writeSummary } from "./summary";
import { findGaps } from "./standout";

const MAX_PEERS = 8; // each peer costs ~3 Cala calls, and Cala allows roughly one call per 1.5 s
const PARENT_IN = ["IS_DIRECT_PARENT_OF", "IS_ULTIMATE_PARENT_OF"];
const PARENT_OUT = ["IS_SUBSIDIARY_OF"];
const EVENTS_OUT = ["PARTICIPATES_IN_CORPORATE_EVENT"];
const INVESTORS_IN = ["INVESTED_IN"];
const MAX_DEAL_LOOKUPS = 6;
const YEARS = 5;
const EARLY = /pre[- ]?seed|seed|angel|grant/i;
// Cala names corporate events by type: MNA_COMPLETED, MNA_ANNOUNCED, FINANCING_RAISED_OR_FACILITY_ENTERED, ...
const DEAL = /\bmna\b|mna_|acqui|merg|takeover|buyout|purchase|stake/i;
// Search answers name banks, funds and investors next to the startups; keep those out of the peer set.
const NOT_A_PEER = /\b(ventures?|capital|partners|bank|banking|fund|funds|investments?|investors?|asset management|holdings|private equity|growth equity|vc)\b|\b(hsbc|nasdaq|blackrock|goldman sachs|fidelity|jpmorgan|y combinator)\b/i;
const PEER_TYPES = new Set(["Company", "Organization"]);

export type MapInput = { idea?: string; company?: string };
type Soft = <T>(label: string, p: Promise<T>, fallback: T) => Promise<T>;
const EMPTY_SEARCH: cala.SearchResult = { content: "", context: [], entities: [] };
const EMPTY_QUERY: cala.QueryResult = { results: [], entities: [] };

/** Startup names from a search answer: the bold lead of each bullet ("- **Greenly** (Paris) — ..."). */
function boldNames(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(/^\s*(?:[-*]|\d+\.)\s+\*\*([^*]{2,60})\*\*/gm)) {
    const name = m[1].replace(/\s*\(.*\)\s*$/, "").replace(/[:,.]$/, "").trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Map a name to an entity from the same response, via its name or its mentions. */
function idIn(entities: cala.EntityRef[], name: string): string | undefined {
  const k = norm(name);
  return entities.find((e) => PEER_TYPES.has(e.entity_type) && (norm(e.name) === k || (e.mentions ?? []).some((m) => norm(m) === k)))?.id;
}

const humanIndustry = (code?: string) => (code && /^[A-Z0-9_]+$/.test(code) ? code.toLowerCase().replace(/_/g, " ") : code);

const DEEP = process.env.CALA_DEEP === "1"; // opt-in: sector-acquirer search (+1 slow knowledge call)
const MAX_ROUNDS_PER_PEER = 6;

type Found = {
  idea?: string;
  target?: cala.Entity;
  topic?: string;
  industry?: string;
  peerList: Peer[];
};

function makeSoft(warnings: string[]): Soft {
  return async (label, p, fallback) => {
    try {
      return await p;
    } catch (e) {
      const msg = (e as Error).message;
      warnings.push(
        /-> 429/.test(msg) ? `${label}: Cala rate limit, skipped` : /abort|timeout/i.test(msg) ? `${label}: Cala timed out, skipped` : `${label}: ${msg.slice(0, 160)}`,
      );
      return fallback;
    }
  };
}

/** Stage 1 (fast-ish): who is already doing this. Two slow Cala calls at most, both disk-cached. */
/** Stage 1. `full` also runs the topic query when search already found enough peers, but only to fill in their funding. */
export async function findPeers(input: MapInput, soft: Soft, warnings: string[], full = false): Promise<Found> {
  const idea = input.idea?.trim() || undefined;
  const company = input.company?.trim() || undefined;

  // The founder's company, if they gave one and Cala knows it.
  let target: cala.Entity | undefined;
  if (company) {
    const hit = (await soft("Find your company", cala.searchEntities(company, ["Company", "Organization"], 3), []))[0];
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
  const targetIndustry = target?.relationships.outgoing.OPERATES_IN_INDUSTRY?.[0]?.name;
  // Cala's industry codes (SOFTWARE_AND_SERVICES) are too coarse to find peers, so the
  // structured query takes the idea as free text: "companies.industry=carbon accounting for SMEs".
  const topic = idea ?? target?.description?.split(/[.;]/)[0]?.slice(0, 120) ?? humanIndustry(targetIndustry);
  const industry = idea ?? humanIndustry(targetIndustry);

  const peers = new Map<string, Peer>();
  const targetKey = target ? norm(target.name) : "";
  const addPeer = (p: Peer) => {
    const k = norm(p.name);
    if (!k || k === targetKey || NOT_A_PEER.test(p.name)) return;
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

  // a) Startups named in a sourced search answer (the bold lead of each bullet).
  const [similar, competitors] = await Promise.all([
    idea ? soft("Similar companies", cala.search(`Which startups and companies are building ${idea}?`), EMPTY_SEARCH) : EMPTY_SEARCH,
    target ? soft("Competitor search", cala.search(`Who are the main direct competitors of ${target.name}?`), EMPTY_SEARCH) : EMPTY_SEARCH,
  ]);
  for (const [res, via] of [[similar, "similar-search"], [competitors, "competitor-search"]] as const) {
    const srcs = cala.knowBitSources(res.context);
    const named = boldNames(res.content);
    if (named.length) for (const name of named) addPeer({ id: idIn(res.entities, name), name, via: [via], sources: srcs });
    else for (const e of res.entities) if (PEER_TYPES.has(e.entity_type)) addPeer({ id: e.id, name: e.name, via: [via], sources: srcs });
  }

  // b) Structured query on the topic: adds peers and their funding totals and stages. When search already
  //    found enough peers, the preview skips it (one slow call less) and the full map uses it for funding only.
  const enough = peers.size >= MAX_PEERS;
  if (topic && (!enough || full)) {
    const rows = await soft(
      "Industry peers",
      cala.query(
        `companies.industry=${topic}.founded_year>=${new Date().getFullYear() - 12} return(name, total_funding, last_funding_round, employee_count, founded_year) order_by=total_funding DESC limit=15`,
      ),
      EMPTY_QUERY,
    );
    for (const row of rows.results) {
      const name = String(field(row, "name", "company", "company_name") ?? "");
      if (!name) continue;
      if (enough && !peers.has(norm(name))) continue;
      const funding = field(row, "total_funding", "funding", "funding_amount", "total_raised");
      addPeer({
        id: idIn(rows.entities, name),
        name,
        foundedYear: parseIntLoose(field(row, "founded_year", "founding_year", "year")),
        employees: parseIntLoose(field(row, "employee_count", "employees")),
        fundingEur: parseMoneyEur(funding),
        fundingLabel: funding ? String(funding) : undefined,
        lastRound: lastRoundType(field(row, "last_funding_round", "round_type", "last_round")),
        via: ["industry"],
        sources: [cala.calaSource(`companies in ${topic}`)],
      });
    }
  }

  // Found by both search and query first, then search-only (closest to the idea), then by funding.
  const peerList = [...peers.values()]
    .sort((a, b) => b.via.length - a.via.length || Number(a.via.includes("industry")) - Number(b.via.includes("industry")) || (b.fundingEur ?? 0) - (a.fundingEur ?? 0))
    .slice(0, MAX_PEERS);
  if (!peerList.length) throw new Error("Cala found no companies close to this idea. Try describing it with the customer and the product, e.g. \"payroll software for restaurants\".");
  return { idea, target, topic, industry, peerList };
}

export type PeersPreview = { stage: "peers"; input: MapInput; industry?: string; peers: Peer[]; warnings: string[] };

export async function buildPeersPreview(input: MapInput): Promise<PeersPreview | MarketMap> {
  if (!input.idea?.trim() && !input.company?.trim()) throw new Error("Describe your idea or name your company.");
  const fx = fixtureFor(input.idea, input.company);
  if (fx) return fx;
  if (!cala.hasCalaKey()) return demoMap(input);
  const warnings: string[] = [];
  const f = await findPeers(input, makeSoft(warnings), warnings);
  return { stage: "peers", input, industry: f.industry, peers: f.peerList, warnings: [...new Set(warnings)] };
}

export async function buildMarketMap(input: MapInput): Promise<MarketMap> {
  const company = input.company?.trim() || undefined;
  if (!input.idea?.trim() && !company) throw new Error("Describe your idea or name your company.");
  const fx = fixtureFor(input.idea, company);
  if (fx) return fx;
  if (!cala.hasCalaKey()) return demoMap(input);
  const resultKey = `map v3 ${norm(input.idea ?? "")} ${norm(company ?? "")}`;
  const cached = await cala.readCachedResult<MarketMap>(resultKey);
  if (cached) return cached;

  const warnings: string[] = [];
  const soft = makeSoft(warnings);
  const { idea, target, topic, industry, peerList } = await findPeers(input, soft, warnings, true);

  // Enrich, one retrieve per peer (fast entity reads): HQ, investors, ownership, corporate events and funding rounds.
  const enriched = await pool(peerList, 4, async (p) => {
    if (!p.id) p.id = bestMatch(await soft(`Resolve ${p.name}`, cala.searchEntities(p.name, ["Company", "Organization"], 3), []), p.name)?.id;
    const entity = p.id
      ? await soft(
          `Retrieve ${p.name}`,
          cala.retrieve(p.id, {
            properties: ["employee_count", "founding_date"],
            outgoing: ["HAS_HEADQUARTERS_IN", ...EVENTS_OUT, ...PARENT_OUT, ...ROUNDS_OUT],
            incoming: [...PARENT_IN, ...INVESTORS_IN],
            limit: 15,
          }),
          undefined,
        )
      : undefined;
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
      p.rounds = await graphRounds(entity, soft);
    }
    return { peer: p, entity };
  });

  // Peers the graph has no rounds for: one batched knowledge query (slow, so only when needed).
  const missing = enriched.filter(({ peer }) => !peer.rounds?.length).map(({ peer }) => peer);
  if (missing.length) {
    const byName = await batchedRounds(missing.map((p) => p.name), soft);
    for (const p of missing) p.rounds = byName.get(norm(p.name)) ?? [];
  }
  for (const { peer: p } of enriched) {
    const rounds = p.rounds ?? [];
    if (!rounds.length) continue;
    const sum = rounds.reduce((s, r) => s + (r.amountEur ?? 0), 0);
    if (p.fundingEur === undefined && sum) {
      p.fundingEur = sum;
      p.fundingLabel = `${rounds.length} round(s)`;
    }
    p.lastRound ??= [...rounds].sort((a, b) => (a.year ?? 0) - (b.year ?? 0)).at(-1)?.type;
  }

  // Anything that invested in a peer is an investor, not a peer.
  const investorKeys = new Set(
    enriched.flatMap(({ peer, entity }) => [
      ...(entity?.relationships.incoming.INVESTED_IN ?? []).map((r) => norm(r.name)),
      ...(peer.rounds ?? []).flatMap((r) => r.investors.map(norm)),
    ]),
  );
  const kept = enriched.filter(({ peer }) => !investorKeys.has(norm(peer.name)));
  const keptPeers = kept.map((e) => e.peer);

  // The founder's own company as a row, so they see themselves in the table.
  const all: Peer[] = [...keptPeers];
  if (target) {
    const rounds = await graphRounds(
      await soft("Your company's rounds", cala.retrieve(target.id, { outgoing: ROUNDS_OUT, limit: 15 }), target),
      soft,
    );
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
      lastRound: [...rounds].sort((a, b) => (a.year ?? 0) - (b.year ?? 0)).at(-1)?.type,
      rounds,
      via: [],
      sources: [...cala.toSources(target.properties.employee_count?.sources), cala.calaSource(`${target.name} funding rounds`)],
    });
  }

  // Capital share and momentum.
  const totalEur = all.reduce((s, p) => s + (p.fundingEur ?? 0), 0);
  for (const p of all) p.share = totalEur && p.fundingEur ? p.fundingEur / totalEur : undefined;
  const top3Share = all.map((p) => p.share ?? 0).sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0);
  const momentum = buildMomentum(keptPeers, top3Share);
  if (!momentum.years.some((y) => y.rounds)) warnings.push("Cala returned no dated funding rounds for these peers, so the funding trend is empty.");

  // Investors, gaps, founder position, acquirers.
  const investors = buildInvestors(kept);
  const [gaps, position, acquirers] = await Promise.all([
    findGaps({ idea, industry, peers: keptPeers, soft }),
    all[0]?.isTarget ? buildPosition(all[0], keptPeers) : Promise.resolve([] as MoatSignal[]),
    buildAcquirers(kept, target?.name, topic, soft),
  ]);

  // HQ of the investors and acquirers, so the globe can place them (fast entity reads, cached).
  const located = [...investors.slice(0, 8), ...acquirers].filter((x) => x.id);
  await pool(located, 4, async (x) => {
    const e = await soft(`HQ of ${x.name}`, cala.retrieve(x.id!, { outgoing: ["HAS_HEADQUARTERS_IN"], limit: 1 }), undefined);
    x.country = e?.relationships.outgoing.HAS_HEADQUARTERS_IN?.[0]?.name;
  });

  const map: MarketMap = {
    input: { idea, company },
    mode: "live",
    target: target ? { id: target.id, name: target.name, description: target.description } : undefined,
    industry,
    peers: all,
    capital: { totalEur, peersWithFunding: all.filter((p) => p.fundingEur).length, top3Share },
    momentum,
    investors: { available: investors.length > 0, list: investors },
    standout: { gaps: gaps.gaps, position, generatedBy: gaps.by },
    acquirers,
    summary: "",
    warnings: [...new Set(warnings)],
    generatedAt: new Date().toISOString(),
  };
  map.summary = await writeSummary(map);
  // Cache complete maps only: a run where Cala calls were skipped should be retried next time.
  if (!map.warnings.some((w) => /skipped|fetch failed|-> 5\d\d/.test(w))) await cala.writeCachedResult(resultKey, map);
  return map;
}

function bestMatch(hits: cala.EntityRef[], name: string): cala.EntityRef | undefined {
  const k = norm(name);
  const ok = hits.filter((h) => PEER_TYPES.has(h.entity_type) || !h.entity_type);
  return ok.find((h) => norm(h.name) === k) ?? ok.find((h) => norm(h.name).startsWith(k)) ?? ok[0];
}

/** "Series C (Feb 2024, $100M) — valued at $1.8B" -> "Series C"; "Secondary market round; valued ..." -> "Secondary market round" */
function lastRoundType(v: unknown): string | undefined {
  if (typeof v !== "string" || !v.trim()) return undefined;
  return v.split(/[;(—–]| - /)[0].trim() || undefined;
}

// ---------- Funding rounds ----------

const ROUNDS_OUT = ["PARTICIPATES_IN_FUNDING_ROUND"];
const ROUND_PROPS = ["round_label", "transaction_value", "transaction_value_units", "announcement_date"];
/** SERIES_C -> "Series C", PRE_SEED -> "Pre Seed" */
const roundLabel = (v: unknown) =>
  typeof v === "string" && v ? v.toLowerCase().replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : undefined;

/** Funding rounds through the graph: FundingRound entities (fast reads) with stage, amount, date and investors. */
async function graphRounds(entity: cala.Entity | undefined, soft: Soft): Promise<Round[]> {
  const refs = (entity?.relationships.outgoing.PARTICIPATES_IN_FUNDING_ROUND ?? []).slice(0, MAX_ROUNDS_PER_PEER);
  const rounds = await pool(refs, 3, async (ref): Promise<Round | undefined> => {
    const r = await soft(
      `Round ${ref.name} of ${entity!.name}`,
      cala.retrieve(ref.id, { properties: ROUND_PROPS, incoming: ROUNDS_OUT, limit: 15 }),
      undefined,
    );
    if (!r) return undefined;
    const pr = r.properties;
    const value = pr.transaction_value?.value;
    const units = String(pr.transaction_value_units?.value ?? "EUR");
    const date = String(pr.announcement_date?.value ?? ref.properties?.event_date ?? "");
    return {
      type: roundLabel(pr.round_label?.value) ?? ref.name,
      amountEur: typeof value === "number" ? parseMoneyEur(`${units} ${value}`) : parseMoneyEur(value),
      year: parseIntLoose(date.match(/\d{4}/)?.[0]),
      investors: (r.relationships.incoming.PARTICIPATES_IN_FUNDING_ROUND ?? [])
        .filter((x) => (x.properties?.role ?? "").toUpperCase() === "INVESTOR")
        .map((x) => x.name),
      sources: cala.toSources([...(pr.transaction_value?.sources ?? []), ...(ref.properties?.sources ?? [])]).slice(0, 3),
    };
  });
  return rounds.filter((r) => r !== undefined);
}

/** One knowledge query for several companies' rounds (~40 s), used only for peers the graph has no rounds for. */
async function batchedRounds(names: string[], soft: Soft): Promise<Map<string, Round[]>> {
  const out = new Map<string, Round[]>();
  if (!names.length) return out;
  const r = await soft(
    "Funding rounds (batch)",
    cala.query(`companies.name=(${names.join(", ")}).funding_rounds return(company, round_type, amount, date)`),
    EMPTY_QUERY,
  );
  for (const x of r.results) {
    const company = String(field(x, "company", "name", "company_name") ?? (names.length === 1 ? names[0] : ""));
    if (!company) continue;
    const date = field(x, "date", "announced_date", "announced_on", "year");
    const k = norm(company);
    const list = out.get(k) ?? [];
    list.push({
      type: (field(x, "round_type", "round", "type", "stage") as string) ?? undefined,
      amountEur: parseMoneyEur(field(x, "amount", "funding_amount", "money_raised", "amount_raised")),
      year: parseIntLoose(String(date ?? "").match(/\d{4}/)?.[0]),
      investors: [],
      sources: [cala.calaSource(`${company} funding rounds`)],
    });
    out.set(k, list);
  }
  return out;
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

function buildInvestors(enriched: { peer: Peer; entity?: cala.Entity }[]): Investor[] {
  const m = new Map<string, Investor>();
  for (const { peer, entity } of enriched)
    for (const r of entity?.relationships.incoming.INVESTED_IN ?? []) {
      const k = norm(r.name);
      if (!k) continue;
      const inv = m.get(k) ?? { id: r.id, name: r.name, rounds: 0, peers: [], sources: [] };
      inv.rounds++;
      if (!inv.peers.includes(peer.name)) inv.peers.push(peer.name);
      inv.sources.push(...cala.toSources(r.properties?.sources).slice(0, 2));
      m.set(k, inv);
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
  topic: string | undefined,
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

  // b) Who acquired a peer: MNA_* events where the peer was the target. The peer's side of the
  //    event already carries its role, so only those events are looked up for the counterparty.
  const deals = enriched
    .flatMap(({ peer, entity }) =>
      (entity?.relationships.outgoing.PARTICIPATES_IN_CORPORATE_EVENT ?? [])
        .filter((ev) => DEAL.test(ev.name) && (ev.properties?.role ?? "TARGET").toUpperCase() !== "ACQUIRER")
        .map((ev) => ({ peer, ev })),
    )
    .slice(0, MAX_DEAL_LOOKUPS);
  await pool(deals, 3, async ({ peer, ev }) => {
    const e = await soft(`Deal ${ev.name} for ${peer.name}`, cala.retrieve(ev.id, { incoming: EVENTS_OUT, limit: 10 }), undefined);
    const when = ev.properties?.event_date?.slice(0, 7);
    for (const party of e?.relationships.incoming.PARTICIPATES_IN_CORPORATE_EVENT ?? []) {
      if (!PEER_TYPES.has(party.entity_type) || norm(party.name) === norm(peer.name)) continue;
      const role = party.properties?.role?.toUpperCase();
      if (role && role !== "ACQUIRER" && role !== "BUYER") continue;
      add(party.name, party.id, 3, {
        kind: "deal_with_peer",
        text: `Acquired ${peer.name}${when ? ` (${when})` : ""}`,
        sources: cala.toSources(party.properties?.sources ?? ev.properties?.sources),
      });
    }
  });

  // c) Sector-level acquisitions Cala can cite.
  if (topic && DEEP) {
    const s = await soft("Sector acquisitions", cala.search(`Which companies acquired ${topic} startups in the last 5 years?`), EMPTY_SEARCH);
    const srcs = cala.knowBitSources(s.context, 4);
    const named = new Set(boldNames(s.content).map(norm));
    for (const e of s.entities)
      if (PEER_TYPES.has(e.entity_type) && (!named.size || named.has(norm(e.name)) || (e.mentions ?? []).some((m) => named.has(norm(m)))))
        add(e.name, e.id, 1, { kind: "sector_deal", text: `Cited as an acquirer in ${topic}`, sources: srcs });
  }

  return [...acq.values()].filter((a) => a.score >= 1).sort((a, b) => b.score - a.score).slice(0, 8);
}

export type { Source };
