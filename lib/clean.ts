// Tidies a map before it is shown: Cala sometimes resolves a short startup name to an unrelated
// older company (e.g. "Ada" to a French firm from 1986), and lists one investor under several legal
// entities in capitals ("INDEX VENTURES (UK) LLP"). Applied to live maps, cached maps and fixtures.
import type { Acquirer, Investor, MarketMap, Peer } from "./types";
import { norm } from "./util";

const LEGAL = /\b(limited|ltd|llp|l\.?p|lp|llc|inc|corp|corporation|plc|gmbh|ag|sa|sas|scsp|scs|sca|bv|nv|oy|oyj|ab|as|s\.?a\.?r\.?l)\b\.?/gi;
const FUND = /\b(fund|venture capital|global venture capital|growth|opportunit(y|ies)|partners fund)\s+([ivx]+|\d+)\b/gi;

/** "INDEX VENTURES (UK) LLP" -> "Index Ventures"; "DN CAPITAL - GLOBAL VENTURE CAPITAL V SCSP" -> "DN Capital". */
export function displayName(raw: string): string {
  let s = raw.replace(/\((uk|us|usa|eu|europe|jersey|guernsey|cayman)\)/gi, " ");
  s = s.replace(FUND, " ").replace(LEGAL, " ");
  s = s.split(/\s[-–]\s/)[0]; // "DN Capital - Global ..." keeps the brand part
  s = s.replace(/[,.\s]+$/g, "").replace(/\s{2,}/g, " ").trim();
  if (s === s.toUpperCase() && /[A-Z]{3,}/.test(s))
    s = s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\b(Dn|Ibm|Sap|Nice|Ai|Vc|Bv)\b/g, (w) => w.toUpperCase());
  return s || raw;
}

const descYear = (p: Peer) => Number(p.description?.match(/\b(?:founded|established)(?: in)? ((?:19|20)\d\d)\b/i)?.[1] ?? NaN);

/** A startup row whose matched graph entity is clearly an older, unrelated company: the entity's own
 *  description gives a founding year before 2000, or one far from the year the funding data gives. */
export const isMismatch = (p: Peer) => {
  if (p.isTarget) return false;
  const d = descYear(p);
  return d < 2000 || (p.foundedYear !== undefined && Math.abs(d - p.foundedYear) > 5) || (p.foundedYear ?? 3000) < 2000;
};

/** "1,196,000,000" in model-written text -> "€1.2B". */
const tidyNumbers = (s: string) =>
  s.replace(/\b\d{1,3}(?:,\d{3}){2,}\b/g, (m) => {
    const n = Number(m.replace(/,/g, ""));
    return n >= 1e9 ? `€${(n / 1e9).toFixed(1)}B` : `€${(n / 1e6).toFixed(1)}M`;
  });

const OFFSHORE = new Set(["seychelles", "cayman islands", "british virgin islands", "bermuda", "jersey", "guernsey", "isle of man", "bahamas"].map(norm));

export function cleanMap(map: MarketMap): MarketMap {
  if ((map as { cleaned?: boolean }).cleaned) return map;
  const suspect = new Set<string>();
  const peers = map.peers.map((p) => {
    if (!isMismatch(p)) return p;
    suspect.add(norm(p.name));
    // Keep the name (it came from a sourced search answer) but drop what came from the wrong entity.
    return { ...p, description: undefined, country: undefined, employees: undefined };
  });

  const inv = new Map<string, Investor>();
  for (const i of map.investors.list) {
    const name = displayName(i.name);
    const k = norm(name);
    const e = inv.get(k);
    if (!e) inv.set(k, { ...i, name, peers: [...i.peers] });
    else {
      e.rounds += i.rounds;
      for (const p of i.peers) if (!e.peers.includes(p)) e.peers.push(p);
      // Fund vehicles are often registered offshore; prefer the place the firm works from.
      if (!e.country || (OFFSHORE.has(norm(e.country)) && i.country && !OFFSHORE.has(norm(i.country)))) e.country = i.country ?? e.country;
      e.sources = [...e.sources, ...i.sources];
    }
  }

  const acquirers: Acquirer[] = [];
  for (const a of map.acquirers) {
    // Evidence that only exists because a startup matched the wrong entity is dropped.
    const evidence = a.evidence.filter((ev) => ![...suspect].some((k) => norm(ev.text).includes(k)));
    if (!evidence.length) continue;
    acquirers.push({ ...a, name: displayName(a.name), evidence });
  }

  const dropped = map.acquirers.filter((a) => !acquirers.some((b) => b.id === a.id && b.name === displayName(a.name)));
  // Remove summary sentences that talk about dropped acquirers or data mismatches.
  const summary = tidyNumbers(map.summary)
    .split(/(?<=[.!?])\s+(?=[A-Z"“])/)
    .filter((s) => !dropped.some((a) => s.includes(a.name)) && !/mismatch|shouldn't be counted|data quality/i.test(s))
    .join(" ");

  return {
    ...map,
    peers,
    investors: { ...map.investors, list: [...inv.values()].sort((a, b) => b.peers.length - a.peers.length || b.rounds - a.rounds) },
    acquirers,
    summary,
    cleaned: true,
  } as MarketMap;
}
