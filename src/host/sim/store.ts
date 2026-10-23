import { spawn } from "node:child_process";
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { parseStudy, type SimulationStudy } from "../../sim/study";
import type { SimGeometry } from "../../sim/geometry";

/**
 * v0.8: where simulation studies live — Aion's plugin data directory (`sim/`), so a study survives the Simulation Card
 * being closed, a new MCP server (Codex may start one per turn) and a restart:
 *
 *   sim/state.json                      the study used last
 *   sim/studies/<id>/study.json         the study (schema-checked whenever it is read)
 *   sim/studies/<id>/geometry/r<rev>/   the CAD geometry it was bound to (geometry.json, geometry.brep)
 *   sim/studies/<id>/meshes/<mesh>/     each mesh (Gmsh input and output, Elmer's mesh, statistics)
 *   sim/studies/<id>/runs/<n>/          each run (job.json, status.json, case.sif, solver.log, results/, summary.json, field.afr)
 *
 * Writes are atomic (a temporary file, then a rename); a lock file keeps two conversations from changing one study at the
 * same moment. Older runs keep their summary; their bulky files (VTU, card bundle) are pruned beyond the last ten.
 */
export class SimStore {
  constructor(readonly root: string) {}

  get studiesDir() { return join(this.root, "studies"); }
  studyDir(id: string) { return join(this.studiesDir, safe(id)); }
  geometryDir(id: string, revision: number) { return join(this.studyDir(id), "geometry", `r${String(revision).padStart(6, "0")}`); }
  meshDir(id: string, mesh: string) { return join(this.studyDir(id), "meshes", safe(mesh)); }
  runDir(id: string, run: number) { return join(this.studyDir(id), "runs", String(run).padStart(4, "0")); }

  newId(): string {
    for (;;) {
      const id = `sim-${randomBytes(3).toString("hex")}`;
      if (!existsSync(this.studyDir(id))) return id;
    }
  }

  list(): { id: string; name: string; analysis: string; updated: string; runs: number; document: string }[] {
    if (!existsSync(this.studiesDir)) return [];
    const out = [];
    for (const id of readdirSync(this.studiesDir)) {
      const study = this.read(id);
      if (study) out.push({ id: study.id, name: study.name, analysis: study.analysis, updated: study.updated, runs: study.results.length, document: study.geometry.document });
    }
    return out.sort((a, b) => b.updated.localeCompare(a.updated));
  }

  read(id: string): SimulationStudy | null {
    const path = join(this.studyDir(id), "study.json");
    if (!existsSync(path)) return null;
    const parsed = parseStudy(JSON.parse(readFileSync(path, "utf8")));
    if (!parsed.ok) throw new Error(`The stored study ${id} is invalid (${parsed.problem}).`);
    return parsed.study;
  }

  write(study: SimulationStudy) {
    const parsed = parseStudy(study);
    if (!parsed.ok) throw new Error(`Refusing to store an invalid study: ${parsed.problem}`);
    atomicWrite(join(this.studyDir(study.id), "study.json"), JSON.stringify(study, null, 1));
    this.setLast(study.id);
  }

  last(): string | null {
    try {
      const id = JSON.parse(readFileSync(join(this.root, "state.json"), "utf8")).last;
      return typeof id === "string" && existsSync(this.studyDir(id)) ? id : null;
    } catch { return null; }
  }

  setLast(id: string) { atomicWrite(join(this.root, "state.json"), JSON.stringify({ last: id })); }

  readGeometry(id: string, revision: number): SimGeometry | null {
    const path = join(this.geometryDir(id, revision), "geometry.json");
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as SimGeometry : null;
  }

  /** Keeps the bulky files of the last `keep` runs (summaries are always kept). */
  prune(id: string, keep = 10) {
    const runs = join(this.studyDir(id), "runs");
    if (!existsSync(runs)) return;
    const all = readdirSync(runs).filter(n => /^\d{4}$/.test(n)).sort();
    for (const name of all.slice(0, Math.max(0, all.length - keep))) {
      for (const file of ["results", "field.afr", "case.sif"]) rmSync(join(runs, name, file), { recursive: true, force: true });
    }
  }

  /** Runs `work` holding the study's lock (waits up to `seconds` for another conversation to finish). */
  async locked<T>(id: string, work: () => Promise<T> | T, seconds = 20): Promise<T> {
    const dir = this.studyDir(id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, ".lock");
    const until = Date.now() + seconds * 1000;
    for (;;) {
      try {
        closeSync(openSync(path, "wx"));
        break;
      } catch {
        // A lock older than two minutes belongs to a process that died.
        try { if (Date.now() - statSync(path).mtimeMs > 120_000) { unlinkSync(path); continue; } } catch { continue; }
        if (Date.now() > until) throw new Error(`The study ${id} is being changed by another conversation; try again.`);
        await new Promise(r => setTimeout(r, 100));
      }
    }
    try { return await work(); } finally { try { unlinkSync(path); } catch { /* gone */ } }
  }
}

const safe = (name: string) => {
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name) || name.startsWith(".")) throw new Error(`unsafe name ${name}`);
  return name;
};

export function atomicWrite(path: string, data: string | Uint8Array) {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

export function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return null; }
}

/**
 * Runs one external program with fixed arguments in a directory: no shell, its output to a log file, killed when it
 * overruns its time. Resolves with its exit code (null if killed) and whether the time ran out.
 */
export function runProgram(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; log: string; seconds: number; onSpawn?: (pid: number) => void }):
  Promise<{ code: number | null; timedOut: boolean; error?: string }> {
  return new Promise(resolve => {
    const log = createWriteStream(options.log, { flags: "w" });
    let child;
    try {
      child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) { log.end(); resolve({ code: null, timedOut: false, error: (error as Error).message }); return; }
    if (child.pid) options.onSpawn?.(child.pid);
    let bytes = 0;
    const write = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= 50 * 1024 * 1024) log.write(chunk);
    };
    child.stdout?.on("data", write);
    child.stderr?.on("data", write);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    }, options.seconds * 1000);
    child.on("error", error => { clearTimeout(timer); log.end(); resolve({ code: null, timedOut, error: error.message }); });
    child.on("close", code => { clearTimeout(timer); log.end(() => resolve({ code, timedOut })); });
  });
}
