import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VisualResolver } from "../../src/host/resolver";
import { planRoute } from "../../src/host/route/planner";
import { routingProvider } from "../../src/host/route/providers";
import { errorCode, errorDetail } from "../../src/visual/errors";
import { formatDistance, formatDuration, type TravelMode } from "../../src/visual/geo/route";

/**
 * Real routing checks (v0.6): the acceptance scenarios planned against the configured provider (by default FOSSGIS's
 * public Valhalla, one request a second) and the real elevation model. Prints each result and writes the evidence to
 * docs/media/v0.6.0/routes.json. `npm run route:verify` (network required; about 15 requests in all).
 */
const SCENARIOS: { id: string; from: string; to: string; mode: TravelMode; via?: string[]; near?: string; expect: "route" | "failure" }[] = [
  { id: "A-cycling", from: "Glasgow", to: "Edinburgh", mode: "cycling", near: "Scotland", expect: "route" },
  { id: "B-hiking", from: "Ambleside", to: "Grasmere", mode: "hiking", near: "England", expect: "route" },
  { id: "C-walking", from: "Edinburgh Castle", to: "Arthur's Seat", mode: "walking", near: "Scotland", expect: "route" },
  { id: "D-reversed", from: "Edinburgh", to: "Glasgow", mode: "cycling", near: "Scotland", expect: "route" },
  { id: "D-waypoint", from: "Glasgow", to: "Edinburgh", via: ["Linlithgow"], mode: "cycling", near: "Scotland", expect: "route" },
  { id: "E-ocean", from: "London", to: "New York", mode: "walking", expect: "failure" },
  { id: "E-no-path", from: "-80.0, 0.0", to: "-80.1, 0.2", mode: "walking", expect: "failure" },
];

const resolver = new VisualResolver();
const { provider, note } = routingProvider();
if (note) console.log(note);
const evidence: unknown[] = [];
let failures = 0;
for (const scenario of SCENARIOS) {
  const started = Date.now();
  try {
    const region = scenario.near ? await resolver.region(scenario.near) : undefined;
    const planned = await planRoute({ from: scenario.from, to: scenario.to, via: scenario.via, mode: scenario.mode }, {
      provider, signal: AbortSignal.timeout(60_000), locate: name => resolver.place(name, region ? { region } : undefined),
    });
    const r = planned.route;
    console.log(`${scenario.id}: ${r.origin.name} → ${r.destination.name} (${r.travelMode}) ${formatDistance(r.distanceMeters)}, ${formatDuration(r.estimatedDurationSeconds)}, `
      + `↑${r.totalAscentMeters} m ↓${r.totalDescentMeters} m, ${r.minimumElevationMeters}–${r.maximumElevationMeters} m, ${r.coordinates.length} points (±${r.toleranceMeters} m), `
      + `${r.elevationSamples.length} samples, ${r.source.elevation}; ${Date.now() - started} ms${r.warnings.length ? `\n   warnings: ${r.warnings.join(" | ")}` : ""}`);
    if (scenario.expect !== "route") failures++;
    evidence.push({ scenario, ok: true, ms: Date.now() - started, summary: { ...r, coordinates: `${r.coordinates.length} points`, elevationSamples: `${r.elevationSamples.length} samples`, first: r.coordinates[0], last: r.coordinates.at(-1) } });
  } catch (error) {
    console.log(`${scenario.id}: ${errorCode(error)}${errorDetail(error) ? ` (${errorDetail(error)})` : ""}; ${Date.now() - started} ms`);
    if (scenario.expect !== "failure") failures++;
    evidence.push({ scenario, ok: false, code: errorCode(error), detail: errorDetail(error) ?? null, ms: Date.now() - started });
  }
}
const out = join("docs", "media", "v0.6.0");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "routes.json"), `${JSON.stringify({ at: new Date().toISOString(), provider: provider.label, evidence }, null, 2)}\n`);
console.log(failures ? `${failures} scenario(s) did not behave as expected` : "every scenario behaved as expected");
process.exitCode = failures ? 1 : 0;
