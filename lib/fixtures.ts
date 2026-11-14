// Saved live maps from Cala, bundled with the app. They load instantly (demo at Slush, cold Vercel
// instances) and let the UI be worked on without a Cala key. Refresh one with `npm run prewarm`
// and copy the cached map from .cache/cala into fixtures/.
import type { MarketMap } from "./types";
import aiAgents from "@/fixtures/ai-agents-customer-support.json";
import { norm } from "./util";
import { cleanMap } from "./clean";

const FIXTURES = [cleanMap(aiAgents as unknown as MarketMap)];

export function fixtureFor(idea?: string, company?: string): MarketMap | undefined {
  if (!idea || company) return undefined;
  return FIXTURES.find((m) => norm(m.input.idea ?? "") === norm(idea));
}

export const fixtureIdeas = FIXTURES.map((m) => m.input.idea!).filter(Boolean);
