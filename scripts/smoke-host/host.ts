import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

/**
 * A minimal MCP Apps host for the smoke test, built from the official AppBridge: it embeds the Aion view in a
 * sandboxed iframe, offers the inline and fullscreen display modes, and forwards the view's tool calls to the
 * real Aion MCP server (through the test runner). Nothing here is Aion-specific.
 */
declare global {
  interface Window {
    hostCallTool(params: unknown): Promise<unknown>;
    hostLog: string[];
    hostDisplayMode: string;
  }
}

window.hostLog = [];
window.hostDisplayMode = "inline";
const iframe = document.createElement("iframe");
iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
iframe.style.cssText = "width: 100%; height: 520px; border: 0; display: block";
document.body.append(iframe);

const bridge = new AppBridge(null, { name: "smoke-host", version: "1.0.0" }, { serverTools: {} }, {
  hostContext: { displayMode: "inline", availableDisplayModes: ["inline", "fullscreen"], theme: "dark", platform: "desktop" },
});
bridge.oncalltool = async params => window.hostCallTool(params) as never;
bridge.onrequestdisplaymode = async ({ mode }) => {
  window.hostLog.push(`display:${mode}`);
  window.hostDisplayMode = mode;
  iframe.style.height = mode === "fullscreen" ? "100vh" : "520px";
  await bridge.sendHostContextChange({ displayMode: mode });
  return { mode };
};
bridge.oninitialized = () => window.hostLog.push("initialized");
await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
iframe.src = "/presence.html";
