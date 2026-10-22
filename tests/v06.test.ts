import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { connectAion, MCP_APPS_CAPABILITIES, PAGE, tempHome } from "./helpers";
import {
  cumulative, elevationAt, elevationStats, haversine, pointAlong, routeAlong, routeBox, simplifyRoute, simplifyToLimit, steepestClimb, validateRoute,
  ROUTE_LIMITS, type GeoRoute,
} from "../src/visual/geo/route";
import { decodePolyline, openRouteServiceProvider, orsFailure, RouteError, routingProvider, valhallaCosting, valhallaFailure, valhallaProvider, type RoutingProvider } from "../src/host/route/providers";
import { parseCoordinates, planRoute } from "../src/host/route/planner";
import { sampleElevation } from "../src/host/route/elevation";
import { freshFor, TileCache, tileAllowed, TILE_POLICY } from "../src/host/route/tiles";
import { configuredEndpoint, type Fetcher } from "../src/host/resolver/net";
import { VisualResolver } from "../src/host/resolver";
import type { TerrainProvider } from "../src/host/resolver/sources/terrain";
import { regionFrame, resolveRegion } from "../src/host/geo/region";
import { clampZoom, fitView, latOf, lonOf, nearestAlong, niceTicks, parseSection, tilesInView, toScreen, worldX, worldY } from "../src/cards/apps/routeExplorer/model";
import { ROUTE_EXPLORER_MANIFEST } from "../src/cards/apps/routeExplorer.manifest";
import { GENERATIVE_SCENE_MANIFEST } from "../src/cards/apps/generativeScene.manifest";
import { validateManifest, type CardAppManifest } from "../src/cards/manifest";
import { CARD_APP_IDS, OPENABLE_CARD_APP_IDS } from "../src/cards/registry";
import { parseFromCard, parseToCard } from "../src/cards/protocol";
import { checkCardReport } from "../src/cards/state";
import { PresenceStore } from "../src/core/store";
import { routePresentation } from "../src/core/presentationRouter";
import { WELCOME_EXAMPLES, welcomeText } from "../src/core/guidance";
import { PresenceHub } from "../src/host/hub/hub";
import { hubCommandSchema, type HubSnapshot } from "../src/host/hub/protocol";
import { decideSurface } from "../src/host/surface";
import * as schemas from "../src/host/schemas";
import { decodeHeightField } from "../src/visual/heightfield";
import { markerWorldPoint } from "../src/visual/geo/markers";
import { terrainWorldPoint } from "../src/visual/points";

const signal = () => AbortSignal.timeout(10_000);
const fetcher = (fn: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) => fn as unknown as Fetcher;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Google's polyline encoding (the inverse of decodePolyline), for stand-in routing answers. */
function encodePolyline(points: [number, number][], precision = 6) {
  const factor = 10 ** precision;
  let out = "", lastLat = 0, lastLon = 0;
  const put = (value: number) => { let v = value < 0 ? ~(value << 1) : value << 1; while (v >= 0x20) { out += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } out += String.fromCharCode(v + 63); };
  for (const [lon, lat] of points) {
    const la = Math.round(lat * factor), lo = Math.round(lon * factor);
    put(la - lastLat); put(lo - lastLon); lastLat = la; lastLon = lo;
  }
  return out;
}

/** A real-looking path between two points: many vertices, gentle bends, never a straight line. */
function path(from: [number, number], to: [number, number], n = 240): [number, number][] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n, bend = Math.sin(t * Math.PI * 3) * 0.01;
    return [from[0] + (to[0] - from[0]) * t + bend, from[1] + (to[1] - from[1]) * t + bend * 0.5] as [number, number];
  });
}
const length = (coords: [number, number][]) => cumulative(coords).at(-1)!;

/** A routing service stand-in: answers with a path between the points it was given, and records every request. */
function stubRouting(answer?: (points: readonly [number, number][]) => [number, number][] | Error): RoutingProvider & { calls: { points: [number, number][]; mode: string }[] } {
  const calls: { points: [number, number][]; mode: string }[] = [];
  return {
    id: "valhalla", label: "Test router", attribution: "Routing: test · © OpenStreetMap contributors (ODbL)",
    maxMeters: { walking: 100_000, hiking: 100_000, cycling: 150_000 }, calls,
    async route(points, mode) {
      calls.push({ points: points.map(p => [p[0], p[1]]), mode });
      const result = answer ? answer(points) : points.slice(1).flatMap((p, i) => path(points[i] as [number, number], p as [number, number]).slice(i ? 1 : 0));
      if (result instanceof Error) throw result;
      return { coordinates: result, distanceMeters: length(result), durationSeconds: length(result) / (mode === "cycling" ? 5 : 1.4), notes: [] };
    },
  };
}

/** Elevation without the network: a smooth hill along the route. */
const flatlandElevation = async (coordinates: readonly [number, number][]) => {
  const along = cumulative(coordinates), total = along.at(-1)!;
  const samples: [number, number][] = Array.from({ length: 101 }, (_, i) => [total * i / 100, 50 + 150 * Math.sin(Math.PI * i / 100)]);
  return { samples, spacing: total / 100, zoom: 12, source: "test elevation" };
};

/** A terrain provider that knows any offline region or route area, with a gentle relief and its frame. */
const terrainStub: TerrainProvider = {
  name: "test-terrain",
  async resolve(name, _style, signal, options = {}) {
    const region = options.area ?? await resolveRegion(name, signal);
    const frame = regionFrame(region, options.include ?? []);
    const width = 48, height = 40, values = new Float32Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) values[y * width + x] = 20 + 600 * Math.exp(-((x - 20) ** 2 + (y - 18) ** 2) / 200);
    return { provider: "test-terrain", kind: "elevation" as const, width, height, values, aspect: (frame.x1 - frame.x0) / (frame.y1 - frame.y0), label: region.label, geo: frame };
  },
};
const geoResolver = () => new VisualResolver({ env: {}, imageProviders: [], terrainProviders: [terrainStub] });
type Out = { isError?: boolean; content: { text: string }[]; structuredContent: { journey?: Record<string, unknown>; presentation: { kind: string; route: string; reason: string } | null; welcome?: string; surface: { mode: string; open: boolean }; window_opened?: boolean; message: string } };
const out = (value: unknown) => value as Out;

/** A valid route document (from the planner, with stand-ins). */
async function sampleRoute(mode: "walking" | "cycling" | "hiking" = "cycling") {
  const planned = await planRoute({ from: "55.8642, -4.2518", to: "55.9533, -3.1883", mode }, { provider: stubRouting(), locate: async () => { throw new Error("unused"); }, elevation: flatlandElevation, signal: signal(), random: () => 0.5 });
  return planned.route;
}

// ── The route document ─────────────────────────────────────────────────────────────────────────────────────────────

test("v0.6 route: distances, points along it, the box", () => {
  assert.ok(Math.abs(haversine([-3.1883, 55.9533], [-4.2518, 55.8642]) - 67_200) < 1_500, "Glasgow–Edinburgh as the crow flies ≈ 67 km");
  const line: [number, number][] = [[0, 0], [0, 1], [1, 1]];
  const along = cumulative(line);
  assert.ok(Math.abs(along[1] - 111_195) < 50);
  assert.deepEqual(pointAlong(line, along, 0), [0, 0]);
  assert.deepEqual(pointAlong(line, along, along[2] + 1), [1, 1]);
  assert.ok(Math.abs(pointAlong(line, along, along[1] / 2)[1] - 0.5) < 1e-9);
  assert.deepEqual(routeBox(line), [0, 0, 1, 1]);
});

test("v0.6 route: simplification keeps the provider's own vertices and never strays beyond its tolerance", () => {
  const coords = path([-4.25, 55.86], [-3.19, 55.95], 3000);
  for (const tolerance of [2, 10, 50]) {
    const simplified = simplifyRoute(coords, tolerance);
    const own = new Set(coords.map(c => c.join(",")));
    assert.ok(simplified.every(c => own.has(c.join(","))), "only original vertices");
    assert.deepEqual(simplified[0], coords[0]); assert.deepEqual(simplified.at(-1), coords.at(-1));
    // Every original point lies within the tolerance (plus a little for the local projection) of the simplified line.
    const k = Math.cos(55.9 * Math.PI / 180) * 111_195, m = 111_195;
    const gap = (p: [number, number]) => Math.min(...simplified.slice(1).map((b, i) => {
      const a = simplified[i], ax = a[0] * k, ay = a[1] * m, bx = b[0] * k - ax, by = b[1] * m - ay, px = p[0] * k - ax, py = p[1] * m - ay;
      const t = Math.max(0, Math.min(1, (px * bx + py * by) / (bx * bx + by * by || 1)));
      return Math.hypot(px - bx * t, py - by * t);
    }));
    assert.ok(coords.filter((_, i) => i % 37 === 0).every(p => gap(p) <= tolerance * 1.02 + 0.5), `within ${tolerance} m`);
  }
  const limited = simplifyToLimit(coords, 400);
  assert.ok(limited.coordinates.length <= 400 && limited.tolerance > 0);
});

test("v0.6 route: elevation statistics are smoothed and need a real climb (no false precision from jitter)", () => {
  const jitter = (i: number) => ((i * 7919) % 11) / 11 * 4 - 2;
  const flat: [number, number][] = Array.from({ length: 400 }, (_, i) => [i * 25, 100 + jitter(i)]);
  const flatStats = elevationStats(flat)!;
  assert.ok(flatStats.ascent < 10 && flatStats.descent < 10, `flat ground with ±2 m noise: ↑${flatStats.ascent.toFixed(1)} ↓${flatStats.descent.toFixed(1)}`);
  const naive = flat.slice(1).reduce((sum, [, e], i) => sum + Math.max(0, e - flat[i][1]), 0);
  assert.ok(naive > 100, `summing every wiggle would claim ${naive.toFixed(0)} m`);
  const hill: [number, number][] = Array.from({ length: 400 }, (_, i) => [i * 25, 100 + 100 * Math.min(1, i / 200) - 100 * Math.max(0, (i - 200) / 200) + jitter(i)]);
  const hillStats = elevationStats(hill)!;
  assert.ok(Math.abs(hillStats.ascent - 100) < 12 && Math.abs(hillStats.descent - 100) < 12, `a 100 m hill: ↑${hillStats.ascent.toFixed(0)} ↓${hillStats.descent.toFixed(0)}`);
  assert.equal(hill[hillStats.highestIndex][1], Math.max(...hill.map(s => s[1])), "the highest point is the raw sample's");
  const climb = steepestClimb(hill, 500)!;
  assert.ok(climb.from < 5000 && climb.gradient > 0.009, JSON.stringify(climb));
  assert.equal(elevationStats([[0, 1]]), null);
});

test("v0.6 route: validation refuses invented or malformed routes", async () => {
  const route = await sampleRoute();
  assert.equal(validateRoute(route).ok, true);
  const bad = (patch: Partial<GeoRoute> | Record<string, unknown>, why: RegExp) => {
    const checked = validateRoute({ ...route, ...patch });
    assert.equal(checked.ok, false, JSON.stringify(patch).slice(0, 60));
    if (!checked.ok) assert.match(checked.problem, why);
  };
  bad({ coordinates: [route.coordinates[0], route.coordinates.at(-1)!] }, /straight line|distance/);
  bad({ coordinates: [route.coordinates[0], route.coordinates[1], [route.coordinates.at(-1)![0], route.coordinates.at(-1)![1]]] }, /jumps|distance/);
  bad({ extra: 1 } as Record<string, unknown>, /unknown field/);
  bad({ coordinates: route.coordinates.map(([lon, lat]) => [lon + 200, lat]) as [number, number][] }, /longitude/);
  bad({ elevationSamples: [[10, 5], [5, 6]] }, /increasing/);
  bad({ elevationSamples: [], totalAscentMeters: 10 }, /need elevation samples/);
  bad({ warnings: ["a\nb"] }, /warnings/);
  bad({ travelMode: "driving" } as unknown as Partial<GeoRoute>, /travelMode/);
  bad({ origin: { name: "A‮B", lat: 1, lon: 1 } }, /name/);
  bad({ coordinates: path([-4.25, 55.86], [-3.19, 55.95], ROUTE_LIMITS.coordinates + 10) }, /coordinates|large/);
  assert.equal(validateRoute("route").ok, false);
});

// ── Providers ──────────────────────────────────────────────────────────────────────────────────────────────────────

test("v0.6 valhalla: only coordinates are sent, with the mode's costing and FOSSGIS's client id; the path is decoded", async () => {
  const sent: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const shape = path([-4.2518, 55.8642], [-3.1883, 55.9533], 60);
  const request = fetcher(async (input, init) => {
    sent.push({ url: String(input), body: JSON.parse(String(init?.body)), headers: init?.headers as Record<string, string> });
    return json({ trip: { legs: [{ shape: encodePolyline(shape) }], summary: { length: 76.02, time: 15648 } } });
  });
  const provider = valhallaProvider({}, request);
  const route = await provider.route([[-4.2518, 55.8642], [-3.1883, 55.9533]], "cycling", signal());
  assert.equal(sent[0].url, "https://valhalla1.openstreetmap.de/route");
  assert.equal(sent[0].headers["X-Client-Id"], "aion-presence");
  assert.match(sent[0].headers["User-Agent"], /^AionPresence\//);
  assert.deepEqual(Object.keys(sent[0].body).sort(), ["costing", "costing_options", "directions_type", "locations", "units"]);
  assert.deepEqual(sent[0].body.locations, [{ lat: 55.8642, lon: -4.2518 }, { lat: 55.9533, lon: -3.1883 }], "coordinates only, never names");
  assert.equal(sent[0].body.costing, "bicycle");
  assert.equal(route.distanceMeters, 76_020);
  assert.ok(route.coordinates.length === shape.length && Math.abs(route.coordinates[10][0] - shape[10][0]) < 1e-6);
  assert.equal(valhallaCosting("hiking").costing_options.pedestrian?.max_hiking_difficulty, 3);
  assert.equal(valhallaCosting("walking").costing, "pedestrian");
  assert.deepEqual(decodePolyline(encodePolyline([[1.5, 2.25], [-0.000001, 0]])), [[1.5, 2.25], [-0.000001, 0]]);
});

test("v0.6 valhalla: its refusals become plain reasons; a slow or broken service is unavailable", async () => {
  for (const [code, expected] of [[442, "route-not-found"], [171, "route-point-unroutable"], [154, "route-too-long"]] as const) {
    const provider = valhallaProvider({ AION_ROUTING_VALHALLA_URL: "http://localhost:8002" }, fetcher(async () => json({ error_code: code, error: "x", status_code: 400 }, 400)));
    await assert.rejects(provider.route([[0, 0], [0.1, 0.1]], "walking", signal()), new RegExp(expected));
  }
  assert.equal(valhallaFailure(undefined, 429).message, "route-rate-limited");
  assert.equal(valhallaFailure(undefined, 502).message, "route-unavailable");
  const down = valhallaProvider({ AION_ROUTING_VALHALLA_URL: "http://localhost:8002" }, fetcher(async () => { throw new TypeError("fetch failed"); }));
  await assert.rejects(down.route([[0, 0], [0.1, 0.1]], "walking", signal()), (error: RouteError) => error.message === "route-unavailable" && error.detail === "network");
  const garbage = valhallaProvider({ AION_ROUTING_VALHALLA_URL: "http://localhost:8002" }, fetcher(async () => json({ trip: { legs: [{ shape: 42 }], summary: { length: 1, time: 1 } } })));
  await assert.rejects(garbage.route([[0, 0], [0.1, 0.1]], "walking", signal()), /route-invalid/);
});

test("v0.6 valhalla: a self-hosted server is the user's (no FOSSGIS limits or queue); only https or this machine", async () => {
  const urls: string[] = [];
  const request = fetcher(async input => { urls.push(String(input)); return json({ trip: { legs: [{ shape: encodePolyline(path([0, 0], [0.1, 0.1], 10)) }], summary: { length: 15, time: 900 } } }); });
  const own = valhallaProvider({ AION_ROUTING_VALHALLA_URL: "http://localhost:8002/" }, request);
  assert.equal(own.label, "Valhalla (localhost:8002)");
  assert.ok(own.maxMeters.walking > 100_000);
  await own.route([[0, 0], [0.1, 0.1]], "walking", signal());
  assert.equal(urls[0], "http://localhost:8002/route");
  assert.equal(configuredEndpoint("http://example.com:8002"), null, "plain http only on this machine");
  assert.equal(configuredEndpoint("https://user:pw@example.com"), null, "no credentials in the address");
  assert.ok(configuredEndpoint("https://routing.example.org/valhalla/"));
  assert.equal(valhallaProvider({ AION_ROUTING_VALHALLA_URL: "http://10.0.0.5:8002" }).label, "Valhalla (FOSSGIS)", "an unusable address falls back to the default");
});

test("v0.6 valhalla: FOSSGIS's public server is asked at most once a second", async () => {
  const at: number[] = [];
  const request = fetcher(async () => { at.push(Date.now()); return json({ trip: { legs: [{ shape: encodePolyline(path([0, 0], [0.05, 0.05], 10)) }], summary: { length: 8, time: 600 } } }); });
  const provider = valhallaProvider({}, request);
  await Promise.all([provider.route([[0, 0], [0.05, 0.05]], "walking", signal()), provider.route([[0, 0], [0.05, 0.05]], "walking", signal())]);
  assert.ok(at[1] - at[0] >= 1_000, `${at[1] - at[0]} ms apart`);
});

test("v0.6 openrouteservice: only with the user's key, sent only to ORS; its refusals as Aion's", async () => {
  assert.equal(openRouteServiceProvider({}), null);
  assert.equal(openRouteServiceProvider({ AION_ROUTING_ORS_KEY: "short" }), null);
  const fallback = routingProvider({ AION_ROUTING_PROVIDER: "openrouteservice" });
  assert.equal(fallback.provider.id, "valhalla");
  assert.match(fallback.note ?? "", /AION_ROUTING_ORS_KEY/);
  const sent: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const coords = path([-2.96, 54.43], [-3.02, 54.46], 30);
  const request = fetcher(async (input, init) => {
    sent.push({ url: String(input), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ features: [{ geometry: { type: "LineString", coordinates: coords }, properties: { summary: { distance: 6500, duration: 5400 } } }] }), { headers: { "content-type": "application/geo+json" } });
  });
  const ors = routingProvider({ AION_ROUTING_PROVIDER: "openrouteservice", AION_ROUTING_ORS_KEY: "0123456789abcdef0123456789abcdef" }, request).provider;
  const route = await ors.route([[-2.96, 54.43], [-3.02, 54.46]], "hiking", signal());
  assert.equal(sent[0].url, "https://api.openrouteservice.org/v2/directions/foot-hiking/geojson");
  assert.equal(sent[0].headers.Authorization, "0123456789abcdef0123456789abcdef");
  assert.equal(route.distanceMeters, 6500);
  assert.equal(orsFailure(2009, 404).message, "route-not-found");
  assert.equal(orsFailure(2010, 404).message, "route-point-unroutable");
  assert.equal(orsFailure(2004, 400).message, "route-too-long");
  assert.equal(orsFailure(undefined, 403).detail, "key-refused");
});

// ── The planner ────────────────────────────────────────────────────────────────────────────────────────────────────

test("v0.6 planner: places by name or coordinates, waypoints in order, one validated route", async () => {
  const routing = stubRouting();
  const looked: string[] = [];
  const places: Record<string, [number, number]> = { Glasgow: [-4.2518, 55.8642], Edinburgh: [-3.1883, 55.9533], Linlithgow: [-3.6, 55.976] };
  const planned = await planRoute({ from: "Glasgow", to: "Edinburgh", via: ["Linlithgow"], mode: "cycling" }, {
    provider: routing, signal: signal(), elevation: flatlandElevation,
    locate: async name => { looked.push(name); const p = places[name]; if (!p) throw new Error("place-not-found"); return { label: name, lon: p[0], lat: p[1], provider: "natural-earth" }; },
  });
  assert.deepEqual(looked, ["Glasgow", "Linlithgow", "Edinburgh"]);
  assert.deepEqual(routing.calls[0].points, [places.Glasgow, places.Linlithgow, places.Edinburgh], "the provider gets the points in order");
  const route = planned.route;
  assert.equal(validateRoute(route).ok, true);
  assert.equal(route.waypoints[0].name, "Linlithgow");
  assert.equal(route.travelMode, "cycling");
  assert.ok(route.totalAscentMeters! >= 140 && route.totalAscentMeters! <= 160 && route.maximumElevationMeters === 200, `↑${route.totalAscentMeters} m, max ${route.maximumElevationMeters} m`);
  assert.ok(route.highest && Math.abs(route.highest.distanceMeters - route.distanceMeters / 2) < route.distanceMeters * 0.02, "the highest point is half way");
  assert.deepEqual(parseCoordinates("55.9486, -3.1999"), { name: "55.9486° N, 3.1999° W", lat: 55.9486, lon: -3.1999 });
  assert.equal(parseCoordinates("Glasgow"), null);
  assert.equal(parseCoordinates("95, 0"), null);
  await assert.rejects(planRoute({ from: "Glasgow", to: "Narnia", mode: "walking" }, { provider: routing, signal: signal(), locate: async name => { const p = places[name]; if (!p) throw new Error("place-not-found"); return { label: name, lon: p[0], lat: p[1], provider: "natural-earth" }; } }),
    (error: Error & { detail?: string }) => error.message === "place-not-found" && error.detail === "Narnia");
});

test("v0.6 planner: the provider's limits, the same place, ends far from the path, and no elevation are all said, never guessed", async () => {
  const routing = stubRouting();
  const deps = { provider: routing, signal: signal(), locate: async () => { throw new Error("unused"); }, elevation: flatlandElevation };
  await assert.rejects(planRoute({ from: "51.5072, -0.1276", to: "40.7128, -74.006", mode: "walking" }, deps), /route-too-long/);
  assert.equal(routing.calls.length, 0, "a straight line already beyond the limit is never sent");
  await assert.rejects(planRoute({ from: "55.9, -3.2", to: "55.9, -3.2", mode: "walking" }, deps), /route-same-place/);
  // The path ends 3 km short of the destination: a warning, not a silent truncation.
  const short = stubRouting(points => path(points[0] as [number, number], [points[1][0] - 0.05, points[1][1]]));
  const warned = await planRoute({ from: "55.86, -4.25", to: "55.95, -3.19", mode: "walking" }, { ...deps, provider: short });
  assert.match(warned.route.warnings.join(" "), /ends 3\.\d km from/);
  const far = stubRouting(points => path(points[0] as [number, number], [points[1][0] - 0.3, points[1][1]]));
  await assert.rejects(planRoute({ from: "55.86, -4.25", to: "55.95, -3.19", mode: "walking" }, { ...deps, provider: far }), /route-point-unroutable/);
  const lost = await planRoute({ from: "55.86, -4.25", to: "55.95, -3.19", mode: "hiking" }, { ...deps, elevation: async () => { throw new Error("elevation-unavailable"); } });
  assert.equal(lost.route.totalAscentMeters, null);
  assert.equal(lost.route.elevationSamples.length, 0);
  assert.match(lost.route.warnings.join(" "), /No elevation could be read/);
  assert.match(lost.route.warnings.join(" "), /cannot say whether a path is open, safe, legally accessible or suitable/, "hiking is never called safe");
  const nonsense = stubRouting(() => [[0, 0], [400, 0]]);
  await assert.rejects(planRoute({ from: "55.86, -4.25", to: "55.95, -3.19", mode: "walking" }, { ...deps, provider: nonsense }), /route-invalid/);
  const huge = await planRoute({ from: "55.86, -4.25", to: "55.95, -3.19", mode: "cycling" }, { ...deps, provider: stubRouting(points => path(points[0] as [number, number], points[1] as [number, number], 9000)) });
  assert.ok(huge.route.coordinates.length <= ROUTE_LIMITS.coordinates && huge.route.toleranceMeters > 0, `${huge.route.coordinates.length} points within ±${huge.route.toleranceMeters} m`);
});

// ── Elevation along the route (synthetic terrarium tiles) ──────────────────────────────────────────────────────────

function pngRGBA(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (bytes: Uint8Array) => { let c = 0xffffffff; for (const b of bytes) c = table[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length), view = new DataView(out.buffer);
    view.setUint32(0, data.length); out.set(Buffer.from(type, "ascii"), 4); out.set(data, 8);
    view.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const header = new Uint8Array(13), hv = new DataView(header.buffer);
  hv.setUint32(0, width); hv.setUint32(4, height); header.set([8, 6, 0, 0, 0], 8);
  const raw = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0))];
  return Buffer.concat(parts);
}

test("v0.6 elevation: sampled every few metres along the route from the terrarium tiles, bilinear and exact", async () => {
  // Elevation rises 1 m per 0.001° of longitude: 300 m at 3.2° W, 400 m at 3.1° W.
  const metres = (lon: number) => 3500 + lon * 1000;
  const tiles: string[] = [];
  const request = fetcher(async input => {
    const match = /terrarium\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(String(input));
    if (!match) return new Response("", { status: 404 });
    tiles.push(match.slice(1).join("/"));
    const [z, x] = match.slice(1).map(Number);
    const rgba = new Uint8Array(256 * 256 * 4);
    for (let py = 0; py < 256; py++) for (let px = 0; px < 256; px++) {
      const lon = (x * 256 + px + 0.5) / (256 * 2 ** z) * 360 - 180, value = metres(lon) + 32768;
      const r = Math.floor(value / 256), g = Math.floor(value) % 256, b = Math.round((value - Math.floor(value)) * 256) % 256, o = (py * 256 + px) * 4;
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255;
    }
    return new Response(Buffer.from(pngRGBA(256, 256, rgba)), { headers: { "content-type": "image/png" } });
  });
  const line: [number, number][] = [[-3.2, 55.9], [-3.15, 55.91], [-3.1, 55.9]];
  const profile = await sampleElevation(line, signal(), request);
  assert.ok(tiles.length > 0 && tiles.length <= 32, `${tiles.length} tiles`);
  assert.ok(profile.zoom >= 10 && profile.zoom <= 13);
  assert.ok(profile.samples.length >= 100 && profile.samples.length <= 501);
  assert.ok(Math.abs(profile.samples[0][1] - 300) < 3 && Math.abs(profile.samples.at(-1)![1] - 400) < 3, `${profile.samples[0][1]} → ${profile.samples.at(-1)![1]}`);
  for (let i = 1; i < profile.samples.length; i++) assert.ok(profile.samples[i][0] > profile.samples[i - 1][0]);
  const again = tiles.length;
  await sampleElevation([...line].reverse(), signal(), request);
  assert.equal(tiles.length, again, "a reversed route reads the tiles it already has");
  // Elsewhere (tiles not read yet), with the service down: elevation-unavailable, with its cause.
  await assert.rejects(sampleElevation([[10.1, 45.1], [10.2, 45.15]], signal(), fetcher(async () => new Response("", { status: 503 }))), (error: Error & { detail?: string }) => error.message === "elevation-unavailable" && error.detail === "http-503");
});

// ── The card: geometry, manifest, bridge ───────────────────────────────────────────────────────────────────────────

test("v0.6 card geometry: Web Mercator, framing, tiles in view, sections, the pointer along the route", () => {
  assert.ok(Math.abs(lonOf(worldX(-3.19)) + 3.19) < 1e-9 && Math.abs(latOf(worldY(55.95)) - 55.95) < 1e-9);
  const coords = path([-4.25, 55.86], [-3.19, 55.95], 200);
  const view = fitView(coords, 600, 360, 30);
  for (const [lon, lat] of coords) {
    const [x, y] = toScreen(view, 600, 360, worldX(lon), worldY(lat));
    assert.ok(x >= 29 && x <= 571 && y >= 29 && y <= 331, `${x.toFixed(0)},${y.toFixed(0)} inside the padded card`);
  }
  assert.ok(view.zoom > 8 && view.zoom < 12);
  const tiles = tilesInView(view, 600, 360);
  assert.ok(tiles.length >= 2 && tiles.length <= 12 && tiles.every(t => t.z === Math.round(view.zoom - 0.1)));
  assert.equal(clampZoom(40), 18);
  assert.deepEqual(parseSection("12-30", 74_500), [12_000, 30_000]);
  assert.deepEqual(parseSection("30 – 12 km", 74_500), [12_000, 30_000]);
  assert.deepEqual(parseSection("70-90", 74_500), [70_000, 74_500]);
  assert.equal(parseSection("near the castle", 74_500), null);
  assert.deepEqual(niceTicks(37, 200, 3), [100, 200]);
  assert.deepEqual(niceTicks(0, 74.5, 6), [0, 20, 40, 60]);
  const screen = coords.map(([lon, lat]) => toScreen(view, 600, 360, worldX(lon), worldY(lat)));
  const along = cumulative(coords);
  const mid = screen[100];
  const hit = nearestAlong(screen, along, mid[0] + 3, mid[1] + 2)!;
  assert.ok(Math.abs(hit.distance - along[100]) < along.at(-1)! * 0.01);
  assert.equal(nearestAlong(screen, along, 5, 5), null);
});

test("v0.6 Route Explorer: a valid manifest, opened by plan_route only; route and tile messages need their capabilities", async () => {
  assert.equal(validateManifest(ROUTE_EXPLORER_MANIFEST).ok, true);
  assert.ok(CARD_APP_IDS.includes("route-explorer") && !OPENABLE_CARD_APP_IDS.includes("route-explorer"));
  assert.equal(schemas.showInteractiveCardInput.safeParse({ app: "route-explorer" }).success, false, "show_interactive_card cannot open it");
  const route = await sampleRoute();
  const instance = "cabcdef123";
  const toCard = (type: string, payload: Record<string, unknown>, manifest: CardAppManifest = ROUTE_EXPLORER_MANIFEST) => parseToCard({ v: 1, instance, type, id: "r1", payload }, instance, manifest);
  assert.equal(toCard("LOAD_ROUTE", { revision: 1, route }).ok, true);
  assert.equal(toCard("LOAD_ROUTE", { revision: 1, route }, GENERATIVE_SCENE_MANIFEST).ok, false, "only a route-documents card gets routes");
  assert.equal(toCard("LOAD_ROUTE", { revision: 1, route: { ...route, coordinates: [[0, 0], [0, 1]] } }).ok, false, "the card validates the route again");
  const png = new ArrayBuffer(64);
  assert.equal(toCard("LOAD_TILE", { tile: { z: 10, x: 500, y: 320 }, mime: "image/png", data: png }).ok, true);
  assert.equal(toCard("LOAD_TILE", { tile: { z: 10, x: 5000, y: 320 }, mime: "image/png", data: png }).ok, false, "a tile outside its zoom's grid");
  assert.equal(toCard("LOAD_TILE", { tile: { z: 10, x: 1, y: 1 }, mime: "image/svg+xml", data: png }).ok, false);
  assert.equal(toCard("LOAD_TILE", { tile: { z: 10, x: 1, y: 1 }, mime: "image/png", data: new ArrayBuffer(2_000_000) }).ok, false, "a tile larger than allowed");
  const fromCard = (type: string, payload: Record<string, unknown>, manifest: CardAppManifest = ROUTE_EXPLORER_MANIFEST) => parseFromCard({ v: 1, instance, type, payload }, instance, manifest);
  assert.equal(fromCard("CURSOR", { distance: 1200 }).ok, true);
  assert.equal(fromCard("CURSOR", { distance: null }).ok, true);
  assert.equal(fromCard("CURSOR", { distance: -1 }).ok, false);
  assert.equal(fromCard("CURSOR", { distance: 5 }, GENERATIVE_SCENE_MANIFEST).ok, false);
  assert.equal(fromCard("TILE_REQUEST", { tiles: [{ z: 12, x: 2000, y: 1300 }] }).ok, true);
  assert.equal(fromCard("TILE_REQUEST", { tiles: Array.from({ length: 17 }, () => ({ z: 1, x: 0, y: 0 })) }).ok, false, "at most 16 a request");
  assert.equal(fromCard("TILE_REQUEST", { tiles: [{ z: 12, x: 2000, y: 1300, url: "https://evil" }] }).ok, false, "a tile is z/x/y, never a URL");
  assert.equal(fromCard("STATE_CHANGED", { state: { sectionKm: "all", highlight: "highest", highlightKm: 31.4, tiles: "ok" } }).ok, true);
});

// ── The shared route state ─────────────────────────────────────────────────────────────────────────────────────────

test("v0.6 store: one route on the card, revised in place; closing the card keeps its terrain and places", async () => {
  const store = new PresenceStore();
  const route = await sampleRoute();
  const terrain = { media: { id: "m0123456789abcdef01", mime: "application/vnd.aion.heightfield", bytes: 100 }, style: "terrain" as const, label: "Scotland", region: "Scotland",
    markers: [{ id: "stirling", label: "Stirling", lat: 56.12, lon: -3.94, color: "#e2725b" }] };
  const content = { kind: "interactive" as const, app: "route-explorer", instance: "croute12345", title: "Glasgow → Edinburgh", layout: "compact" as const, config: {}, terrain, geoRoute: route };
  const shown = store.present(content, 0);
  assert.equal(shown.route, "hybrid", "a route is hybrid: terrain and card");
  assert.equal(shown.reason, "route-hybrid");
  assert.equal(shown.bodyHold, 0, "the terrain stays as long as the card");
  assert.equal("geoRoute" in shown, false, "the route lives on the card, not the presentation");
  assert.equal(store.snapshot().card?.route?.revision, 1);
  store.present({ ...content, geoRoute: { ...route, id: "rreversed1" } }, 0);
  assert.equal(store.snapshot().card?.route?.revision, 2, "the same card: the next revision");
  assert.equal(store.snapshot().card?.route?.document.id, "rreversed1");
  assert.equal(store.setMarkers([]), true);
  assert.deepEqual(store.snapshot().presentation?.kind === "interactive" && store.snapshot().presentation!.kind === "interactive" ? (store.snapshot().presentation as { terrain?: { markers?: unknown[] } }).terrain?.markers : null, []);
  store.setMarkers(terrain.markers);
  assert.equal(store.cardCommand("close").ok, true);
  const after = store.snapshot().presentation;
  assert.equal(after?.kind, "terrain", "the route went, the terrain stayed");
  assert.equal(after?.kind === "terrain" && after.media.id, terrain.media.id);
  assert.equal(after?.kind === "terrain" && after.markers?.[0]?.label, "Stirling");
  assert.equal(store.snapshot().card, null);
  store.clearPresentation();
  assert.equal(store.snapshot().presentation, null);
  assert.equal(routePresentation({ content: { ...content } }).route, "hybrid");
  assert.equal(routePresentation({ content: { ...content, terrain: undefined } }).route, "card", "without terrain, the card alone");
});

test("v0.6 hub: route acknowledgements are checked; tiles only for the open route, never a general proxy", async () => {
  const home = tempHome();
  const served: string[] = [];
  const tiles = new TileCache(join(home, "tiles"), { request: fetcher(async input => { served.push(String(input)); return new Response(Buffer.from(pngRGBA(1, 1, new Uint8Array([1, 2, 3, 255]))), { headers: { "content-type": "image/png", "cache-control": "max-age=86400" } }); }) });
  const hub = new PresenceHub({ home, port: 0, page: () => PAGE, tiles, bridge: { locate: () => null } });
  await hub.start();
  try {
    const token = new URL(hub.surfaceUrl).searchParams.get("token")!;
    const tile = (z: number, x: number, y: number) => fetch(`${hub.url}tile/${z}/${x}/${y}?token=${token}`);
    assert.equal((await tile(12, 2000, 1300)).status, 404, "no route, no tiles");
    const route = await sampleRoute();
    hub.apply({ type: "present", content: { kind: "interactive", app: "route-explorer", instance: "croute12345", title: "Route", layout: "compact", config: {}, geoRoute: route }, hold: 0 });
    // Glasgow at zoom 12: x = (−4.25 + 180) / 360 · 4096 ≈ 2000, y ≈ 1279.
    const inside = await tile(12, 2000, 1279);
    assert.equal(inside.status, 200);
    assert.equal(inside.headers.get("content-type"), "image/png");
    assert.equal((await tile(12, 100, 100)).status, 403, "a tile far from the route is refused");
    assert.equal((await tile(1, 0, 0)).status, 403, "a world view is not the route's");
    assert.equal(served.length, 1);
    assert.equal((await tile(12, 2000, 1279)).status, 200);
    assert.equal(served.length, 1, "the second time it comes from the cache");
    assert.equal((await fetch(`${hub.url}tile/12/2000/1279`)).status, 403, "the token is required");
    // The card's report about its route: only revisions that exist.
    const card = hub.snapshot().card!;
    assert.equal(checkCardReport({ window: "abcdefgh", instance: card.instance, route: { revision: 1, ok: true } }, card, ROUTE_EXPLORER_MANIFEST).ok, true);
    assert.equal(checkCardReport({ window: "abcdefgh", instance: card.instance, route: { revision: 5, ok: true } }, card, ROUTE_EXPLORER_MANIFEST).ok, false);
    assert.equal(checkCardReport({ window: "abcdefgh", instance: card.instance, route: { revision: 1, ok: true } }, card, GENERATIVE_SCENE_MANIFEST).ok, false);
    assert.equal(hubCommandSchema.safeParse({ type: "present", content: { kind: "interactive", app: "earth-moon", instance: "cearth12345", title: "E", layout: "expanded", config: {}, geoRoute: route } }).success, false,
      "only the Route Explorer takes a route");
  } finally { await hub.stop(); }
});

test("v0.6 tiles: OpenStreetMap's policy — cached by its headers (else 7 days), revalidated, bounded, and can be turned off", async () => {
  let now = 1_000_000;
  const requests: { url: string; headers: Record<string, string> }[] = [];
  let reply: () => Response = () => new Response(Buffer.from(pngRGBA(1, 1, new Uint8Array([9, 9, 9, 255]))), { headers: { "content-type": "image/png", etag: "\"v1\"" } });
  const cache = new TileCache(join(tempHome(), "tiles"), { now: () => now, request: fetcher(async (input, init) => { requests.push({ url: String(input), headers: init?.headers as Record<string, string> }); return reply(); }) });
  const first = await cache.get(10, 500, 320, signal());
  assert.equal(requests[0].url, "https://tile.openstreetmap.org/10/500/320.png");
  assert.match(requests[0].headers["User-Agent"], /^AionPresence\/[\d.]+ \(Codex plugin; \+https:/, "an identifying User-Agent");
  assert.equal(requests[0].headers["Cache-Control"], undefined, "never no-cache");
  now += 6 * 86_400_000;
  assert.deepEqual(await cache.get(10, 500, 320, signal()), first);
  assert.equal(requests.length, 1, "fresh for 7 days without headers saying otherwise");
  now += 2 * 86_400_000;
  reply = () => new Response(null, { status: 304, headers: { "cache-control": "max-age=3600" } });
  assert.deepEqual(await cache.get(10, 500, 320, signal()), first);
  assert.equal(requests[1].headers["If-None-Match"], "\"v1\"", "an expired tile is revalidated, not fetched again");
  assert.equal(freshFor(new Headers({ "cache-control": "public, max-age=604800" })), 604_800);
  assert.equal(freshFor(new Headers({ expires: new Date(Date.now() + 120_000).toUTCString() })) > 100, true);
  assert.equal(freshFor(new Headers()), TILE_POLICY.fallbackSeconds);
  const off = new TileCache(join(tempHome(), "tiles"), { env: { AION_PRESENCE_TILES: "off" } });
  await assert.rejects(off.get(1, 0, 0, signal()), /tiles-off/);
  const box: [number, number, number, number] = [-4.25, 55.86, -3.19, 55.95];
  assert.equal(tileAllowed(12, 2000, 1279, box), true);
  assert.equal(tileAllowed(12, 0, 0, box), false);
  assert.equal(tileAllowed(19, 0, 0, box), false);
  assert.equal(tileAllowed(1.5, 0, 0, box), false);
});

test("v0.6 alignment: the route lands on the terrain where the samplers put each latitude and longitude", async () => {
  const resolver = geoResolver();
  const area = await resolver.terrainArea("Glasgow – Edinburgh", [-4.4, 55.75, -3.0, 56.05]);
  const field = decodeHeightField(area.bytes);
  const target = { kind: "heightfield" as const, field, style: "terrain" as const };
  const route = await sampleRoute();
  const points = route.coordinates.map(([lon, lat]) => markerWorldPoint(target, lon, lat));
  assert.ok(points.every(Boolean), "every vertex of the route is on its terrain");
  // East is to the right on the body: Glasgow (west) is left of Edinburgh (east), and A stands where the path starts.
  const a = markerWorldPoint(target, route.origin.lon, route.origin.lat)!, b = markerWorldPoint(target, route.destination.lon, route.destination.lat)!;
  assert.ok(a[0] < b[0]);
  assert.ok(Math.hypot(points[0]![0] - a[0], points[0]![2] - a[2]) < 0.02, "A and the first vertex coincide");
  // Off the terrain there is no point (the overlay breaks the line there instead of inventing one).
  assert.equal(markerWorldPoint(target, 10, 40), null);
  // The same place along the route for the card and the body: distances along the drawn line use the route's length.
  const along = routeAlong(route);
  assert.ok(Math.abs(along.at(-1)! - route.distanceMeters) < 1);
  assert.ok(elevationAt(route, route.distanceMeters / 2)! > 190, "the profile's middle is the hill's top");
  const [lon, lat] = pointAlong(route.coordinates, along, route.highest!.distanceMeters);
  assert.ok(Math.abs(lon - route.highest!.lon) < 1e-4 && Math.abs(lat - route.highest!.lat) < 1e-4, "the highest point is where the route says");
  assert.ok(terrainWorldPoint(field, 0.5, 0.5, 0.04).every(Number.isFinite));
});

// ── plan_route through the MCP server ──────────────────────────────────────────────────────────────────────────────

test("v0.6 plan_route: Scotland's terrain, then a cycling route drawn on it (the terrain kept) with the Route Explorer", async () => {
  const routing = stubRouting();
  const aion = await connectAion({ resolver: geoResolver(), routing });
  try {
    const terrain = out(await aion.call("show_terrain", { region: "Scotland" }));
    assert.equal(terrain.isError, undefined);
    const before = (await aion.link.run(backend => backend.state())).presentation as Extract<HubSnapshot["presentation"], { kind: "terrain" }>;
    const planned = out(await aion.call("plan_route", { from: "Glasgow", to: "Edinburgh", mode: "cycling" }));
    assert.equal(planned.isError, undefined, planned.content[0].text);
    assert.match(planned.content[0].text, /^Planned: Glasgow → Edinburgh by bicycle: \d+\.\d km, about /);
    const journey = planned.structuredContent.journey!;
    assert.equal(journey.from, "Glasgow");
    assert.equal(journey.mode, "cycling");
    assert.ok(Number(journey.distance_km) > 60 && Number(journey.ascent_m) > 0);
    assert.equal(routing.calls[0].mode, "cycling");
    const snapshot = await aion.link.run(backend => backend.state());
    const shown = snapshot.presentation as Extract<HubSnapshot["presentation"], { kind: "interactive" }>;
    assert.equal(shown.kind, "interactive");
    assert.equal(shown.app, "route-explorer");
    assert.equal(shown.route, "hybrid");
    assert.equal(shown.terrain?.media.id, before.media.id, "the route is drawn on the terrain on show (not a new one)");
    assert.equal(snapshot.card?.route?.revision, 1);
    // Follow-ups: reverse, another mode, a waypoint — the route's own places, no new lookups needed.
    const reversed = out(await aion.call("plan_route", { reverse: true }));
    assert.equal(reversed.structuredContent.journey?.from, "Edinburgh");
    assert.deepEqual(routing.calls[1].points, [...routing.calls[0].points].reverse());
    const again = await aion.link.run(backend => backend.state());
    assert.equal(again.card?.instance, snapshot.card?.instance, "the same card");
    assert.equal(again.card?.route?.revision, 2);
    const walking = out(await aion.call("plan_route", { mode: "walking" }));
    assert.equal(walking.structuredContent.journey?.mode, "walking");
    assert.deepEqual(routing.calls[2].points, routing.calls[1].points, "only the mode changed");
    const via = out(await aion.call("plan_route", { via: ["Stirling"] }));
    assert.deepEqual(via.structuredContent.journey?.via, ["Stirling"]);
    assert.equal(routing.calls[3].points.length, 3);
    // A marker on the route's terrain keeps the route.
    const marked = out(await aion.call("mark_map", { add: [{ place: "Falkirk" }] }));
    assert.equal(marked.isError, undefined, marked.content[0].text);
    assert.equal((await aion.link.run(backend => backend.state())).presentation?.kind, "interactive");
    // The card's figures for Codex.
    const inspected = out(await aion.call("inspect_interactive_card", {}));
    assert.match(inspected.content[0].text, /"route":\{"revision":4,"from":"Edinburgh","to":"Glasgow","mode":"walking","via":\["Stirling"\]/);
    // "Remove the route": the terrain stays.
    const cleared = out(await aion.call("plan_route", { clear: true }));
    assert.match(cleared.content[0].text, /Removed the route; the terrain stays/);
    const after = await aion.link.run(backend => backend.state());
    assert.equal(after.presentation?.kind, "terrain");
    assert.equal(after.presentation?.kind === "terrain" && after.presentation.media.id, before.media.id);
    // "Reverse it" still works after the card closed (the route this server planned last).
    const back = out(await aion.call("plan_route", { reverse: true }));
    assert.equal(back.structuredContent.journey?.from, "Glasgow");
  } finally { await aion.close(); }
});

test("v0.6 plan_route: a route far from the terrain on show gets its own surroundings; failures change nothing", async () => {
  const routing = stubRouting();
  const aion = await connectAion({ resolver: geoResolver(), routing });
  try {
    await aion.call("show_terrain", { region: "France" });
    const france = (await aion.link.run(backend => backend.state())).presentation as Extract<HubSnapshot["presentation"], { kind: "terrain" }>;
    // With France on show, "Glasgow" is still the city Aion knows (never a search bounded to France).
    const scots = out(await aion.call("plan_route", { from: "Glasgow", to: "Edinburgh", mode: "cycling" }));
    assert.equal(scots.isError, undefined, scots.content[0].text);
    assert.ok(Math.abs(Number((scots.structuredContent.journey?.places as { lat: number }[])[0].lat) - 55.86) < 0.1, "Glasgow, Scotland");
    const hike = out(await aion.call("plan_route", { from: "54.4326, -2.9631", to: "54.4590, -3.0244", mode: "hiking" }));
    assert.equal(hike.isError, undefined, hike.content[0].text);
    const shown = (await aion.link.run(backend => backend.state())).presentation as Extract<HubSnapshot["presentation"], { kind: "interactive" }>;
    assert.notEqual(shown.terrain?.media.id, france.media.id, "a hike in the Lake District is not drawn on France");
    assert.match(String(hike.structuredContent.journey?.warnings), /cannot say whether a path is open, safe/);
    const id = shown.id;
    const failing = stubRouting(() => new RouteError("route-not-found"));
    const other = await connectAion({ home: aion.home, resolver: geoResolver(), routing: failing });
    try {
      const none = out(await other.call("plan_route", { from: "55.86, -4.25", to: "55.95, -3.19", mode: "walking" }));
      assert.equal(none.isError, true);
      assert.match(none.content[0].text, /^route-not-found: Test router found no route on foot between 55\.86, -4\.25 and 55\.95, -3\.19 on OpenStreetMap's paths\. Nothing was drawn/);
      assert.equal((await other.link.run(backend => backend.state())).presentation?.id, id, "what Aion shows is unchanged");
      // A follow-up on another conversation's route keeps that route's start (the hike's): far beyond a hike's reach.
      assert.match(out(await other.call("plan_route", { to: "Edinburgh" })).content[0].text, /^route-too-long/);
    } finally { await other.close(); }
    const fresh = await connectAion({ resolver: geoResolver(), routing: stubRouting() });
    try {
      const asks = out(await fresh.call("plan_route", { to: "Edinburgh" }));
      assert.match(asks.content[0].text, /route-needs-places: give from \(the start\)\. If the user did not say, ask them only that/);
    } finally { await fresh.close(); }
    const unknown = out(await aion.call("plan_route", { from: "Qwxzzz", to: "Edinburgh", mode: "walking" }));
    assert.equal(unknown.isError, true);
    assert.match(unknown.content[0].text, /place-(not-found|unavailable)/);
    const nowhere = out(await aion.call("plan_route", { clear: true }));
    assert.equal(nowhere.isError, undefined);
    assert.match(out(await aion.call("plan_route", { clear: true })).content[0].text, /no-route/);
  } finally { await aion.close(); }
});

// ── Task 2: Aion's own window, one window, the first-run welcome ───────────────────────────────────────────────────

test("v0.6 window: Aion opens in its own window by default, even where the host could embed it", async () => {
  const aion = await connectAion({ capabilities: MCP_APPS_CAPABILITIES });
  try {
    const opened = out(await aion.call("open_presence", { display: "immersive" }));
    assert.equal(opened.structuredContent.surface.mode, "companion");
    assert.equal(aion.opened.length, 1, "one window opened");
    assert.equal((await aion.link.run(backend => backend.state())).hub.surfaceMode, "companion");
  } finally { await aion.close(); }
  const plain = await connectAion();
  try {
    const asked = out(await plain.call("open_presence", { surface: "embedded" }));
    assert.equal(asked.structuredContent.surface.mode, "companion");
    assert.match(asked.content[0].text, /does not render MCP Apps, so Aion opened in its own window instead/);
  } finally { await plain.close(); }
  assert.equal(decideSurface(MCP_APPS_CAPABILITIES, undefined, {}).reason, "companion-default");
});

test("v0.6 window: several conversations asking at once open one window; an open window is reused", async () => {
  const first = await connectAion();
  const second = await connectAion({ home: first.home });
  try {
    const a = out(await first.call("open_presence", { display: "immersive" }));
    assert.equal(a.structuredContent.window_opened, true);
    assert.equal((await second.link.run(backend => backend.state())).hub.launching, true, "every process sees a window on its way");
    const b = out(await second.call("open_presence", { display: "immersive" }));
    assert.equal(b.structuredContent.window_opened, false);
    assert.equal(second.opened.length, 0, "no second window");
    assert.match(b.content[0].text, /already opening/);
    assert.equal(b.structuredContent.surface.open, true);
  } finally { await second.close(); await first.close(); }
  // A launch that failed (no browser could be started) does not make the next request wait.
  const home = tempHome();
  const hub = new PresenceHub({ home, port: 0, page: () => PAGE, bridge: { locate: () => null } });
  hub.apply({ type: "launching" });
  assert.equal(hub.snapshot().hub.launching, true);
  hub.apply({ type: "launching", failed: true });
  assert.equal(hub.snapshot().hub.launching, false);
});

test("v0.6 welcome: on a fresh installation only, remembered once seen, shown again when asked", async () => {
  const home = tempHome();
  const hub = new PresenceHub({ home, port: 0, page: () => PAGE, bridge: { locate: () => null } });
  assert.equal(hub.snapshot().hub.welcome, true, "a fresh installation");
  hub.apply({ type: "welcome", done: true });
  assert.equal(hub.snapshot().hub.welcome, false);
  assert.ok(existsSync(join(home, "welcome-complete")), "remembered in the plugin data");
  const later = new PresenceHub({ home, port: 0, page: () => PAGE, bridge: { locate: () => null } });
  assert.equal(later.snapshot().hub.welcome, false, "a returning user (another session) does not see it again");
  later.apply({ type: "welcome", show: true });
  assert.equal(later.snapshot().hub.welcome, true, "unless asked");
  later.apply({ type: "welcome", done: true });
  assert.equal(later.snapshot().hub.welcome, false);
  const aion = await connectAion();
  try {
    const opened = out(await aion.call("open_presence", { display: "immersive" }));
    assert.equal(opened.structuredContent.welcome, "shown");
    assert.match(opened.content[0].text, /the window shows examples, so do not list them/);
    await aion.link.run(backend => backend.apply({ type: "welcome", done: true }));
    const again = out(await aion.call("open_presence", { welcome: true }));
    assert.equal(again.structuredContent.welcome, "shown");
    assert.match(again.content[0].text, /getting-started introduction is on show/);
  } finally { await aion.close(); }
});

test("v0.6 welcome: three short examples in English and Chinese, each a real tool with arguments it accepts", () => {
  const inputs: Record<string, { safeParse(value: unknown): { success: boolean } }> = { show_terrain: schemas.showTerrainInput, plan_route: schemas.planRouteInput, show_interactive_card: schemas.showInteractiveCardInput };
  assert.equal(WELCOME_EXAMPLES.length, 3);
  for (const example of WELCOME_EXAMPLES) {
    assert.equal(inputs[example.tool].safeParse(example.args).success, true, example.tool);
    assert.ok(example.prompt.en.length < 60 && example.prompt.zh.length < 30);
  }
  for (const language of ["en", "zh"] as const) {
    const text = welcomeText(language);
    assert.ok(text.intro.length < 240, "read in well under half a minute");
    assert.match(text.intro, /Codex/, "Aion is Codex's visual presence");
    assert.doesNotMatch(text.intro, /another AI|second AI|独立的 AI/);
  }
});
