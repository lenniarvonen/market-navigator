"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import type { Acquirer, MarketMap, MoatSignal, Momentum, Peer, Source } from "@/lib/types";
import { fmtEur } from "@/lib/util";
import { centreOf, jitter, locate, type LonLat } from "@/lib/geo";
import { Glyph, KIND_LABEL, type GlobeMarker, type MarkerKind } from "./Globe";

// The globe measures the window and runs an animation loop, so it renders on the client only.
const Globe = dynamic(() => import("./Globe"), { ssr: false, loading: () => <div className="globe" /> });

const EXAMPLES = ["Carbon accounting for SMEs", "AI tools for dental clinics", "B2B payments for freelancers"];
const KINDS: MarkerKind[] = ["startup", "invention", "investor", "acquirer"];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const anchor = (kind: MarkerKind, name: string) => `e-${kind}-${slug(name)}`;

type Phase = "rest" | "finding" | "reading" | "done";

export default function Home() {
  const [idea, setIdea] = useState("");
  const [company, setCompany] = useState("");
  const [map, setMap] = useState<MarketMap | null>(null);
  const [preview, setPreview] = useState<Peer[] | null>(null);
  const [err, setErr] = useState("");
  const [phase, setPhase] = useState<Phase>("rest");
  const loading = phase === "finding" || phase === "reading";

  async function run(i: string, c = company) {
    if (!i.trim() && !c.trim()) return;
    setIdea(i);
    setErr("");
    setMap(null);
    setPreview(null);
    setPhase("finding");
    let gotPeers = false;
    try {
      const qs = new URLSearchParams();
      if (i.trim()) qs.set("idea", i.trim());
      if (c.trim()) qs.set("company", c.trim());
      window.history.replaceState(null, "", `?${qs}`); // shareable link to this map
      // Step 1: the peer list (one or two Cala calls); the startups land on the globe first.
      const pres = await fetch(`/api/map?${qs}&stage=peers`);
      const pdata = await pres.json();
      if (!pres.ok) throw new Error(pdata.error ?? "Something went wrong");
      if (pdata.stage !== "peers") {
        setMap(pdata); // demo mode answers with the full map
        setPhase("done");
        return;
      }
      gotPeers = true;
      setPreview(pdata.peers);
      setPhase("reading");
      // Step 2: funding, investors and deals; reuses step 1 from the cache.
      const res = await fetch(`/api/map?${qs}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Something went wrong");
      setMap(data);
      setPreview(null);
      setPhase("done");
    } catch (e) {
      setErr((e as Error).message);
      setPhase(gotPeers ? "done" : "rest");
    }
  }

  // A link with ?idea= (and optional &company=) opens straight on that map.
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const i = sp.get("idea") ?? "", c = sp.get("company") ?? "";
    if (i || c) {
      setCompany(c);
      run(i, c);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const peers = map?.peers ?? preview ?? [];
  const markers = useMemo(() => buildMarkers(peers, map), [peers, map]);
  const focus = useMemo<LonLat | undefined>(
    () => centreOf(markers.filter((m) => m.kind === "startup").map((m) => m.at)),
    [markers],
  );
  const counts = useMemo(
    () => Object.fromEntries(KINDS.map((k) => [k, markers.filter((m) => m.kind === k).length])) as Record<MarkerKind, number>,
    [markers],
  );
  const atRest = phase === "rest";

  function select(m: GlobeMarker) {
    const el = document.getElementById(anchor(m.kind, m.name));
    if (!el) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" });
    el.classList.remove("flash");
    void el.offsetWidth; // restart the highlight
    el.classList.add("flash");
    el.focus({ preventScroll: true });
  }

  function reset() {
    window.history.replaceState(null, "", window.location.pathname);
    setMap(null);
    setPreview(null);
    setPhase("rest");
    setErr("");
  }

  return (
    <>
      <header className="bar">
        <a className="wordmark" href="/" onClick={(e) => { e.preventDefault(); reset(); }}>Market Navigator</a>
        <span className="bar-note">Built on Cala's company graph</span>
      </header>

      <section className={`stage ${atRest ? "at-rest" : "has-map"}`} aria-label="Search and globe">
        <Globe markers={markers} focus={focus} spin={atRest || phase === "finding"} onSelect={select} />

        <div className="nav">
          {atRest && (
            <>
              <h1>Who's already building your idea?</h1>
              <p className="lede">Describe it in one line. The startups doing it light up on the globe, with their funding, backers and buyers, every fact sourced.</p>
            </>
          )}
          <form className="search" onSubmit={(e) => { e.preventDefault(); run(idea); }}>
            <label className="field idea">
              <span className="sr-only">Your idea</span>
              <input value={idea} onChange={(e) => setIdea(e.target.value)} placeholder="Your idea, e.g. payroll software for restaurants" />
            </label>
            <label className="field company">
              <span className="sr-only">Your company, optional</span>
              <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Your company (optional)" />
            </label>
            <button className="go" disabled={loading}>{loading ? "Mapping" : "Map my market"}</button>
          </form>
          {atRest && (
            <div className="examples">
              {EXAMPLES.map((x) => <button key={x} type="button" onClick={() => run(x, "")}>{x}</button>)}
            </div>
          )}
          {!atRest && <Status phase={phase} found={peers.length} err={err} />}
          {atRest && err && <p className="status error" role="alert">{err}</p>}
        </div>

        {!atRest && (
          <ul className="legend" aria-label="Legend">
            {KINDS.map((k) => (
              <li key={k} className={counts[k] ? "" : "none"}>
                <Glyph kind={k} />
                {KIND_LABEL[k]}s <span className="count">{counts[k]}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {preview && !map && <PeersPreview peers={preview} />}
      {map && <MapView map={map} />}

      <footer className="foot">
        <span className="foot-name">Market Navigator</span>
        <span>Company, funding, investor and deal data from Cala. Amounts in EUR at approximate rates.</span>
      </footer>
    </>
  );
}

function Status({ phase, found, err }: { phase: Phase; found: number; err: string }) {
  if (err) return <p className="status error" role="alert">{err}</p>;
  const text =
    phase === "finding" ? "Finding who's already building this. A new idea takes about a minute; one mapped before loads at once."
    : phase === "reading" ? `${found} companies found. Reading their funding rounds, investors and deals.`
    : null;
  return text ? <p className="status" role="status">{text}</p> : null;
}

/** Startups by HQ, investors and acquirers by their HQ when Cala knows it. */
function buildMarkers(peers: Peer[], map: MarketMap | null): GlobeMarker[] {
  const out: GlobeMarker[] = [];
  const add = (kind: MarkerKind, name: string, place?: string) => {
    const at = locate(place);
    if (!at) return;
    out.push({ id: `${kind}:${name}`, kind, name, place, at: jitter(at, name) });
  };
  for (const p of peers) if (!p.isTarget) add("startup", p.name, p.country);
  for (const i of map?.investors.list ?? []) add("investor", i.name, i.country);
  for (const a of map?.acquirers ?? []) add("acquirer", a.name, a.country);
  return out;
}

function PeersPreview({ peers }: { peers: Peer[] }) {
  return (
    <main className="results">
      <section className="panel wide" aria-labelledby="peers-h">
        <h2 id="peers-h">Who's already doing this</h2>
        <PeerTable peers={peers} />
      </section>
    </main>
  );
}

function PeerTable({ peers, showShare = false }: { peers: Peer[]; showShare?: boolean }) {
  const maxShare = Math.max(...peers.map((p) => p.share ?? 0), 0.0001);
  return (
    <div className="scroll">
      <table>
        <thead>
          <tr>
            <th>Company</th>
            <th className="num">Raised</th>
            {showShare && <th className="share-h">Share of capital</th>}
            <th>Last round</th>
            <th>HQ</th>
          </tr>
        </thead>
        <tbody>
          {peers.map((p) => (
            <tr key={p.name} id={p.isTarget ? undefined : anchor("startup", p.name)} tabIndex={-1} className={p.isTarget ? "target" : ""}>
              <td>
                <div className="name">
                  {!p.isTarget && <Glyph kind="startup" />}
                  <span>{p.name}{p.isTarget && " (you)"}</span>
                  <Sources sources={p.sources} />
                </div>
                {p.description && <div className="desc">{p.description}</div>}
              </td>
              <td className="num">{p.fundingEur !== undefined ? fmtEur(p.fundingEur) : "–"}</td>
              {showShare && (
                <td className="share-c">
                  <div className="share">
                    <div className="bar-track" aria-hidden><i style={{ width: `${((p.share ?? 0) / maxShare) * 100}%` }} /></div>
                    <span className="num">{p.share !== undefined ? pct(p.share) : "–"}</span>
                  </div>
                </td>
              )}
              <td>{p.lastRound ?? "–"}</td>
              <td>{p.country ?? "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MapView({ map }: { map: MarketMap }) {
  const target = map.peers.find((p) => p.isTarget);
  const found = map.peers.filter((p) => !p.isTarget).length;
  return (
    <main className="results">
      {map.mode === "demo" && <div className="banner">Demo mode: no Cala key is set, so every company, investor and number below is fictional.</div>}

      <section className="overview" aria-labelledby="overview-h">
        <h1 id="overview-h">{map.input.idea ?? map.target?.name}</h1>
        <p className="summary">{map.summary}</p>
        <dl className="figures">
          <div><dt>Companies found</dt><dd>{found}</dd></div>
          <div><dt>Known capital raised</dt><dd>{fmtEur(map.capital.totalEur)}</dd></div>
          <div><dt>Held by the top 3</dt><dd>{pct(map.capital.top3Share)}</dd></div>
          {target ? (
            <div><dt>Your share</dt><dd>{target.share !== undefined ? pct(target.share) : "–"}</dd></div>
          ) : (
            <div><dt>Rounds, last 2 years</dt><dd>{TREND[map.momentum.trend]}</dd></div>
          )}
        </dl>
      </section>

      <section className="panel wide" aria-labelledby="peers-h">
        <h2 id="peers-h">Who's already doing this</h2>
        <PeerTable peers={map.peers} showShare />
        <p className="note">Share of capital is each company's share of the money raised across this set. Revenue isn't public for private companies, so this is the proxy.</p>
      </section>

      <div className="pair">
        <section className="panel" aria-labelledby="money-h">
          <h2 id="money-h">Is money flowing in?</h2>
          <MomentumView m={map.momentum} />
        </section>

        <section className="panel" aria-labelledby="inv-h">
          <h2 id="inv-h">Who invests here</h2>
          {map.investors.list.length === 0 ? (
            <p className="note">Cala lists no investors for these companies yet.</p>
          ) : (
            <ul className="rows">
              {map.investors.list.slice(0, 8).map((i) => (
                <li key={i.name} id={anchor("investor", i.name)} tabIndex={-1}>
                  <div className="name"><Glyph kind="investor" /><span>{i.name}</span><Sources sources={i.sources} /></div>
                  <div className="desc">Backed {i.peers.join(", ")}{i.country ? ` · ${i.country}` : ""}</div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="pair">
        <section className="panel" aria-labelledby="gap-h">
          <h2 id="gap-h">Where you can stand out</h2>
          <div className="gaps">
            {map.standout.gaps.map((g, i) => (
              <article key={i}>
                <h3>{g.title}</h3>
                <p>{g.detail}</p>
                {g.peers.length > 0 && <p className="note">Based on {g.peers.join(", ")}</p>}
              </article>
            ))}
          </div>
          {map.standout.position.length > 0 && (
            <>
              <h3 className="sub">Your position</h3>
              {map.standout.position.map((m) => <PositionRow key={m.key} m={m} />)}
            </>
          )}
          <p className="note">{map.standout.generatedBy === "claude" ? "Written by Claude from the sourced facts on this page." : "Computed from the sourced facts on this page."}</p>
        </section>

        <section className="panel" aria-labelledby="acq-h">
          <h2 id="acq-h">How companies here end</h2>
          {map.acquirers.length === 0 ? (
            <p className="note">Cala shows no acquisitions around these companies yet.</p>
          ) : (
            <ul className="rows">{map.acquirers.map((a) => <AcquirerRow key={a.name} a={a} max={map.acquirers[0].score} />)}</ul>
          )}
        </section>
      </div>

      {map.warnings.length > 0 && (
        <details className="gaps-list">
          <summary>{map.warnings.length} data gap{map.warnings.length > 1 ? "s" : ""}</summary>
          <ul>{map.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </details>
      )}
    </main>
  );
}

const TREND: Record<Momentum["trend"], string> = { rising: "Rising", flat: "Flat", falling: "Falling", unknown: "Too little data" };
const CROWD: Record<Momentum["crowding"], string> = { crowded: "Crowded: a few leaders hold most of the capital", contested: "Contested: many funded players", open: "Open: few funded players", unknown: "Too few funded companies to judge crowding" };

function MomentumView({ m }: { m: Momentum }) {
  const W = 560, H = 180, pad = 24, gap = 28;
  const maxR = Math.max(1, ...m.years.map((y) => y.rounds));
  const slot = (W - gap * (m.years.length - 1)) / m.years.length;
  const bw = Math.min(64, slot);
  const yScale = (n: number) => ((H - pad * 2) * n) / maxR;
  return (
    <>
      <dl className="figures small">
        <div><dt>Rounds, last 2 years vs the 2 before</dt><dd>{TREND[m.trend]}</dd></div>
        <div><dt>Pre-seed or seed</dt><dd>{m.earlyShare !== undefined ? pct(m.earlyShare) : "–"}</dd></div>
      </dl>
      <div className="chart-key"><span><i className="sw early" />Pre-seed and seed</span><span><i className="sw later" />Series A and later</span></div>
      <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Funding rounds per year, split by stage">
        {m.years.map((y, i) => {
          const x = i * (slot + gap) + (slot - bw) / 2;
          const he = yScale(y.early), hl = yScale(y.later);
          const base = H - pad;
          const tip = `${y.year}: ${y.rounds} rounds (${y.early} early, ${y.later} later), ${fmtEur(y.capitalEur)}`;
          return (
            <g key={y.year}>
              <title>{tip}</title>
              <rect x={x} y={base} width={bw} height={2} className="baseline" />
              {he > 0 && <path d={bar(x, base - he, bw, he, hl === 0)} className="early" />}
              {hl > 0 && <path d={bar(x, base - he - hl - (he > 0 ? 2 : 0), bw, hl, true)} className="later" />}
              <text x={x + bw / 2} y={H - 4} className="tick">{y.year}</text>
              <text x={x + bw / 2} y={base - he - hl - (he && hl ? 2 : 0) - 8} className="val">{y.rounds}</text>
            </g>
          );
        })}
      </svg>
      <table className="sr-only">
        <caption>Funding rounds per year</caption>
        <thead><tr><th>Year</th><th>Early rounds</th><th>Later rounds</th><th>Capital</th></tr></thead>
        <tbody>{m.years.map((y) => <tr key={y.year}><td>{y.year}</td><td>{y.early}</td><td>{y.later}</td><td>{fmtEur(y.capitalEur)}</td></tr>)}</tbody>
      </table>
      <p className="note">{CROWD[m.crowding]}. The top 3 hold {pct(m.top3Share)} of the known capital. <Sources sources={m.sources} /></p>
    </>
  );
}

/** Bar segment with 3px rounded top corners only when it is the top of the stack. */
function bar(x: number, y: number, w: number, h: number, roundTop: boolean) {
  const r = roundTop ? Math.min(3, h, w / 2) : 0;
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

function PositionRow({ m }: { m: MoatSignal }) {
  const val = (v: number | string | undefined) => (v === undefined ? "–" : typeof v === "string" ? v : m.key === "capital" ? fmtEur(v) : String(Math.round(v)));
  return (
    <div className="moat">
      <div><b>{m.label}</b><div className="note">You: {val(m.target)}. Peer median: {val(m.peerMedian)}.</div></div>
      <span className={`verdict ${m.verdict}`}>{m.verdict === "unknown" ? "No data" : m.verdict[0].toUpperCase() + m.verdict.slice(1)}</span>
    </div>
  );
}

function AcquirerRow({ a, max }: { a: Acquirer; max: number }) {
  return (
    <li id={anchor("acquirer", a.name)} tabIndex={-1}>
      <div className="name">
        <Glyph kind="acquirer" />
        <span>{a.name}</span>
        <span className="strength" role="img" aria-label={`Evidence score ${a.score} of ${max}`}><i style={{ width: `${(a.score / max) * 100}%` }} /></span>
      </div>
      <ul className="evidence">{a.evidence.slice(0, 4).map((e, i) => <li key={i}>{e.text}<Sources sources={e.sources} /></li>)}</ul>
      {a.country && <div className="desc">{a.country}</div>}
    </li>
  );
}

function Sources({ sources }: { sources: Source[] }) {
  const uniq = sources.filter((s, i) => sources.findIndex((x) => (x.url ?? x.name) === (s.url ?? s.name)) === i).slice(0, 3);
  if (!uniq.length) return null;
  return (
    <span className="cites">
      {uniq.map((s, i) =>
        s.url ? (
          <a key={i} className="cite" href={s.url} target="_blank" rel="noreferrer" title={`${s.name}${s.date ? `, ${s.date}` : ""}`} aria-label={`Source: ${s.name}`}>{i + 1}</a>
        ) : (
          <span key={i} className="cite" title={s.name}>{i + 1}</span>
        ),
      )}
    </span>
  );
}

const pct = (x: number) => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;
