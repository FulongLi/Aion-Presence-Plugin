import { spawn } from "node:child_process";
import { dirname, join } from "node:path";

/**
 * v0.7: opens a saved .FCStd in the FreeCAD application (the single-writer hand-off: Aion stops changing the document
 * until it is reloaded). macOS: the FreeCAD.app bundle that holds the freecadcmd Aion uses (`open -a`); elsewhere the
 * `freecad` executable beside it. Resolves false if it could not be started.
 */
export function openInFreecad(path: string, command: string | null, platform = process.platform): Promise<boolean> {
  let file: string, args: string[];
  if (platform === "darwin") {
    const app = command?.match(/^(.*\.app)\/Contents\//)?.[1];
    file = "open";
    args = app ? ["-a", app, path] : ["-a", "FreeCAD", path];
  } else {
    const dir = command ? dirname(command) : "";
    file = dir ? join(dir, platform === "win32" ? "freecad.exe" : "freecad") : "freecad";
    args = [path];
  }
  return new Promise(resolve => {
    try {
      const child = spawn(file, args, { detached: true, stdio: "ignore", windowsHide: false });
      child.once("error", () => resolve(false));
      child.once("spawn", () => { child.unref(); resolve(true); });
    } catch { resolve(false); }
  });
}
