"use client";

// A draggable orthographic globe: coastlines drawn as thin light lines on a midnight sea, one
// marker per entity. Drag, arrow keys or the controls turn it; it turns slowly on its own at rest
// unless the visitor prefers reduced motion.
import { useEffect, useRef, type MutableRefObject } from "react";
import { geoDistance, geoGraticule10, geoOrthographic, geoPath } from "d3-geo";
import { LAND, type LonLat } from "@/lib/geo";

export type MarkerKind = "startup" | "investor" | "invention" | "acquirer";
export type GlobeMarker = { id: string; kind: MarkerKind | "you"; name: string; place?: string; at: LonLat };
/** A connection drawn as a great-circle arc between two markers. */
export type GlobeLink = { id: string; kind: "investor" | "acquirer" | "you"; from: LonLat; to: LonLat; ends: [string, string] };
/** Imperative controls for the buttons under the globe. */
export type GlobeControl = { turn: (deg: number) => void; zoom: (by: number) => void; flyTo: (at: LonLat) => void };

export const KIND_LABEL: Record<MarkerKind, string> = {
  startup: "Competitor",
  investor: "Early investor",
  invention: "Innovation",
  acquirer: "Potential acquirer",
};
export const KIND_PLURAL: Record<MarkerKind, string> = {
  startup: "Competitors",
  investor: "Early investors",
  invention: "Innovations",
  acquirer: "Potential acquirers",
};

/** One glyph per kind, used on the globe, in the layer list and next to names in the report. */
export function Glyph({ kind, size = 14 }: { kind: MarkerKind | "you"; size?: number }) {
  const common = { className: `glyph ${kind}`, width: size, height: size, viewBox: "0 0 16 16", "aria-hidden": true } as const;
  switch (kind) {
    case "startup":
      return <svg {...common}><circle cx="8" cy="8" r="5.5" /></svg>;
    case "investor":
      return <svg {...common}><path d="M8 1.8 14.2 8 8 14.2 1.8 8Z" /></svg>;
    case "acquirer":
      return <svg {...common}><rect x="2.75" y="2.75" width="10.5" height="10.5" rx="1.5" /></svg>;
    case "invention":
      return <svg {...common}><path d="M8 2.2 14.2 13.3H1.8Z" /></svg>;
    case "you":
      return <svg {...common}><circle cx="8" cy="8" r="5" /></svg>;
  }
}

type Props = {
  markers: GlobeMarker[];
  links?: GlobeLink[];
  /** Marker id lit by a hover elsewhere on the page. */
  active?: string;
  /** Marker id shown as selected (ring and name). */
  selected?: string;
  /** Turn the globe to this point when it changes. */
  focus?: LonLat;
  /** Slow turn at rest. */
  spin: boolean;
  control?: MutableRefObject<GlobeControl | null>;
  onSelect?: (m: GlobeMarker) => void;
  onHover?: (id?: string) => void;
  /** Ids of the markers on the visible face, reported when the set changes. */
  onView?: (ids: string[]) => void;
};

const SPIN_DEG_PER_MS = 0.004;
const FLY_MS = 1200;

export default function Globe({ markers, links = [], active, selected, focus, spin, control, onSelect, onHover, onView }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const sea = useRef<SVGCircleElement>(null);
  const rim = useRef<SVGCircleElement>(null);
  const land = useRef<SVGPathElement>(null);
  const grid = useRef<SVGPathElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const pins = useRef(new Map<string, HTMLButtonElement>());
  const arcs = useRef(new Map<string, SVGPathElement>());
  const st = useRef({
    rot: [-15, -35, 0] as [number, number, number], // starts over the Nordics
    zoom: 1,
    size: 0,
    dragging: false,
    last: [0, 0] as [number, number],
    idleUntil: 0,
    fly: undefined as undefined | { from: [number, number]; to: [number, number]; t0: number },
    dirty: true,
    reduced: false,
    spin,
    markers,
    links,
    view: "",
    onView,
  });
  st.current.spin = spin;
  st.current.markers = markers;
  st.current.links = links;
  st.current.onView = onView;
  st.current.dirty = true;

  const flyTo = (at: LonLat) => {
    const s = st.current;
    const to: [number, number] = [-at[0], Math.max(-60, Math.min(60, -at[1]))];
    s.idleUntil = performance.now() + 8000;
    if (s.reduced) {
      s.rot = [to[0], to[1], 0];
      s.dirty = true;
      return;
    }
    let from0 = s.rot[0]; // take the short way round
    while (from0 - to[0] > 180) from0 -= 360;
    while (to[0] - from0 > 180) from0 += 360;
    s.fly = { from: [from0, s.rot[1]], to, t0: performance.now() };
  };

  const turn = (dx: number, dy: number) => {
    const s = st.current;
    const k = 180 / Math.max(200, s.size * s.zoom); // a drag across the globe turns it about 180 degrees
    s.rot = [s.rot[0] + dx * k, Math.max(-80, Math.min(80, s.rot[1] - dy * k)), 0];
    s.fly = undefined;
    s.idleUntil = performance.now() + 8000;
    s.dirty = true;
  };

  if (control)
    control.current = {
      turn: (deg) => {
        const s = st.current;
        flyTo([-(s.rot[0] + deg), -s.rot[1]]);
      },
      zoom: (by) => {
        const s = st.current;
        s.zoom = Math.max(1, Math.min(3.2, s.zoom * by));
        s.dirty = true;
      },
      flyTo,
    };

  useEffect(() => {
    if (focus) flyTo(focus);
  }, [focus?.[0], focus?.[1]]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const s = st.current;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    s.reduced = mq.matches;
    const onMq = () => (s.reduced = mq.matches);
    mq.addEventListener("change", onMq);

    const projection = geoOrthographic().clipAngle(90).precision(0.4);
    const path = geoPath(projection);
    const graticule = geoGraticule10();

    const ro = new ResizeObserver(([e]) => {
      s.size = Math.min(e.contentRect.width, e.contentRect.height);
      s.dirty = true;
    });
    if (wrap.current) ro.observe(wrap.current);

    let raf = 0;
    let prev = performance.now();
    const frame = (now: number) => {
      const dt = Math.min(64, now - prev);
      prev = now;
      if (s.fly) {
        const t = Math.min(1, (now - s.fly.t0) / FLY_MS);
        const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; // ease in-out cubic
        s.rot = [s.fly.from[0] + (s.fly.to[0] - s.fly.from[0]) * e, s.fly.from[1] + (s.fly.to[1] - s.fly.from[1]) * e, 0];
        if (t >= 1) s.fly = undefined;
        s.dirty = true;
      } else if (s.spin && !s.reduced && !s.dragging && now > s.idleUntil) {
        s.rot = [s.rot[0] + dt * SPIN_DEG_PER_MS, s.rot[1], 0];
        s.dirty = true;
      }
      if (s.dirty && s.size > 0 && wrap.current) {
        s.dirty = false;
        const w = wrap.current.clientWidth, h = wrap.current.clientHeight;
        const r = (s.size / 2 - 2) * s.zoom;
        projection.scale(r).translate([w / 2, h / 2]).rotate(s.rot);
        for (const c of [sea.current, rim.current]) {
          c?.setAttribute("r", String(r));
          c?.setAttribute("cx", String(w / 2));
          c?.setAttribute("cy", String(h / 2));
        }
        land.current?.setAttribute("d", path(LAND as Parameters<typeof path>[0]) ?? "");
        grid.current?.setAttribute("d", path(graticule) ?? "");
        for (const l of s.links) arcs.current.get(l.id)?.setAttribute("d", path({ type: "LineString", coordinates: [l.from, l.to] }) ?? "");
        const centre: [number, number] = [-s.rot[0], -s.rot[1]];
        const seen: string[] = [];
        for (const m of s.markers) {
          const el = pins.current.get(m.id);
          if (!el) continue;
          const front = geoDistance(m.at, centre) < Math.PI / 2 - 0.03;
          const p = projection(m.at);
          const inside = p && p[0] > -8 && p[0] < w + 8 && p[1] > -8 && p[1] < h + 8;
          if (!front || !p || !inside) {
            el.style.visibility = "hidden";
            continue;
          }
          seen.push(m.id);
          el.style.visibility = "visible";
          el.style.transform = `translate(${p[0]}px, ${p[1]}px)`;
        }
        const key = seen.join("|");
        if (key !== s.view) {
          s.view = key;
          s.onView?.(seen);
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      mq.removeEventListener("change", onMq);
    };
  }, []);

  const lit = active ?? selected;
  return (
    <div className="globe" ref={wrap}>
      <svg
        ref={svg}
        className="globe-svg"
        role="img"
        aria-label="Globe. Drag or use the arrow keys to turn it."
        tabIndex={0}
        onPointerDown={(e) => {
          st.current.dragging = true;
          st.current.last = [e.clientX, e.clientY];
          svg.current?.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const s = st.current;
          if (!s.dragging) return;
          turn(e.clientX - s.last[0], e.clientY - s.last[1]);
          s.last = [e.clientX, e.clientY];
        }}
        onPointerUp={(e) => {
          st.current.dragging = false;
          svg.current?.releasePointerCapture(e.pointerId);
        }}
        onPointerCancel={() => (st.current.dragging = false)}
        onKeyDown={(e) => {
          const step = 24;
          const d = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
          if (d) {
            e.preventDefault();
            turn(d[0], d[1]);
          }
        }}
      >
        <circle ref={sea} className="sea" />
        <path ref={grid} className="graticule" />
        <path ref={land} className="land" />
        <circle ref={rim} className="rim" />
        {links.map((l) => (
          <path
            key={l.id}
            className={`arc ${l.kind}${lit && l.ends.includes(lit) ? " on" : ""}${lit && !l.ends.includes(lit) && l.kind !== "you" ? " off" : ""}`}
            ref={(el) => {
              if (el) arcs.current.set(l.id, el);
              else arcs.current.delete(l.id);
            }}
          />
        ))}
      </svg>
      <div className="pins">
        {markers.map((m) => {
          const named = m.kind === "you" || selected === m.id;
          return (
            <button
              key={m.id}
              type="button"
              className={`pin ${m.kind}${active === m.id ? " on" : ""}${selected === m.id ? " sel" : ""}`}
              ref={(el) => {
                if (el) pins.current.set(m.id, el);
                else pins.current.delete(m.id);
              }}
              style={{ visibility: "hidden" }}
              aria-label={`${m.kind === "you" ? "You" : KIND_LABEL[m.kind]}: ${m.name}${m.place ? `, ${m.place}` : ""}`}
              aria-pressed={m.kind === "you" ? undefined : selected === m.id}
              onClick={() => onSelect?.(m)}
              onMouseEnter={() => onHover?.(m.id)}
              onMouseLeave={() => onHover?.(undefined)}
              onFocus={() => onHover?.(m.id)}
              onBlur={() => onHover?.(undefined)}
            >
              <Glyph kind={m.kind} />
              {named ? (
                <span className="chip" aria-hidden>{m.kind === "you" ? "You" : m.name}</span>
              ) : (
                <span className="tip" role="presentation">
                  {m.name}
                  <small>{KIND_LABEL[m.kind as MarkerKind]}{m.place ? ` · ${m.place}` : ""}</small>
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
