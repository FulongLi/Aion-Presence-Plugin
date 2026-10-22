import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { Readable, Writable } from "node:stream";

/**
 * v0.7: the FreeCAD backend — Aion's connection to a locally installed FreeCAD (see docs/FREECAD.md).
 *
 * Aion starts FreeCAD's own command-line interpreter (`freecadcmd`) with a fixed worker script that ships with the plugin
 * (plugins/aion-presence/cad/aion_freecad_worker.py), and talks to it over pipes: requests on stdin, one JSON response per
 * line on file descriptor 3. There is no network port, so nothing else on the machine can reach it, and it accepts only
 * the worker's own named operations with validated arguments — never code. The worker lives as long as the MCP server
 * (one per Codex session), is started on first use, and is restarted if it dies (open documents are then reported as
 * lost; a saved .FCStd can be reopened).
 *
 * Discovery never assumes a system Python can import FreeCAD: it runs FreeCAD's bundled interpreter, found from
 * `AION_FREECAD` (freecadcmd, or the FreeCAD.app bundle), then the standard install locations, then PATH.
 */
export interface FreecadInstall { command: string; source: "env" | "standard" | "path" }

export function freecadCandidates(env: NodeJS.ProcessEnv = process.env, platform = process.platform): { command: string; source: FreecadInstall["source"] }[] {
  const out: { command: string; source: FreecadInstall["source"] }[] = [];
  const explicit = env.AION_FREECAD?.trim();
  if (explicit) {
    const app = explicit.replace(/\/+$/, "");
    out.push({ command: app.endsWith(".app") ? join(app, "Contents/Resources/bin/freecadcmd") : app, source: "env" });
  }
  if (platform === "darwin") {
    for (const root of ["/Applications", join(homedir(), "Applications")]) {
      for (const name of ["FreeCAD.app", "FreeCAD 1.1.app", "FreeCAD 1.0.app"]) out.push({ command: join(root, name, "Contents/Resources/bin/freecadcmd"), source: "standard" });
    }
  } else if (platform === "win32") {
    const programs = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs")].filter(Boolean) as string[];
    for (const root of programs) for (const name of ["FreeCAD 1.1", "FreeCAD 1.0", "FreeCAD"]) out.push({ command: join(root, name, "bin", "freecadcmd.exe"), source: "standard" });
  } else {
    for (const path of ["/usr/bin/freecadcmd", "/usr/local/bin/freecadcmd", "/usr/bin/FreeCADCmd", "/snap/bin/freecad.cmd"]) out.push({ command: path, source: "standard" });
  }
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const name of platform === "win32" ? ["freecadcmd.exe", "FreeCADCmd.exe"] : ["freecadcmd", "FreeCADCmd"]) out.push({ command: join(dir, name), source: "path" });
  }
  return out;
}

/** The first candidate that exists as a file (it is proven by starting the worker, not by its name). */
export function findFreecad(env: NodeJS.ProcessEnv = process.env, platform = process.platform): FreecadInstall | null {
  for (const candidate of freecadCandidates(env, platform)) {
    try { if (statSync(candidate.command).isFile()) return candidate; } catch { /* not here */ }
  }
  return null;
}

export const FREECAD_INSTALL_HELP = "FreeCAD is not installed (or not found). Install FreeCAD 1.0 or newer from https://www.freecad.org/downloads.php "
  + "(macOS: drag FreeCAD.app into Applications), or set AION_FREECAD to its freecadcmd (or FreeCAD.app). Everything else in Aion works without it.";

export interface CadFailure { code: string; message: string; [key: string]: unknown }
export type WorkerResponse = { ok: true; result: Record<string, unknown>; document?: CadDocumentReport; preview?: CadPreview; timing_ms?: { freecad: number; tessellation: number } }
  | { ok: false; error: CadFailure };

export interface CadComponent { id: string; label: string; type: string; role: string; parameters: Record<string, string | number>; base?: string; tool?: string; body?: string; hidden?: boolean; material?: string }
export interface CadDocumentReport {
  id: string; name: string; revision: number; path: string | null; saved: boolean; handed_off: boolean;
  components?: CadComponent[]; history?: { revision: number; description: string }[]; undo?: string[]; redo?: string[];
  solids: { id: string; label: string; volume_mm3?: number; valid: boolean; size_mm?: [number, number, number]; hidden?: boolean }[];
}
export interface CadPreviewPart { id: string; label: string; role: string; type: string; color: string; metadata: Record<string, string | number | boolean>; positions: string; indices: string; triangles: number }
export interface CadPreviewNode { id: string; label: string; role: string; type: string; metadata: Record<string, string | number | boolean>; children: CadPreviewPart[] }
export interface CadPreview { nodes: CadPreviewNode[]; triangles: number }

/** The worker's first line: FreeCAD's version and what it offers. */
export interface WorkerHello { ready: true; protocol: number; freecad: string; build: string; python: string; sketcher: boolean }

export interface FreecadBackendOptions {
  /** The worker script (plugins/aion-presence/cad/aion_freecad_worker.py). */
  script: string;
  env?: NodeJS.ProcessEnv;
  /** Seconds a single operation may take before the worker is stopped (a runaway recompute). */
  timeoutSeconds?: number;
  /** Seconds FreeCAD may take to start. */
  startSeconds?: number;
  /** Tests: another way to start the worker. */
  launch?: (install: FreecadInstall, script: string) => ChildProcess;
}

export class FreecadBackend {
  private child: ChildProcess | null = null;
  private hello: WorkerHello | null = null;
  private starting: Promise<WorkerHello> | null = null;
  private pending = new Map<number, { resolve(value: WorkerResponse): void; timer: ReturnType<typeof setTimeout> }>();
  private nextId = 1;
  private buffer = "";
  private queue: Promise<unknown> = Promise.resolve();
  /** Documents the current worker holds (a restarted worker has none). */
  generation = 0;
  install: FreecadInstall | null = null;

  constructor(private readonly options: FreecadBackendOptions) {}

  get running() { return this.child !== null && this.hello !== null; }
  get version() { return this.hello?.freecad ?? null; }

  /** Starts FreeCAD if needed; resolves with its version, or rejects with a CadFailure-shaped error. */
  async start(): Promise<WorkerHello> {
    if (this.hello && this.child) return this.hello;
    this.starting ??= this.launch().finally(() => { this.starting = null; });
    return this.starting;
  }

  private launch(): Promise<WorkerHello> {
    const install = findFreecad(this.options.env);
    this.install = install;
    if (!install) return Promise.reject(Object.assign(new Error(FREECAD_INSTALL_HELP), { code: "backend-unavailable" }));
    if (!existsSync(this.options.script)) return Promise.reject(Object.assign(new Error(`The FreeCAD worker script is missing (${this.options.script}).`), { code: "backend-unavailable" }));
    const child = this.options.launch?.(install, this.options.script)
      ?? spawn(install.command, [this.options.script], {
        stdio: ["pipe", "ignore", "pipe", "pipe"], windowsHide: true,
        // No __pycache__ beside the worker (it lives in the installed plugin).
        env: { ...process.env, ...this.options.env, PYTHONDONTWRITEBYTECODE: "1" },
      });
    this.child = child;
    this.generation++;
    this.buffer = "";
    let stderr = "";
    child.stderr?.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-2_000); });
    const channel = child.stdio[3] as Readable | undefined;
    return new Promise<WorkerHello>((resolve, reject) => {
      const startTimer = setTimeout(() => { this.stop(); reject(Object.assign(new Error(`FreeCAD did not start within ${this.options.startSeconds ?? 30} s.`), { code: "backend-unavailable" })); }, (this.options.startSeconds ?? 30) * 1000);
      const onLine = (line: string) => {
        let message: Record<string, unknown>;
        try { message = JSON.parse(line); } catch { return; }
        if (message.ready === true && !this.hello) {
          clearTimeout(startTimer);
          this.hello = message as unknown as WorkerHello;
          resolve(this.hello);
          return;
        }
        const id = message.id as number | undefined;
        const waiting = id !== undefined ? this.pending.get(id) : undefined;
        if (!waiting) return;
        this.pending.delete(id!);
        clearTimeout(waiting.timer);
        waiting.resolve(message as unknown as WorkerResponse);
      };
      channel?.setEncoding?.("utf8");
      channel?.on("data", chunk => {
        this.buffer += String(chunk);
        let at: number;
        while ((at = this.buffer.indexOf("\n")) >= 0) { const line = this.buffer.slice(0, at); this.buffer = this.buffer.slice(at + 1); if (line.trim()) onLine(line); }
      });
      child.on("error", error => { clearTimeout(startTimer); this.exited(); reject(Object.assign(new Error(`FreeCAD could not be started (${install.command}): ${error.message}`), { code: "backend-unavailable" })); });
      child.on("exit", code => {
        clearTimeout(startTimer);
        const wasReady = this.hello !== null;
        this.exited();
        if (!wasReady) reject(Object.assign(new Error(`FreeCAD exited before it was ready (code ${code}). ${stderr.trim().split("\n").slice(-2).join(" ")}`.trim()), { code: "backend-unavailable" }));
      });
    });
  }

  private exited() {
    this.child = null;
    this.hello = null;
    for (const [id, waiting] of this.pending) { clearTimeout(waiting.timer); waiting.resolve({ ok: false, error: { code: "backend-unavailable", message: "FreeCAD stopped while working; its open documents were lost (a saved .FCStd can be reopened)." } }); this.pending.delete(id); }
  }

  /** One operation; operations run one at a time, in order. */
  call(op: string, args: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Promise<WorkerResponse> {
    const run = async (): Promise<WorkerResponse> => {
      try { await this.start(); } catch (error) {
        return { ok: false, error: { code: (error as { code?: string }).code ?? "backend-unavailable", message: (error as Error).message } };
      }
      const child = this.child, input = child?.stdin as Writable | null | undefined;
      if (!child || !input) return { ok: false, error: { code: "backend-unavailable", message: "FreeCAD is not running." } };
      const id = this.nextId++;
      return new Promise<WorkerResponse>(resolve => {
        const seconds = this.options.timeoutSeconds ?? 60;
        const timer = setTimeout(() => {
          this.pending.delete(id);
          // A recompute that does not finish: the worker is stopped (FreeCAD cannot interrupt one), and says so.
          this.stop();
          resolve({ ok: false, error: { code: "timeout", message: `FreeCAD did not finish ${op} within ${seconds} s and was stopped; unsaved changes were lost.` } });
        }, seconds * 1000);
        this.pending.set(id, { resolve, timer });
        input.write(`${JSON.stringify({ id, op, args, ...extra })}\n`);
      });
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  stop() {
    const child = this.child;
    this.exited();
    try { child?.stdin?.end(); child?.kill(); } catch { /* already gone */ }
  }
}
