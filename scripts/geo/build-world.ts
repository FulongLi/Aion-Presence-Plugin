import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../lib/pluginPackage";

/**
 * Builds src/host/geo/world-data.json, Aion's small offline world, from Natural Earth (public domain,
 * https://www.naturalearthdata.com, via github.com/nvkelso/natural-earth-vector/tree/master/geojson):
 *
 *   ne_50m_admin_0_countries.geojson        every country: outline, names (incl. Chinese), continent, region
 *   ne_50m_admin_0_map_units.geojson        the parts people ask for by name: Scotland, England, Wales, Svalbard…
 *   ne_50m_populated_places_simple.geojson  about 1,250 cities and towns, for instant, offline markers
 *
 *   npx tsx scripts/geo/build-world.ts <directory with those three files>
 *
 * Outlines are simplified (Douglas–Peucker, 0.012°), quantised to 0.01° (about a kilometre) and delta-encoded.
 * The downloaded files themselves are not part of the repository; this file and the output are.
 */
const dir = process.argv[2];
if (!dir) { console.error("usage: build-world.ts <natural-earth-geojson-dir>"); process.exit(1); }
const read = (name: string) => JSON.parse(readFileSync(join(dir, `${name}.geojson`), "utf8")) as { features: Feature[] };
interface Feature { properties: Record<string, string | number | null>; geometry: { type: string; coordinates: unknown } }
type Ring = [number, number][];

const TOLERANCE = 0.012, QUANTUM = 100;

function simplify(ring: Ring, tolerance: number): Ring {
  if (ring.length <= 4) return ring;
  const keep = new Uint8Array(ring.length);
  keep[0] = keep[ring.length - 1] = 1;
  const stack: [number, number][] = [[0, ring.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = ring[a], [bx, by] = ring[b];
    const dx = bx - ax, dy = by - ay, length = Math.hypot(dx, dy);
    let worst = -1, index = -1;
    for (let i = a + 1; i < b; i++) {
      // A closed ring starts and ends on the same point: there the distance is to that point.
      const distance = length < 1e-12 ? Math.hypot(ring[i][0] - ax, ring[i][1] - ay) : Math.abs((ring[i][0] - ax) * dy - (ring[i][1] - ay) * dx) / length;
      if (distance > worst) { worst = distance; index = i; }
    }
    if (worst > tolerance) { keep[index] = 1; stack.push([a, index], [index, b]); }
  }
  return ring.filter((_, i) => keep[i]);
}

/** A ring as integers: the first point absolute, then deltas, in hundredths of a degree. Tiny islands survive as at least a triangle. */
function encode(ring: Ring): number[] | null {
  let points = simplify(ring, TOLERANCE).map(([x, y]) => [Math.round(x * QUANTUM), Math.round(y * QUANTUM)] as [number, number]);
  points = points.filter((p, i) => i === 0 || p[0] !== points[i - 1][0] || p[1] !== points[i - 1][1]);
  if (points.length > 1 && points[0][0] === points[points.length - 1][0] && points[0][1] === points[points.length - 1][1]) points.pop();
  if (points.length < 3) {
    const raw = ring.map(([x, y]) => [Math.round(x * QUANTUM), Math.round(y * QUANTUM)] as [number, number]);
    const unique = raw.filter((p, i) => raw.findIndex(q => q[0] === p[0] && q[1] === p[1]) === i);
    if (unique.length < 3) return null;
    points = unique.slice(0, Math.max(3, Math.min(unique.length, 8)));
  }
  const out: number[] = [points[0][0], points[0][1]];
  for (let i = 1; i < points.length; i++) out.push(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return out;
}

function polygons(geometry: Feature["geometry"]): number[][][] {
  const list = geometry.type === "Polygon" ? [geometry.coordinates as Ring[]] : geometry.type === "MultiPolygon" ? geometry.coordinates as Ring[][] : [];
  return list.map(polygon => polygon.map(encode).filter((ring): ring is number[] => ring !== null)).filter(polygon => polygon.length > 0);
}

const text = (value: unknown) => typeof value === "string" && value.trim() && value !== "-99" ? value.trim() : undefined;
const unique = (values: (string | undefined)[]) => [...new Set(values.filter((value): value is string => !!value))];

const countries = read("ne_50m_admin_0_countries").features.map(feature => {
  const p = feature.properties;
  return {
    id: String(p.ADM0_A3),
    name: text(p.NAME) ?? String(p.ADMIN),
    names: unique([text(p.ADMIN), text(p.NAME_LONG), text(p.FORMAL_EN), text(p.NAME_EN), text(p.NAME_ALT), text(p.ABBREV), text(p.BRK_NAME), text(p.GEOUNIT), text(p.SUBUNIT)])
      .filter(name => name !== text(p.NAME)),
    zh: unique([text(p.NAME_ZH), text(p.NAME_ZHT)]),
    codes: unique([text(p.ISO_A2_EH), text(p.ISO_A3_EH), text(p.ADM0_A3)]),
    continent: String(p.CONTINENT), subregion: String(p.SUBREGION),
    label: [Number(p.LABEL_X), Number(p.LABEL_Y)],
    polygons: polygons(feature.geometry),
  };
});
const known = new Set(countries.map(country => country.name));
const units = read("ne_50m_admin_0_map_units").features
  .filter(feature => feature.properties.GEOUNIT !== feature.properties.ADMIN && !known.has(String(feature.properties.NAME)))
  .map(feature => {
    const p = feature.properties;
    return {
      id: `${p.ADM0_A3}.${String(p.GU_A3)}`,
      name: text(p.GEOUNIT) ?? String(p.NAME),
      names: unique([text(p.NAME), text(p.NAME_LONG), text(p.NAME_EN), text(p.BRK_NAME)]).filter(name => name !== text(p.GEOUNIT)),
      zh: unique([text(p.NAME_ZH), text(p.NAME_ZHT)]),
      codes: [] as string[],
      parent: String(p.ADM0_A3),
      continent: String(p.CONTINENT), subregion: String(p.SUBREGION),
      label: [Number(p.LABEL_X), Number(p.LABEL_Y)],
      polygons: polygons(feature.geometry),
    };
  });
const places = read("ne_50m_populated_places_simple").features.map(feature => {
  const p = feature.properties;
  return [String(p.name), text(p.nameascii) !== p.name ? text(p.nameascii) ?? "" : "", text(p.namealt) ?? "", Math.round(Number(p.latitude) * 1e4) / 1e4,
    Math.round(Number(p.longitude) * 1e4) / 1e4, String(p.adm0_a3), Number(p.pop_max) || 0, Number(p.adm0cap) ? 1 : 0];
});

const out = {
  source: "Natural Earth 1:50m (admin-0 countries, admin-0 map units, populated places, simple), public domain — https://www.naturalearthdata.com",
  encoding: "rings: [x0, y0, dx1, dy1, …] in hundredths of a degree (longitude, latitude); places: [name, ascii, alternative, lat, lon, country, population, capital]",
  regions: [...countries, ...units],
  places,
};
const target = join(REPO_ROOT, "src", "host", "geo", "world-data.json");
writeFileSync(target, JSON.stringify(out));
const vertices = out.regions.reduce((sum, region) => sum + region.polygons.flat().reduce((n, ring) => n + ring.length / 2, 0), 0);
console.log(`${target}: ${out.regions.length} regions (${units.length} map units), ${vertices} vertices, ${places.length} places, ${(JSON.stringify(out).length / 1024).toFixed(0)} KB`);
