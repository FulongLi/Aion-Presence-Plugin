import { angle, describePolygons, frameWindow, unit, type GeoPolygon } from "../../visual/geo/extent";
import { fillRings, outlineLines, type GeoMap } from "../../visual/geo/map";
import { project, unproject, wrapLon, type Frame } from "../../visual/geo/projection";
import type { GeoRegion } from "./region";
import { worldRegions } from "./world";

/**
 * The map of a region through its frame: its outline and land, the borders between a group's members, and every
 * neighbour in view, faintly, so "where Los Angeles is in the USA" has Canada and Mexico around it.
 */
export function buildMap(region: GeoRegion, frame: Frame): GeoMap {
  const own = new Set(region.ids);
  const window = frameWindow(frame);
  const mid = [(window.west + window.east) / 2, (window.south + window.north) / 2];
  const centre = unit(mid[0], mid[1]);
  const edges = [[window.west, window.south], [window.west, window.north], [window.east, window.south], [window.east, window.north],
    [window.west, mid[1]], [window.east, mid[1]], [mid[0], window.south], [mid[0], window.north]];
  const reach = Math.max(...edges.map(([lon, lat]) => angle(centre, unit(lon, lat)))) + 5;
  const { x0, y0, x1, y1 } = frame, mx = (x1 - x0) * 0.15, my = (y1 - y0) * 0.15;
  const centreGeo = unproject((x0 + x1) / 2, (y0 + y1) / 2, frame.projection);
  // A polygon is in view when a vertex is, or when it contains the whole view (the Grand Canyon lies inside the United States).
  const inView = (polygon: GeoPolygon) => (polygon[0] ?? []).some(([lon, lat]) => {
    const xy = project(lon, lat, frame.projection);
    return xy !== null && xy[0] > x0 - mx && xy[0] < x1 + mx && xy[1] > y0 - my && xy[1] < y1 + my;
  }) || (centreGeo !== null && containsPoint(polygon[0] ?? [], centreGeo));
  // Neighbours: regions with a part in view (a unit's siblings — England beside Scotland — instead of their whole country).
  const parents = new Set(region.ids.map(id => id.includes(".") ? id.split(".")[0] : ""));
  const neighbours: GeoPolygon[] = [];
  for (const other of worldRegions()) {
    // A unit's own country is drawn as its other units (not whole, over it); other countries are drawn whole.
    if (own.has(other.id) || parents.has(other.id)) continue;
    if (other.parent && !parents.has(other.parent)) continue;
    for (const [k, info] of describePolygons(other.polygons).entries()) {
      if (angle(centre, info.centre) - info.radius < reach && inView(other.polygons[k])) neighbours.push(other.polygons[k]);
    }
  }
  const members = region.members ?? [];
  const minStep = Math.max(0.0015, Math.min(0.004, (frame.x1 - frame.x0) / 600));
  return {
    v: 1, frame, label: region.label,
    focus: members.length ? [] : outlineLines(region.focus, frame, { minStep }),
    borders: members.length ? outlineLines(members.flat(), frame, { minStep }) : [],
    context: outlineLines(neighbours, frame, { minStep: minStep * 1.5 }),
    fill: fillRings(region.focus, frame, minStep),
    contextFill: fillRings(neighbours, frame, minStep * 1.5),
  };
}

/** Even-odd point in polygon on longitude and latitude (longitudes taken relative to the point, so the date line is no seam). */
export function containsPoint(ring: readonly [number, number][], [lon, lat]: [number, number]): boolean {
  let within = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = wrapLon(ring[i][0] - lon), yi = ring[i][1], xj = wrapLon(ring[j][0] - lon), yj = ring[j][1];
    if (Math.abs(xi - xj) > 180) continue;
    if ((yi > lat) !== (yj > lat) && 0 < (xj - xi) * (lat - yi) / (yj - yi) + xi) within = !within;
  }
  return within;
}
