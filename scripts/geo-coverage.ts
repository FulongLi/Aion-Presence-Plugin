import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { VisualResolver } from "../src/host/resolver";
import { frameWindow } from "../src/visual/geo/extent";
import { MAP_LIMITS } from "../src/visual/geo/map";
import { REPO_ROOT } from "./lib/pluginPackage";

/**
 * `npm run geo:coverage`: Aion's geography against the real public services — the offline world, OpenStreetMap's
 * geocoders and the AWS elevation tiles — across continents, the largest and smallest countries, high latitudes,
 * the date line, the poles, regions within countries, Chinese names and city markers. Requests are spaced (Nominatim
 * asks for at most one a second). Writes docs/GEO-COVERAGE.md with what was actually measured.
 *
 *   npm run geo:coverage                 maps, markers and terrain
 *   npm run geo:coverage -- --no-terrain maps and markers only (no elevation tiles)
 */
const resolver = new VisualResolver({ env: {} });
const terrainToo = !process.argv.includes("--no-terrain");
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface Case { region: string; group: string; terrain?: boolean; markers?: string[] }
const CASES: Case[] = [
  { region: "Africa", group: "continent", terrain: true, markers: ["Cape Town", "Cairo"] },
  { region: "Europe", group: "continent" }, { region: "Asia", group: "continent" }, { region: "North America", group: "continent" },
  { region: "South America", group: "continent", terrain: true, markers: ["Ushuaia"] }, { region: "Oceania", group: "continent" },
  { region: "Antarctica", group: "continent · pole", terrain: true }, { region: "World", group: "world" }, { region: "Arctic", group: "pole" },
  { region: "Russia", group: "largest", terrain: true }, { region: "Canada", group: "largest" }, { region: "United States", group: "largest", terrain: true, markers: ["Los Angeles", "New York"] },
  { region: "China", group: "largest" }, { region: "中国", group: "Chinese name", terrain: true }, { region: "Brazil", group: "largest" },
  { region: "Australia", group: "largest", markers: ["Sydney"] }, { region: "India", group: "largest" },
  { region: "Greenland", group: "high latitude", terrain: true }, { region: "Svalbard", group: "high latitude", terrain: true },
  { region: "Iceland", group: "high latitude", terrain: true, markers: ["Reykjavik"] }, { region: "Norway", group: "high latitude" },
  { region: "Alaska", group: "high latitude · OSM", terrain: true },
  { region: "Fiji", group: "date line", terrain: true, markers: ["Suva"] }, { region: "Kiribati", group: "date line" },
  { region: "New Zealand", group: "date line", terrain: true }, { region: "Chukotka", group: "date line · OSM" },
  { region: "Singapore", group: "small" }, { region: "Malta", group: "small" }, { region: "Luxembourg", group: "small" }, { region: "Vatican City", group: "small" },
  { region: "Scotland", group: "country part", terrain: true, markers: ["Glasgow", "Edinburgh"] }, { region: "苏格兰", group: "Chinese name" },
  { region: "Japan", group: "archipelago", terrain: true, markers: ["Kyoto"] }, { region: "日本", group: "Chinese name" }, { region: "Indonesia", group: "archipelago" },
  { region: "California", group: "state · OSM", terrain: true, markers: ["San Francisco"] }, { region: "Bavaria", group: "state · OSM" },
  { region: "Hokkaido", group: "island · OSM" }, { region: "四川", group: "Chinese name · OSM" }, { region: "Swiss Alps", group: "range · OSM", terrain: true },
  { region: "Grand Canyon", group: "landmark · OSM", terrain: true }, { region: "Mount Everest", group: "point · OSM", terrain: true },
];

interface Row { region: string; group: string; map: string; markers: string; terrain: string; ms: number; ok: boolean }
const rows: Row[] = [];
const started = Date.now();
for (const item of CASES) {
  const t = Date.now();
  const row: Row = { region: item.region, group: item.group, map: "", markers: "", terrain: "", ms: 0, ok: true };
  try {
    const region = await resolver.region(item.region);
    const placed: [number, number][] = [];
    const notes: string[] = [];
    for (const name of item.markers ?? []) {
      try {
        const found = await resolver.place(name, { region });
        placed.push([found.lon, found.lat]);
        notes.push(`${name} ${found.lat.toFixed(2)}, ${found.lon.toFixed(2)} (${found.provider})`);
      } catch (error) { row.ok = false; notes.push(`${name}: ${(error as Error).message}`); }
      if (region.provider !== "natural-earth") await pause(1100);
    }
    const map = await resolver.map(item.region, placed);
    const w = frameWindow(map.map.frame);
    const vertices = [...map.map.focus, ...map.map.borders, ...map.map.context, ...map.map.fill, ...map.map.contextFill].reduce((n, l) => n + l.length / 2, 0);
    if (vertices > MAP_LIMITS.vertices) row.ok = false;
    row.map = `${map.region.label} · ${map.region.provider} · ${(w.east - w.west).toFixed(1)}° × ${(w.north - w.south).toFixed(1)}° · ${vertices} vertices · ${(map.bytes.length / 1024).toFixed(0)} KB`;
    row.markers = notes.join("; ");
    if (item.terrain && terrainToo) {
      try {
        const terrain = await resolver.terrain(item.region, "terrain", undefined, placed);
        const e = terrain.field.elevation;
        row.terrain = `${terrain.field.width}×${terrain.field.height} · ${terrain.source.provider}${e ? ` · ${e.min}–${e.max} m` : ""}`;
      } catch (error) { row.ok = false; row.terrain = `✗ ${(error as Error).message}`; }
    }
  } catch (error) { row.ok = false; row.map = `✗ ${(error as Error).message}`; }
  row.ms = Date.now() - t;
  rows.push(row);
  console.log(`${row.ok ? "✓" : "✗"} ${item.region.padEnd(16)} ${row.map}${row.markers ? ` | ${row.markers}` : ""}${row.terrain ? ` | terrain ${row.terrain}` : ""} (${row.ms} ms)`);
  await pause(1100);
}
const passed = rows.filter(row => row.ok).length;
const lines = [
  "# Geographic coverage (measured)",
  "",
  `Measured by \`npm run geo:coverage\` on ${new Date().toISOString().slice(0, 10)} against the live services: ${passed} of ${rows.length} regions passed`
    + ` (${((Date.now() - started) / 1000).toFixed(0)} s, requests spaced for Nominatim's usage policy). Map: what was framed, by whom, the window`
    + " in degrees, and the size of the map sent to the surface. Markers: the coordinates found (and by whom). Terrain: grid, elevation tiles"
    + " zoom and source, real elevation range.",
  "",
  "This is a sample across the hard cases, not a claim of complete worldwide coverage. Every one of Aion's offline regions (≈ 270 countries and"
    + " named parts, plus continents and groups) is also checked offline by `tests/v41.test.ts` on every test run.",
  "",
  "| Region | Case | Map | Markers | Terrain |",
  "| --- | --- | --- | --- | --- |",
  ...rows.map(row => `| ${row.ok ? "✓" : "✗"} ${row.region} | ${row.group} | ${row.map} | ${row.markers || "—"} | ${row.terrain || "—"} |`),
  "",
];
writeFileSync(join(REPO_ROOT, "docs", "GEO-COVERAGE.md"), lines.join("\n"));
console.log(`\ngeo:coverage: ${passed}/${rows.length} passed → docs/GEO-COVERAGE.md`);
if (passed < rows.length) process.exitCode = 1;
