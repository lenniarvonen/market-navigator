// Coverage probe: run `CALA_API_KEY=... npm run probe -- "Company A" "Company B"`
// Prints what Cala knows about each company: industries, relationships, events, funding rows.
const BASE = "https://api.cala.ai/v1";
const H = { "X-API-KEY": process.env.CALA_API_KEY ?? "", "Content-Type": "application/json" };
const get = (p: string) => fetch(BASE + p, { headers: H }).then((r) => r.json());
const post = (p: string, b: unknown) => fetch(BASE + p, { method: "POST", headers: H, body: JSON.stringify(b) }).then((r) => r.json());

const names = process.argv.slice(2);
if (!names.length) names.push("Wolt", "Supercell", "Aiven");
for (const name of names) {
  const s = await get(`/entities?name=${encodeURIComponent(name)}&entity_types=Company&limit=1`);
  const e = s.entities?.[0];
  console.log(`\n=== ${name} -> ${e ? `${e.name} (${e.id})` : "NOT FOUND"}`);
  if (!e) continue;
  const intro = await get(`/entities/${e.id}/introspection`);
  console.log("relationships:", JSON.stringify(intro.relationships));
  const rels = (dir: "incoming" | "outgoing") => Object.fromEntries((intro.relationships?.[dir] ?? []).map((r: string) => [r, { limit: 5, offset: 0 }]));
  const full = await post(`/entities/${e.id}`, { properties: intro.properties ?? [], relationships: { incoming: rels("incoming"), outgoing: rels("outgoing") } });
  for (const dir of ["incoming", "outgoing"] as const)
    for (const [k, v] of Object.entries(full.relationships?.[dir] ?? {}))
      console.log(`  ${dir} ${k}: ${(v as { name: string }[]).map((x) => x.name).join(", ")}`);
  const fr = await post("/knowledge/query", { input: `${e.name}.funding_rounds` });
  console.log("funding rows:", JSON.stringify(fr.results ?? fr).slice(0, 600));
}
export {};
