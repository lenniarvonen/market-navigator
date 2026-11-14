import { NextRequest, NextResponse } from "next/server";
import { buildMarketMap, buildPeersPreview } from "@/lib/navigator";
import { cleanMap } from "@/lib/clean";

export const runtime = "nodejs";
export const maxDuration = 120;

// GET /api/map?idea=<one-line idea>&company=<optional company name>
// (?q= is accepted as an alias for idea.)
// &stage=peers returns only the peer list (one or two Cala calls) so the UI can render it first;
// the full call then reuses those calls from the cache.
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const idea = (sp.get("idea") ?? sp.get("q"))?.trim() || undefined;
  const company = sp.get("company")?.trim() || undefined;
  if (!idea && !company) return NextResponse.json({ error: "Describe your idea (?idea=...) or name your company (?company=...)." }, { status: 400 });
  try {
    if (sp.get("stage") === "peers") return NextResponse.json(await buildPeersPreview({ idea, company }));
    return NextResponse.json(cleanMap(await buildMarketMap({ idea, company })));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
