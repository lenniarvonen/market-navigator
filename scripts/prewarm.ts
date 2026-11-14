// Fill the Cala disk cache (.cache/cala) for demo ideas, so the demo answers instantly.
// Start the app first (npm run dev or npm start), then: npm run prewarm [-- "idea one" "idea two"]
// BASE_URL defaults to http://localhost:3000.
const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const DEFAULT_IDEAS = [
  "Carbon accounting for SMEs",
  "AI tools for dental clinics",
  "B2B payments for freelancers",
  "AI agents for customer support",
  "EV charging software for housing companies",
];
const ideas = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_IDEAS;

for (const idea of ideas) {
  const t0 = Date.now();
  for (const stage of ["peers", "full"]) {
    const qs = new URLSearchParams({ idea });
    if (stage === "peers") qs.set("stage", "peers");
    const res = await fetch(`${BASE_URL}/api/map?${qs}`);
    const data = (await res.json()) as { error?: string; peers?: unknown[]; warnings?: string[] };
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(`${idea} [${stage}] ${res.status} ${data.error ?? `${data.peers?.length ?? 0} peers, ${data.warnings?.length ?? 0} warnings`} (${secs}s)`);
  }
}
export {};
