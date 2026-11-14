import { NextRequest, NextResponse } from "next/server";
import { buildMarketMap } from "@/lib/navigator";

export const runtime = "nodejs";
export const maxDuration = 120;

// GET /api/map?idea=<one-line idea>&company=<optional company name>
// (?q= is accepted as an alias for idea.)
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const idea = (sp.get("idea") ?? sp.get("q"))?.trim() || undefined;
  const company = sp.get("company")?.trim() || undefined;
  if (!idea && !company) return NextResponse.json({ error: "Describe your idea (?idea=...) or name your company (?company=...)." }, { status: 400 });
  try {
    return NextResponse.json(await buildMarketMap({ idea, company }));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
