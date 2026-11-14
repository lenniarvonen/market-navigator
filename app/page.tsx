"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { Acquirer, Investor, MarketMap, MoatSignal, Momentum, Peer, Source } from "@/lib/types";
import { fmtEur } from "@/lib/util";
import { centreOf, jitter, locate, type LonLat } from "@/lib/geo";
import { Glyph, KIND_LABEL, KIND_PLURAL, type GlobeControl, type GlobeLink, type GlobeMarker, type MarkerKind } from "./Globe";

// The globe measures its box and runs an animation loop, so it renders on the client only.
const Globe = dynamic(() => import("./Globe"), { ssr: false, loading: () => <div className="globe" /> });

const EXAMPLES = ["AI agents for customer support", "Carbon accounting for SMEs", "AI tools for dental clinics", "B2B payments for freelancers"];
const KINDS: MarkerKind[] = ["startup", "investor", "invention", "acquirer"];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const anchor = (kind: MarkerKind, name: string) => `e-${kind}-${slug(name)}`;

type Phase = "rest" | "finding" | "reading" | "done";

export default function Home() {
  const [idea, setIdea] = useState("");
  const [company, setCompany] = useState("");
  const [asked, setAsked] = useState({ idea: "", company: "" });
  const [map, setMap] = useState<MarketMap | null>(null);
  const [preview, setPreview] = useState<Peer[] | null>(null);
  const [err, setErr] = useState("");
  const [phase, setPhase] = useState<Phase>("rest");
  const [active, setActive] = useState<string | undefined>();
  const [selected, setSelected] = useState<string | undefined>();
  const [layers, setLayers] = useState<Record<MarkerKind, boolean>>({ startup: true, investor: true, invention: true, acquirer: true });
  const [inView, setInView] = useState<string[]>([]);
  const control = useRef<GlobeControl | null>(null);
  const loading = phase === "finding" || phase === "reading";

  async function run(i: string, c = company) {
    if (!i.trim() && !c.trim()) return;
    setIdea(i);
    setAsked({ idea: i.trim(), company: c.trim() });
    setErr("");
    setMap(null);
    setPreview(null);
    setSelected(undefined);
    setActive(undefined);
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
        setMap(pdata); // a saved or demo map answers with the full map
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
  const shown = useMemo(() => markers.filter((m) => m.kind === "you" || layers[m.kind]), [markers, layers]);
  const you = markers.find((m) => m.kind === "you");
  const sel = markers.find((m) => m.id === selected);
  const links = useMemo(() => {
    const ids = new Set(shown.map((m) => m.id));
    const out = buildLinks(markers, map).filter((l) => l.ends.every((e) => ids.has(e)));
    if (you && sel && sel.kind !== "you") out.push({ id: "you-link", kind: "you", from: you.at, to: sel.at, ends: [you.id, sel.id] });
    return out;
  }, [markers, map, shown, you, sel]);
  const home = useMemo<LonLat | undefined>(
    () => you?.at ?? centreOf(markers.filter((m) => m.kind === "startup").map((m) => m.at)),
    [markers, you],
  );
  const counts = useMemo(
    () => Object.fromEntries(KINDS.map((k) => [k, markers.filter((m) => m.kind === k).length])) as Record<MarkerKind, number>,
    [markers],
  );
  const startups = peers.filter((p) => !p.isTarget).length;
  const atRest = phase === "rest";

  // Open each map with its best-funded placed competitor selected, as a worked example.
  useEffect(() => {
    if (map && !selected) setSelected(markers.find((m) => m.kind === "startup")?.id);
  }, [map]); // eslint-disable-line react-hooks/exhaustive-deps

  const ids = useMemo(() => new Set(markers.map((m) => m.id)), [markers]);
  /** A report row was hovered or focused: light its marker and arcs. */
  const hover = (kind: MarkerKind, name?: string) => setActive(name && ids.has(`${kind}:${name}`) ? `${kind}:${name}` : undefined);
  /** A report row was clicked: select its marker and turn the globe to it. */
  const show = (kind: MarkerKind, name: string) => {
    const m = markers.find((x) => x.id === `${kind}:${name}`);
    if (m) choose(m);
  };
  const rows: RowEvents = { hover, show, active: active ?? selected };

  function choose(m: GlobeMarker) {
    if (m.kind === "you") return;
    setSelected(m.id);
    control.current?.flyTo(m.at);
  }

  function toReport(m: GlobeMarker) {
    if (m.kind === "you") return;
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
    setActive(undefined);
    setSelected(undefined);
  }

  const visible = inView.map((id) => markers.find((m) => m.id === id)).filter((m): m is GlobeMarker => !!m && m.kind !== "you");
  const title = asked.idea || asked.company || map?.input.idea || "";

  return (
    <>
      <header className="bar">
        <a className="wordmark" href="/" onClick={(e) => { e.preventDefault(); reset(); }}>
          <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden><circle cx="11" cy="11" r="9.25" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M1.75 11h18.5M11 1.75c2.7 2.5 3.9 5.6 3.9 9.25S13.7 17.75 11 20.25M11 1.75C8.3 4.25 7.1 7.35 7.1 11s1.2 6.75 3.9 9.25" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
          <span>Market Navigator</span>
        </a>
        {!atRest && (
          <form className="top-search" role="search" onSubmit={(e) => { e.preventDefault(); run(idea); }}>
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="m11 11 3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
            <label className="sr-only" htmlFor="top-q">Map another idea</label>
            <input id="top-q" value={idea} onChange={(e) => setIdea(e.target.value)} placeholder="Map another idea, e.g. payroll for restaurants" />
          </form>
        )}
        <div className="bar-end">
          {!atRest && asked.company && <span className="you-chip">Your startup · {asked.company}{you?.place ? ` · ${you.place}` : ""}</span>}
          {map && <span className="badge">{map.mode === "demo" ? "Sample data" : "Cala data"}</span>}
          {atRest && <span className="bar-note">Built on Cala&rsquo;s company graph</span>}
        </div>
      </header>

      <div className={atRest ? "hero" : "app"}>
        {!atRest && (
          <aside className="side" aria-label="Layers and companies in view">
            <h2 className="side-h">Layers</h2>
            <ul className="layers">
              {KINDS.map((k) => (
                <li key={k}>
                  <label className={`layer${counts[k] ? "" : " empty"}`}>
                    <Glyph kind={k} />
                    <span className="layer-name">{KIND_PLURAL[k]}</span>
                    <span className="layer-count">{counts[k]}</span>
                    <input type="checkbox" checked={layers[k]} disabled={!counts[k]} onChange={(e) => setLayers({ ...layers, [k]: e.target.checked })} />
                    <span className="check" aria-hidden />
                  </label>
                </li>
              ))}
            </ul>
            {startups > counts.startup && <p className="side-note">{startups - counts.startup} of {startups} competitors have no known HQ. They are in the report below, not on the globe.</p>}
            <div className="side-h row"><h2>In view</h2><span>{visible.length} of {shown.filter((m) => m.kind !== "you").length}</span></div>
            <ul className="inview">
              {visible.map((m) => (
                <li key={m.id}>
                  <button type="button" className={selected === m.id ? "sel" : ""} onClick={() => choose(m)} onMouseEnter={() => setActive(m.id)} onMouseLeave={() => setActive(undefined)}>
                    <Glyph kind={m.kind} />
                    <span className="iv-name">{m.name}</span>
                    <span className="iv-place">{m.place}</span>
                  </button>
                </li>
              ))}
            </ul>
          </aside>
        )}

        <section className="centre" aria-labelledby="map-h">
          {atRest ? (
            <div className="nav">
              <h1 id="map-h">Who&rsquo;s already building your idea?</h1>
              <p className="lede">Describe it in one line. Competitors, early investors and likely buyers light up on the globe. Every fact links to its source.</p>
              <form className="search" onSubmit={(e) => { e.preventDefault(); run(idea); }}>
                <label className="field idea">
                  <span className="sr-only">Your idea</span>
                  <input value={idea} onChange={(e) => setIdea(e.target.value)} placeholder="Your idea, e.g. payroll for restaurants" />
                </label>
                <label className="field company">
                  <span className="sr-only">Your company, optional</span>
                  <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Your company (optional)" />
                </label>
                <button className="go" disabled={loading}>Map my market</button>
              </form>
              <div className="examples">
                <span className="examples-h">Try</span>
                {EXAMPLES.map((x) => <button key={x} type="button" onClick={() => run(x, "")}>{x}</button>)}
              </div>
              {err && <p className="status error" role="alert">{err}</p>}
            </div>
          ) : (
            <div className="centre-head">
              <h1 id="map-h">{title}</h1>
              <p className="hint">Drag the globe to turn it. Select a marker for details.</p>
            </div>
          )}
          <div className="globe-box">
            <Globe
              markers={shown}
              links={links}
              active={active}
              selected={selected}
              focus={home}
              spin={atRest || phase === "finding"}
              control={control}
              onSelect={choose}
              onHover={setActive}
              onView={setInView}
            />
          </div>
          {!atRest && (
            <>
              <Status phase={phase} found={startups} err={err} />
              <div className="controls" role="group" aria-label="Globe controls">
                <div className="seg">
                  <button type="button" aria-label="Turn west" onClick={() => control.current?.turn(-30)}><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
                  <button type="button" aria-label="Turn east" onClick={() => control.current?.turn(30)}><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
                </div>
                <div className="seg">
                  <button type="button" aria-label="Zoom out" onClick={() => control.current?.zoom(0.8)}><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><path d="M3 8h10" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg></button>
                  <button type="button" aria-label="Zoom in" onClick={() => control.current?.zoom(1.25)}><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><path d="M3 8h10M8 3v10" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg></button>
                </div>
                <button type="button" className="seg solo" onClick={() => home && control.current?.flyTo(home)}>{you ? "Recenter on you" : "Recenter"}</button>
              </div>
            </>
          )}
        </section>

        {!atRest && (
          <aside className="detail" aria-label="Selected company" aria-live="polite">
            {sel && sel.kind !== "you" ? (
              <Detail m={sel} map={map} peers={peers} onCenter={() => control.current?.flyTo(sel.at)} onReport={() => toReport(sel)} />
            ) : (
              <div className="detail-empty">
                <p>{loading ? "Placing the companies on the globe." : "Select a marker or a name on the left to see who it is, how much it raised and who backed it."}</p>
              </div>
            )}
          </aside>
        )}
      </div>

      {preview && !map && <PeersPreview peers={preview} rows={rows} />}
      {map && <MapView map={map} rows={rows} />}

      <footer className="foot">
        <span>Company, funding, investor and deal data from Cala. Amounts in EUR at approximate rates.</span>
      </footer>
    </>
  );
}

/** The right-hand panel: what the selected marker is, in a few sourced facts. */
function Detail({ m, map, peers, onCenter, onReport }: { m: GlobeMarker; map: MarketMap | null; peers: Peer[]; onCenter: () => void; onReport: () => void }) {
  const kind = m.kind as MarkerKind;
  let rows: [string, string][] = [];
  let about: string | undefined;
  let why: string | undefined;
  let sources: Source[] = [];
  if (kind === "startup") {
    const p = peers.find((x) => x.name === m.name);
    about = p?.description;
    sources = p?.sources ?? [];
    const backers = map?.investors.list.filter((i) => i.peers.includes(m.name)).map((i) => i.name) ?? [];
    rows = [
      ["Raised", p?.fundingEur !== undefined ? fmtEur(p.fundingEur) : "Unknown"],
      ...(p?.share !== undefined ? [["Share of capital", pct(p.share)] as [string, string]] : []),
      ["Last round", p?.lastRound ?? "Unknown"],
      ...(p?.foundedYear ? [["Founded", String(p.foundedYear)] as [string, string]] : []),
      ...(p?.employees ? [["Team", teamBand(p.employees)] as [string, string]] : []),
      ...(backers.length ? [["Backed by", backers.slice(0, 3).join(", ")] as [string, string]] : []),
    ];
    const gap = map?.standout.gaps.find((g) => g.peers.includes(m.name));
    why = gap ? `${gap.title}. ${gap.detail.split(/(?<=[.!?])\s+(?=[A-Z])/)[0]}` : undefined;
  } else if (kind === "investor") {
    const i: Investor | undefined = map?.investors.list.find((x) => x.name === m.name);
    sources = i?.sources ?? [];
    rows = [
      ["Backed here", i?.peers.join(", ") ?? "Unknown"],
      ["Rounds joined", String(i?.rounds ?? 0)],
    ];
    if (i) why = `Has backed ${i.peers.length === 1 ? "one company" : `${i.peers.length} companies`} in this space, so it already knows the market you would pitch.`;
  } else if (kind === "acquirer") {
    const a: Acquirer | undefined = map?.acquirers.find((x) => x.name === m.name);
    sources = a?.evidence.flatMap((e) => e.sources) ?? [];
    rows = (a?.evidence ?? []).slice(0, 4).map((e, n) => [n === 0 ? "Evidence" : "", e.text]);
  }
  return (
    <div className="detail-body">
      <p className={`kicker ${kind}`}><Glyph kind={kind} size={12} />{KIND_LABEL[kind]}</p>
      <h2 className="detail-name">{m.name}</h2>
      {m.place && <p className="detail-place">{m.place}</p>}
      {about && <p className="detail-about">{about}</p>}
      <dl className="facts">
        {rows.map(([k, v], n) => <div key={n}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
      {sources.length > 0 && <p className="detail-src">Sources <Sources sources={sources} /></p>}
      {why && (
        <div className="why">
          <h3>Why it matters to you</h3>
          <p>{why}</p>
        </div>
      )}
      <div className="actions">
        <button type="button" className="btn primary" onClick={onReport}>Show in the report</button>
        <button type="button" className="btn" onClick={onCenter}>Center on globe</button>
      </div>
    </div>
  );
}

const teamBand = (n: number) => (n <= 10 ? "1–10" : n <= 25 ? "11–25" : n <= 50 ? "26–50" : n <= 200 ? "51–200" : n <= 1000 ? "201–1,000" : "1,000+");

type RowEvents = { hover: (kind: MarkerKind, name?: string) => void; show: (kind: MarkerKind, name: string) => void; active?: string };
/** Hover, focus and click wiring for a report row that has a marker on the globe. */
const rowProps = (r: RowEvents, kind: MarkerKind, name: string) => ({
  onMouseEnter: () => r.hover(kind, name),
  onMouseLeave: () => r.hover(kind),
  onFocus: () => r.hover(kind, name),
  onBlur: () => r.hover(kind),
  onClick: () => r.show(kind, name),
  "data-on": r.active === `${kind}:${name}` || undefined,
});

function Status({ phase, found, err }: { phase: Phase; found: number; err: string }) {
  if (err) return <p className="status error" role="alert">{err}</p>;
  const text =
    phase === "finding" ? "Finding who's already building this. A new idea takes about a minute; one mapped before loads at once."
    : phase === "reading" ? `${found} companies found. Reading their funding rounds, investors and deals.`
    : null;
  return text ? <p className="status" role="status">{text}</p> : null;
}

/** Competitors by HQ, investors and acquirers by their HQ when Cala knows it, and you. */
function buildMarkers(peers: Peer[], map: MarketMap | null): GlobeMarker[] {
  const out: GlobeMarker[] = [];
  const add = (kind: GlobeMarker["kind"], name: string, place?: string) => {
    const at = locate(place);
    if (!at) return;
    const shown = place?.replace(/, City of$/i, ""); // "London, City of" reads as London
    out.push({ id: `${kind}:${name}`, kind, name, place: shown, at: kind === "you" ? at : jitter(at, name) });
  };
  const sorted = [...peers].sort((a, b) => (b.fundingEur ?? -1) - (a.fundingEur ?? -1));
  for (const p of sorted) add(p.isTarget ? "you" : "startup", p.name, p.country);
  for (const i of map?.investors.list ?? []) add("investor", i.name, i.country);
  for (const a of map?.acquirers ?? []) add("acquirer", a.name, a.country);
  return out;
}

/** Investor to each startup it backed; acquirer to each startup its evidence names. */
function buildLinks(markers: GlobeMarker[], map: MarketMap | null): GlobeLink[] {
  if (!map) return [];
  const at = new Map(markers.map((m) => [m.id, m.at]));
  const out: GlobeLink[] = [];
  const link = (kind: "investor" | "acquirer", from: string, peer: string) => {
    const a = at.get(`${kind}:${from}`), b = at.get(`startup:${peer}`);
    if (a && b) out.push({ id: `${kind}:${from}>${peer}`, kind, from: a, to: b, ends: [`${kind}:${from}`, `startup:${peer}`] });
  };
  for (const i of map.investors.list) for (const p of i.peers) link("investor", i.name, p);
  for (const a of map.acquirers)
    for (const p of map.peers) if (a.evidence.some((e) => e.text.includes(p.name))) link("acquirer", a.name, p.name);
  return out;
}

function PeersPreview({ peers, rows }: { peers: Peer[]; rows: RowEvents }) {
  return (
    <main className="results">
      <section className="panel" aria-labelledby="peers-h">
        <h2 id="peers-h"><span className="step">1</span>Who&rsquo;s already doing this</h2>
        <PeerTable peers={peers} rows={rows} />
      </section>
    </main>
  );
}

function PeerTable({ peers, rows, showShare = false }: { peers: Peer[]; rows: RowEvents; showShare?: boolean }) {
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
            <th className="hq">HQ</th>
          </tr>
        </thead>
        <tbody>
          {peers.map((p) => (
            <tr key={p.name} id={p.isTarget ? undefined : anchor("startup", p.name)} tabIndex={-1} className={p.isTarget ? "target" : ""} {...(p.isTarget ? {} : rowProps(rows, "startup", p.name))}>
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
              <td className="hq">{p.country ?? "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MapView({ map, rows }: { map: MarketMap; rows: RowEvents }) {
  const target = map.peers.find((p) => p.isTarget);
  const found = map.peers.filter((p) => !p.isTarget).length;
  return (
    <main className="results">
      {map.mode === "demo" && <div className="banner">Demo mode: no Cala key is set, so every company, investor and number below is fictional.</div>}

      <section className="overview" aria-labelledby="overview-h">
        <p className="eyebrow">The report</p>
        <h2 id="overview-h">What the data says</h2>
        <Summary text={map.summary} />
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

      <section className="panel" aria-labelledby="peers-h">
        <h2 id="peers-h"><span className="step">1</span>Who&rsquo;s already doing this</h2>
        <PeerTable peers={map.peers} rows={rows} showShare />
        <p className="note">Share of capital is each company's share of the money raised across this set. Revenue isn't public for private companies, so this is the proxy.</p>
      </section>

      <div className="pair">
        <section className="panel" aria-labelledby="money-h">
          <h2 id="money-h"><span className="step">2</span>Is money flowing in?</h2>
          <MomentumView m={map.momentum} />
        </section>

        <section className="panel" aria-labelledby="inv-h">
          <h2 id="inv-h"><span className="step">3</span>Who invests here</h2>
          {map.investors.list.length === 0 ? (
            <p className="note">Cala lists no investors for these companies yet.</p>
          ) : (
            <ul className="rows">
              {map.investors.list.slice(0, 8).map((i) => (
                <li key={i.name} id={anchor("investor", i.name)} tabIndex={-1} {...rowProps(rows, "investor", i.name)}>
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
          <h2 id="gap-h"><span className="step">4</span>Where you can stand out</h2>
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
          <h2 id="acq-h"><span className="step">5</span>How companies here end</h2>
          {map.acquirers.length === 0 ? (
            <p className="note">Cala shows no acquisitions around these companies yet.</p>
          ) : (
            <ul className="rows">{map.acquirers.map((a) => <AcquirerRow key={a.name} a={a} rows={rows} />)}</ul>
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

function AcquirerRow({ a, rows }: { a: Acquirer; rows: RowEvents }) {
  return (
    <li id={anchor("acquirer", a.name)} tabIndex={-1} {...rowProps(rows, "acquirer", a.name)}>
      <div className="name">
        <Glyph kind="acquirer" />
        <span>{a.name}</span>
      </div>
      <ul className="evidence">{a.evidence.slice(0, 4).map((e, i) => <li key={i}>{e.text}<Sources sources={e.sources} /></li>)}</ul>
      {a.country && <div className="desc">{a.country}</div>}
    </li>
  );
}

/** The summary, two sentences at first; the rest one click away. */
function Summary({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const parts = text.split(/(?<=[.!?])\s+(?=[A-Z"“])/);
  const short = parts.slice(0, 2).join(" ");
  const more = parts.length > 2;
  return (
    <p className="summary">
      {open || !more ? text : short}
      {more && <> <button type="button" className="more" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Show less" : "Read all"}</button></>}
    </p>
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
