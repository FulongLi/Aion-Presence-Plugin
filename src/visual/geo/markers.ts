import { terrainWorldPoint } from "../points";
import type { VisualTarget } from "../types";
import { mapWorldPoint } from "./map";
import { geoToNormal, project } from "./projection";

/**
 * Where a latitude and longitude stands on the formed body, through exactly the geometry the samplers used: on a map,
 * through its frame; on terrain, onto the cell of the height field and up to its relief. Null when the visual has no
 * geography, or the place is outside it. The marker layer draws there; tests hold it to the samplers.
 */
export function markerWorldPoint(target: VisualTarget | null | undefined, lon: number, lat: number): [number, number, number] | null {
  if (!target) return null;
  if (target.kind === "map") {
    const n = geoToNormal(lon, lat, target.map.frame);
    return n ? mapWorldPoint(n[0], n[1], 0.06) : null;
  }
  if (target.kind === "heightfield" && target.field.geo) {
    const { geo } = target.field;
    const xy = project(lon, lat, geo.projection);
    if (!xy) return null;
    const u = (xy[0] - geo.x0) / (geo.x1 - geo.x0), v = (geo.y1 - xy[1]) / (geo.y1 - geo.y0);
    if (u < -0.02 || u > 1.02 || v < -0.02 || v > 1.02) return null;
    return terrainWorldPoint(target.field, u, v, 0.04);
  }
  return null;
}
