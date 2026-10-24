import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runJob, type JobSpec } from "./job";
import { findSimTools, toolsReport } from "./tools";

/**
 * v0.8: the simulation job runner (runtime/aion-sim.mjs). The MCP server starts it detached for every run, so a solve
 * outlives one tool call and one Codex turn; it is also the command-line entry another host (AIPE) can use:
 *
 *   node aion-sim.mjs job <run directory>   runs the job described by <run directory>/job.json (status in status.json)
 *   node aion-sim.mjs tools                 reports the Gmsh and Elmer installations found
 */
const [command, arg] = process.argv.slice(2);

if (command === "job" && arg) {
  const spec = JSON.parse(readFileSync(join(arg, "job.json"), "utf8")) as JobSpec;
  if (spec.format !== "aion.sim.job/1" || spec.runDir !== arg) {
    console.error("not an Aion simulation job");
    process.exit(2);
  }
  const status = await runJob(spec);
  process.exit(status.state === "done" ? 0 : 1);
} else if (command === "tools") {
  const tools = await findSimTools();
  const report = toolsReport(tools);
  console.log(report.lines.join("\n"));
  for (const p of tools.problems) console.log(`  (${p})`);
  process.exit(report.ready ? 0 : 1);
} else {
  console.error("usage: aion-sim.mjs job <run directory> | tools");
  process.exit(2);
}
