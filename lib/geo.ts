// Places Cala's HQ names on the globe. Cala returns a mix of countries ("Sweden"), regions
// ("Hérault", "Ontario", "Karnātaka") and cities ("Roma"), so regions and cities get their own
// coordinates and everything else falls back to the country's centroid from world-atlas.
import { geoCentroid } from "d3-geo";
import { feature } from "topojson-client";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import type { Topology, GeometryCollection } from "topojson-specification";
import countries110 from "world-atlas/countries-110m.json";

export type LonLat = [number, number];

const topo = countries110 as unknown as Topology<{ countries: GeometryCollection<{ name: string }>; land: GeometryCollection }>;
export const COUNTRIES = feature(topo, topo.objects.countries) as FeatureCollection<Geometry, { name: string }>;
export const LAND = feature(topo, topo.objects.land) as FeatureCollection | Feature;

const key = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// [lon, lat]. Regions, states and cities that Cala uses as HQ values, plus small countries that
// are missing from the 1:110m atlas.
const PLACES: Record<string, LonLat> = {
  // small countries and territories
  singapore: [103.8, 1.35], "hong kong": [114.17, 22.32], luxembourg: [6.13, 49.61], malta: [14.5, 35.9],
  monaco: [7.42, 43.74], liechtenstein: [9.55, 47.14], bahrain: [50.56, 26.07], mauritius: [57.55, -20.3],
  "cayman islands": [-81.25, 19.31], bermuda: [-64.75, 32.3], andorra: [1.52, 42.51], gibraltar: [-5.35, 36.14],
  // United States
  california: [-119.4, 36.8], "san francisco": [-122.42, 37.77], "new york": [-74.0, 40.71], massachusetts: [-71.4, 42.3],
  boston: [-71.06, 42.36], texas: [-99.0, 31.0], austin: [-97.74, 30.27], washington: [-120.7, 47.4], seattle: [-122.33, 47.61],
  delaware: [-75.5, 39.0], illinois: [-89.2, 40.0], chicago: [-87.63, 41.88], colorado: [-105.5, 39.0], florida: [-81.7, 28.1],
  georgia: [-83.4, 32.7], utah: [-111.7, 39.3], "district of columbia": [-77.04, 38.9],
  // Canada
  ontario: [-79.4, 43.7], toronto: [-79.38, 43.65], quebec: [-71.2, 46.8], montreal: [-73.57, 45.5],
  "british columbia": [-123.1, 49.28], vancouver: [-123.12, 49.28], alberta: [-114.07, 51.05],
  // Europe: regions and cities
  london: [-0.13, 51.51], england: [-1.5, 52.5], scotland: [-4.2, 56.5], edinburgh: [-3.19, 55.95],
  paris: [2.35, 48.86], "ile de france": [2.5, 48.7], herault: [3.5, 43.6], montpellier: [3.88, 43.61], lyon: [4.84, 45.76],
  "haute saone": [6.1, 47.6], "hauts de seine": [2.22, 48.85], "bas rhin": [7.6, 48.6], "auvergne rhone alpes": [4.8, 45.5],
  berlin: [13.4, 52.52], munich: [11.58, 48.14], bayern: [11.5, 48.8], bavaria: [11.5, 48.8], hamburg: [9.99, 53.55],
  "baden wurttemberg": [9.0, 48.6], "nordrhein westfalen": [7.5, 51.5], hessen: [9.0, 50.6], frankfurt: [8.68, 50.11],
  roma: [12.5, 41.9], rome: [12.5, 41.9], milano: [9.19, 45.46], milan: [9.19, 45.46], lombardia: [9.8, 45.6],
  madrid: [-3.7, 40.42], barcelona: [2.17, 41.39], catalonia: [1.8, 41.8], lisbon: [-9.14, 38.72],
  amsterdam: [4.9, 52.37], "noord holland": [4.9, 52.6], rotterdam: [4.48, 51.92], brussels: [4.35, 50.85],
  zurich: [8.54, 47.38], geneva: [6.14, 46.2], zug: [8.52, 47.17], vienna: [16.37, 48.21], wien: [16.37, 48.21],
  dublin: [-6.26, 53.35], copenhagen: [12.57, 55.68], oslo: [10.75, 59.91], stockholm: [18.07, 59.33],
  helsinki: [24.94, 60.17], uusimaa: [24.9, 60.3], espoo: [24.66, 60.21], tampere: [23.76, 61.5], oulu: [25.47, 65.01],
  harjumaa: [24.75, 59.4], tallinn: [24.75, 59.44], riga: [24.1, 56.95], vilnius: [25.28, 54.69], warsaw: [21.01, 52.23],
  prague: [14.42, 50.08], budapest: [19.04, 47.5], bucharest: [26.1, 44.43], athens: [23.73, 37.98],
  // Asia, Africa, Oceania, Latin America
  karnataka: [75.7, 15.3], bengaluru: [77.59, 12.97], bangalore: [77.59, 12.97], maharashtra: [75.7, 19.7], mumbai: [72.88, 19.08],
  delhi: [77.21, 28.61], haryana: [76.1, 29.1], gurgaon: [77.03, 28.46], telangana: [79.0, 17.9], "tamil nadu": [78.7, 11.1],
  "tel aviv": [34.78, 32.09], beijing: [116.4, 39.9], shanghai: [121.47, 31.23], shenzhen: [114.06, 22.54],
  tokyo: [139.69, 35.69], seoul: [126.98, 37.57], dubai: [55.27, 25.2], "abu dhabi": [54.37, 24.45], riyadh: [46.68, 24.71],
  lagos: [3.38, 6.52], nairobi: [36.82, -1.29], "cape town": [18.42, -33.92], johannesburg: [28.05, -26.2],
  "new south wales": [147.0, -32.0], sydney: [151.21, -33.87], victoria: [144.8, -37.0], melbourne: [144.96, -37.81],
  "sao paulo": [-46.63, -23.55], "mexico city": [-99.13, 19.43], "buenos aires": [-58.38, -34.6], bogota: [-74.07, 4.71],
};

// Spellings Cala uses that differ from world-atlas names.
const COUNTRY_ALIAS: Record<string, string> = {
  usa: "united states of america", us: "united states of america", "united states": "united states of america",
  uk: "united kingdom", "great britain": "united kingdom", "czech republic": "czechia", "south korea": "south korea",
  "republic of korea": "south korea", korea: "south korea", "russian federation": "russia", uae: "united arab emirates",
  holland: "netherlands", "the netherlands": "netherlands", "bosnia and herzegovina": "bosnia and herz",
  "dominican republic": "dominican rep", "ivory coast": "cote d ivoire", "central african republic": "central african rep",
};

let centroids: Map<string, LonLat> | undefined;
function countryCentroids() {
  if (centroids) return centroids;
  centroids = new Map();
  for (const f of COUNTRIES.features) centroids.set(key(f.properties.name), geoCentroid(f) as LonLat);
  // The US and France centroids fall far from where companies are; use their main hubs instead.
  centroids.set("united states of america", [-98.5, 39.5]);
  centroids.set("france", [2.4, 46.6]);
  centroids.set("norway", [9.5, 61.0]);
  return centroids;
}

/** Coordinates for a Cala HQ value, or undefined when the name is unknown. */
export function locate(place: string | undefined): LonLat | undefined {
  if (!place) return undefined;
  const k = key(place);
  if (!k) return undefined;
  if (PLACES[k]) return PLACES[k];
  const c = countryCentroids();
  return c.get(COUNTRY_ALIAS[k] ?? k) ?? c.get(k.replace(/^the /, ""));
}

/** A small deterministic offset so companies in one country don't sit on one pixel. */
export function jitter([lon, lat]: LonLat, seed: string, degrees = 1.6): LonLat {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const a = ((h >>> 0) % 3600) / 3600 * Math.PI * 2;
  const r = (((h >>> 12) % 1000) / 1000) * degrees;
  return [lon + Math.cos(a) * r, lat + Math.sin(a) * r * 0.7];
}

/** Centre of gravity of a set of points on the sphere, for flying the globe to a market. */
export function centreOf(points: LonLat[]): LonLat | undefined {
  if (!points.length) return undefined;
  let x = 0, y = 0, z = 0;
  for (const [lon, lat] of points) {
    const l = (lon * Math.PI) / 180, p = (lat * Math.PI) / 180;
    x += Math.cos(p) * Math.cos(l);
    y += Math.cos(p) * Math.sin(l);
    z += Math.sin(p);
  }
  const n = Math.hypot(x, y, z);
  if (n < 1e-6) return points[0];
  return [(Math.atan2(y, x) * 180) / Math.PI, (Math.asin(z / n) * 180) / Math.PI];
}
