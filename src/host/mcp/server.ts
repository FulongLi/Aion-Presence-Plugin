import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { CLIENT_CAPABILITIES_META_KEY, McpServer, type CallToolResult, type ClientCapabilities, type ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import { AION_BODIES, bodyLabel } from "../../core/body";
import { AION_IDENTITY, embodimentStatement } from "../../core/identity";
import {
  cleanCode, cleanText, describePresentation, LIMITS, type PresentationContent,
} from "../../core/presentation";
import { ACTIVITY_STATES } from "../../core/state";
import { visualForms } from "../../visual/forms";
import type { PresenceBackend, PresenceLink } from "../hub/link";
import type { DisplayPreference, HubSnapshot } from "../hub/protocol";
import { loadImageSource, MediaError } from "../media";
import {
  mediaInput, openPresenceInput, setBodyFormInput, setPresenceStateInput, showArtifactInput, showImageInput, showResultInput,
  showTextInput, showVisualFormInput, svgSource, syncInput,
} from "../schemas";
import { decideSurface, hostSupportsMcpApps, openBrowser, type SurfaceMode } from "../surface";

export const PRESENCE_RESOURCE_URI = "ui://aion-presence/presence.html";

export const TOOL_NAMES = [
  "open_presence", "set_presence_state", "set_body_form", "show_visual_form", "show_text", "show_image", "show_result", "show_artifact", "clear_presentation",
] as const;
export const APP_TOOL_NAMES = ["presence_sync", "presence_media"] as const;

export interface AionServerOptions {
  link: PresenceLink;
  /** The single-file presence surface (also served by the hub as the companion page). */
  page: () => string;
  version: string;
  /** Opens the companion window (injectable for tests). */
  openWindow?: (url: string) => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
}

const PRESENTATION_KINDS = ["form", "text", "result", "image", "artifact"] as const;

/** The structured result every Aion tool returns. */
export const presenceOutput = z.object({
  ok: z.boolean(),
  message: z.string(),
  state: z.enum(ACTIVITY_STATES),
  body: z.enum(AION_BODIES),
  presentation: z.object({ id: z.string(), kind: z.enum(PRESENTATION_KINDS), description: z.string(), hold_seconds: z.number() }).nullable(),
  surface: z.object({
    mode: z.enum(["embedded", "companion"]),
    open: z.boolean().describe("A companion window is connected, or the host is embedding Aion."),
    hooks: z.enum(["active", "not-detected"]).describe("active: Codex lifecycle hooks already reflect reading, editing, testing, building and completion."),
  }),
  url: z.string().optional().describe("The local companion window address (open_presence only)."),
  window_opened: z.boolean().optional(),
  fullscreen: z.enum(["requested", "not-requested"]).optional(),
});
type PresenceOutput = z.infer<typeof presenceOutput>;

const formCatalogue = () => visualForms.categories().map(category =>
  `${category.label}: ${visualForms.forms().filter(form => form.category === category.id).map(form => form.id.slice(category.id.length + 1)).join(", ")}`).join(". ");

/**
 * The Aion Presence MCP server: a small, coherent tool surface over the presence hub. Codex is the
 * intelligence and calls these tools; nothing here calls a model, holds a credential or reaches the network.
 */
export function createAionServer(options: AionServerOptions): McpServer {
  const { link } = options;
  const env = options.env ?? process.env;
  const openWindow = options.openWindow ?? openBrowser;
  const server = new McpServer({ name: "aion-presence", title: "Aion Presence", version: options.version }, {
    instructions: `${embodimentStatement("Codex")} Call open_presence when the user asks to open Aion. Use the other tools sparingly, for meaningful state and concise results; see the aion-presence skill.`,
  });
  let embeddedSeen = false;

  const capabilities = (ctx?: ServerContext): ClientCapabilities | undefined =>
    (ctx?.mcpReq.envelope as Record<string, unknown> | undefined)?.[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined
    ?? server.server.getClientCapabilities();
  const modeFor = (ctx?: ServerContext): SurfaceMode => decideSurface(capabilities(ctx), "auto", env).mode;

  const summarize = (snapshot: HubSnapshot, mode: SurfaceMode, message: string, ok = true): PresenceOutput => ({
    ok, message,
    state: snapshot.activity.state,
    body: snapshot.body,
    presentation: snapshot.presentation
      ? { id: snapshot.presentation.id, kind: snapshot.presentation.kind, description: describePresentation(snapshot.presentation), hold_seconds: snapshot.presentation.hold }
      : null,
    surface: { mode, open: mode === "embedded" ? embeddedSeen : snapshot.hub.viewers > 0, hooks: snapshot.hub.hooksActive ? "active" : "not-detected" },
  });
  const result = (output: PresenceOutput): CallToolResult => {
    const notOpen = !output.surface.open && output.surface.mode === "companion" ? " (Aion is not open: call open_presence if the user wants to see it.)" : "";
    return { content: [{ type: "text", text: `${output.message}${notOpen}` }], structuredContent: output };
  };
  const failure = (message: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: message }] });
  const run = async (ctx: ServerContext | undefined, command: (backend: PresenceBackend) => Promise<HubSnapshot>, message: (snapshot: HubSnapshot) => string) => {
    const snapshot = await link.run(command);
    return result(summarize(snapshot, modeFor(ctx), message(snapshot)));
  };
  const present = (ctx: ServerContext, content: PresentationContent, hold?: number) =>
    run(ctx, backend => backend.apply({ type: "present", content, hold }), snapshot => `Aion is presenting ${describePresentation(content)}${snapshot.presentation?.hold ? ` for ${Math.round(snapshot.presentation.hold)} s` : " until cleared"}.`);
  const media = async (source: string) => {
    const { data, mime } = await loadImageSource(source);
    return link.run(backend => backend.addMedia(data, mime));
  };
  const mediaFailure = (error: unknown) => error instanceof MediaError ? failure(`${error.message}: ${error.detail}`) : failure("image-unavailable: the image could not be read.");

  registerAppResource(server, "Aion Presence", PRESENCE_RESOURCE_URI, {
    description: "The Aion Presence surface: Aion's particle body and the presentations it carries.",
    _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: false } },
  }, async () => ({
    contents: [{
      uri: PRESENCE_RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: options.page(),
      _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: false } },
    }],
  }));

  registerAppTool(server, "open_presence", {
    title: "Open Aion",
    description: [
      `Open ${AION_IDENTITY.name}, the visual body of this Codex session. Use when the user asks to open, show or wake Aion ("Open Aion"),`,
      "or once before presenting something visually when Aion is not open. Aion is not another AI model: Codex keeps doing all reasoning and work;",
      "Aion only presents it. In hosts that render MCP Apps Aion appears inside the host (fullscreen when requested and the host offers it);",
      "otherwise a local companion window opens. Calling it again is harmless and does not open a second window. Do not call it every turn.",
    ].join(" "),
    inputSchema: openPresenceInput,
    outputSchema: presenceOutput,
    annotations: { title: "Open Aion", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { resourceUri: PRESENCE_RESOURCE_URI } },
  }, async (args, ctx) => {
    const decision = decideSurface(capabilities(ctx), args.surface ?? "auto", env);
    const display: DisplayPreference = args.display ?? "auto";
    let snapshot = await link.run(backend => backend.apply({ type: "open", display }));
    if (args.body) snapshot = await link.run(backend => backend.apply({ type: "body", body: args.body! }));
    const url = link.current?.surfaceUrl;
    let opened = false;
    if (decision.mode === "embedded") embeddedSeen = true;
    else if (snapshot.hub.viewers === 0 && url) opened = await openWindow(url);
    const output = summarize(snapshot, decision.mode, decision.mode === "embedded"
      ? `Aion is open in ${display === "fullscreen" ? "fullscreen (where the host offers it)" : "this conversation"} as the ${bodyLabel(snapshot.body)}.`
      : snapshot.hub.viewers > 0 ? `Aion is already open in its companion window, as the ${bodyLabel(snapshot.body)}.`
        : opened ? `Aion opened in a companion window, as the ${bodyLabel(snapshot.body)}.`
          : `Aion is ready as the ${bodyLabel(snapshot.body)}; open ${url ?? "the companion window"} to see it.`);
    if (decision.mode === "companion") output.surface.open = snapshot.hub.viewers > 0 || opened;
    return result({ ...output, url, window_opened: opened, fullscreen: display === "fullscreen" ? "requested" : "not-requested" });
  });

  server.registerTool("set_presence_state", {
    title: "Set Aion's state",
    description: [
      "Reflect what Codex is doing in Aion's body language: idle, listening, thinking, working, reading, editing, testing, building, presenting, complete or error.",
      "When open_presence reports hooks: active, reading, editing, testing, building and completion already follow Codex automatically; then use this only",
      "for phases hooks cannot see (thinking through a design, an error you diagnosed). When hooks are not detected, set the state at the start of each",
      "meaningful phase. Never call it for every small step, and never claim a state that is not true.",
    ].join(" "),
    inputSchema: setPresenceStateInput,
    outputSchema: presenceOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (args, ctx) => run(ctx, backend => backend.apply({ type: "activity", state: args.state, label: args.label }), () => `Aion's state is ${args.state}.`));

  server.registerTool("set_body_form", {
    title: "Set Aion's body",
    description: "Change Aion's persistent body: sphere (the original abstract body) or figure (a quiet, minimal humanoid of particles). Use when the user asks for a different body (\"take a human form\", \"go back to the sphere\"). The body persists; every temporary visual returns to it. Not for showing information.",
    inputSchema: setBodyFormInput,
    outputSchema: presenceOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (args, ctx) => run(ctx, backend => backend.apply({ type: "body", body: args.body }), snapshot => `Aion's body is the ${bodyLabel(snapshot.body)}.`));

  server.registerTool("show_visual_form", {
    title: "Show a visual form",
    description: `Turn Aion's body into one of its own procedural visual forms for a moment, then back to its persistent body. Use when the user asks for one of these concepts or one genuinely illustrates the point. Not for arbitrary pictures (show_image) or words (show_text). Forms — ${formCatalogue()}.`,
    inputSchema: showVisualFormInput,
    outputSchema: presenceOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, (args, ctx) => {
    const match = visualForms.lookup(args.form);
    if (!match) return failure(`form-not-found: "${args.form}" is not one of Aion's visual forms. Available: ${visualForms.ids().join(", ")}.`);
    const variant = args.variant === undefined ? match.variant : visualForms.variant(match.entry, args.variant);
    if (args.variant !== undefined && !variant) {
      return failure(`variant-not-found: ${match.entry.id} has ${match.entry.variants?.length ? `the variants ${match.entry.variants.map(item => item.id).join(", ")}` : "no variants"}.`);
    }
    return present(ctx, { kind: "form", form: match.entry.id, ...(variant ? { variant } : {}), label: visualForms.label(match.entry.id, variant) }, args.hold_seconds);
  });

  server.registerTool("show_text", {
    title: "Show text",
    description: `Present concise text with Aion. Up to 16 plain characters (a word, a number such as "48/48", a time) become the particle body itself; longer text (≤ ${LIMITS.text} characters) appears as quiet typography beside the presenting body. Use for one point the user should see at a glance. Not for logs or code (show_artifact); keep detail in the conversation.`,
    inputSchema: showTextInput,
    outputSchema: presenceOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, (args, ctx) => present(ctx, { kind: "text", text: args.text, ...(args.title ? { title: args.title } : {}) }, args.hold_seconds));

  server.registerTool("show_image", {
    title: "Show an image",
    description: "Present an image the user should see — one Codex generated, a screenshot, a rendered diagram. By default Aion's particles become the picture; mode \"framed\" shows the exact image beside the body (best where detail matters). Accepts an absolute local path, a file:// URL or a data:image URL; remote URLs are never fetched and nothing is uploaded anywhere.",
    inputSchema: showImageInput,
    outputSchema: presenceOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args, ctx) => {
    try {
      const ref = await media(args.source);
      return present(ctx, { kind: "image", media: ref, mode: args.mode ?? "particles", ...(args.alt ? { alt: args.alt } : {}) }, args.hold_seconds);
    } catch (error) { return mediaFailure(error); }
  });

  server.registerTool("show_result", {
    title: "Show a result",
    description: "Present the outcome of a task concisely: a title, a one- or two-line summary, a status (success ✓, failure ✕, partial !, info) and up to 8 short detail lines — e.g. title \"Done\", summary \"48 / 48 tests passed\", details [\"8 files changed\", \"Build successful\"]. Use once when meaningful work finishes (tests, a build, a refactor). Never paste logs: the full detail stays in Codex.",
    inputSchema: showResultInput,
    outputSchema: presenceOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, (args, ctx) => present(ctx, { kind: "result", title: args.title, summary: args.summary, status: args.status ?? "info", details: args.details ?? [] }, args.hold_seconds));

  server.registerTool("show_artifact", {
    title: "Show an artifact",
    description: `Show a concise artifact beside Aion: a code excerpt, short text, a list, a file-change summary, an SVG diagram (e.g. an architecture sketch) or a local image. Use when seeing it helps more than describing it. Keep it short (≤ ${LIMITS.artifact} characters — an excerpt, not a whole file). Required fields by type: text/code/svg → content; list → items; changes → changes; image → source.`,
    inputSchema: showArtifactInput,
    outputSchema: presenceOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args, ctx) => {
    const base = { kind: "artifact" as const, type: args.type, title: args.title };
    switch (args.type) {
      case "text": {
        const content = cleanText(args.content, LIMITS.artifact);
        return content ? present(ctx, { ...base, content }, args.hold_seconds) : failure("content-required: a text artifact needs content (plain text).");
      }
      case "code": {
        const content = cleanCode(args.content, LIMITS.artifact);
        return content ? present(ctx, { ...base, content, ...(args.language ? { language: args.language.toLowerCase() } : {}) }, args.hold_seconds)
          : failure("content-required: a code artifact needs content.");
      }
      case "list":
        return args.items ? present(ctx, { ...base, items: args.items }, args.hold_seconds) : failure("items-required: a list artifact needs items.");
      case "changes":
        return args.changes ? present(ctx, { ...base, changes: args.changes }, args.hold_seconds) : failure("changes-required: a changes artifact needs changes.");
      case "svg": {
        const svg = args.content === undefined ? null : svgSource(args.content);
        if (!svg) return failure("svg-invalid: content must be one <svg>…</svg> document.");
        const ref = await link.run(backend => backend.addMedia(Buffer.from(svg, "utf8"), "image/svg+xml"));
        return present(ctx, { ...base, media: ref }, args.hold_seconds);
      }
      case "image": {
        if (!args.source) return failure("source-required: an image artifact needs source (an absolute local path or a data:image URL).");
        try { return present(ctx, { ...base, media: await media(args.source) }, args.hold_seconds); } catch (error) { return mediaFailure(error); }
      }
    }
  });

  server.registerTool("clear_presentation", {
    title: "Clear the presentation",
    description: "End the current presentation now; Aion returns to its persistent body. Presentations end by themselves after their hold, so use this only when the user asks or the content is obsolete.",
    inputSchema: z.object({}).strict(),
    outputSchema: presenceOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (_args, ctx) => run(ctx, backend => backend.apply({ type: "clear" }), () => "Aion returned to its body."));

  // Tools only the embedded view calls. They exist only for hosts that render MCP Apps: elsewhere they would
  // be noise in the agent's tool list.
  let appToolsRegistered = false;
  const registerAppOnlyTools = () => {
    if (appToolsRegistered) return;
    appToolsRegistered = true;
    registerAppTool(server, "presence_sync", {
      title: "Aion Presence sync",
      description: "For the Aion Presence view only: waits for the next presence state.",
      inputSchema: syncInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: PRESENCE_RESOURCE_URI, visibility: ["app"] } },
    }, async args => {
      embeddedSeen = true;
      const snapshot = await link.run(backend => backend.state(args.after_revision ?? -1, args.hub, args.wait_ms ?? 0));
      return { content: [{ type: "text", text: `revision ${snapshot.revision}` }], structuredContent: snapshot as unknown as Record<string, unknown> };
    });
    registerAppTool(server, "presence_media", {
      title: "Aion Presence media",
      description: "For the Aion Presence view only: the bytes of an image being presented.",
      inputSchema: mediaInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: PRESENCE_RESOURCE_URI, visibility: ["app"] } },
    }, async args => {
      const item = await link.run(backend => backend.media(args.id));
      if (!item) return failure("media-not-found");
      return { content: [{ type: "text", text: item.mime }], structuredContent: { mime: item.mime, data: item.data.toString("base64") } };
    });
  };
  if (env.AION_PRESENCE_APP_TOOLS === "always") registerAppOnlyTools();
  server.server.oninitialized = () => { if (hostSupportsMcpApps(server.server.getClientCapabilities())) registerAppOnlyTools(); };
  return server;
}
