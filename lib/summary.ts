// Turns a market map into a short "so what" for a validation-stage founder.
// Uses Claude when ANTHROPIC_API_KEY is set; otherwise a deterministic template.
import Anthropic from "@anthropic-ai/sdk";
import type { MarketMap } from "./types";
import { fmtEur } from "./util";

export async function writeSummary(map: MarketMap): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) return templateSummary(map);
  try {
    const client = new Anthropic();
    const compact = {
      idea: map.input.idea,
      company: map.target?.name,
      industry: map.industry,
      peers: map.peers.map((p) => ({ name: p.name, isFounder: p.isTarget, funding: p.fundingEur ? fmtEur(p.fundingEur) : undefined, lastRound: p.lastRound, country: p.country })),
      momentum: { roundsPerYear: map.momentum.years, trend: map.momentum.trend, earlyShare: map.momentum.earlyShare, crowding: map.momentum.crowding },
      earlyInvestors: map.investors.list.slice(0, 5).map((i) => ({ name: i.name, backed: i.peers })),
      gaps: map.standout.gaps.map((g) => g.title),
      acquirers: map.acquirers.slice(0, 3).map((a) => ({ name: a.name, evidence: a.evidence.map((e) => e.text) })),
    };
    const res = await client.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 2000,
      output_config: { effort: "low" },
      system:
        "You advise a founder who is still validating an idea. Write exactly 3 short, plain sentences (60 words at most), with no headings or bullet points. Write money the way the JSON does (e.g. €1.2B), never as long digits. " +
        "Use only the facts in the JSON and never invent numbers or companies. Sentence 1: how crowded the space is and who leads it. " +
        "Sentence 2: whether money is flowing in and whether there is a visible exit. Sentence 3: one concrete validation step for this week. " +
        "Do not comment on data quality.",
      messages: [{ role: "user", content: JSON.stringify(compact) }],
    });
    if (res.stop_reason === "refusal") return templateSummary(map);
    const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
    return text || templateSummary(map);
  } catch (e) {
    map.warnings.push(e instanceof Anthropic.APIError ? `Summary model error ${e.status}; used template summary.` : "Summary generation failed; used template summary.");
    return templateSummary(map);
  }
}

export function templateSummary(map: MarketMap): string {
  const others = map.peers.filter((p) => !p.isTarget);
  const leader = [...others].sort((a, b) => (b.fundingEur ?? 0) - (a.fundingEur ?? 0))[0];
  const m = map.momentum;
  const where = map.industry ? ` in ${map.industry}` : "";
  const parts = [
    `Cala finds ${others.length} companies close to this idea${where}, which have raised about ${fmtEur(map.capital.totalEur)} between them.`,
    leader?.fundingEur
      ? `${leader.name} leads at ${fmtEur(leader.fundingEur)}${m.crowding === "unknown" ? "." : `, and the top three hold ${pct(m.top3Share)} of the capital, so the space looks ${m.crowding}.`}`
      : "",
    m.trend !== "unknown"
      ? `Funding rounds are ${m.trend} over the last two years${m.earlyShare !== undefined ? `, and ${pct(m.earlyShare)} of rounds were pre-seed or seed` : ""}.`
      : "There are too few dated rounds to call a funding trend.",
    map.investors.list[0] ? `${map.investors.list[0].name} is the most active early investor here, backing ${list(map.investors.list[0].peers)}.` : "",
    map.acquirers[0] ? `${map.acquirers[0].name} looks like the most likely acquirer: ${lcFirst(map.acquirers[0].evidence[0]?.text ?? "")}.` : "Cala shows no clear exit pattern in this space yet.",
    leader ? `This week, talk to five customers of ${leader.name} and ask what it does badly.` : "",
  ];
  return parts.filter(Boolean).join(" ");
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const lcFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const list = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
