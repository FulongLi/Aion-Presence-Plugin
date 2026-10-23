import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, posix, relative } from "node:path";
import { resultBundle } from "../../sim/bundle";
import { buildSif, readElmerLog, readScalars, runProblems } from "../../sim/elmer";
import type { SimGeometry } from "../../sim/geometry";
import { buildGeo, checkFaceMapping, readMsh, type MeshSizing, type MeshStats } from "../../sim/gmsh";
import { headline, readVtu, summarize, type ResultSummary } from "../../sim/results";
import { bind, blocking, validate } from "../../sim/setup";
import type { SimulationStudy } from "../../sim/study";
import { atomicWrite, readJson, runProgram } from "./store";
import { toolEnv } from "./tools";

/**
 * v0.8: one simulation job — mesh (Gmsh, unless an identical mesh exists), convert (ElmerGrid), solve (ElmerSolver),
 * process (results → summary and the card's bundle). It runs in its own process (`aion-sim.mjs job <dir>`, started
 * detached by the MCP server so that a long solve outlives one tool call and one Codex turn), or in-process for tests.
 * Every stage is recorded in status.json; a stage that fails stops the job with what went wrong, its log, and nothing
 * presented as a result. A zero exit code is never taken as proof: the mesh's faces must match the CAD faces, the
 * solver's log must be free of errors and reach its end, and the result files must exist and parse.
 */
export interface JobSpec {
  format: "aion.sim.job/1";
  study: SimulationStudy;
  run: number;
  geometryFile: string;
  brepFile: string;
  meshId: string;
  meshDir: string;
  runDir: string;
  sizing: MeshSizing;
  refine: { faces?: number[]; solids?: number[]; size_mm: number }[];
  tools: { gmsh: string; gmshVersion: string; elmerSolver: string; elmerGrid: string; elmerVersion: string; elmerHome?: string };
  limits: { meshSeconds: number; maxElements: number };
}

export type JobState = "queued" | "meshing" | "converting" | "solving" | "processing" | "done" | "failed";
export interface JobStatus {
  state: JobState;
  message: string;
  started: string;
  updated: string;
  pid?: number;
  meshReused?: boolean;
  seconds?: { mesh?: number; convert?: number; solve?: number; process?: number };
  error?: { stage: string; message: string; details?: string[]; log?: string };
}

export interface MeshRecord { id: string; stats: MeshStats; sizing: MeshSizing; order: 1 | 2; gmsh: string; warnings: string[]; created: string }

const ACTIVE: JobState[] = ["queued", "meshing", "converting", "solving", "processing"];
export const isActive = (status: JobStatus | null) => Boolean(status && ACTIVE.includes(status.state));

/** Whether the process recorded in an active status is still alive (a dead runner leaves a stale "solving"). */
export function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export function readStatus(runDir: string): JobStatus | null { return readJson<JobStatus>(join(runDir, "status.json")); }

function tail(path: string, lines = 12): string {
  try { return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).slice(-lines).join("\n").slice(-2000); } catch { return ""; }
}

/** Meshes the geometry (Gmsh), checks it against the CAD faces, converts it for Elmer (ElmerGrid). */
export async function makeMesh(spec: Pick<JobSpec, "meshDir" | "meshId" | "brepFile" | "sizing" | "refine" | "tools" | "limits" | "study">, geometry: SimGeometry,
  report: (state: JobState, message: string) => void = () => {}): Promise<{ ok: true; mesh: MeshRecord; reused: boolean; seconds: { mesh: number; convert: number } } | { ok: false; stage: string; message: string; details?: string[]; log?: string }> {
  const dir = spec.meshDir;
  const record = readJson<MeshRecord>(join(dir, "mesh.json"));
  if (record && existsSync(join(dir, "elmer", "mesh.header"))) return { ok: true, mesh: record, reused: true, seconds: { mesh: 0, convert: 0 } };
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const env = toolEnv({ elmerHome: spec.tools.elmerHome });
  report("meshing", `Gmsh is meshing ${geometry.solids.length} solid${geometry.solids.length > 1 ? "s" : ""} (${geometry.faces.length} faces)…`);
  const brep = join(dir, "geometry.brep");
  atomicWrite(brep, readFileSync(spec.brepFile));
  atomicWrite(join(dir, "mesh.geo"), buildGeo({ brepFile: "geometry.brep", mshFile: "mesh.msh", solids: geometry.solids.length, faces: geometry.faces.length, sizing: spec.sizing, order: spec.study.mesh.order, refine: spec.refine }));
  const t0 = Date.now();
  const gmsh = await runProgram(spec.tools.gmsh, ["mesh.geo", "-0", "-nopopup", "-v", "4"], { cwd: dir, env, log: join(dir, "gmsh.log"), seconds: spec.limits.meshSeconds });
  const meshSeconds = (Date.now() - t0) / 1000;
  const gmshLog = (() => { try { return readFileSync(join(dir, "gmsh.log"), "utf8"); } catch { return ""; } })();
  const errors = gmshLog.split(/\r?\n/).filter(l => /^Error\s*:/.test(l)).map(l => l.replace(/^Error\s*:\s*/, "")).slice(0, 8);
  const warnings = [...new Set(gmshLog.split(/\r?\n/).filter(l => /^Warning\s*:/.test(l)).map(l => l.replace(/^Warning\s*:\s*/, "")))].slice(0, 12);
  if (gmsh.timedOut) return { ok: false, stage: "mesh", message: `Gmsh did not finish within ${spec.limits.meshSeconds} s (stopped). Use a coarser mesh or less refinement.`, log: tail(join(dir, "gmsh.log")) };
  if (gmsh.error) return { ok: false, stage: "mesh", message: `Gmsh could not be started: ${gmsh.error}` };
  if (errors.length || gmsh.code !== 0 || !existsSync(join(dir, "mesh.msh"))) {
    return { ok: false, stage: "mesh", message: `Gmsh could not mesh the geometry${errors.length ? `: ${errors[0]}` : ` (exit ${gmsh.code})`}.`, details: errors, log: tail(join(dir, "gmsh.log")) };
  }
  report("meshing", "Checking the mesh against the CAD faces…");
  let stats: MeshStats;
  try { stats = readMsh(readFileSync(join(dir, "mesh.msh"), "utf8")); } catch (error) { return { ok: false, stage: "mesh", message: `The mesh could not be read: ${(error as Error).message}.` }; }
  if (!stats.tetrahedra) return { ok: false, stage: "mesh", message: "Gmsh produced no volume elements (is the geometry a closed solid?).", log: tail(join(dir, "gmsh.log")) };
  if (stats.tetrahedra > spec.limits.maxElements) return { ok: false, stage: "mesh", message: `The mesh has ${stats.tetrahedra.toLocaleString("en")} elements, over the limit of ${spec.limits.maxElements.toLocaleString("en")}: use a coarser size.` };
  const mapping = checkFaceMapping(stats, geometry);
  if (mapping.length) return { ok: false, stage: "mesh", message: "The mesh's faces do not match the CAD faces, so boundary conditions could land on the wrong faces; nothing was solved.", details: mapping.slice(0, 8) };
  report("converting", `ElmerGrid is converting ${stats.tetrahedra.toLocaleString("en")} elements…`);
  const t1 = Date.now();
  const grid = await runProgram(spec.tools.elmerGrid, ["14", "2", "mesh.msh", "-out", "elmer"], { cwd: dir, env, log: join(dir, "elmergrid.log"), seconds: spec.limits.meshSeconds });
  const convertSeconds = (Date.now() - t1) / 1000;
  const header = (() => { try { return readFileSync(join(dir, "elmer", "mesh.header"), "utf8").trim().split(/\s+/).map(Number); } catch { return null; } })();
  if (grid.timedOut || grid.code !== 0 || !header || header[0] !== stats.nodes) {
    return { ok: false, stage: "convert", message: `ElmerGrid could not convert the mesh${grid.timedOut ? " in time" : header ? ` (it wrote ${header[0]} nodes of ${stats.nodes})` : ""}.`, log: tail(join(dir, "elmergrid.log")) };
  }
  rmSync(brep, { force: true });
  const mesh: MeshRecord = { id: spec.meshId, stats, sizing: spec.sizing, order: spec.study.mesh.order, gmsh: spec.tools.gmshVersion, warnings, created: new Date().toISOString() };
  atomicWrite(join(dir, "mesh.json"), JSON.stringify(mesh));
  return { ok: true, mesh, reused: false, seconds: { mesh: meshSeconds, convert: convertSeconds } };
}

export async function runJob(spec: JobSpec): Promise<JobStatus> {
  const started = new Date().toISOString();
  let status: JobStatus = { state: "queued", message: "Starting…", started, updated: started, pid: process.pid, seconds: {} };
  const write = (patch: Partial<JobStatus>) => { status = { ...status, ...patch, updated: new Date().toISOString() }; atomicWrite(join(spec.runDir, "status.json"), JSON.stringify(status)); };
  const failWith = (stage: string, message: string, details?: string[], log?: string) => { write({ state: "failed", message, error: { stage, message, ...(details?.length ? { details } : {}), ...(log ? { log } : {}) } }); return status; };
  write({});
  try {
    const geometry = JSON.parse(readFileSync(spec.geometryFile, "utf8")) as SimGeometry;
    const study = spec.study;
    const setup = bind(study, geometry);
    const errors = blocking(validate(study, geometry, setup));
    if (errors.length) return failWith("validate", "The study is not ready to solve.", errors.map(e => e.message));

    const meshed = await makeMesh(spec, geometry, (state, message) => write({ state, message }));
    if (!meshed.ok) return failWith(meshed.stage, meshed.message, meshed.details, meshed.log);
    write({ meshReused: meshed.reused, seconds: { ...status.seconds, mesh: meshed.seconds.mesh, convert: meshed.seconds.convert } });

    write({ state: "solving", message: `Elmer is solving (${meshed.mesh.stats.tetrahedra.toLocaleString("en")} elements, ${study.analysis})…` });
    const meshDb = relative(spec.runDir, join(spec.meshDir, "elmer")).split("\\").join("/");
    atomicWrite(join(spec.runDir, "case.sif"), buildSif(study, geometry, setup, { meshDir: posix.dirname(meshDb), meshName: posix.basename(meshDb), resultsDir: "results", order: study.mesh.order }));
    const t2 = Date.now();
    const solve = await runProgram(spec.tools.elmerSolver, ["case.sif"], { cwd: spec.runDir, env: toolEnv({ elmerHome: spec.tools.elmerHome }), log: join(spec.runDir, "solver.log"), seconds: study.solver.timeoutSeconds });
    const solveSeconds = (Date.now() - t2) / 1000;
    write({ seconds: { ...status.seconds, solve: solveSeconds } });
    const logText = (() => { try { return readFileSync(join(spec.runDir, "solver.log"), "utf8"); } catch { return ""; } })();
    const elmer = readElmerLog(logText);
    if (solve.timedOut) return failWith("solve", `Elmer did not finish within ${study.solver.timeoutSeconds} s and was stopped.`, undefined, tail(join(spec.runDir, "solver.log")));
    if (solve.error) return failWith("solve", `ElmerSolver could not be started: ${solve.error}`);
    const problems = runProblems(elmer);
    if (solve.code !== 0) problems.unshift(`ElmerSolver exited with code ${solve.code}`);
    const vtu = join(spec.runDir, "results", "result_t0001.vtu");
    if (!existsSync(vtu)) problems.push("Elmer wrote no result file");
    if (problems.length) return failWith("solve", `Elmer did not solve the study: ${problems[0]}`, problems.slice(0, 8), tail(join(spec.runDir, "solver.log")));

    write({ state: "processing", message: "Reading the results…" });
    const t3 = Date.now();
    const field = readVtu(readFileSync(vtu, "utf8"));
    const scalarsDir = join(spec.runDir, "results");
    const scalars = existsSync(join(scalarsDir, "scalars.dat")) ? readScalars(readFileSync(join(scalarsDir, "scalars.dat.names"), "utf8"), readFileSync(join(scalarsDir, "scalars.dat"), "utf8")) : {};
    const stats = meshed.mesh.stats;
    const summary: ResultSummary = summarize({
      study, geometry, setup, mesh: field, run: spec.run, meshId: spec.meshId, scalars,
      meshInfo: { nodes: stats.nodes, tetrahedra: stats.tetrahedra, triangles: stats.triangles, order: stats.order, quality: { min: stats.quality.min, mean: stats.quality.mean }, max_mm: spec.sizing.max_mm },
      solver: { name: "Elmer", version: elmer.version ?? spec.tools.elmerVersion, seconds: elmer.time?.real ?? solveSeconds, solvers: elmer.solvers, warnings: elmer.warnings.slice(0, 12) },
    });
    if (meshed.mesh.stats.quality.min < 0.05) summary.notes.push(`The mesh has very flat elements (minimum quality ${meshed.mesh.stats.quality.min.toFixed(3)}); local values near them are less reliable.`);
    const { bytes, omitted } = resultBundle(study, geometry, setup, field, summary);
    summary.notes.push(...omitted);
    atomicWrite(join(spec.runDir, "field.afr"), bytes);
    atomicWrite(join(spec.runDir, "summary.json"), JSON.stringify({ ...summary, headline: headline(summary) }));
    write({ state: "done", message: `Solved in ${solveSeconds.toFixed(1)} s.`, seconds: { ...status.seconds, process: (Date.now() - t3) / 1000 } });
    return status;
  } catch (error) {
    return failWith("process", `The job failed: ${(error as Error).message}`);
  }
}
