// Thin, defensive client for the Cala API (https://docs.cala.ai).
// Response shapes are parsed loosely because the API is in beta.
import type { Source } from "./types";

const BASE = process.env.CALA_BASE_URL ?? "https://api.cala.ai/v1";
const cache = new Map<string, Promise<unknown>>();

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
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        "X-API-KEY": process.env.CALA_API_KEY ?? "",
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new CalaError(res.status, `Cala ${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
    }
    return (await res.json()) as T;
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
type RawRel = { id: string; name: string; entity_type: string; properties?: { sources?: RawSource[]; valid_since?: string; valid_until?: string } };

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
 * Only asks for relationships the entity actually exposes (via introspection),
 * so one unknown relationship name can't fail the whole call.
 */
export async function retrieve(
  id: string,
  want: { properties?: string[]; incoming?: string[]; outgoing?: string[]; limit?: number } = {},
): Promise<Entity> {
  const intro = await introspect(id).catch(() => null);
  const pick = (names: string[] = [], allowed?: string[]) =>
    Object.fromEntries(
      names.filter((n) => !allowed || allowed.includes(n)).map((n) => [n, { limit: want.limit ?? 25, offset: 0 }]),
    );
  const body = {
    properties: (want.properties ?? []).filter((p) => !intro || intro.properties.includes(p)),
    relationships: {
      incoming: pick(want.incoming, intro?.relationships.incoming),
      outgoing: pick(want.outgoing, intro?.relationships.outgoing),
    },
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
