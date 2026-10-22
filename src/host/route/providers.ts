import { ResolveError } from "../../visual/errors";
import type { TravelMode } from "../../visual/geo/route";
import { configuredEndpoint, HOSTS, requestJSON, type Fetcher } from "../resolver/net";

/**
 * Routing providers (v0.6): real paths over OpenStreetMap's road, path and trail network, from a routing service.
 * Aion never computes or invents a route itself, and Codex never supplies coordinates for one: a provider answers with
 * its own geometry, or with why it has none.
 *
 *   valhalla          default. FOSSGIS e.V.'s public server (valhalla1.openstreetmap.de, the router behind
 *                     openstreetmap.org's directions), used under its fair-use policy — one request a second at most,
 *                     an identifying User-Agent and X-Client-Id, no bulk use — or any Valhalla the user runs
 *                     (AION_ROUTING_VALHALLA_URL, e.g. http://localhost:8002), where that policy does not apply.
 *   openrouteservice  optional: HeiGIT's service with the user's own free key (AION_ROUTING_ORS_KEY).
 *
 * Only the coordinates of the places (already geocoded) are sent — never names, conversation text or anything else.
 */
export interface ProviderRoute {
  /** [lon, lat] in degrees, the provider's own geometry. */
  coordinates: [number, number][];
  distanceMeters: number;
  durationSeconds: number;
  /** Notes the provider gives about the route (a ferry, a toll, an unpaved section…). */
  notes: string[];
}

export interface RoutingProvider {
  readonly id: "valhalla" | "openrouteservice";
  /** How the provider is named in results and the card. */
  readonly label: string;
  /** The attribution its terms ask for. */
  readonly attribution: string;
  /** The longest route it plans for each mode, in metres (its own limits; a longer request is refused before sending). */
  readonly maxMeters: Record<TravelMode, number>;
  route(points: readonly [number, number][], mode: TravelMode, signal: AbortSignal): Promise<ProviderRoute>;
}

/**
 * Stable, model-safe failure codes (their words are in the MCP server):
 *   route-not-found        the network has no path between the places for this mode
 *   route-point-unroutable a place is too far from any path the mode may use (a sea, a private estate, no data)
 *   route-too-long         longer than the provider plans for this mode
 *   route-rate-limited     the provider asked us to slow down
 *   route-unavailable      the provider could not be reached or failed (detail: timeout, network, http-5xx…)
 *   route-invalid          the provider answered with something that is not a usable route
 */
export class RouteError extends ResolveError {}

/** Decodes an encoded polyline (Google's format) with `precision` decimal places (Valhalla uses 6, ORS 5). */
export function decodePolyline(encoded: string, precision = 6): [number, number][] {
  const factor = 10 ** precision, out: [number, number][] = [];
  let index = 0, lat = 0, lon = 0;
  const next = () => {
    let result = 0, shift = 0, byte: number;
    do {
      if (index >= encoded.length) throw new RouteError("route-invalid", "polyline");
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && shift < 35);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < encoded.length) {
    lat += next(); lon += next();
    out.push([lon / factor, lat / factor]);
  }
  return out;
}

/** One request a second to a shared public server, whoever in this process asks (its fair-use policy). */
function politeQueue(minIntervalMs: number) {
  let last = 0, chain: Promise<void> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const run = chain.then(async () => {
      const wait = last + minIntervalMs - Date.now();
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
      last = Date.now();
    });
    chain = run.catch(() => {});
    return run.then(work);
  };
}
const fossgisQueue = politeQueue(1100);

type ValhallaResponse = {
  trip?: { legs?: { shape?: string; summary?: { length?: number; time?: number } }[]; summary?: { length?: number; time?: number; has_ferry?: boolean; has_toll?: boolean; has_highway?: boolean } };
  error_code?: number; error?: string; status_code?: number;
};

/** Valhalla's costing for each travel mode. Hiking allows mountain paths up to SAC T3 (demanding mountain hiking). */
export function valhallaCosting(mode: TravelMode) {
  switch (mode) {
    case "walking": return { costing: "pedestrian", costing_options: { pedestrian: { max_hiking_difficulty: 1 } } };
    case "hiking": return { costing: "pedestrian", costing_options: { pedestrian: { max_hiking_difficulty: 3, use_hills: 0.5 } } };
    case "cycling": return { costing: "bicycle", costing_options: { bicycle: { bicycle_type: "Hybrid", use_roads: 0.25 } } };
  }
}

/** Valhalla's error codes (https://valhalla.github.io/valhalla/api/turn-by-turn/api-reference/) as Aion's. */
export function valhallaFailure(code: number | undefined, status: number): RouteError {
  if (status === 429) return new RouteError("route-rate-limited");
  switch (code) {
    case 154: case 155: case 156: case 157: return new RouteError("route-too-long");
    case 170: case 171: return new RouteError("route-point-unroutable");
    case 442: case 443: return new RouteError("route-not-found");
    case 125: case 126: case 150: case 151: case 152: case 153: return new RouteError("route-invalid", `valhalla-${code}`);
    default: return status >= 500 ? new RouteError("route-unavailable", `http-${status}`) : new RouteError("route-not-found", code ? `valhalla-${code}` : `http-${status}`);
  }
}

export function valhallaProvider(env: NodeJS.ProcessEnv = process.env, request?: Fetcher): RoutingProvider {
  const own = configuredEndpoint(env.AION_ROUTING_VALHALLA_URL);
  const base = own ?? new URL(`https://${HOSTS.valhalla}/`);
  const shared = !own;
  return {
    id: "valhalla",
    label: shared ? "Valhalla (FOSSGIS)" : `Valhalla (${base.host})`,
    attribution: shared ? "Routing: Valhalla on FOSSGIS e.V.'s server · © OpenStreetMap contributors (ODbL)" : "Routing: Valhalla · © OpenStreetMap contributors (ODbL)",
    // FOSSGIS's limits (observed 2026-10-22: pedestrian 100 km, bicycle 150 km); a self-hosted server has its own.
    maxMeters: shared ? { walking: 100_000, hiking: 100_000, cycling: 150_000 } : { walking: 500_000, hiking: 500_000, cycling: 1_000_000 },
    async route(points, mode, signal) {
      const body = JSON.stringify({
        locations: points.map(([lon, lat]) => ({ lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6 })),
        ...valhallaCosting(mode), directions_type: "none", units: "kilometers",
      });
      const send = () => requestJSON<ValhallaResponse>(new URL("route", base), {
        hosts: [HOSTS.valhalla], signal, request, body, ...(own ? { trusted: own } : {}), timeoutMs: 15_000,
        // FOSSGIS asks apps used by end users to identify themselves this way.
        headers: { "X-Client-Id": "aion-presence" },
      });
      let answer: Awaited<ReturnType<typeof send>>;
      try { answer = await (shared ? fossgisQueue(send) : send()); } catch (error) {
        signal.throwIfAborted();
        const code = error instanceof Error ? error.message : "error";
        if (code === "http-429") throw new RouteError("route-rate-limited");
        throw new RouteError("route-unavailable", code);
      }
      const { status, data } = answer;
      if (status !== 200 || !data.trip) throw valhallaFailure(data.error_code, status);
      const legs = data.trip.legs ?? [];
      const coordinates: [number, number][] = [];
      for (const leg of legs) {
        if (typeof leg.shape !== "string") throw new RouteError("route-invalid", "shape");
        const shape = decodePolyline(leg.shape, 6);
        coordinates.push(...(coordinates.length ? shape.slice(1) : shape));
      }
      const length = data.trip.summary?.length, time = data.trip.summary?.time;
      if (!Number.isFinite(length) || !Number.isFinite(time) || coordinates.length < 2) throw new RouteError("route-invalid", "summary");
      const notes = [data.trip.summary?.has_ferry && "includes a ferry", data.trip.summary?.has_toll && "includes a toll"].filter((note): note is string => !!note);
      return { coordinates, distanceMeters: length! * 1000, durationSeconds: time!, notes };
    },
  };
}

type OrsResponse = {
  features?: { geometry?: { type?: string; coordinates?: number[][] }; properties?: { summary?: { distance?: number; duration?: number } } }[];
  error?: { code?: number; message?: string } | string;
};

export const ORS_PROFILES: Record<TravelMode, string> = { walking: "foot-walking", hiking: "foot-hiking", cycling: "cycling-regular" };

/** OpenRouteService's error codes (https://giscience.github.io/openrouteservice/api-reference/error-codes) as Aion's. */
export function orsFailure(code: number | undefined, status: number): RouteError {
  if (status === 429) return new RouteError("route-rate-limited");
  if (status === 401 || status === 403) return new RouteError("route-unavailable", "key-refused");
  switch (code) {
    case 2004: return new RouteError("route-too-long");
    case 2010: return new RouteError("route-point-unroutable");
    case 2009: return new RouteError("route-not-found");
    default: return status >= 500 ? new RouteError("route-unavailable", `http-${status}`) : new RouteError("route-not-found", code ? `ors-${code}` : `http-${status}`);
  }
}

/** OpenRouteService with the user's own key; null when no key is configured. The key is sent only to ORS, as a header. */
export function openRouteServiceProvider(env: NodeJS.ProcessEnv = process.env, request?: Fetcher): RoutingProvider | null {
  const key = env.AION_ROUTING_ORS_KEY?.trim();
  if (!key || !/^[A-Za-z0-9=_-]{16,200}$/.test(key)) return null;
  return {
    id: "openrouteservice",
    label: "openrouteservice",
    attribution: "Routing: © openrouteservice.org by HeiGIT · © OpenStreetMap contributors (ODbL)",
    maxMeters: { walking: 300_000, hiking: 300_000, cycling: 300_000 },
    async route(points, mode, signal) {
      const body = JSON.stringify({ coordinates: points.map(([lon, lat]) => [Math.round(lon * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6]), instructions: false });
      let answer: { status: number; data: OrsResponse };
      try {
        answer = await requestJSON<OrsResponse>(`https://${HOSTS.openrouteservice}/v2/directions/${ORS_PROFILES[mode]}/geojson`, {
          hosts: [HOSTS.openrouteservice], signal, request, body, timeoutMs: 15_000,
          mimes: ["application/json", "application/geo+json"], headers: { Authorization: key },
        });
      } catch (error) {
        signal.throwIfAborted();
        const code = error instanceof Error ? error.message : "error";
        if (code === "http-429") throw new RouteError("route-rate-limited");
        throw new RouteError("route-unavailable", code);
      }
      const { status, data } = answer;
      const feature = data.features?.[0];
      if (status !== 200 || !feature) throw orsFailure(typeof data.error === "object" ? data.error?.code : undefined, status);
      const raw = feature.geometry?.type === "LineString" ? feature.geometry.coordinates ?? [] : [];
      const coordinates = raw.filter(c => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1])).map(c => [c[0], c[1]] as [number, number]);
      const summary = feature.properties?.summary;
      if (coordinates.length < 2 || !Number.isFinite(summary?.distance) || !Number.isFinite(summary?.duration)) throw new RouteError("route-invalid", "summary");
      return { coordinates, distanceMeters: summary!.distance!, durationSeconds: summary!.duration!, notes: [] };
    },
  };
}

/**
 * The provider in use: AION_ROUTING_PROVIDER = valhalla (default) | openrouteservice. OpenRouteService needs its key;
 * without one the default is kept and the reason is given.
 */
export function routingProvider(env: NodeJS.ProcessEnv = process.env, request?: Fetcher): { provider: RoutingProvider; note?: string } {
  if (env.AION_ROUTING_PROVIDER === "openrouteservice") {
    const ors = openRouteServiceProvider(env, request);
    if (ors) return { provider: ors };
    return { provider: valhallaProvider(env, request), note: "AION_ROUTING_PROVIDER is openrouteservice but AION_ROUTING_ORS_KEY is missing or malformed: using Valhalla." };
  }
  return { provider: valhallaProvider(env, request) };
}
