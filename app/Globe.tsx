"use client";

// A draggable orthographic globe with one marker per entity. Flat land on a midnight sea, no glow:
// the markers are the only colour on it. Drag (or arrow keys) to turn it; it turns slowly on its
// own at rest unless the visitor prefers reduced motion.
import { useEffect, useRef } from "react";
import { geoDistance, geoOrthographic, geoPath } from "d3-geo";
import { LAND, type LonLat } from "@/lib/geo";

export type MarkerKind = "startup" | "invention" | "investor" | "acquirer";
export type GlobeMarker = { id: string; kind: MarkerKind; name: string; place?: string; at: LonLat };

export const KIND_LABEL: Record<MarkerKind, string> = {
  startup: "Startup",
  invention: "Invention",
  investor: "Investor",
  acquirer: "Acquirer",
};

/** One glyph per kind, used on the globe, in the legend and next to names in the sections. */
export function Glyph({ kind, size = 14 }: { kind: MarkerKind; size?: number }) {
  const common = { className: `glyph ${kind}`, width: size, height: size, viewBox: "0 0 16 16", "aria-hidden": true } as const;
  switch (kind) {
    case "startup":
      return <svg {...common}><circle cx="8" cy="8" r="5.5" /></svg>;
    case "investor":
      return <svg {...common}><rect x="3" y="3" width="10" height="10" rx="1.5" /></svg>;
    case "acquirer":
      return <svg {...common}><path d="M8 2.5 14 13.5H2Z" /></svg>;
    case "invention":
      return <svg {...common}><path d="M8 1.8 14.2 8 8 14.2 1.8 8Z" /></svg>;
  }
}

type Props = {
  markers: GlobeMarker[];
  /** Turn the globe to this point (changes when a new map arrives). */
  focus?: LonLat;
  /** Slow turn at rest. */
  spin: boolean;
  onSelect?: (m: GlobeMarker) => void;
};

const SPIN_DEG_PER_MS = 0.004;
const FLY_MS = 1400;

export default function Globe({ markers, focus, spin, onSelect }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const sea = useRef<SVGCircleElement>(null);
  const land = useRef<SVGPathElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const pins = useRef(new Map<string, HTMLButtonElement>());
  const st = useRef({
    rot: [-15, -35, 0] as [number, number, number], // starts over the Nordics
    size: 0,
    dragging: false,
    last: [0, 0] as [number, number],
    idleUntil: 0,
    fly: undefined as undefined | { from: [number, number]; to: [number, number]; t0: number },
    dirty: true,
    reduced: false,
    spin,
    markers,
  });
  st.current.spin = spin;
  st.current.markers = markers;
  st.current.dirty = true;

  // Fly to a new focus point.
  useEffect(() => {
    if (!focus) return;
    const s = st.current;
    const to: [number, number] = [-focus[0], Math.max(-60, Math.min(60, -focus[1]))];
    if (s.reduced) {
      s.rot = [to[0], to[1], 0];
      s.dirty = true;
      return;
    }
    // Take the short way round.
    let from0 = s.rot[0];
    while (from0 - to[0] > 180) from0 -= 360;
    while (to[0] - from0 > 180) from0 += 360;
    s.fly = { from: [from0, s.rot[1]], to, t0: performance.now() };
  }, [focus?.[0], focus?.[1]]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const s = st.current;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    s.reduced = mq.matches;
    const onMq = () => (s.reduced = mq.matches);
    mq.addEventListener("change", onMq);

    const projection = geoOrthographic().clipAngle(90).precision(0.4);
    const path = geoPath(projection);

    const ro = new ResizeObserver(([e]) => {
      s.size = e.contentRect.width;
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
      if (s.dirty && s.size > 0) {
        s.dirty = false;
        const r = s.size / 2;
        projection.scale(r - 1).translate([r, r]).rotate(s.rot);
        sea.current?.setAttribute("r", String(r - 1));
        sea.current?.setAttribute("cx", String(r));
        sea.current?.setAttribute("cy", String(r));
        land.current?.setAttribute("d", path(LAND as Parameters<typeof path>[0]) ?? "");
        const centre: [number, number] = [-s.rot[0], -s.rot[1]];
        for (const m of s.markers) {
          const el = pins.current.get(m.id);
          if (!el) continue;
          const front = geoDistance(m.at, centre) < Math.PI / 2 - 0.03;
          const p = projection(m.at);
          if (!front || !p) {
            el.style.visibility = "hidden";
            continue;
          }
          el.style.visibility = "visible";
          el.style.transform = `translate(${p[0]}px, ${p[1]}px)`;
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

  const turn = (dx: number, dy: number) => {
    const s = st.current;
    const k = 180 / Math.max(200, s.size); // a drag across the globe turns it about 180 degrees
    s.rot = [s.rot[0] + dx * k, Math.max(-80, Math.min(80, s.rot[1] - dy * k)), 0];
    s.fly = undefined;
    s.idleUntil = performance.now() + 5000;
    s.dirty = true;
  };

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
        <path ref={land} className="land" />
      </svg>
      <div className="pins">
        {markers.map((m) => (
          <button
            key={m.id}
            type="button"
            className={`pin ${m.kind}`}
            ref={(el) => {
              if (el) pins.current.set(m.id, el);
              else pins.current.delete(m.id);
            }}
            style={{ visibility: "hidden" }}
            aria-label={`${KIND_LABEL[m.kind]}: ${m.name}${m.place ? `, ${m.place}` : ""}`}
            onClick={() => onSelect?.(m)}
          >
            <Glyph kind={m.kind} />
            <span className="tip" role="presentation">
              {m.name}
              <small>{KIND_LABEL[m.kind]}{m.place ? ` · ${m.place}` : ""}</small>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
