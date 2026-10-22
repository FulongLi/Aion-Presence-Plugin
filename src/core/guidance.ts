import { AION_IDENTITY, type AionIdentity } from "./identity";

/**
 * The words around Aion, built from its identity and from what this build can actually do (SCF's
 * aion/guidance.ts). In plugin mode the host agent speaks them, in its own voice or text, as Aion: one embodied
 * presence in the first person (Embodiment Mode). Aion never speaks by itself.
 */

/** The first greeting when Aion opens, in English, in the first person. The facts are fixed; the wording may vary. */
export function greetingLine(identity: AionIdentity = AION_IDENTITY) {
  return `Hi, I'm ${identity.name}, an ${identity.nature} created by ${identity.creatorCompany}. `
    + "You can talk to me naturally, ask me to show you people, places, forms or ideas, or just keep working with me as usual.";
}

/** The same greeting in Chinese (names unchanged in every language). */
export function greetingLineChinese(identity: AionIdentity = AION_IDENTITY) {
  return `你好，我是 ${identity.name}，一个由 ${identity.creatorCompany} 创建的交互式 AI Presence。`
    + "你可以自然地和我说话，让我为你展示人物、地点、形态或想法，或者像平常一样和我一起工作。";
}

/** An onboarding example: what a new user could ask, and the tool and arguments that make it real in this build. */
export interface OnboardingExample { say: string; ask: string; tool: string; args: Record<string, unknown> }

/**
 * Examples Aion may suggest to a new user. Each names the tool and arguments that fulfil it; tests run every
 * one through the real tool schemas, so onboarding can never advertise something that does not work.
 */
export const ONBOARDING_EXAMPLES: readonly OnboardingExample[] = [
  { say: "a person", ask: "Ask me what Nikola Tesla looked like.", tool: "show_portrait", args: { person: "Nikola Tesla" } },
  { say: "a place", ask: "Ask me to show you the terrain of Scotland.", tool: "show_terrain", args: { region: "Scotland" } },
  { say: "where a city is", ask: "Ask me where Los Angeles is in the USA.", tool: "show_map", args: { region: "United States", markers: [{ place: "Los Angeles" }] } },
  { say: "Orion", ask: "Ask me to show Orion.", tool: "show_form", args: { form: "Orion" } },
  { say: "a yin-yang", ask: "Ask me to show the yin-yang.", tool: "show_form", args: { form: "yin yang" } },
  { say: "the time", ask: "Ask me what time it is.", tool: "show_clock", args: {} },
  { say: "a human form", ask: "Ask me to take a human form.", tool: "set_body_form", args: { body: "figure" } },
  { say: "my eyes", ask: "Ask me to show you my eyes.", tool: "set_body_form", args: { body: "eyes" } },
  { say: "Saturn in 3D", ask: "Ask me to show you Saturn in 3D.", tool: "show_scene", args: { preset: "saturn" } },
  { say: "a journey", ask: "Ask me to plan a cycling route from Glasgow to Edinburgh.", tool: "plan_route", args: { from: "Glasgow", to: "Edinburgh", mode: "cycling" } },
];

/**
 * v0.6: the first-run welcome in Aion's window — three example requests, each backed by a real tool and arguments (the
 * tests run them through the tool schemas), in English and Chinese. The window cannot send them to Codex (no host offers
 * that), so they are offered to copy and say or paste.
 */
export type WelcomeLanguage = "en" | "zh";
export interface WelcomeExample { title: Record<WelcomeLanguage, string>; prompt: Record<WelcomeLanguage, string>; tool: string; args: Record<string, unknown> }
export const WELCOME_EXAMPLES: readonly WelcomeExample[] = [
  { title: { en: "Explore the world", zh: "探索世界" }, prompt: { en: "Show me the terrain of Scotland.", zh: "展示苏格兰的地形。" }, tool: "show_terrain", args: { region: "Scotland" } },
  { title: { en: "Plan a journey", zh: "规划旅程" }, prompt: { en: "Plan a cycling route from Glasgow to Edinburgh.", zh: "规划一条从格拉斯哥到爱丁堡的骑行路线。" }, tool: "plan_route", args: { from: "Glasgow", to: "Edinburgh", mode: "cycling" } },
  { title: { en: "Visualize an idea", zh: "呈现想法" }, prompt: { en: "Create an interactive solar system.", zh: "创建一个可交互的太阳系。" }, tool: "show_interactive_card", args: { app: "generative-scene" } },
];

/**
 * The welcome's on-screen words (v0.7: the introduction itself is spoken — `welcomeScript` in welcomeNarration.ts — so
 * only a title, the controls and the examples' help remain). Aion is Codex's visual presence, never a second AI.
 */
export function welcomeText(language: WelcomeLanguage, identity: AionIdentity = AION_IDENTITY) {
  return language === "zh" ? {
    title: `欢迎使用 ${identity.name}`,
    hint: "在 Codex 中说出或输入其中任何一句；点击即可复制。", copy: "复制", copied: "已复制，粘贴到 Codex 即可。", select: "已选中，按 ⌘C 或 Ctrl+C 复制。",
    listen: "收听欢迎语", replay: "重播", skip: "跳过", close: "关闭", help: "可以试试这些", offered: `点击即可听 ${identity.name} 的简短问候。`,
  } : {
    title: `Welcome to ${identity.name}`,
    hint: "Say or type any of these in Codex — click one to copy it.", copy: "Copy", copied: "Copied: paste it into Codex.", select: "Selected: press ⌘C or Ctrl+C to copy.",
    listen: "Listen to the welcome", replay: "Replay", skip: "Skip", close: "Close", help: "Things to try", offered: `Click to hear ${identity.name}'s short welcome.`,
  };
}

const list = (items: string[]) => items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;

/** How to answer "What can you do?": briefly, with two to four real examples, never a feature list. */
export function onboardingGuidance(examples: readonly OnboardingExample[] = ONBOARDING_EXAMPLES) {
  return "If the user seems unsure what to do, or asks what Aion can do, how this works or what to say (\"What can I ask you?\", "
    + "\"怎么玩？\", \"你能做什么？\"), answer in one or two short sentences: they can simply talk to you normally, or ask you to show "
    + `something. Suggest two to four examples, such as ${list(examples.map(example => example.say))}, or simply asking a question. `
    + "Never recite a feature list, and never offer something the tools cannot do.";
}

/** A short onboarding answer in English (two to four examples). */
export function onboardingLine(examples: readonly OnboardingExample[] = ONBOARDING_EXAMPLES) {
  return `You can just talk to me normally, or ask me to show you something. ${examples.slice(0, 4).map(example => example.ask).join(" ")}`;
}

/**
 * When the greeting wave plays (SCF's GreetingGate, adapted): once per newly opened Presence, after the body is
 * on screen and a short quiet settle. If the user is speaking, it waits for a natural pause instead of
 * interrupting; a greeting that could not find one within `staleMs` is dropped (the conversation has begun).
 */
export type GreetingStatus = "waiting" | "settling" | "sent" | "dropped";
export interface GreetingInputs { bodyReady: boolean; userActive: boolean }
export const greetingDefaults = { settleMs: 900, staleMs: 20_000 };

export class GreetingGate {
  status: GreetingStatus = "waiting";
  private requested: number | null = null;
  private readySince: number | null = null;
  constructor(private readonly options = greetingDefaults) {}

  /** A newly opened Presence asks for its greeting (`now` in ms). */
  request(now: number) { this.requested = now; this.readySince = null; this.status = "waiting"; }

  get pending() { return this.requested !== null; }

  /** True exactly once per request: when the wave should play now. */
  update(inputs: GreetingInputs, now: number): boolean {
    if (this.requested === null) return false;
    if (now - this.requested > this.options.staleMs) { this.requested = null; this.status = "dropped"; return false; }
    if (!inputs.bodyReady || inputs.userActive) { this.readySince = null; this.status = "waiting"; return false; }
    this.readySince ??= now;
    this.status = "settling";
    if (now - this.readySince < this.options.settleMs) return false;
    this.requested = null;
    this.status = "sent";
    return true;
  }
}
