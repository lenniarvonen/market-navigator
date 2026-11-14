// Small parsing helpers for Cala's loosely typed rows.

// Rough FX to EUR, good enough for a share-of-capital view. Shown as approximate in the UI.
const FX: Record<string, number> = { "€": 1, EUR: 1, $: 0.92, USD: 0.92, "£": 1.17, GBP: 1.17, SEK: 0.087, NOK: 0.085, DKK: 0.134, CHF: 1.05 };
const SCALE: Record<string, number> = { k: 1e3, K: 1e3, m: 1e6, M: 1e6, mn: 1e6, b: 1e9, B: 1e9, bn: 1e9 };

/** "€38.9M ($42M)" -> 38900000, "~$12.5–13M" -> 11500000, "over 100M" -> 100000000, 2500000 -> 2500000 */
export function parseMoneyEur(v: unknown): number | undefined {
  if (typeof v === "number" && isFinite(v)) return v;
  if (typeof v !== "string") return undefined;
  // Ranges ("~$12.5–13M") take the low end, keeping the scale that follows the range.
  const m = v.match(/(€|\$|£|EUR|USD|GBP|SEK|NOK|DKK|CHF)?\s*([\d.,]+)(?:\s*[–—-]\s*[\d.,]+)?\s*(bn|mn|[kKmMbB])?/);
  if (!m) return undefined;
  const n = parseFloat(m[2].replace(/,/g, ""));
  if (!isFinite(n)) return undefined;
  const cur = m[1] ?? (v.match(/\b(EUR|USD|GBP|SEK|NOK|DKK|CHF)\b/)?.[1] ?? "€");
  return n * (SCALE[m[3] ?? ""] ?? 1) * (FX[cur] ?? 1);
}

export function parseIntLoose(v: unknown): number | undefined {
  if (typeof v === "number" && isFinite(v)) return Math.round(v);
  if (typeof v !== "string") return undefined;
  const m = v.replace(/,/g, "").match(/\d+(\.\d+)?\s*([kK])?/);
  if (!m) return undefined;
  return Math.round(parseFloat(m[0]) * (m[2] ? 1000 : 1));
}

/** First present value among candidate keys (case-insensitive). */
export function field(row: Record<string, unknown>, ...keys: string[]): unknown {
  const lower = Object.fromEntries(Object.entries(row).map(([k, v]) => [k.toLowerCase(), v]));
  for (const k of keys) {
    const v = lower[k.toLowerCase()];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

export function median(xs: number[]): number | undefined {
  const s = xs.filter((x) => isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return undefined;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export const norm = (s: string) =>
  s.toLowerCase().replace(/\b(inc|ltd|oy|ab|gmbh|sas|bv|plc|llc|as|oyj)\b\.?/g, "").replace(/[^a-z0-9]/g, "");

export async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

export function fmtEur(n?: number): string {
  if (n === undefined) return "n/a";
  if (n >= 1e9) return `€${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `€${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `€${(n / 1e3).toFixed(0)}k`;
  return `€${n.toFixed(0)}`;
}
