"use client";

import { useState } from "react";
import type { Acquirer, MarketMap, MoatSignal, Momentum, Source } from "@/lib/types";
import { fmtEur } from "@/lib/util";

const EXAMPLES = ["Carbon accounting for SMEs", "AI tools for dental clinics", "B2B payments for freelancers"];

export default function Home() {
  const [idea, setIdea] = useState("");
  const [company, setCompany] = useState("");
  const [map, setMap] = useState<MarketMap | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  async function run(i: string, c = company) {
    if (!i.trim() && !c.trim()) return;
    setIdea(i);
    setLoading(true);
    setErr("");
    setMap(null);
    try {
      const qs = new URLSearchParams();
      if (i.trim()) qs.set("idea", i.trim());
      if (c.trim()) qs.set("company", c.trim());
      const res = await fetch(`/api/map?${qs}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Something went wrong");
      setMap(data);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main>
      <h1>Market Navigator</h1>
      <p className="sub">Describe what you're building. See who's already doing it, whether money is flowing in, who invests early, where you can stand out and how companies in this space end. Every fact is sourced.</p>
      <form onSubmit={(e) => { e.preventDefault(); run(idea); }}>
        <input className="idea" value={idea} onChange={(e) => setIdea(e.target.value)} placeholder="Your idea in one line, e.g. carbon accounting for Nordic SMEs" aria-label="Your idea" />
        <input className="company" value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Your company (optional)" aria-label="Your company, optional" />
        <button disabled={loading}>{loading ? "Mapping…" : "Map my market"}</button>
      </form>
      <div className="examples">
        {EXAMPLES.map((x) => <button key={x} type="button" onClick={() => run(x, "")} disabled={loading}>{x}</button>)}
      </div>
      {loading && <div className="panel muted">Reading Cala's graph: companies, rounds, investors and deals. This takes 20 to 60 seconds.</div>}
      {err && <div className="panel error">{err}</div>}
      {map && <MapView map={map} />}
    </main>
  );
}

function MapView({ map }: { map: MarketMap }) {
  const target = map.peers.find((p) => p.isTarget);
  const maxShare = Math.max(...map.peers.map((p) => p.share ?? 0), 0.0001);
  return (
    <>
      {map.mode === "demo" && <div className="banner">Demo mode: no Cala key is set, so every company, investor and number below is fictional.</div>}
      <section className="panel">
        <h2>{map.input.idea ?? map.target?.name}{map.industry && <span className="tag">{map.industry}</span>}</h2>
        <p className="summary">{map.summary}</p>
      </section>

      <div className="grid">
        <div>
          <section className="panel">
            <h2><span className="num-badge">1</span>Who's already doing this</h2>
            <div className="stats">
              <Stat v={String(map.peers.filter((p) => !p.isTarget).length)} l="companies found" />
              <Stat v={fmtEur(map.capital.totalEur)} l="known capital raised" />
              <Stat v={pct(map.capital.top3Share)} l="held by top 3" />
              {target && <Stat v={target.share !== undefined ? pct(target.share) : "n/a"} l="your share" />}
            </div>
            <div className="scroll">
              <table>
                <thead><tr><th>Company</th><th className="num">Raised</th><th>Share</th><th>Stage</th><th>HQ</th></tr></thead>
                <tbody>
                  {map.peers.map((p) => (
                    <tr key={p.name} className={p.isTarget ? "target" : ""}>
                      <td>
                        <div>{p.name}{p.via.some((v) => v !== "industry") && <span className="tag" title="Found by searching for your idea or your competitors">close match</span>}<Sources sources={p.sources} /></div>
                        {p.description && <div className="desc">{p.description}</div>}
                      </td>
                      <td className="num">{p.fundingEur !== undefined ? fmtEur(p.fundingEur) : "–"}</td>
                      <td><div className="bar" title={p.share !== undefined ? pct(p.share) : "unknown"}><i style={{ width: `${((p.share ?? 0) / maxShare) * 100}%` }} /></div></td>
                      <td>{p.lastRound ?? "–"}</td>
                      <td>{p.country ?? "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="src">Share means share of the capital raised across these companies. Revenue isn't public for private companies, so this is a proxy. Amounts are converted to EUR at approximate rates.</p>
          </section>

          <section className="panel">
            <h2><span className="num-badge">2</span>Is money flowing in?</h2>
            <MomentumView m={map.momentum} />
          </section>
        </div>

        <div>
          <section className="panel">
            <h2><span className="num-badge">3</span>Who invests here early</h2>
            {!map.investors.available && <p className="src">Cala's round data for these companies doesn't name investors yet.</p>}
            {map.investors.available && map.investors.list.length === 0 && <p className="src">No pre-seed or seed investors found for these companies.</p>}
            <ul className="plain">
              {map.investors.list.slice(0, 6).map((i) => (
                <li key={i.name}>
                  <b>{i.name}</b> <span className="muted">· backed {i.peers.join(", ")}</span><Sources sources={i.sources} />
                </li>
              ))}
            </ul>
          </section>

          <section className="panel">
            <h2><span className="num-badge">4</span>Where you can stand out</h2>
            {map.standout.gaps.map((g, i) => (
              <div className="gap" key={i}>
                <b>{g.title}</b>
                <p>{g.detail}</p>
                {g.peers.length > 0 && <div className="src">Based on: {g.peers.join(", ")}</div>}
              </div>
            ))}
            {map.standout.position.length > 0 && (
              <>
                <h3>Your position</h3>
                {map.standout.position.map((m) => <PositionRow key={m.key} m={m} />)}
              </>
            )}
            <p className="src">{map.standout.generatedBy === "claude" ? "Written by Claude from the sourced facts above." : "Computed from the sourced facts above."}</p>
          </section>

          <section className="panel">
            <h2><span className="num-badge">5</span>How companies here end</h2>
            {map.acquirers.length === 0 && <p className="src">Cala shows no acquisitions around these companies yet.</p>}
            {map.acquirers.map((a) => <AcquirerRow key={a.name} a={a} max={map.acquirers[0].score} />)}
          </section>
        </div>
      </div>

      {map.warnings.length > 0 && (
        <details><summary>{map.warnings.length} data gap{map.warnings.length > 1 ? "s" : ""}</summary><ul>{map.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></details>
      )}
    </>
  );
}

function Stat({ v, l }: { v: string; l: string }) {
  return <div className="stat"><b>{v}</b><span>{l}</span></div>;
}

const TREND: Record<Momentum["trend"], string> = { rising: "Rising", flat: "Flat", falling: "Falling", unknown: "Too little data" };
const CROWD: Record<Momentum["crowding"], string> = { crowded: "Crowded: a few leaders hold most capital", contested: "Contested: many funded players", open: "Open: few funded players", unknown: "Too few funded companies to judge crowding" };

function MomentumView({ m }: { m: Momentum }) {
  const W = 560, H = 170, pad = 22, gap = 24;
  const maxR = Math.max(1, ...m.years.map((y) => y.rounds));
  const slot = (W - gap * (m.years.length - 1)) / m.years.length;
  const bw = Math.min(56, slot);
  const yScale = (n: number) => ((H - pad * 2) * n) / maxR;
  return (
    <>
      <div className="stats">
        <Stat v={TREND[m.trend]} l="rounds, last 2 years vs 2 before" />
        <Stat v={m.earlyShare !== undefined ? pct(m.earlyShare) : "n/a"} l="of rounds were pre-seed or seed" />
      </div>
      <div className="legend"><span><i className="sw early" />Pre-seed and seed</span><span><i className="sw later" />Series A and later</span></div>
      <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Funding rounds per year, split by stage">
        <line x1="0" x2={W} y1={H - pad} y2={H - pad} className="axis" />
        {m.years.map((y, i) => {
          const x = i * (slot + gap) + (slot - bw) / 2;
          const he = yScale(y.early), hl = yScale(y.later);
          const base = H - pad;
          const tip = `${y.year}: ${y.rounds} rounds (${y.early} early, ${y.later} later), ${fmtEur(y.capitalEur)}`;
          return (
            <g key={y.year}>
              <title>{tip}</title>
              <rect x={i * (slot + gap)} y={0} width={slot} height={H} fill="transparent" />
              {he > 0 && <path d={bar(x, base - he, bw, he, hl === 0)} className="early" />}
              {hl > 0 && <path d={bar(x, base - he - hl - (he > 0 ? 2 : 0), bw, hl, true)} className="later" />}
              <text x={x + bw / 2} y={H - 6} className="tick">{y.year}</text>
              {y.rounds > 0 && <text x={x + bw / 2} y={base - he - hl - (he && hl ? 2 : 0) - 5} className="val">{y.rounds}</text>}
            </g>
          );
        })}
      </svg>
      <table className="sr-only">
        <caption>Funding rounds per year</caption>
        <thead><tr><th>Year</th><th>Early rounds</th><th>Later rounds</th><th>Capital</th></tr></thead>
        <tbody>{m.years.map((y) => <tr key={y.year}><td>{y.year}</td><td>{y.early}</td><td>{y.later}</td><td>{fmtEur(y.capitalEur)}</td></tr>)}</tbody>
      </table>
      <p className="src">{CROWD[m.crowding]} (top 3 hold {pct(m.top3Share)} of capital). <Sources sources={m.sources} /></p>
    </>
  );
}

/** Bar segment with 4px rounded top corners only when it is the top of the stack. */
function bar(x: number, y: number, w: number, h: number, roundTop: boolean) {
  const r = roundTop ? Math.min(4, h, w / 2) : 0;
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

function PositionRow({ m }: { m: MoatSignal }) {
  const val = (v: number | string | undefined) => (v === undefined ? "n/a" : typeof v === "string" ? v : m.key === "capital" ? fmtEur(v) : String(Math.round(v)));
  return (
    <div className="moat">
      <div><b>{m.label}</b><div className="src">You: {val(m.target)} · peer median: {val(m.peerMedian)}</div></div>
      <span className={`verdict ${m.verdict}`}>{m.verdict === "unknown" ? "no data" : m.verdict}</span>
    </div>
  );
}

function AcquirerRow({ a, max }: { a: Acquirer; max: number }) {
  const dots = Math.max(1, Math.round((a.score / max) * 5));
  return (
    <div className="acq">
      <header><b>{a.name}</b><span className="dots" title={`evidence score ${a.score}`}>{"●".repeat(dots)}{"○".repeat(5 - dots)}</span></header>
      <ul>{a.evidence.slice(0, 4).map((e, i) => <li key={i}>{e.text}<Sources sources={e.sources} /></li>)}</ul>
    </div>
  );
}

function Sources({ sources }: { sources: Source[] }) {
  const uniq = sources.filter((s, i) => sources.findIndex((x) => (x.url ?? x.name) === (s.url ?? s.name)) === i).slice(0, 3);
  if (!uniq.length) return null;
  return (
    <span className="src">
      {uniq.map((s, i) =>
        s.url ? (
          <a key={i} className="cite" href={s.url} target="_blank" rel="noreferrer" title={`${s.name}${s.date ? `, ${s.date}` : ""}`}>{i + 1}</a>
        ) : (
          <span key={i} className="cite" title={s.name}>{i + 1}</span>
        ),
      )}
    </span>
  );
}

const pct = (x: number) => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;
