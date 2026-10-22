import { ResolveError, errorCode, errorDetail } from "../../visual/errors";
import {
  elevationStats, haversine, roundClimb, ROUTE_LIMITS, routeAlong, routePointAt, simplifyToLimit, validateRoute,
  type GeoRoute, type RoutePlace, type RoutePoint, type TravelMode,
} from "../../visual/geo/route";
import type { FoundPlace } from "../geo/region";
import { sampleElevation, type ElevationProfile } from "./elevation";
import { RouteError, type RoutingProvider } from "./providers";

/**
 * The Route Planner (v0.6): places by name → real coordinates (Aion's gazetteer, then OpenStreetMap, exactly as markers
 * are found) → a routing provider's real path → checked, simplified for display within a stated tolerance → elevation
 * sampled along it → one validated GeoRoute. Nothing here invents geometry: if the provider has no path, there is no
 * route, and the error says why.
 */
/** A place by name (or "lat, lon"), or one already found (a follow-up keeps the route's own places). */
export type PlaceInput = string | RoutePlace;
export interface PlanRequest { from: PlaceInput; to: PlaceInput; via?: readonly PlaceInput[]; mode: TravelMode }

export interface PlanDependencies {
  provider: RoutingProvider;
  /** Finds a place by name (the resolver's `place`, near the region on show). */
  locate(name: string): Promise<FoundPlace>;
  /** Elevation along the route (injectable for tests). */
  elevation?(coordinates: readonly [number, number][], signal: AbortSignal): Promise<ElevationProfile>;
  signal: AbortSignal;
  random?: () => number;
}

/** "55.9486, -3.1999" (latitude first, as people write them) → a place at exactly those coordinates. */
export function parseCoordinates(text: string): RoutePlace | null {
  const match = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(text);
  if (!match) return null;
  const lat = Number(match[1]), lon = Number(match[2]);
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return null;
  return { name: `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? "N" : "S"}, ${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? "E" : "W"}`, lat, lon };
}

const tidyName = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, ROUTE_LIMITS.name);

/** A place the user named, found (what they called it is kept as its name). */
async function resolvePlace(input: PlaceInput, deps: PlanDependencies): Promise<RoutePlace> {
  if (typeof input !== "string") return { name: input.name, lat: input.lat, lon: input.lon };
  const text = input;
  const exact = parseCoordinates(text);
  if (exact) return exact;
  try {
    const found = await deps.locate(text);
    return { name: tidyName(text), lat: Math.round(found.lat * 1e6) / 1e6, lon: Math.round(found.lon * 1e6) / 1e6 };
  } catch (error) {
    deps.signal.throwIfAborted();
    const code = errorCode(error);
    throw new ResolveError(code === "place-not-found" || code === "place-unavailable" ? code : "place-unavailable", text.slice(0, 80));
  }
}

const id = (random: () => number) => `r${Array.from({ length: 12 }, () => Math.floor(random() * 36).toString(36)).join("")}`;

const MODE_NOTES: Record<TravelMode, string | null> = {
  walking: null,
  cycling: null,
  hiking: "Paths come from OpenStreetMap: Aion cannot say whether a path is open, safe, legally accessible or suitable today.",
};

export interface PlannedRoute { route: GeoRoute; places: RoutePlace[]; elevationError?: string }

export async function planRoute(request: PlanRequest, deps: PlanDependencies): Promise<PlannedRoute> {
  const via = (request.via ?? []).slice(0, ROUTE_LIMITS.waypoints);
  const places: RoutePlace[] = [];
  for (const text of [request.from, ...via, request.to]) places.push(await resolvePlace(text, deps));
  // A straight line is the shortest any route can be: beyond the provider's limit there is no need to ask it.
  let straight = 0;
  for (let i = 1; i < places.length; i++) straight += haversine([places[i - 1].lon, places[i - 1].lat], [places[i].lon, places[i].lat]);
  if (straight > deps.provider.maxMeters[request.mode]) throw new RouteError("route-too-long", `${Math.round(straight / 1000)} km`);
  if (straight < 20) throw new RouteError("route-same-place");

  const path = await deps.provider.route(places.map(p => [p.lon, p.lat]), request.mode, deps.signal);
  // The provider's geometry is checked before anything shows it.
  if (path.coordinates.some(([lon, lat]) => !(Math.abs(lon) <= 180 && Math.abs(lat) <= 90))) throw new RouteError("route-invalid", "coordinates");
  if (!(path.distanceMeters > 0) || path.distanceMeters > ROUTE_LIMITS.distanceMeters) throw new RouteError("route-invalid", "distance");
  const warnings: string[] = [];
  // How near the path starts and ends to the places asked for (a summit off the path network, a castle's interior…).
  const ends = [
    { place: places[0], at: path.coordinates[0] },
    { place: places[places.length - 1], at: path.coordinates[path.coordinates.length - 1] },
  ];
  for (const { place, at } of ends) {
    const gap = haversine([place.lon, place.lat], at);
    if (gap > 10_000) throw new RouteError("route-point-unroutable", place.name);
    if (gap > Math.max(300, path.distanceMeters * 0.02)) warnings.push(`The route ${place === places[0] ? "starts" : "ends"} ${gap >= 1000 ? `${(gap / 1000).toFixed(1)} km` : `${Math.round(gap)} m`} from ${place.name}: as near as the path network reaches.`);
  }
  const simplified = simplifyToLimit(path.coordinates);
  const coordinates = simplified.coordinates.map(([lon, lat]) => [Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5] as [number, number]);
  for (const note of path.notes) warnings.push(`The route ${note}.`);
  const modeNote = MODE_NOTES[request.mode];
  if (modeNote) warnings.push(modeNote);

  // Elevation along the provider's full geometry (not the simplified one): the profile follows the real path.
  let profile: ElevationProfile | null = null, elevationError: string | undefined;
  try { profile = await (deps.elevation ?? ((c, s) => sampleElevation(c, s)))(path.coordinates, deps.signal); } catch (error) {
    deps.signal.throwIfAborted();
    elevationError = errorDetail(error) ?? errorCode(error);
    warnings.push("No elevation could be read for this route, so it has no profile or climbing figures.");
  }
  const scale = profile && profile.samples.length ? path.distanceMeters / Math.max(1, profile.samples[profile.samples.length - 1][0]) : 1;
  const samples: [number, number][] = profile ? profile.samples.map(([d, e]) => [Math.round(d * scale), Math.round(e * 10) / 10]) : [];
  // Strictly increasing distances, as the document requires.
  const unique = samples.filter((s, i) => i === 0 || s[0] > samples[i - 1][0]).slice(0, ROUTE_LIMITS.samples);
  const stats = elevationStats(unique);
  const draft = {
    id: id(deps.random ?? Math.random),
    origin: places[0], destination: places[places.length - 1], waypoints: places.slice(1, -1),
    travelMode: request.mode,
    source: { routing: deps.provider.label, elevation: profile?.source ?? "none", attribution: deps.provider.attribution },
    coordinates, toleranceMeters: simplified.tolerance,
    distanceMeters: Math.round(path.distanceMeters), estimatedDurationSeconds: Math.round(path.durationSeconds),
    elevationSamples: unique, sampleSpacingMeters: profile ? Math.round(profile.spacing * scale) : 0,
    totalAscentMeters: stats ? roundClimb(stats.ascent) : null, totalDescentMeters: stats ? roundClimb(stats.descent) : null,
    minimumElevationMeters: stats ? Math.round(stats.min) : null, maximumElevationMeters: stats ? Math.round(stats.max) : null,
    highest: null as RoutePoint | null, lowest: null as RoutePoint | null,
    warnings: warnings.slice(0, ROUTE_LIMITS.warnings).map(w => w.slice(0, ROUTE_LIMITS.warning)),
  } satisfies GeoRoute;
  if (stats) {
    const along = routeAlong(draft);
    const point = (index: number): RoutePoint => {
      const [d, e] = unique[index];
      const [lon, lat] = routePointAt(draft, d, along);
      return { distanceMeters: d, lon: Math.round(lon * 1e5) / 1e5, lat: Math.round(lat * 1e5) / 1e5, elevationMeters: Math.round(e) };
    };
    draft.highest = point(stats.highestIndex);
    draft.lowest = point(stats.lowestIndex);
  }
  const checked = validateRoute(draft);
  if (!checked.ok) throw new RouteError("route-invalid", checked.problem.slice(0, 80));
  return { route: checked.route, places, ...(elevationError ? { elevationError } : {}) };
}
