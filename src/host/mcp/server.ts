import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { CLIENT_CAPABILITIES_META_KEY, McpServer, type CallToolResult, type ClientCapabilities, type ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import { AION_BODIES, bodyLabel, PERSISTENT_BODIES } from "../../core/body";
import { AION_IDENTITY, embodimentStatement } from "../../core/identity";
import {
  cleanCode, cleanText, describePresentation, LIMITS, type Presentation, type PresentationContent,
} from "../../core/presentation";
import { PRESENTATION_ROUTES, type PresentationPreference } from "../../core/presentationRouter";
import { greetingLine, greetingLineChinese, onboardingGuidance } from "../../core/guidance";
import { ACTIVITY_STATES } from "../../core/state";
import { errorCode } from "../../visual/errors";
import { visualForms, type VisualFormRegistry } from "../../visual/forms";
import { clockText } from "../../visual/validate";
import type { PresenceBackend, PresenceLink } from "../hub/link";
import type { DisplayPreference, HubSnapshot } from "../hub/protocol";
import { loadImageSource, MediaError } from "../media";
import { imageSize } from "../resolver/imageInfo";
import { VisualResolver } from "../resolver";
import {
  mediaInput, openPresenceInput, setBodyFormInput, setPresenceStateInput, showArtifactInput, showClockInput, showEmojiInput,
  showFormInput, showImageInput, showNumberInput, showPortraitInput, showResultInput, showSymbolInput, showTerrainInput,
  showTextInput, showVisualFormInput, svgSource, syncInput,
} from "../schemas";
import { decideSurface, hostSupportsMcpApps, openBrowser, type SurfaceMode } from "../surface";

export const PRESENCE_RESOURCE_URI = "ui://aion-presence/presence.html";

export { APP_TOOL_NAMES, TOOL_NAMES, type ToolName } from "./toolNames";

export interface AionServerOptions {
  link: PresenceLink;
  /** The single-file presence surface (also served by the hub as the companion page). */
  page: () => string;
  version: string;
  /** Opens the companion window (injectable for tests). `immersive`: as a foreground, full-screen-sized app window. */
  openWindow?: (url: string, options?: { immersive?: boolean }) => Promise<boolean>;
  /** Looks up portraits, images and terrain on public data sources (injectable for tests). */
  resolver?: VisualResolver;
  /** The plugin's assets/ directory, for curated first-party assets. */
  assetsDir?: string;
  /** The local clock (injectable for tests). */
  now?: () => Date;
  /** A companion window launched this recently is never replaced (it may still be loading). Default 15 s. */
  relaunchQuietMs?: number;
  /** Called once the host has connected and declared its capabilities (first-run opening). */
  onReady?: (host: { embedded: boolean; client?: string }) => void;
  env?: NodeJS.ProcessEnv;
}

const PRESENTATION_KINDS = ["form", "text", "result", "image", "terrain", "clock", "number", "symbol", "emoji", "artifact"] as const;

/** The structured result every Aion tool returns. */
export const presenceOutput = z.object({
  ok: z.boolean(),
  message: z.string(),
  state: z.enum(ACTIVITY_STATES),
  body: z.enum(AION_BODIES),
  presentation: z.object({
    id: z.string(), kind: z.enum(PRESENTATION_KINDS), description: z.string(), hold_seconds: z.number(),
    route: z.enum(PRESENTATION_ROUTES).describe("body: Aion's particle body became it. card: a high-fidelity card beside the body. hybrid: both."),
    reason: z.string().describe("Why this route (e.g. portrait-hybrid, fidelity, body-native, too-detailed-for-body)."),
  }).nullable(),
  surface: z.object({
    mode: z.enum(["embedded", "companion"]),
    open: z.boolean().describe("A companion window is connected, or the host is embedding Aion."),
    hooks: z.enum(["active", "not-detected"]).describe("active: Codex lifecycle hooks already reflect reading, editing, testing, building and completion."),
  }),
  shown: z.string().optional().describe("What the body shows, when you may want to say it: the local time, the form a name found, the person or place found."),
  source: z.object({ provider: z.string(), page: z.string().optional(), license: z.string().optional() }).optional()
    .describe("Where a looked-up picture or terrain came from (a public source), for attribution if asked."),
  greeting: z.object({
    due: z.boolean().describe("true once per newly opened Presence: introduce Aion in one short reply (see line); false: it is already open, do not greet again."),
    line: z.string().optional().describe("The canonical introduction in English. Word it naturally; keep the names and facts."),
    line_zh: z.string().optional().describe("The same introduction in Chinese, for a user writing in Chinese."),
  }).optional(),
  url: z.string().optional().describe("The local companion window address (open_presence only)."),
  window_opened: z.boolean().optional(),
  fullscreen: z.enum(["requested", "not-requested"]).optional(),
  immersive: z.object({
    requested: z.boolean(),
    path: z.enum(["host-fullscreen", "companion-fullscreen", "companion-window", "none"])
      .describe("host-fullscreen: asked the host for its fullscreen display mode (the host's own composer or voice controls may stay). "
        + "companion-fullscreen: a foreground window that enters true fullscreen at the user's first click on Enter Presence. "
        + "companion-window: a foreground window only. none: not requested."),
    needs_gesture: z.boolean().describe("The browser requires one click (Enter Presence) before true fullscreen."),
  }).optional(),
});
type PresenceOutput = z.infer<typeof presenceOutput>;

/** Every form id SCF's own visual language offers, grouped by category (symbols have their own tool). */
export function formCatalog(registry: VisualFormRegistry = visualForms): string {
  return registry.categories().filter(category => category.id !== "symbol")
    .map(category => `${category.label}: ${registry.forms().filter(form => form.category === category.id).map(form => form.id).join(", ")}`)
    .join(". ");
}

/** The variants forms declare, forms with the same set grouped together; the first is the default (SCF). */
export function formVariantCatalog(registry: VisualFormRegistry = visualForms): string {
  const groups = new Map<string, string[]>();
  for (const form of registry.forms()) {
    if (!form.variants?.length) continue;
    const key = form.variants.map((variant, index) => `${variant.id}${index ? "" : " (default)"}`).join(" or ");
    groups.set(key, [...(groups.get(key) ?? []), form.id]);
  }
  return [...groups].map(([variants, forms]) => `${forms.join(", ")}: ${variants}`).join("; ");
}

/**
 * Tool descriptions are part of the visual-intent system: Codex chooses a visual from them. The wording is
 * SCF's, tuned there over many conversations, with "your particle body" read as Aion, Codex's body.
 */
export const TOOL_DESCRIPTIONS = {
  show_image: `Form a picture of almost anything with Aion's particle body: a person, vehicle, product, object, animal, building, place, `
    + `artwork, logo, map or a reference image of an idea. With query, Aion first checks its curated local assets (such as the `
    + `${AION_IDENTITY.creatorCompany} company logo), then searches open image sources (Wikipedia, Wikimedia Commons, Openverse); no key is needed. `
    + "With source, it shows an image on this machine instead: one Codex generated, a screenshot, a rendered diagram. Use when seeing it "
    + "materially helps, e.g. the user asks what something looks like or wants to see it. For a real person's face prefer show_portrait; "
    + "for Taoist symbols, constellations and zodiac signs always use show_form.",
  show_portrait: "Form a portrait of a real, recognizable person with Aion's particle body, from public photos (Wikipedia, then other open "
    + "image sources), framed head and shoulders. Use when the user wants to see what someone looks like (\"What did Nikola Tesla look "
    + "like?\", \"Show me Albert Einstein\"), or when a portrait materially helps the answer. Do not call just because a name appears in "
    + "conversation.",
  show_terrain: "Form the terrain of a real region as a raised relief with Aion's particle body, from real elevation data: mountains rise, "
    + "valleys sink. Use for the terrain, topography, relief or landscape shape of a country, region, island, mountain range or other "
    + "place (\"What is the terrain of Scotland like?\", \"Show me the Swiss Alps\").",
  show_form: () => "Form a symbol or figure from Aion's own visual language directly with its particle body. It is drawn procedurally on the "
    + "device, with no image search: Taoist symbols (the yin-yang/taiji, the yin and yang lines, the eight trigrams 乾 兑 离 震 巽 坎 艮 坤 "
    + "and the bagua), constellations as star maps, the twelve zodiac signs and the planetary symbols. Always prefer it to show_image for "
    + "these (\"What does Orion look like?\", \"Show me the yin-yang\"). Pass a form id from the list, or a plain name in English or Chinese "
    + `("yin yang", "Orion", "Leo zodiac sign", "猎户座"). Form ids: ${formCatalog()}.`,
  show_clock: "Form a clock face showing a time with Aion's particle body. Use when seeing a time helps: the user asks what time it is, or "
    + "a specific time matters to the answer. Omit time to show the user's current local time; the result tells you that time so you can say it.",
  show_number: "Show one short, key number with Aion's particle body (e.g. 42%, 84, 23°C, £28,000, 3.14). Use only for the single number "
    + "that is the heart of the answer, not for every number mentioned.",
  show_text: `Show text with Aion. One short word or label (up to 16 plain characters, e.g. a city, a name, "48/48") becomes the particle `
    + `body itself: use it sparingly, when a single word is the answer or a useful anchor. Longer text (≤ ${LIMITS.text} characters) appears as `
    + "quiet typography beside the presenting body, for one point the user should see at a glance. Not for logs or code (show_artifact).",
  show_symbol: "Show a simple symbol with Aion's particle body, e.g. a check for yes/correct, a cross for no/wrong, a heart, a star, or an "
    + "arrow for a direction or trend.",
  show_emoji: "Briefly form one emoji with Aion's particle body as a short expressive reaction, like a gesture: e.g. 🎉 for a celebration, "
    + "😂 amusement, 🤔 thinking, 😮 surprise, 👍 approval, 💡 an idea, 🚀 a launch. Also use it when the user asks to see an emoji. It is drawn "
    + "instantly on the device (no image search). Use it only when a reaction genuinely adds to the moment, never on every reply or as filler.",
  clear_presentation: "Immediately end the temporary visual or presentation, e.g. when it is no longer relevant: Aion returns to its current "
    + "persistent body (the sphere or the figure). It does not change that body; use set_body_form for that. Presentations also end by "
    + "themselves after their hold.",
  set_body_form: "Change Aion's persistent body, the form it rests in between visuals: "
    + `${PERSISTENT_BODIES.map(body => `"${body.id}" (${body.description.replace(/^your /, "its ")})`).join(", ")}. `
    + "Use it only when the user asks Aion to take a form, e.g. \"take a human form\", \"become a figure\", \"go back to the sphere\", "
    + "\"变成人形\", \"回到球体\". It stays until changed; every temporary visual returns to it. A figure is not a person to search for: "
    + "never use show_image or show_portrait for it.",
} as const;

/** The route in a few words, for the tool result. */
function routeWords(presentation: Presentation): string {
  const seconds = (value: number) => value ? `${Math.round(value)} s` : "until cleared";
  switch (presentation.route) {
    case "body": return `the body becomes it (${seconds(presentation.bodyHold)}; ${presentation.reason})`;
    case "card": return `a card beside the body (${seconds(presentation.cardHold)}; ${presentation.reason})`;
    case "hybrid": return `the body forms it (${seconds(presentation.bodyHold)}) and a card shows the original (${seconds(presentation.cardHold)}; ${presentation.reason})`;
  }
}

/** Model-facing explanations of resolver failures (SCF's tool statuses), so Codex can carry on in words. */
function resolveFailure(code: string, what: string): string {
  switch (code) {
    case "portrait-not-found": return `portrait-not-found: no public portrait of ${what} was found. Describe them in words instead.`;
    case "image-not-found": return `image-not-found: no suitable open image of "${what}" was found. Describe it in words, or try a more specific query.`;
    case "region-not-found": return `region-not-found: no place called "${what}" was found. Check the name, or describe the terrain in words.`;
    case "terrain-unavailable": return `terrain-unavailable: elevation data for ${what} could not be loaded right now. Describe the terrain in words.`;
    default: return `${code}: the public image sources could not be reached right now. Answer in words; Aion stays as it is.`;
  }
}

/**
 * The Aion Presence MCP server: a small, coherent tool surface over the presence hub. Codex is the
 * intelligence and calls these tools; nothing here calls a model or holds a credential. The only network it
 * uses beyond its loopback hub is public data (pictures, places, elevation) when Codex asks to show one.
 */
export function createAionServer(options: AionServerOptions): McpServer {
  const { link } = options;
  const env = options.env ?? process.env;
  const openWindow = options.openWindow ?? openBrowser;
  const resolver = options.resolver ?? new VisualResolver({ env, assetsDir: options.assetsDir });
  const now = options.now ?? (() => new Date());
  const server = new McpServer({ name: "aion-presence", title: "Aion Presence", version: options.version }, {
    instructions: `${embodimentStatement("Codex")} Call open_presence with display "immersive" when the user asks to open Aion. While Aion `
      + "is open, you are present to the user as Aion: speak in the first person, never describe Aion as a separate agent, and do not narrate "
      + "these tools. When the user asks to see something, or what someone or something looks like, show it with the matching tool instead of "
      + `only describing it; otherwise use the tools sparingly. ${onboardingGuidance()} See the aion-presence skill (Embodiment Mode).`,
  });
  let embeddedSeen = false;
  /** When this server last launched a companion window: a window still loading is never replaced. */
  let launchedAt = -Infinity;
  const RELAUNCH_QUIET_MS = options.relaunchQuietMs ?? 15_000;
  /** When an embedded view last synced: it is showing Aion right now if that was recent. */
  let embeddedSyncAt = -Infinity;
  const EMBEDDED_LIVE_MS = 30_000;

  const capabilities = (ctx?: ServerContext): ClientCapabilities | undefined =>
    (ctx?.mcpReq.envelope as Record<string, unknown> | undefined)?.[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined
    ?? server.server.getClientCapabilities();
  const modeFor = (ctx?: ServerContext): SurfaceMode => decideSurface(capabilities(ctx), "auto", env).mode;

  const summarize = (snapshot: HubSnapshot, mode: SurfaceMode, message: string, ok = true): PresenceOutput => ({
    ok, message,
    state: snapshot.activity.state,
    body: snapshot.body,
    presentation: snapshot.presentation
      ? {
        id: snapshot.presentation.id, kind: snapshot.presentation.kind, description: describePresentation(snapshot.presentation), hold_seconds: snapshot.presentation.hold,
        route: snapshot.presentation.route, reason: snapshot.presentation.reason,
      }
      : null,
    surface: { mode, open: mode === "embedded" ? embeddedSeen : snapshot.hub.viewers > 0, hooks: snapshot.hub.hooksActive ? "active" : "not-detected" },
  });
  const result = (output: PresenceOutput): CallToolResult => {
    const notOpen = !output.surface.open && output.surface.mode === "companion" ? " (Aion is not open: call open_presence if the user wants to see it.)" : "";
    return { content: [{ type: "text", text: `${output.message}${notOpen}` }], structuredContent: output };
  };
  const failure = (message: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: message }] });
  const run = async (ctx: ServerContext | undefined, command: (backend: PresenceBackend) => Promise<HubSnapshot>, message: (snapshot: HubSnapshot) => string,
    extra: Partial<PresenceOutput> = {}) => {
    const snapshot = await link.run(command);
    return result({ ...summarize(snapshot, modeFor(ctx), message(snapshot)), ...extra });
  };
  const present = (ctx: ServerContext, content: PresentationContent, hold?: number, extra: Partial<PresenceOutput> = {},
    request: { presentation?: PresentationPreference; detail?: boolean } = {}) =>
    run(ctx, backend => backend.apply({ type: "present", content, hold, ...request }),
      snapshot => `Shown: ${describePresentation(content)}${snapshot.presentation ? ` — ${routeWords(snapshot.presentation)}` : ""}. `
        + "Answer in your own voice, in the first person; do not narrate this tool call.", extra);
  const media = async (source: string) => {
    const { data, mime } = await loadImageSource(source);
    return link.run(backend => backend.addMedia(data, mime));
  };
  const mediaFailure = (error: unknown) => error instanceof MediaError ? failure(`${error.message}: ${error.detail}`) : failure("image-unavailable: the image could not be read.");
  const hand = (bytes: Uint8Array, mime: string) => link.run(backend => backend.addMedia(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), mime));
  const credit = (source: { provider: string; license?: string }) => source.provider === "local-assets" ? undefined
    : `${{ wikipedia: "Wikipedia", commons: "Wikimedia Commons", openverse: "Openverse", web: "Web search" }[source.provider] ?? source.provider}${source.license ? ` · ${source.license}` : ""}`.slice(0, LIMITS.title);
  const label = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, LIMITS.title) || undefined;
  const size = (bytes: Uint8Array) => imageSize(bytes) ?? {};

  const showForm = (ctx: ServerContext, args: z.infer<typeof showFormInput>) => {
    const match = visualForms.lookup(args.form);
    if (!match) return failure(`form-not-found: "${args.form}" is not one of Aion's visual forms yet. Use another tool (show_image for a picture), or just speak. Available: ${visualForms.ids().join(", ")}.`);
    // An unknown variant falls back to the default, like an image intent (SCF): only a well-formed but unknown name fails.
    const variant = (args.variant === undefined ? undefined : visualForms.variant(match.entry, args.variant)) ?? match.variant;
    const shown = visualForms.label(match.entry.id, variant);
    return present(ctx, { kind: "form", form: match.entry.id, ...(variant ? { variant } : {}), label: shown }, args.hold_seconds, { shown });
  };

  registerAppResource(server, "Aion Presence", PRESENCE_RESOURCE_URI, {
    description: "The Aion Presence surface: Aion's particle body and the presentations it carries.",
    _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, permissions: { microphone: {} }, prefersBorder: false } },
  }, async () => ({
    contents: [{
      uri: PRESENCE_RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: options.page(),
      // The microphone is only analysed locally for body language (never recorded or sent); hosts may decline it.
      _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, permissions: { microphone: {} }, prefersBorder: false } },
    }],
  }));

  registerAppTool(server, "open_presence", {
    title: "Open Aion",
    description: [
      `Open ${AION_IDENTITY.name}, your embodied interface: while it is open the user sees and hears you through Aion. Use when the user asks to open,`,
      "show or wake Aion (\"Open Aion\", \"打开 Aion\") — then pass display \"immersive\" — or once before presenting something visually when Aion is",
      "not open. Aion is not another AI model: you keep doing all reasoning and work. In hosts that render MCP Apps Aion appears inside the host",
      "(fullscreen where the host offers it); otherwise a local companion window opens in the foreground. Calling it again is harmless and does",
      "not open a second window. Do not call it every turn.",
    ].join(" "),
    inputSchema: openPresenceInput,
    outputSchema: presenceOutput,
    annotations: { title: "Open Aion", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { resourceUri: PRESENCE_RESOURCE_URI } },
  }, async (args, ctx) => {
    const decision = decideSurface(capabilities(ctx), args.surface ?? "auto", env);
    const display: DisplayPreference = args.display ?? "auto";
    const immersive = display === "immersive" || display === "fullscreen";
    // A newly opened Presence (nothing is showing Aion yet) greets once: a small wave, and Codex's introduction.
    const before = await link.run(backend => backend.state());
    const fresh = decision.mode === "embedded" ? Date.now() - embeddedSyncAt > EMBEDDED_LIVE_MS : before.hub.viewers === 0;
    let snapshot = await link.run(backend => backend.apply({ type: "open", display, greet: fresh }));
    // Aion may already be showing because it opened by itself on the first run: Codex still introduces it, once.
    const introduce = fresh || before.hub.introduction;
    if (before.hub.introduction) snapshot = await link.run(backend => backend.apply({ type: "introduced" }));
    if (args.body) snapshot = await link.run(backend => backend.apply({ type: "body", body: args.body! }));
    // AION_PRESENCE_DEBUG=1 opens the companion with its diagnostics (for `npm run diagnose`; development only).
    const url = link.current?.surfaceUrl && `${link.current.surfaceUrl}${env.AION_PRESENCE_DEBUG === "1" ? "&debug=1" : ""}`;
    let opened = false;
    if (decision.mode === "embedded") embeddedSeen = true;
    else if (snapshot.hub.viewers === 0 && url) opened = await openWindow(url, { immersive });
    else if (immersive && url && !snapshot.hub.surface.visible && !snapshot.hub.surface.fullscreen && Date.now() - launchedAt > RELAUNCH_QUIET_MS) {
      // Open but hidden behind other windows (or minimized): a page cannot raise itself, but a newly launched app
      // window comes to the front. It replaces the open one, which retires as soon as the new one connects. (Focus
      // alone is not used: a pending permission prompt takes it from a window that is in front.)
      snapshot = await link.run(backend => backend.apply({ type: "supersede" }));
      opened = await openWindow(url, { immersive });
    }
    if (opened) launchedAt = Date.now();
    const output = summarize(snapshot, decision.mode, decision.mode === "embedded"
      ? `Aion is open ${immersive ? "and asked the host for fullscreen (the host decides; its own composer may stay visible)" : "in this conversation"}, as the ${bodyLabel(snapshot.body)}.`
      : opened ? `Aion opened in its own ${immersive ? "foreground window; one click on Enter Presence makes it fullscreen" : "window"}, as the ${bodyLabel(snapshot.body)}.`
        : snapshot.hub.viewers > 0 ? `Aion is already open${snapshot.hub.surface.fullscreen ? " in fullscreen (its own space)" : snapshot.hub.surface.visible ? " on screen" : ""}, as the ${bodyLabel(snapshot.body)}.`
          : `Aion is ready as the ${bodyLabel(snapshot.body)}; open ${url ?? "the companion window"} to see it.`);
    if (decision.mode === "companion") output.surface.open = snapshot.hub.viewers > 0 || opened;
    const greeting = introduce ? { due: true, line: greetingLine(), line_zh: greetingLineChinese() } : { due: false };
    if (introduce) output.message += " A greeting is due: introduce Aion once, briefly (see greeting.line).";
    const path = !immersive ? "none" : decision.mode === "embedded" ? "host-fullscreen" : "companion-fullscreen";
    return result({
      ...output, greeting, url, window_opened: opened, fullscreen: immersive ? "requested" : "not-requested",
      immersive: { requested: immersive, path, needs_gesture: path === "companion-fullscreen" },
    });
  });

  server.registerTool("set_presence_state", {
    title: "Set Aion's state",
    description: [
      `Reflect what Codex is doing in Aion's body language: ${ACTIVITY_STATES.join(", ")}.`,
      "When open_presence reports hooks: active, reading, editing, testing, building and completion already follow Codex automatically; then use this only",
      "for phases hooks cannot see (thinking through a design, an error you diagnosed). When hooks are not detected, set the state at the start of each",
      "meaningful phase. Never call it for every small step, and never claim a state that is not true.",
    ].join(" "),
    inputSchema: setPresenceStateInput,
    outputSchema: presenceOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (args, ctx) => run(ctx, backend => backend.apply({ type: "activity", state: args.state, label: args.label }), () => `State: ${args.state}. Nothing to tell the user about it.`));

  server.registerTool("set_body_form", {
    title: "Set Aion's body",
    description: TOOL_DESCRIPTIONS.set_body_form,
    inputSchema: setBodyFormInput,
    outputSchema: presenceOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (args, ctx) => run(ctx, backend => backend.apply({ type: "body", body: args.body }), snapshot => `Body: ${bodyLabel(snapshot.body)}. Say it in the first person if at all (e.g. "Here I am in human form").`,
    { shown: bodyLabel(args.body) }));

  server.registerTool("show_image", {
    title: "Show an image",
    description: TOOL_DESCRIPTIONS.show_image,
    inputSchema: showImageInput,
    outputSchema: presenceOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (args, ctx) => {
    if ((args.query === undefined) === (args.source === undefined)) {
      return failure("invalid-arguments: give exactly one of query (something to look up, e.g. \"Eiffel Tower\") or source (an image file on this machine).");
    }
    if (args.source !== undefined) {
      try {
        const { data, mime } = await loadImageSource(args.source);
        const ref = await link.run(backend => backend.addMedia(data, mime));
        return present(ctx, { kind: "image", media: ref, ...(args.mode ? { mode: args.mode } : {}), fit: "object", origin: "local", ...size(data), ...(args.alt ? { alt: args.alt } : {}) },
          args.hold_seconds, {}, { presentation: args.presentation, detail: args.detail });
      } catch (error) { return mediaFailure(error); }
    }
    try {
      const found = await resolver.image(args.query!, args.intent ?? "general");
      const ref = await hand(found.bytes, found.mime);
      const alt = args.alt ?? label(found.label);
      const by = credit(found.source);
      return present(ctx, {
        kind: "image", media: ref, ...(args.mode ? { mode: args.mode } : {}), fit: found.fit, origin: "lookup",
        ...(found.width && found.height ? { width: found.width, height: found.height } : {}), ...(alt ? { alt } : {}), ...(by ? { credit: by } : {}),
      }, args.hold_seconds, { shown: found.label, source: found.source }, { presentation: args.presentation, detail: args.detail });
    } catch (error) { return failure(resolveFailure(errorCode(error), args.query!)); }
  });

  server.registerTool("show_portrait", {
    title: "Show a portrait",
    description: TOOL_DESCRIPTIONS.show_portrait,
    inputSchema: showPortraitInput,
    outputSchema: presenceOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args, ctx) => {
    try {
      const found = await resolver.portrait(args.person);
      const ref = await hand(found.bytes, found.mime);
      const by = credit(found.source);
      return present(ctx, {
        kind: "image", media: ref, fit: "portrait", origin: "lookup", alt: label(found.label) ?? args.person,
        ...(found.width && found.height ? { width: found.width, height: found.height } : {}), ...(by ? { credit: by } : {}),
      }, args.hold_seconds, { shown: found.label, source: found.source }, { presentation: args.presentation });
    } catch (error) { return failure(resolveFailure(errorCode(error), args.person)); }
  });

  server.registerTool("show_terrain", {
    title: "Show terrain",
    description: TOOL_DESCRIPTIONS.show_terrain,
    inputSchema: showTerrainInput,
    outputSchema: presenceOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args, ctx) => {
    try {
      const found = await resolver.terrain(args.region, args.style ?? "terrain");
      const ref = await hand(found.bytes, found.mime);
      const { elevation } = found.field;
      const by = credit(found.source);
      return present(ctx, {
        kind: "terrain", media: ref, style: args.style ?? "terrain", label: label(found.label) ?? args.region,
        ...(elevation ? { elevation: { min: elevation.min, max: elevation.max } } : {}), ...(by ? { credit: by } : {}),
      }, args.hold_seconds, { shown: `${found.label}${elevation ? ` (elevation ${elevation.min}–${elevation.max} m)` : ""}`, source: found.source },
      { presentation: args.presentation });
    } catch (error) { return failure(resolveFailure(errorCode(error), args.region)); }
  });

  server.registerTool("show_form", {
    title: "Show a visual form",
    description: TOOL_DESCRIPTIONS.show_form(),
    inputSchema: showFormInput,
    outputSchema: presenceOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, (args, ctx) => showForm(ctx, args));

  server.registerTool("show_clock", {
    title: "Show a clock",
    description: TOOL_DESCRIPTIONS.show_clock,
    inputSchema: showClockInput,
    outputSchema: presenceOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, (args, ctx) => {
    const time = args.time ?? clockText(now());
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return present(ctx, { kind: "clock", time }, args.hold_seconds, { shown: args.time ? time : `${time} (local time, ${zone})` });
  });

  server.registerTool("show_number", {
    title: "Show a number",
    description: TOOL_DESCRIPTIONS.show_number,
    inputSchema: showNumberInput,
    outputSchema: presenceOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, (args, ctx) => present(ctx, { kind: "number", value: args.value }, args.hold_seconds));

  server.registerTool("show_text", {
    title: "Show text",
    description: TOOL_DESCRIPTIONS.show_text,
    inputSchema: showTextInput,
    outputSchema: presenceOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, (args, ctx) => present(ctx, { kind: "text", text: args.text, ...(args.title ? { title: args.title } : {}) }, args.hold_seconds, {}, { presentation: args.presentation }));

  server.registerTool("show_symbol", {
    title: "Show a symbol",
    description: TOOL_DESCRIPTIONS.show_symbol,
    inputSchema: showSymbolInput,
    outputSchema: presenceOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, (args, ctx) => present(ctx, { kind: "symbol", symbol: args.symbol }, args.hold_seconds));

  server.registerTool("show_emoji", {
    title: "Show an emoji",
    description: TOOL_DESCRIPTIONS.show_emoji,
    inputSchema: showEmojiInput,
    outputSchema: presenceOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, (args, ctx) => present(ctx, { kind: "emoji", emoji: args.emoji }, args.hold_seconds));

  server.registerTool("show_result", {
    title: "Show a result",
    description: "Present the outcome of a task concisely: a title, a one- or two-line summary, a status (success ✓, failure ✕, partial !, info) and up to 8 short detail lines — e.g. title \"Done\", summary \"48 / 48 tests passed\", details [\"8 files changed\", \"Build successful\"]. Use once when meaningful work finishes (tests, a build, a refactor). Never paste logs: the full detail stays in Codex.",
    inputSchema: showResultInput,
    outputSchema: presenceOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, (args, ctx) => present(ctx, { kind: "result", title: args.title, summary: args.summary, status: args.status ?? "info", details: args.details ?? [] },
    args.hold_seconds, {}, { presentation: args.presentation }));

  server.registerTool("show_artifact", {
    title: "Show an artifact",
    description: `Show a concise artifact beside Aion: a code excerpt, short text, a list, a file-change summary, an SVG diagram (e.g. an architecture sketch) or a local image. Use when seeing it helps more than describing it. Keep it short (≤ ${LIMITS.artifact} characters — an excerpt, not a whole file). Required fields by type: text/code/svg → content; list → items; changes → changes; image → source.`,
    inputSchema: showArtifactInput,
    outputSchema: presenceOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args, ctx) => {
    const base = { kind: "artifact" as const, type: args.type, title: args.title };
    const routed = { presentation: args.presentation };
    switch (args.type) {
      case "text": {
        const content = cleanText(args.content, LIMITS.artifact);
        return content ? present(ctx, { ...base, content }, args.hold_seconds, {}, routed) : failure("content-required: a text artifact needs content (plain text).");
      }
      case "code": {
        const content = cleanCode(args.content, LIMITS.artifact);
        return content ? present(ctx, { ...base, content, ...(args.language ? { language: args.language.toLowerCase() } : {}) }, args.hold_seconds, {}, routed)
          : failure("content-required: a code artifact needs content.");
      }
      case "list":
        return args.items ? present(ctx, { ...base, items: args.items }, args.hold_seconds, {}, routed) : failure("items-required: a list artifact needs items.");
      case "changes":
        return args.changes ? present(ctx, { ...base, changes: args.changes }, args.hold_seconds, {}, routed) : failure("changes-required: a changes artifact needs changes.");
      case "svg": {
        const svg = args.content === undefined ? null : svgSource(args.content);
        if (!svg) return failure("svg-invalid: content must be one <svg>…</svg> document.");
        const ref = await link.run(backend => backend.addMedia(Buffer.from(svg, "utf8"), "image/svg+xml"));
        return present(ctx, { ...base, media: ref }, args.hold_seconds, {}, routed);
      }
      case "image": {
        if (!args.source) return failure("source-required: an image artifact needs source (an absolute local path or a data:image URL).");
        try { return present(ctx, { ...base, media: await media(args.source) }, args.hold_seconds, {}, routed); } catch (error) { return mediaFailure(error); }
      }
    }
  });

  server.registerTool("clear_presentation", {
    title: "Return to the body",
    description: TOOL_DESCRIPTIONS.clear_presentation,
    inputSchema: z.object({}).strict(),
    outputSchema: presenceOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (_args, ctx) => run(ctx, backend => backend.apply({ type: "clear" }), () => "Cleared: back to the persistent body."));

  server.registerTool("show_visual_form", {
    title: "Show a visual form (older name)",
    description: "Older name of show_form, kept so earlier clients keep working. Prefer show_form; it behaves identically.",
    inputSchema: showVisualFormInput,
    outputSchema: presenceOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, (args, ctx) => showForm(ctx, args));

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
      embeddedSyncAt = Date.now();
      const snapshot = await link.run(backend => backend.state(args.after_revision ?? -1, args.hub, args.wait_ms ?? 0));
      return { content: [{ type: "text", text: `revision ${snapshot.revision}` }], structuredContent: snapshot as unknown as Record<string, unknown> };
    });
    registerAppTool(server, "presence_media", {
      title: "Aion Presence media",
      description: "For the Aion Presence view only: the bytes of an image or terrain being presented.",
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
  server.server.oninitialized = () => {
    const embedded = hostSupportsMcpApps(server.server.getClientCapabilities());
    if (embedded) registerAppOnlyTools();
    options.onReady?.({ embedded, client: server.server.getClientVersion()?.name });
  };
  return server;
}
