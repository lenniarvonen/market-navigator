// Thin, defensive client for the Cala API (https://docs.cala.ai).
// Response shapes are parsed loosely because the API is in beta.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Source } from "./types";

const BASE = process.env.CALA_BASE_URL ?? "https://api.cala.ai/v1";
const cache = new Map<string, Promise<unknown>>();

// Cala rate-limits hard (429 after ~15 quick calls, no Retry-After), so every call goes
// through one global queue with a minimum gap between request starts, and 429s retry with backoff.
// /knowledge/* calls are slow (20-75 s each) and Cala runs them one at a time per key, so the gap
// barely matters there; entity reads take ~0.1 s, so they get a shorter gap.
const GAP_KNOWLEDGE = Number(process.env.CALA_MIN_GAP_MS ?? 1500);
const GAP_ENTITY = Number(process.env.CALA_ENTITY_GAP_MS ?? 400);
const TIMEOUT = Number(process.env.CALA_TIMEOUT_MS ?? 90_000);
const BACKOFF = [2000, 4000, 8000];
let nextSlot = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function slot(gap: number) {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + gap;
  if (at > now) await sleep(at - now);
}

// Disk cache (.cache/cala/<hash>.json) so repeat runs and demos cost no calls.
// Set CALA_DISK_CACHE=0 to disable.
const DISK = process.env.CALA_DISK_CACHE !== "0";
const CACHE_DIR = path.join(process.cwd(), ".cache", "cala");
const diskFile = (key: string) => path.join(CACHE_DIR, `${createHash("sha1").update(key).digest("hex")}.json`);
async function diskGet(key: string): Promise<unknown | undefined> {
  if (!DISK) return undefined;
  try {
    return JSON.parse(await readFile(diskFile(key), "utf8")).body;
  } catch {
    return undefined;
  }
}
async function diskPut(key: string, body: unknown) {
  if (!DISK) return;
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(diskFile(key), JSON.stringify({ key, savedAt: new Date().toISOString(), body }));
  } catch {
    // cache is best-effort
  }
}

/** Whole-result disk cache (same .cache/cala folder) so a mapped idea, Claude text included, reloads instantly. */
export async function readCachedResult<T>(key: string): Promise<T | undefined> {
  return (await diskGet(`result ${key}`)) as T | undefined;
}
export async function writeCachedResult(key: string, value: unknown) {
  await diskPut(`result ${key}`, value);
}

export class CalaError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const hasCalaKey = () => Boolean(process.env.CALA_API_KEY);

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const key = `${method} ${path} ${body ? JSON.stringify(body) : ""}`;
  const hit = cache.get(key);
  if (hit) return hit as Promise<T>;
  const p = (async () => {
    const disk = await diskGet(key);
    if (disk !== undefined) return disk as T;
    for (let attempt = 0; ; attempt++) {
      await slot(path.startsWith("/knowledge") ? GAP_KNOWLEDGE : GAP_ENTITY);
      const res = await fetch(`${BASE}${path}`, {
        signal: AbortSignal.timeout(TIMEOUT),
        method,
        headers: {
          "X-API-KEY": process.env.CALA_API_KEY ?? "",
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        cache: "no-store",
      });
      // 429: back off and retry. 502/503/504 (Cala's gateway on heavy queries): one retry.
      if ((res.status === 429 && attempt < BACKOFF.length) || ([502, 503, 504].includes(res.status) && attempt < 1)) {
        await sleep(BACKOFF[attempt]);
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new CalaError(res.status, `Cala ${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
      }
      const json = (await res.json()) as T;
      await diskPut(key, json);
      return json;
    }
  })();
  cache.set(key, p);
  p.catch(() => cache.delete(key));
  return p;
}

// ---------- Endpoint wrappers ----------

export type EntityRef = { id: string; name: string; entity_type: string; description?: string; mentions?: string[] };

export async function searchEntities(name: string, types: string[] = [], limit = 5): Promise<EntityRef[]> {
  const qs = new URLSearchParams({ name: name.slice(0, 100), limit: String(limit) });
  types.forEach((t) => qs.append("entity_types", t));
  const r = await call<{ entities?: EntityRef[] }>("GET", `/entities?${qs}`);
  return r.entities ?? [];
}

export type QueryResult = { results: Record<string, unknown>[]; entities: EntityRef[] };

export async function query(input: string): Promise<QueryResult> {
  const r = await call<Partial<QueryResult>>("POST", "/knowledge/query", { input });
  return { results: r.results ?? [], entities: r.entities ?? [] };
}

type KnowBit = {
  id: string;
  content: string;
  origins?: { source?: { name?: string; url?: string }; document?: { name?: string; url?: string } }[];
};
export type SearchResult = { content: string; context: KnowBit[]; entities: EntityRef[] };

export async function search(input: string): Promise<SearchResult> {
  const r = await call<Partial<SearchResult>>("POST", "/knowledge/search", {
    input,
    explainability: false,
    return_entities: true,
  });
  return { content: r.content ?? "", context: r.context ?? [], entities: r.entities ?? [] };
}

export type Introspection = {
  properties: string[];
  relationships: { incoming: string[]; outgoing: string[] };
};

export async function introspect(id: string): Promise<Introspection> {
  const r = await call<Partial<Introspection>>("GET", `/entities/${id}/introspection`);
  return {
    properties: r.properties ?? [],
    relationships: { incoming: r.relationships?.incoming ?? [], outgoing: r.relationships?.outgoing ?? [] },
  };
}

type RawSource = { name?: string; date?: string; document?: string | { endpoint?: string } };
type RawProp = { value: unknown; sources?: RawSource[] };
type RawRel = {
  id: string;
  name: string;
  entity_type: string;
  properties?: { sources?: RawSource[]; valid_since?: string; valid_until?: string; role?: string; event_date?: string };
};

export type Entity = {
  id: string;
  name: string;
  entity_type: string;
  description?: string;
  properties: Record<string, RawProp>;
  relationships: { incoming: Record<string, RawRel[]>; outgoing: Record<string, RawRel[]> };
};

/**
 * Retrieve an entity with the given properties and relationships.
 * Cala ignores relationship names the entity doesn't have, so no introspection call is needed.
 */
export async function retrieve(
  id: string,
  want: { properties?: string[]; incoming?: string[]; outgoing?: string[]; limit?: number } = {},
): Promise<Entity> {
  const pick = (names: string[] = []) => Object.fromEntries(names.map((n) => [n, { limit: want.limit ?? 25, offset: 0 }]));
  const body = {
    properties: want.properties ?? [],
    relationships: { incoming: pick(want.incoming), outgoing: pick(want.outgoing) },
  };
  const r = await call<Partial<Entity>>("POST", `/entities/${id}`, body);
  return {
    id: r.id ?? id,
    name: r.name ?? "",
    entity_type: r.entity_type ?? "",
    description: r.description,
    properties: r.properties ?? {},
    relationships: { incoming: r.relationships?.incoming ?? {}, outgoing: r.relationships?.outgoing ?? {} },
  };
}

// ---------- Source helpers ----------

export function toSources(raw: RawSource[] | undefined): Source[] {
  return (raw ?? []).map((s) => ({
    name: s.name ?? "source",
    date: s.date,
    url: typeof s.document === "string" ? s.document : s.document?.endpoint,
  }));
}

export function knowBitSources(bits: KnowBit[], limit = 6): Source[] {
  const seen = new Set<string>();
  const out: Source[] = [];
  for (const b of bits) {
    for (const o of b.origins ?? []) {
      const url = o.document?.url ?? o.source?.url;
      const name = o.document?.name ?? o.source?.name ?? "source";
      const k = url ?? name;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ name, url });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

export const calaSource = (label: string): Source => ({ name: `Cala: ${label}` });
