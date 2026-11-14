// "Where you can stand out": differentiation gaps from what the peers have in common.
// Claude reads only sourced peer facts; without ANTHROPIC_API_KEY a data-only template is used.
import Anthropic from "@anthropic-ai/sdk";
import * as cala from "./cala";
import type { Gap, Peer } from "./types";
import { fmtEur, median, pool } from "./util";

type Soft = <T>(label: string, p: Promise<T>, fallback: T) => Promise<T>;

export async function findGaps(args: {
  idea?: string;
  industry?: string;
  peers: Peer[];
  soft: Soft;
}): Promise<{ gaps: Gap[]; by: "claude" | "template" }> {
  const { idea, industry, peers, soft } = args;

  // Founder backgrounds for the best-funded peers (one sourced question each).
  const top = [...peers].sort((a, b) => (b.fundingEur ?? 0) - (a.fundingEur ?? 0)).slice(0, 4);
  const teams = await pool(top, 4, async (p) => {
    const r = await soft(
      `Team of ${p.name}`,
      cala.search(`Who founded ${p.name} and where did they work before?`),
      { content: "", context: [], entities: [] } as cala.SearchResult,
    );
    return [p.name, r.content.slice(0, 300)] as const;
  });
  const teamOf = new Map(teams.filter(([, t]) => t));

  if (process.env.ANTHROPIC_API_KEY) {
    try {
      return { gaps: await claudeGaps(idea, industry, peers, teamOf), by: "claude" };
    } catch {
      // fall through to the template
    }
  }
  return { gaps: templateGaps(peers), by: "template" };
}

async function claudeGaps(idea: string | undefined, industry: string | undefined, peers: Peer[], teamOf: Map<string, string>): Promise<Gap[]> {
  const facts = peers.map((p) => ({
    name: p.name,
    description: p.description,
    country: p.country,
    founded: p.foundedYear,
    employees: p.employees,
    funding: p.fundingEur ? fmtEur(p.fundingEur) : undefined,
    lastRound: p.lastRound,
    founders: teamOf.get(p.name),
  }));
  const client = new Anthropic();
  const res = await client.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 4000,
    output_config: {
      effort: "low",
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["gaps"],
          properties: {
            gaps: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["title", "detail", "peers"],
                properties: {
                  title: { type: "string" },
                  detail: { type: "string" },
                  peers: { type: "array", items: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
    system:
      "You help a validation-stage founder find where they can stand out in a market. " +
      "You get facts about existing companies in the space. Return exactly 3 gaps: places where the existing companies " +
      "cluster (same customer, same country, same stage, same kind of team) and leave room for a newcomer. " +
      "Each gap needs a short title (max 8 words), a 1-2 sentence detail grounded in the facts, and the names of the peers it is based on. " +
      "Use only the facts given. Never invent companies, numbers or customers. If facts are thin, say what is unknown instead of guessing.",
    messages: [{ role: "user", content: JSON.stringify({ idea, industry, peers: facts }) }],
  });
  if (res.stop_reason === "refusal") throw new Error("refused");
  const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  const parsed = JSON.parse(text) as { gaps: Gap[] };
  const known = new Set(peers.map((p) => p.name));
  return parsed.gaps.slice(0, 3).map((g) => ({ ...g, peers: g.peers.filter((n) => known.has(n)) }));
}

/** Data-only observations, used when Claude isn't configured. */
export function templateGaps(peers: Peer[]): Gap[] {
  const gaps: Gap[] = [];
  const byCountry = new Map<string, string[]>();
  for (const p of peers) if (p.country) byCountry.set(p.country, [...(byCountry.get(p.country) ?? []), p.name]);
  const [topCountry, inCountry] = [...byCountry.entries()].sort((a, b) => b[1].length - a[1].length)[0] ?? [];
  if (topCountry && inCountry && inCountry.length >= Math.max(2, peers.length * 0.4))
    gaps.push({
      title: `Most players are based in ${topCountry}`,
      detail: `${inCountry.length} of ${peers.length} peers are headquartered in ${topCountry}. Other markets may be less served.`,
      peers: inCountry,
    });

  const funded = peers.filter((p) => p.fundingEur);
  const big = funded.filter((p) => (p.fundingEur ?? 0) >= 10e6);
  if (big.length)
    gaps.push({
      title: "Well-funded players will move upmarket",
      detail: `${big.length} ${big.length === 1 ? "peer has" : "peers have"} raised €10M or more. They tend to chase larger customers, which can leave smaller customers to a focused newcomer.`,
      peers: big.map((p) => p.name),
    });

  const medYear = median(peers.map((p) => p.foundedYear ?? NaN));
  const young = peers.filter((p) => p.foundedYear && medYear && p.foundedYear > medYear);
  if (medYear)
    gaps.push({
      title: young.length >= peers.length / 2 ? "The space is young and still forming" : "Incumbents are older",
      detail: `The median peer was founded in ${Math.round(medYear)}. ${young.length} ${young.length === 1 ? "is" : "are"} newer than that.`,
      peers: young.map((p) => p.name),
    });

  return gaps.slice(0, 3);
}
