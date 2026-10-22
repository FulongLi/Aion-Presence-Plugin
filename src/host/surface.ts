import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { getUiCapability, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { ClientCapabilities } from "@modelcontextprotocol/server";

/**
 * Presentation modes (v0.6: Aion's own window by default):
 *
 *   companion  Aion's independent companion window — a quiet app window driven by the local hub. The default on every
 *              host, so "Open Aion" always gives Aion its own space beside the conversation.
 *   embedded   inside the host's conversation, rendered by a host that declares MCP Apps support (the
 *              io.modelcontextprotocol/ui extension with the text/html;profile=mcp-app type) — only when asked for
 *              (`surface: "embedded"`, or AION_PRESENCE_SURFACE=embedded for the v0.5 behaviour).
 *
 * No host API is assumed or emulated. A host that does not declare MCP Apps support never gets the embedded path, even
 * when it is asked for: Aion then opens its own window and says why.
 */
export type SurfaceMode = "embedded" | "companion";
export type SurfaceRequest = "auto" | "companion" | "embedded";

export interface SurfaceDecision {
  mode: SurfaceMode;
  /** Whether the host declared MCP Apps support. */
  embeddedSupported: boolean;
  reason: "companion-default" | "companion-requested" | "embedded-requested" | "embedded-unsupported";
}

export function hostSupportsMcpApps(capabilities: ClientCapabilities | null | undefined): boolean {
  return getUiCapability(capabilities)?.mimeTypes?.includes(RESOURCE_MIME_TYPE) ?? false;
}

export function decideSurface(capabilities: ClientCapabilities | null | undefined, request: SurfaceRequest = "auto",
  env: NodeJS.ProcessEnv = process.env): SurfaceDecision {
  const embeddedSupported = hostSupportsMcpApps(capabilities);
  const forced = env.AION_PRESENCE_SURFACE === "companion" || env.AION_PRESENCE_SURFACE === "embedded" ? env.AION_PRESENCE_SURFACE : null;
  const preference = forced ?? request;
  if (preference === "embedded") {
    return embeddedSupported ? { mode: "embedded", embeddedSupported, reason: "embedded-requested" } : { mode: "companion", embeddedSupported, reason: "embedded-unsupported" };
  }
  return { mode: "companion", embeddedSupported, reason: preference === "companion" ? "companion-requested" : "companion-default" };
}

export interface BrowserLaunch { command: string; args: string[] }

/**
 * How to open the companion window on this platform. A Chromium-family browser in app mode gives a quiet,
 * chrome-less window (and WebGPU) that opens in the foreground; otherwise the default browser opens the page.
 * AION_PRESENCE_BROWSER = default | chrome | none.
 *
 * Window size flags only apply when the browser is not already running (a running Chromium forwards the URL to
 * its existing process and ignores them), so an immersive page also sizes its own app window to the screen (see
 * surface/immersive.ts). True fullscreen always waits for the user's first click: no flag bypasses that.
 */
export function browserLaunch(url: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync, options: { immersive?: boolean } = {}): BrowserLaunch | null {
  const preference = env.AION_PRESENCE_BROWSER ?? "chrome";
  if (preference === "none") return null;
  if (platform === "darwin") {
    if (preference === "chrome") {
      for (const app of ["Google Chrome", "Microsoft Edge", "Chromium", "Brave Browser"]) {
        if (exists(`/Applications/${app}.app`)) return { command: "open", args: ["-na", app, "--args", `--app=${url}`, options.immersive ? "--start-maximized" : "--window-size=880,980"] };
      }
    }
    return { command: "open", args: [url] };
  }
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
}

/** Opens the companion window; false when it could not be launched (the URL is still returned to the agent). */
export function openBrowser(url: string, options: { immersive?: boolean } = {}): Promise<boolean> {
  const launch = browserLaunch(url, process.platform, process.env, existsSync, options);
  if (!launch) return Promise.resolve(false);
  return new Promise(resolve => {
    try {
      const child = spawn(launch.command, launch.args, { detached: true, stdio: "ignore" });
      child.once("error", () => resolve(false));
      child.once("spawn", () => { child.unref(); resolve(true); });
    } catch { resolve(false); }
  });
}
