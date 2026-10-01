import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { getUiCapability, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { ClientCapabilities } from "@modelcontextprotocol/server";

/**
 * Presentation modes, chosen from what the host actually declares:
 *
 *   embedded   the host renders MCP Apps (it advertises the io.modelcontextprotocol/ui extension with the
 *              text/html;profile=mcp-app type): Aion is rendered inside the host, in the display modes the
 *              host offers.
 *   companion  otherwise: Aion opens as a local Presence window driven by the same state.
 *
 * No host API is assumed or emulated. A host that does not declare MCP Apps support never gets the
 * embedded path, even when it is asked for.
 */
export type SurfaceMode = "embedded" | "companion";

export interface SurfaceDecision {
  mode: SurfaceMode;
  /** Whether the host declared MCP Apps support. */
  embeddedSupported: boolean;
  reason: "host-renders-mcp-apps" | "host-without-mcp-apps" | "companion-requested";
}

export function hostSupportsMcpApps(capabilities: ClientCapabilities | null | undefined): boolean {
  return getUiCapability(capabilities)?.mimeTypes?.includes(RESOURCE_MIME_TYPE) ?? false;
}

export function decideSurface(capabilities: ClientCapabilities | null | undefined, request: "auto" | "companion" = "auto",
  env: NodeJS.ProcessEnv = process.env): SurfaceDecision {
  const embeddedSupported = hostSupportsMcpApps(capabilities);
  const preference = env.AION_PRESENCE_SURFACE === "companion" ? "companion" : request;
  if (preference === "companion") return { mode: "companion", embeddedSupported, reason: "companion-requested" };
  return embeddedSupported
    ? { mode: "embedded", embeddedSupported, reason: "host-renders-mcp-apps" }
    : { mode: "companion", embeddedSupported, reason: "host-without-mcp-apps" };
}

export interface BrowserLaunch { command: string; args: string[] }

/**
 * How to open the companion window on this platform. A Chromium-family browser in app mode gives a quiet,
 * chrome-less window (and WebGPU); otherwise the default browser opens the page.
 * AION_PRESENCE_BROWSER = default | chrome | none.
 */
export function browserLaunch(url: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync): BrowserLaunch | null {
  const preference = env.AION_PRESENCE_BROWSER ?? "chrome";
  if (preference === "none") return null;
  if (platform === "darwin") {
    if (preference === "chrome") {
      for (const app of ["Google Chrome", "Microsoft Edge", "Chromium", "Brave Browser"]) {
        if (exists(`/Applications/${app}.app`)) return { command: "open", args: ["-na", app, "--args", `--app=${url}`, "--window-size=880,980"] };
      }
    }
    return { command: "open", args: [url] };
  }
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
}

/** Opens the companion window; false when it could not be launched (the URL is still returned to the agent). */
export function openBrowser(url: string): Promise<boolean> {
  const launch = browserLaunch(url);
  if (!launch) return Promise.resolve(false);
  return new Promise(resolve => {
    try {
      const child = spawn(launch.command, launch.args, { detached: true, stdio: "ignore" });
      child.once("error", () => resolve(false));
      child.once("spawn", () => { child.unref(); resolve(true); });
    } catch { resolve(false); }
  });
}
