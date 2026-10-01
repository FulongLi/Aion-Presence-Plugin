import assert from "node:assert/strict";
import { crc32, deflateSync } from "node:zlib";
import { join } from "node:path";
import { test } from "node:test";
import { PLUGIN_ROOT } from "../scripts/lib/pluginPackage";
import { matchLocalAsset } from "../src/host/resolver/assets";
import { imageSize } from "../src/host/resolver/imageInfo";
import { PROVIDER_ORDER, resolveImage } from "../src/host/resolver/images";
import { VisualResolver } from "../src/host/resolver/index";
import { ALLOWED_HOSTS, checkedURL, fetchImage, HOSTS, safeFetch, USER_AGENT } from "../src/host/resolver/net";
import { decodePng } from "../src/host/resolver/png";
import { braveProvider } from "../src/host/resolver/sources/brave";
import { elevationTilesProvider, geocode, mercatorX, mercatorY, normalizeBox, planTiles, terrainLimits } from "../src/host/resolver/sources/terrain";
import type { ImageCandidate, ImageProvider, ResolveTrace } from "../src/host/resolver/types";
import {
  buildHeightField, decodeHeightField, decodeTerrarium, encodeHeightField, heightRange, rasterizePolygon, type TerrainSource,
} from "../src/visual/heightfield";
import { createTargetPoints, terrainLayout } from "../src/visual/points";
import type { Raster } from "../src/visual/types";

const signal = () => new AbortController().signal;
const trace = (): ResolveTrace => ({ action: "image", query: "", status: "resolving", chain: [] });
type Request = (input: URL, init?: RequestInit) => Promise<Response>;
const fetcher = (fn: Request) => fn as unknown as typeof fetch;

/** A PNG of `raster` (RGBA, 8 bit), each row written with `filter` (0–4) so the decoder's unfiltering is exercised. */
export function encodePng(raster: Raster, filters: number[] = [0, 1, 2, 3, 4]): Uint8Array {
  const { width, height, data } = raster, stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const filter = filters[y % filters.length];
    raw[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x++) {
      const v = data[y * stride + x], a = x >= 4 ? data[y * stride + x - 4] : 0, b = y ? data[(y - 1) * stride + x] : 0;
      const c = y && x >= 4 ? data[(y - 1) * stride + x - 4] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const predictor = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter];
      raw[y * (stride + 1) + 1 + x] = (v - predictor) & 0xff;
    }
  }
  const chunk = (name: string, body: Buffer) => {
    const head = Buffer.alloc(8); head.writeUInt32BE(body.length); head.write(name, 4, "latin1");
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])));
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}

/** Terrarium-encodes metres into an RGBA pixel. */
function encode(metres: number): [number, number, number, number] {
  const v = metres + 32768;
  return [Math.floor(v / 256), Math.floor(v) % 256, Math.round((v - Math.floor(v)) * 256) % 256, 255];
}

// ── the network guard ────────────────────────────────────────────────────────────────────────────────────

test("only HTTPS requests to the public data allowlist pass the guard", () => {
  assert.equal(checkedURL("https://en.wikipedia.org/w/api.php", [HOSTS.wikipedia]).hostname, "en.wikipedia.org");
  for (const bad of [
    "http://en.wikipedia.org/w/api.php", "https://en.wikipedia.org:8443/", "https://user:pw@commons.wikimedia.org/",
    "https://api.openai.com/v1/responses", "https://example.com/", "file:///etc/passwd", "https://evil.wikipedia.org.example.com/",
  ]) assert.throws(() => checkedURL(bad, ALLOWED_HOSTS), /url-rejected/, bad);
  // A host on the call's own list but not on the global allowlist is still refused.
  assert.throws(() => checkedURL("https://example.com/x.png", ["example.com"]), /url-rejected/);
});

test("requests identify the plugin, refuse redirects and credentials, and check type and size", async () => {
  let init: RequestInit | undefined;
  const ok = fetcher(async (_url, options) => { init = options; return new Response(new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]), { headers: { "content-type": "image/jpeg" } }); });
  await fetchImage("https://upload.wikimedia.org/a.jpg", { hosts: HOSTS.wikimediaImages, signal: signal(), request: ok });
  assert.equal(init?.redirect, "error");
  assert.equal(init?.credentials, "omit");
  assert.equal((init?.headers as Record<string, string>)["User-Agent"], USER_AGENT);
  const html = fetcher(async () => new Response("<html>", { headers: { "content-type": "text/html" } }));
  await assert.rejects(fetchImage("https://upload.wikimedia.org/a.jpg", { hosts: HOSTS.wikimediaImages, signal: signal(), request: html }), /type/);
  const liar = fetcher(async () => new Response("<svg onload=x>", { headers: { "content-type": "image/png" } }));
  await assert.rejects(fetchImage("https://upload.wikimedia.org/a.png", { hosts: HOSTS.wikimediaImages, signal: signal(), request: liar }), /type/);
  const big = fetcher(async () => new Response(new Uint8Array(2048), { headers: { "content-type": "image/png" } }));
  await assert.rejects(safeFetch("https://upload.wikimedia.org/a.png", { hosts: HOSTS.wikimediaImages, mimes: ["image/png"], maxBytes: 1024, signal: signal(), request: big }), /too-large/);
  const missing = fetcher(async () => new Response("", { status: 404 }));
  await assert.rejects(fetchImage("https://upload.wikimedia.org/a.png", { hosts: HOSTS.wikimediaImages, signal: signal(), request: missing }), /http-404/);
});

// ── image checks and decoding ────────────────────────────────────────────────────────────────────────────

test("PNG decoding is exact for every row filter (elevation must not be altered)", () => {
  const width = 7, height = 10, data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i++) data[i] = (i * 37 + (i >> 3) * 11) & 0xff;
  const decoded = decodePng(encodePng({ width, height, data }));
  assert.equal(decoded.width, width);
  assert.equal(decoded.height, height);
  assert.deepEqual(Array.from(decoded.data), Array.from(data));
  assert.throws(() => decodePng(new Uint8Array(40)), /png-invalid/);
});

test("image dimensions are read from PNG, JPEG and WebP headers without decoding", () => {
  const png = encodePng({ width: 9, height: 4, data: new Uint8ClampedArray(9 * 4 * 4) });
  assert.deepEqual(imageSize(png), { width: 9, height: 4 });
  // JPEG: SOI, APP0 (length 16), SOF0 with height 300, width 400.
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...new Array(14).fill(0), 0xff, 0xc0, 0, 17, 8, 1, 44, 1, 144, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(imageSize(jpeg), { width: 400, height: 300 });
  assert.equal(imageSize(new Uint8Array([1, 2, 3])), null);
});

// ── images and portraits ─────────────────────────────────────────────────────────────────────────────────

const JPEG = (width: number, height: number) => new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 3, ...new Array(12).fill(0)]);

function provider(name: string, candidates: Partial<ImageCandidate>[], calls: string[]): ImageProvider {
  return {
    name,
    async search(query) {
      calls.push(`${name}:${query}`);
      return candidates.map(candidate => ({
        provider: name, url: `https://upload.wikimedia.org/${name}.jpg`, title: query, relevance: 1, width: 600, height: 800, mime: "image/jpeg",
        load: async () => ({ bytes: JPEG(600, 800), mime: "image/jpeg" }), ...candidate,
      }));
    },
  };
}

test("portraits follow SCF's chain: Wikipedia first, and the result is framed as a portrait", async () => {
  assert.deepEqual(PROVIDER_ORDER.portrait, ["wikipedia", "web", "openverse", "commons"]);
  const calls: string[] = [];
  const resolver = new VisualResolver({ imageProviders: [provider("openverse", [{}], calls), provider("wikipedia", [{ title: "Nikola Tesla", pageUrl: "https://en.wikipedia.org/wiki/Nikola_Tesla" }], calls)] });
  const tesla = await resolver.portrait("Nikola Tesla");
  assert.deepEqual(calls, ["wikipedia:Nikola Tesla"]);
  assert.equal(tesla.fit, "portrait");
  assert.equal(tesla.label, "Nikola Tesla");
  assert.equal(tesla.mime, "image/jpeg");
  assert.equal(tesla.source.provider, "wikipedia");
  // A repeated request is served from memory.
  await resolver.portrait("Nikola Tesla");
  assert.equal(calls.length, 1);
});

test("image intents choose provider order and framing; nothing usable is 'not found', failures 'unavailable'", async () => {
  const calls: string[] = [];
  const resolver = new VisualResolver({ imageProviders: [provider("wikipedia", [], calls), provider("commons", [{ title: "Tesla Model Y 2023" }], calls), provider("openverse", [], calls)] });
  const car = await resolver.image("Tesla Model Y", "vehicle");
  assert.deepEqual(calls, ["wikipedia:Tesla Model Y", "commons:Tesla Model Y"]);
  assert.equal(car.fit, "object");
  assert.equal((await resolver.image("Europe", "map")).fit, "map");
  const empty = new VisualResolver({ imageProviders: [provider("wikipedia", [], []), provider("openverse", [], [])] });
  await assert.rejects(empty.portrait("Nobody Atall"), /portrait-not-found/);
  const broken = new VisualResolver({ imageProviders: [{ name: "wikipedia", search: async () => { throw new Error("http-503"); } }] });
  await assert.rejects(broken.portrait("Nikola Tesla"), /portrait-unavailable/);
  // A download that is not a sane image (tiny, or not an image at all) is refused server-side.
  const tiny = new VisualResolver({ imageProviders: [provider("wikipedia", [{ load: async () => ({ bytes: JPEG(10, 10), mime: "image/jpeg" }) }], [])] });
  await assert.rejects(tiny.portrait("Nikola Tesla"), /portrait-unavailable/);
});

test("ranking drops off-topic or unusable candidates before anything is downloaded", async () => {
  const t = trace();
  const loads: string[] = [];
  const candidates: Partial<ImageCandidate>[] = [
    { title: "Nikola Tesla signature", load: async () => { loads.push("signature"); return { bytes: JPEG(600, 800), mime: "image/jpeg" }; } },
    { title: "Nikola Tesla", load: async () => { loads.push("photo"); return { bytes: JPEG(600, 800), mime: "image/jpeg" }; } },
    { title: "Nikola Tesla", width: 40, height: 40 },
  ];
  const found = await resolveImage("Nikola Tesla", "portrait", { providers: [provider("wikipedia", candidates, [])] }, signal(), t, "portrait");
  assert.equal(found.candidate.title, "Nikola Tesla");
  assert.deepEqual(loads, ["photo"]);
  assert.match(t.chain[0].outcome, /selected/);
});

test("the Spirit Connect logo comes only from the plugin's own asset, never a web search", async () => {
  for (const query of ["Spirit Connect logo", "our company logo", "the Spirit Connect brand mark", "spiritconnect"]) assert.equal(matchLocalAsset(query)?.id, "spirit-connect-logo", query);
  for (const query of ["logo", "company", "Spirit Connect headquarters", "Tesla logo"]) assert.equal(matchLocalAsset(query), null, query);
  const calls: string[] = [];
  const resolver = new VisualResolver({ assetsDir: join(PLUGIN_ROOT, "assets"), imageProviders: [provider("openverse", [{}], calls)] });
  const logo = await resolver.image("Spirit Connect logo", "general");
  assert.equal(logo.fit, "logo");
  assert.equal(logo.mime, "image/svg+xml");
  assert.equal(logo.label, "Spirit Connect");
  assert.deepEqual(calls, [], "no provider was asked");
});

test("the optional keyed web search is off unless the user sets its key", () => {
  assert.equal(braveProvider({}), null);
  assert.equal(new VisualResolver({ env: {} }).providers.includes("web"), false);
  assert.equal(braveProvider({ AION_PRESENCE_BRAVE_SEARCH_KEY: "k" })?.name, "web");
});

// ── terrain ──────────────────────────────────────────────────────────────────────────────────────────────

test("terrarium decoding recovers metres; transparent pixels are no-data", () => {
  const data = new Uint8ClampedArray(16);
  data.set(encode(0), 0); data.set(encode(1085.5), 4); data.set(encode(-42), 8); data.set([0, 0, 0, 0], 12);
  const metres = decodeTerrarium({ width: 4, height: 1, data });
  assert.deepEqual(Array.from(metres.subarray(0, 3)), [0, 1085.5, -42]);
  assert.ok(Number.isNaN(metres[3]));
});

test("polygon rasterization fills the inside of rings (even-odd), including holes", () => {
  const square: [number, number][] = [[2, 2], [8, 2], [8, 8], [2, 8]];
  assert.equal(rasterizePolygon([square], 10, 10).reduce((a, b) => a + b, 0), 36);
  const hole: [number, number][] = [[4, 4], [6, 4], [6, 6], [4, 6]];
  assert.equal(rasterizePolygon([square, hole], 10, 10).reduce((a, b) => a + b, 0), 32);
});

test("region boxes: points grow, continents are capped, zoom and tiles stay bounded", () => {
  const point = normalizeBox({ west: 86.925, east: 86.925, south: 27.988, north: 27.988 });
  assert.ok(Math.abs(point.east - point.west - terrainLimits.pointSpan) < 1e-9);
  const huge = normalizeBox({ west: -170, east: 170, south: -80, north: 89 });
  assert.ok(huge.east - huge.west <= terrainLimits.maxSpan + 1e-9 && huge.north <= 84);
  const wales = planTiles(normalizeBox({ west: -5.81, east: -2.65, south: 51.23, north: 53.64 }));
  const uk = planTiles(normalizeBox({ west: -14.02, east: 2.09, south: 49.67, north: 61.06 }));
  for (const plan of [wales, uk]) assert.ok((plan.tx1 - plan.tx0 + 1) * (plan.ty1 - plan.ty0 + 1) <= terrainLimits.maxTiles);
  assert.ok(wales.z > uk.z, "a smaller region gets more detail");
  assert.ok(Math.abs(mercatorY(0, 0) - 128) < 1e-9 && Math.abs(mercatorX(0, 0) - 128) < 1e-9);
});

test("geocoding sends only the region: Nominatim with outline first, Photon as fallback", async () => {
  const urls: string[] = [];
  const nominatim = fetcher(async (input, init) => {
    urls.push(String(input));
    assert.equal((init?.headers as Record<string, string>)["User-Agent"], USER_AGENT, "Nominatim's usage policy: identify the app");
    return Response.json([{ name: "Cymru / Wales", boundingbox: ["51.2", "53.6", "-5.8", "-2.6"],
      geojson: { type: "MultiPolygon", coordinates: [[[[-5, 52], [-3, 52], [-3, 53], [-5, 53], [-5, 52]]]] } }]);
  });
  const wales = await geocode("Wales", signal(), nominatim);
  assert.equal(wales.label, "Cymru / Wales");
  assert.equal(wales.rings?.length, 1);
  assert.equal(new URL(urls[0]).searchParams.get("q"), "Wales");
  const photon = fetcher(async input => String(input).includes("nominatim")
    ? new Response("", { status: 503 })
    : Response.json({ features: [{ properties: { name: "Wales", extent: [-5.8, 53.6, -2.6, 51.2] } }] }));
  assert.equal((await geocode("Wales", signal(), photon)).provider, "photon");
  const nobody = fetcher(async input => String(input).includes("nominatim") ? Response.json([]) : Response.json({ features: [] }));
  await assert.rejects(geocode("Narnia", signal(), nobody), /region-not-found/);
});

/** A synthetic world: a mountain at (0.5°E, 50.7°N), plains west of 1.6°E, sea east of it; served as real PNG tiles. */
const world = (lon: number, lat: number) => lon < 1.6 ? 40 + 1500 * Math.exp(-((lon - 0.5) ** 2 + (lat - 50.7) ** 2) / 0.05) : -30;
const unproject = (px: number, py: number, z: number) => {
  const size = 256 * 2 ** z;
  return [px / size * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * py / size))) * 180 / Math.PI];
};
function tileWorld() {
  const tiles: string[] = [];
  const request = fetcher(async input => {
    const match = /terrarium\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(String(input));
    if (!match) return new Response("", { status: 404 });
    tiles.push(match.slice(1).join("/"));
    const [z, x, y] = match.slice(1).map(Number);
    const data = new Uint8ClampedArray(256 * 256 * 4);
    for (let py = 0; py < 256; py++) for (let px = 0; px < 256; px++) {
      const [lon, lat] = unproject(x * 256 + px + 0.5, y * 256 + py + 0.5, z);
      data.set(encode(world(lon, lat)), (py * 256 + px) * 4);
    }
    return new Response(Buffer.from(encodePng({ width: 256, height: 256, data }, [1, 2, 4])), { headers: { "content-type": "image/png" } });
  });
  return { request, tiles };
}
const testland = async () => ({ label: "Testland", provider: "test", box: { west: 0, east: 2, south: 50, north: 51.5 },
  rings: [[[0, 50], [1.2, 50], [1.2, 51.5], [0, 51.5], [0, 50]] as [number, number][]] });

test("elevation tiles: region → bounded set of real PNG tiles → masked elevation grid in metres", async () => {
  const { request, tiles } = tileWorld();
  const source = await elevationTilesProvider(undefined, request, testland).resolve("Testland", "terrain", signal());
  assert.ok(tiles.length > 0 && tiles.length <= terrainLimits.maxTiles, `${tiles.length} tiles`);
  assert.equal(source.kind, "elevation");
  assert.ok(Math.max(source.width, source.height) <= 160);
  assert.ok(source.mask, "the outline became a mask");
  let max = -Infinity;
  for (let i = 0; i < source.values.length; i++) if (source.mask![i]) max = Math.max(max, source.values[i]);
  assert.ok(max > 1200, `peak ${max} m`);
});

test("height field: land only, percentile-normalized, relief from the real range; survives the byte codec", () => {
  const w = 40, h = 30, values = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) values[y * w + x] = x >= 30 ? -50 : 20 + 900 * Math.exp(-((x - 12) ** 2 + (y - 15) ** 2) / 30);
  values[3 * w + 3] = 9000;
  const source: TerrainSource = { provider: "test", kind: "elevation", width: w, height: h, values, aspect: 4 / 3, label: "Test" };
  const field = buildHeightField(source, "terrain");
  assert.ok(field.width <= 32, "the sea is cropped away");
  const { min, max } = heightRange(field);
  assert.ok(min >= 0 && max <= 1 && max - min > 0.5);
  assert.equal(field.elevation?.max, 9000);
  const back = decodeHeightField(encodeHeightField(field));
  assert.equal(back.width, field.width);
  assert.deepEqual(back.mask && Array.from(back.mask), field.mask && Array.from(field.mask));
  for (let i = 0; i < field.values.length; i++) assert.ok(Math.abs(back.values[i] - field.values[i]) < 1 / 30000);
  assert.ok(Math.abs(back.aspect - field.aspect) < 1e-5 && Math.abs(back.relief - field.relief) < 1e-6);
  assert.throws(() => decodeHeightField(new Uint8Array(10)), /heightfield-invalid/);
  const forged = encodeHeightField(field); forged[4] = 255; forged[5] = 255;
  assert.throws(() => decodeHeightField(forged), /heightfield-invalid/);
});

test("terrain resolves to a height field the particle body can sample as 2.5D relief", async () => {
  const { request } = tileWorld();
  const resolver = new VisualResolver({ terrainProviders: [elevationTilesProvider(undefined, request, testland)] });
  const terrain = await resolver.terrain("Testland", "relief");
  assert.equal(terrain.label, "Testland");
  const points = createTargetPoints({ kind: "heightfield", field: decodeHeightField(terrain.bytes), style: "relief" }, 4000);
  assert.equal(points.positions.length, 12_000);
  let top = -Infinity, bottom = Infinity;
  for (let i = 0; i < 4000; i++) { top = Math.max(top, points.positions[i * 3 + 1]); bottom = Math.min(bottom, points.positions[i * 3 + 1]); }
  assert.ok(top - bottom > terrainLayout.height * 0.3, "it stands as relief, not a flat image");
  const unknown = new VisualResolver({ terrainProviders: [{ name: "t", resolve: async () => { throw new Error("region-not-found"); } }] });
  await assert.rejects(unknown.terrain("Narnia"), /region-not-found/);
  const down = new VisualResolver({ terrainProviders: [{ name: "t", resolve: async () => { throw new Error("http-503"); } }] });
  await assert.rejects(down.terrain("Wales"), /terrain-unavailable/);
});
