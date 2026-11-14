// Fictional demo data, used only when no CALA_API_KEY is set.
// Every company and investor here is invented, so the UI can be shown before live data is wired.
import type { MarketMap, Peer, Round, Source } from "./types";
import { templateSummary } from "./summary";
import { templateGaps } from "./standout";
import { buildMomentum, type MapInput } from "./navigator";

const DEMO: Source[] = [{ name: "Demo data (fictional)" }];
const r = (year: number, type: string, m: number, investors: string[]): Round => ({ year, type, amountEur: m * 1e6, investors, sources: DEMO });

const PEERS: Peer[] = [
  { name: "Carbonly Nord", country: "Sweden", foundedYear: 2019, employees: 85, lastRound: "Series B", via: ["similar-search", "industry"], sources: DEMO, description: "Emissions reporting for mid-size manufacturers",
    rounds: [r(2022, "Seed", 3, ["Polar Seed Fund"]), r(2023, "Series A", 9, ["Halo Ventures"]), r(2025, "Series B", 16, ["Halo Ventures", "Ostra Capital"])] },
  { name: "Footprint Labs", country: "Finland", foundedYear: 2020, employees: 60, lastRound: "Series A", via: ["similar-search", "industry"], sources: DEMO, description: "Scope 3 supplier data platform",
    rounds: [r(2022, "Pre-seed", 0.5, ["Northern Angels"]), r(2023, "Seed", 4, ["Polar Seed Fund", "Kettu VC"]), r(2025, "Series A", 15, ["Ostra Capital"])] },
  { name: "Emitrace", country: "Finland", foundedYear: 2021, employees: 22, lastRound: "Seed", via: ["similar-search"], sources: DEMO, description: "Carbon accounting add-on for bookkeeping software",
    rounds: [r(2023, "Pre-seed", 0.6, ["Northern Angels"]), r(2025, "Seed", 5.5, ["Kettu VC", "Polar Seed Fund"])] },
  { name: "GreenBooks AI", country: "Estonia", foundedYear: 2023, employees: 9, lastRound: "Pre-seed", via: ["industry"], sources: DEMO, description: "AI receipts-to-emissions for micro businesses",
    rounds: [r(2024, "Pre-seed", 0.8, ["Baltic Founders Club"]), r(2026, "Seed", 1.0, ["Kettu VC"])] },
  { name: "Scope3 Studio", country: "Sweden", foundedYear: 2020, employees: 40, lastRound: "Series A", via: ["industry"], sources: DEMO, description: "ESG reporting for retail chains",
    rounds: [r(2022, "Seed", 2.5, ["Polar Seed Fund"]), r(2024, "Series A", 8.5, ["Halo Ventures"])] },
  { name: "Klimaregnskap", country: "Norway", foundedYear: 2018, employees: 30, lastRound: "Seed", via: ["industry"], sources: DEMO, description: "Climate accounts for municipalities",
    rounds: [r(2022, "Seed", 4.4, ["Fjell Partners"])] },
  { name: "Tundra ESG", country: "Sweden", foundedYear: 2022, employees: 12, lastRound: "Pre-seed", via: ["similar-search"], sources: DEMO, description: "CSRD readiness checklists for SMEs",
    rounds: [r(2024, "Pre-seed", 0.7, ["Northern Angels"]), r(2026, "Seed", 2.2, ["Polar Seed Fund"])] },
];

export function demoMap(input: MapInput): MarketMap {
  const peers: Peer[] = PEERS.map((p) => {
    const fundingEur = (p.rounds ?? []).reduce((s, x) => s + (x.amountEur ?? 0), 0);
    return { ...p, fundingEur, fundingLabel: `${p.rounds?.length} round(s)` };
  });
  const total = peers.reduce((s, p) => s + (p.fundingEur ?? 0), 0);
  for (const p of peers) p.share = (p.fundingEur ?? 0) / total;
  const top3Share = peers.map((p) => p.share ?? 0).sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0);

  const momentum = buildMomentum(peers, top3Share);
  momentum.sources = DEMO;
  const inv = new Map<string, { name: string; rounds: number; peers: string[]; sources: Source[] }>();
  for (const p of peers)
    for (const x of p.rounds ?? []) {
      if (!/seed/i.test(x.type ?? "")) continue;
      for (const n of x.investors) {
        const v = inv.get(n) ?? { name: n, rounds: 0, peers: [], sources: DEMO };
        v.rounds++;
        if (!v.peers.includes(p.name)) v.peers.push(p.name);
        inv.set(n, v);
      }
    }

  const map: MarketMap = {
    input,
    mode: "demo",
    industry: "Carbon accounting software",
    peers,
    capital: { totalEur: total, peersWithFunding: peers.length, top3Share },
    momentum,
    investors: { available: true, list: [...inv.values()].sort((a, b) => b.peers.length - a.peers.length || b.rounds - a.rounds) },
    standout: { gaps: templateGaps(peers), position: [], generatedBy: "template" },
    acquirers: [
      { name: "NorthBank Software Group", score: 8, evidence: [
        { kind: "owns_peer", text: "Owns Klimaregnskap (since 2024-03)", sources: DEMO },
        { kind: "deal_with_peer", text: "Deal with Emitrace: minority stake, 2025", sources: DEMO },
        { kind: "sector_deal", text: "Cited as an acquirer in carbon accounting software", sources: DEMO },
      ] },
      { name: "Fjord ERP", score: 4, evidence: [
        { kind: "deal_with_peer", text: "Deal with Footprint Labs: acquisition talks reported, 2025", sources: DEMO },
        { kind: "deal_with_peer", text: "Deal with Scope3 Studio: strategic partnership, 2024", sources: DEMO },
      ] },
      { name: "Baltic Audit Partners", score: 2, evidence: [{ kind: "deal_with_peer", text: "Deal with GreenBooks AI: acquisition, 2026", sources: DEMO }] },
    ],
    summary: "",
    warnings: ["Demo mode: no CALA_API_KEY is set, so every company, investor and number shown is fictional."],
    generatedAt: new Date().toISOString(),
  };
  map.summary = templateSummary(map);
  return map;
}
