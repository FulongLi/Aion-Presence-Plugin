import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { findFreecad } from "../cad/freecad";

/**
 * v0.8: the external simulation programs — Gmsh (meshing) and Elmer FEM (ElmerGrid, ElmerSolver) — found on the user's
 * machine, never bundled. Like FreeCAD they are optional: without them `simulate` says what is missing and how to
 * install it, and everything else in Aion works. They are separate programs Aion starts with fixed arguments in a job
 * directory (no shell, no code from a request); their licences (GPL) apply to them, not to Aion.
 *
 * Search order — Gmsh: AION_GMSH; the gmsh FreeCAD ships (FreeCAD 1.x bundles it); Homebrew / system paths; PATH.
 * Elmer: AION_ELMER (its bin directory, or ElmerSolver itself); ~/.aion-sim/elmer (scripts/sim/build-elmer.sh); Homebrew /
 * system paths; PATH. Each candidate is proven by running it for its version.
 */
export interface SimTool { name: "gmsh" | "ElmerSolver" | "ElmerGrid"; path: string; version: string; source: string; tested: boolean }
export interface SimTools { gmsh: SimTool | null; elmerSolver: SimTool | null; elmerGrid: SimTool | null; elmerHome?: string; problems: string[] }

export const TESTED = { gmsh: ["4.15"], elmer: ["26.2"] };
export const MINIMUM = { gmsh: [4, 8], elmer: [9, 0] };

export const INSTALL_HELP = {
  gmsh: "Gmsh is not installed (or not found). FreeCAD 1.x includes it (install FreeCAD from https://www.freecad.org/downloads.php); "
    + "or install Gmsh 4.8+ from https://gmsh.info (macOS: brew install gmsh), or set AION_GMSH to the gmsh program.",
  elmer: "Elmer FEM is not installed (or not found). macOS: `sh scripts/sim/build-elmer.sh` (in the Aion repository) builds it into ~/.aion-sim/elmer "
    + "without sudo, or `brew tap elmercsc/elmerfem && brew install elmer`; Linux: your distribution's elmerfem package or the ElmerCSC PPA; "
    + "Windows: the installer from https://www.elmerfem.org. Or set AION_ELMER to Elmer's bin directory.",
};

const exe = (name: string, platform: string) => (platform === "win32" ? `${name}.exe` : name);
const isFile = (path: string) => { try { return statSync(path).isFile(); } catch { return false; } };

export function gmshCandidates(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): { path: string; source: string }[] {
  const out: { path: string; source: string }[] = [];
  if (env.AION_GMSH?.trim()) out.push({ path: env.AION_GMSH.trim(), source: "AION_GMSH" });
  const freecad = findFreecad(env, platform);
  if (freecad) out.push({ path: join(dirname(freecad.command), exe("gmsh", platform)), source: "FreeCAD" });
  if (platform === "darwin") out.push({ path: "/opt/homebrew/bin/gmsh", source: "Homebrew" }, { path: "/usr/local/bin/gmsh", source: "Homebrew" });
  else if (platform !== "win32") out.push({ path: "/usr/bin/gmsh", source: "system" }, { path: "/usr/local/bin/gmsh", source: "system" });
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) out.push({ path: join(dir, exe("gmsh", platform)), source: "PATH" });
  return out;
}

export function elmerCandidates(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): { bin: string; source: string }[] {
  const out: { bin: string; source: string }[] = [];
  const explicit = env.AION_ELMER?.trim();
  if (explicit) out.push({ bin: /ElmerSolver(\.exe)?$/i.test(explicit) ? dirname(explicit) : explicit.replace(/[\\/]+$/, ""), source: "AION_ELMER" });
  const home = env.AION_SIM_HOME?.trim() || join(homedir(), ".aion-sim");
  out.push({ bin: join(home, "elmer", "bin"), source: "~/.aion-sim" });
  if (platform === "darwin") out.push({ bin: "/opt/homebrew/bin", source: "Homebrew" }, { bin: "/usr/local/bin", source: "Homebrew" });
  else if (platform === "win32") {
    for (const root of [env.ProgramFiles, env["ProgramFiles(x86)"]].filter(Boolean) as string[]) out.push({ bin: join(root, "Elmer 26.2-Release", "bin"), source: "standard" }, { bin: join(root, "Elmer", "bin"), source: "standard" });
  } else out.push({ bin: "/usr/bin", source: "system" }, { bin: "/usr/local/bin", source: "system" });
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) out.push({ bin: dir, source: "PATH" });
  return out;
}

/** Runs a program briefly for its version text (stdout and stderr together). */
export function versionText(path: string, args: string[], env: NodeJS.ProcessEnv, seconds = 15): Promise<string> {
  return new Promise(resolve => {
    let text = "";
    let child;
    try { child = spawn(path, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); } catch { resolve(""); return; }
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, seconds * 1000);
    child.stdout?.on("data", chunk => { text = (text + String(chunk)).slice(0, 8000); });
    child.stderr?.on("data", chunk => { text = (text + String(chunk)).slice(0, 8000); });
    child.on("error", () => { clearTimeout(timer); resolve(""); });
    child.on("close", () => { clearTimeout(timer); resolve(text); });
  });
}

const atLeast = (version: string, minimum: number[]) => {
  const parts = version.split(/[.-]/).map(Number);
  for (let i = 0; i < minimum.length; i++) {
    if ((parts[i] ?? 0) > minimum[i]) return true;
    if ((parts[i] ?? 0) < minimum[i]) return false;
  }
  return true;
};
const tested = (version: string, list: string[]) => list.some(v => version === v || version.startsWith(`${v}.`) || version.startsWith(`${v}-`));

/** The environment the simulation programs run in: the user's PATH and home, a fixed locale, ELMER_HOME when known. */
export function toolEnv(tools: Pick<SimTools, "elmerHome">, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = ["PATH", "HOME", "USER", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "LD_LIBRARY_PATH", "DYLD_FALLBACK_LIBRARY_PATH"];
  const env: NodeJS.ProcessEnv = { LANG: "C", LC_ALL: "C", OMP_NUM_THREADS: "1" };
  for (const key of keep) if (base[key]) env[key] = base[key];
  if (tools.elmerHome) env.ELMER_HOME = tools.elmerHome;
  return env;
}

let cached: { key: string; tools: Promise<SimTools> } | null = null;

/** Finds and proves the tools (cached per environment for the life of the process). */
export function findSimTools(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, fresh = false): Promise<SimTools> {
  const key = JSON.stringify([env.AION_GMSH, env.AION_ELMER, env.AION_SIM_HOME, env.AION_FREECAD, env.PATH, platform]);
  if (!fresh && cached?.key === key) return cached.tools;
  const tools = discover(env, platform);
  cached = { key, tools };
  return tools;
}

async function discover(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<SimTools> {
  const problems: string[] = [];
  const out: SimTools = { gmsh: null, elmerSolver: null, elmerGrid: null, problems };
  const seen = new Set<string>();
  for (const c of gmshCandidates(env, platform)) {
    if (seen.has(c.path) || !isFile(c.path)) continue;
    seen.add(c.path);
    const text = await versionText(c.path, ["-version"], toolEnv({}, env));
    const version = /(\d+\.\d+\.\d+)/.exec(text)?.[1];
    if (!version) { problems.push(`${c.path} did not report a Gmsh version`); continue; }
    if (!atLeast(version, MINIMUM.gmsh)) { problems.push(`Gmsh ${version} at ${c.path} is older than ${MINIMUM.gmsh.join(".")}`); continue; }
    out.gmsh = { name: "gmsh", path: c.path, version, source: c.source, tested: tested(version, TESTED.gmsh) };
    break;
  }
  for (const c of elmerCandidates(env, platform)) {
    const solver = join(c.bin, exe("ElmerSolver", platform)), grid = join(c.bin, exe("ElmerGrid", platform));
    if (seen.has(solver) || !isFile(solver)) continue;
    seen.add(solver);
    if (!isFile(grid)) { problems.push(`${c.bin} has ElmerSolver but no ElmerGrid`); continue; }
    const prefix = dirname(c.bin);
    const elmerHome = existsSync(join(prefix, "share", "elmersolver")) ? prefix : undefined;
    const text = await versionText(solver, ["-v"], toolEnv({ elmerHome }, env));
    const version = /Version:\s*([\d.]+)/.exec(text)?.[1] ?? /ELMER SOLVER \(v\s*([\d.]+)\)/.exec(text)?.[1];
    if (!version) { problems.push(`${solver} did not report an Elmer version`); continue; }
    if (!atLeast(version, MINIMUM.elmer)) { problems.push(`Elmer ${version} at ${solver} is older than ${MINIMUM.elmer.join(".")}`); continue; }
    out.elmerSolver = { name: "ElmerSolver", path: solver, version, source: c.source, tested: tested(version, TESTED.elmer) };
    out.elmerGrid = { name: "ElmerGrid", path: grid, version, source: c.source, tested: tested(version, TESTED.elmer) };
    out.elmerHome = elmerHome;
    break;
  }
  return out;
}

export function toolsReport(tools: SimTools): { ready: boolean; missing: string[]; lines: string[] } {
  const missing: string[] = [];
  const lines: string[] = [];
  if (tools.gmsh) lines.push(`Gmsh ${tools.gmsh.version} (${tools.gmsh.source}: ${tools.gmsh.path})${tools.gmsh.tested ? "" : " — this version is not one Aion was tested with"}`);
  else { missing.push("gmsh"); lines.push(INSTALL_HELP.gmsh); }
  if (tools.elmerSolver) lines.push(`Elmer ${tools.elmerSolver.version} (${tools.elmerSolver.source}: ${dirname(tools.elmerSolver.path)})${tools.elmerSolver.tested ? "" : " — this version is not one Aion was tested with"}`);
  else { missing.push("elmer"); lines.push(INSTALL_HELP.elmer); }
  return { ready: missing.length === 0, missing, lines };
}
