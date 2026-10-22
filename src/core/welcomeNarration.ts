import { AION_IDENTITY, type AionIdentity } from "./identity";
import type { WelcomeLanguage } from "./guidance";

/**
 * v0.7: the spoken first-run welcome — what Aion says, which voice says it, and when (a pure state machine, so the
 * lifecycle is tested without a browser). The window speaks it with a local speech synthesizer (the browser's Speech
 * Synthesis API, which on macOS uses the system's voices); no host exposes a speech-output API to a plugin, and the
 * audio bridge only *captures* Codex's voice. Aion still has no model of its own: the words are fixed.
 *
 *   due ─► waiting (body appears, greeting wave, a quiet moment) ─► starting ─► speaking ─► finished ("spoken")
 *                │                                   │
 *                │ no usable voice                   └─ refused without a user gesture ─► offered ("Listen to the welcome")
 *                └─► text (a short accessible text)
 *   any time: Skip ("skipped"), a visual request ("started"), a new conversation turn or closing the window while
 *   speaking ("interrupted"), Replay (speaks again).
 *
 * The hub remembers the welcome as complete only with one of those outcomes: a narration that never began (refused,
 * no voice, the window closed first) is never taken for one that was heard.
 */
export function welcomeScript(language: WelcomeLanguage, identity: AionIdentity = AION_IDENTITY): readonly string[] {
  return language === "zh" ? [
    `你好，我是 ${identity.name}。`,
    "我是你的视觉伙伴，由 Codex 驱动。",
    "我可以帮你探索世界、呈现想法、创建三维模型，让你的项目生动起来。",
    "告诉我你想创造或探索什么就好。",
  ] : [
    `Hello, I'm ${identity.name}.`,
    "I'm your visual companion, powered by Codex.",
    "I can help you explore the world, visualize ideas, create three-dimensional models, and bring your projects to life.",
    "Just tell me what you'd like to create or explore.",
  ];
}

/** The language a synthesizer is asked for. */
export const WELCOME_SPEECH_LANG: Record<WelcomeLanguage, string> = { en: "en-US", zh: "zh-CN" };

/** A voice as a synthesizer lists it (SpeechSynthesisVoice's fields). */
export interface VoiceInfo { name: string; lang: string; localService: boolean; default?: boolean }

/** macOS's novelty voices: never Aion's. */
const NOVELTY = /^(albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|junior|ralph|fred|kathy|grandma|grandpa|rocko|shelley|flo|eddy|reed|sandy)\b/i;

/**
 * The voice for the welcome: an on-device voice in the user's language (a network voice would send the text to a speech
 * service, so it is never chosen), the user's region first, an enhanced or premium voice before a compact one, a
 * natural voice before a novelty one. Null: no on-device voice speaks this language.
 */
export function chooseVoice(voices: readonly VoiceInfo[], language: WelcomeLanguage, preferred = ""): VoiceInfo | null {
  const want = language === "zh" ? "zh" : "en";
  const region = preferred.toLowerCase().replace("_", "-");
  const candidates = voices.filter(v => v.localService && v.lang.toLowerCase().replace("_", "-").split("-")[0] === want && !NOVELTY.test(v.name));
  if (!candidates.length) return null;
  const score = (v: VoiceInfo) => {
    const lang = v.lang.toLowerCase().replace("_", "-");
    let s = 0;
    if (region && region.startsWith(want) && lang === region) s += 8;
    else if (lang === WELCOME_SPEECH_LANG[language].toLowerCase()) s += 6;
    // Mainland Mandarin by default; Cantonese (zh-HK) only when the user's own region asks for it.
    if (want === "zh" && lang === "zh-hk" && region !== "zh-hk") s -= 4;
    if (/premium/i.test(v.name)) s += 5; else if (/enhanced|neural|natural/i.test(v.name)) s += 4;
    if (/^(samantha|ava|allison|susan|serena|karen|daniel|moira|tingting|ting-ting|meijia|lili|yu-shu|tian-tian)\b/i.test(v.name)) s += 2;
    if (v.default) s += 1;
    return s;
  };
  return [...candidates].sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name))[0];
}

export type NarrationPhase = "idle" | "waiting" | "starting" | "speaking" | "offered" | "text" | "finished" | "skipped" | "stopped";
/** Why the welcome is complete (what the hub remembers). */
export const WELCOME_OUTCOMES = ["spoken", "skipped", "started", "interrupted", "read"] as const;
export type NarrationOutcome = (typeof WELCOME_OUTCOMES)[number];
/** What the window should do now. */
export interface NarrationStep { speak?: true; cancel?: true; complete?: NarrationOutcome }

export const narrationDefaults = {
  /** After the body is ready and nothing else is happening, this long before speaking (the greeting wave plays first). */
  settleMs: 1_400,
  /** Waiting this long for a quiet moment (Codex still answering) offers "Listen to the welcome" instead. */
  busyMs: 12_000,
  /** The engine has not started speaking this long after it was asked: treated as refused (autoplay policy). */
  startMs: 2_500,
  /** The text alternative counts as read after this long on screen. */
  readMs: 9_000,
};

export interface NarrationInputs {
  /** The particle body is on screen. */
  bodyReady: boolean;
  /** Codex is working or answering, or the user is talking: the welcome does not talk over them. */
  busy: boolean;
  /** An on-device voice can speak the welcome in this window. */
  speech: boolean;
}

export class WelcomeNarration {
  phase: NarrationPhase = "idle";
  /** The outcome already reported (once per showing). */
  completed: NarrationOutcome | null = null;
  /** The sentence being spoken (or -1). */
  sentence = -1;
  private quietSince: number | null = null;
  private dueAt = 0;
  private askedAt = 0;
  private textAt = 0;
  /** The user asked by a gesture (Listen or Replay): a refusal then is a failure, not an autoplay block. */
  private gesture = false;

  constructor(private readonly options = narrationDefaults) {}

  get active() { return this.phase !== "idle"; }
  get speaking() { return this.phase === "starting" || this.phase === "speaking"; }

  /** The welcome is due (the first launch, or "show me the introduction again"). */
  due(now: number): NarrationStep {
    this.phase = "waiting"; this.completed = null; this.sentence = -1; this.quietSince = null; this.dueAt = now; this.gesture = false;
    return {};
  }

  /** Called often while active: decides when to begin, and notices a start that never came. */
  tick(inputs: NarrationInputs, now: number): NarrationStep {
    if (this.phase === "waiting") {
      if (!inputs.speech) return this.toText(now);
      if (!inputs.bodyReady || inputs.busy) {
        this.quietSince = null;
        if (now - this.dueAt > this.options.busyMs) this.phase = "offered";
        return {};
      }
      this.quietSince ??= now;
      if (now - this.quietSince < this.options.settleMs) return {};
      return this.begin(now, false);
    }
    if (this.phase === "starting" && now - this.askedAt > this.options.startMs) return this.refused(now);
    if (this.phase === "text" && !this.completed && now - this.textAt > this.options.readMs) return this.finish("read");
    return {};
  }

  /** The synthesizer began speaking. */
  started(): NarrationStep { if (this.phase === "starting") this.phase = "speaking"; return {}; }
  /** It began sentence `index`. */
  spokeSentence(index: number) { if (this.speaking) { this.phase = "speaking"; this.sentence = index; } }
  /** It reached the end of the last sentence. */
  ended(): NarrationStep {
    if (!this.speaking) return {};
    this.phase = "finished"; this.sentence = -1;
    return this.finish("spoken");
  }
  /**
   * The synthesizer refused or failed. Before any word was spoken and without a gesture, that is the autoplay policy:
   * offer "Listen to the welcome". Otherwise the short text stands in (and nothing is taken for spoken).
   */
  failed(now: number, notAllowed: boolean): NarrationStep {
    if (!this.speaking) return {};
    if (this.phase === "starting" && notAllowed && !this.gesture) return { ...this.refused(now) };
    return { cancel: true, ...this.toText(now) };
  }

  /** "Listen to the welcome" (a user gesture), or Replay. */
  listen(now: number, speech: boolean): NarrationStep {
    if (this.phase === "idle") return {};
    if (!speech) return this.toText(now);
    return { cancel: true, ...this.begin(now, true) };
  }

  skip(): NarrationStep {
    if (this.phase === "idle") return {};
    const wasSpeaking = this.speaking;
    this.phase = "skipped"; this.sentence = -1;
    return { ...(wasSpeaking ? { cancel: true as const } : {}), ...this.finish("skipped") };
  }

  /**
   * Something else takes over: a visual request (the user has started), a new conversation turn, or the window closing.
   * A narration that had not begun is not completed by a turn or a close (it was never heard).
   */
  interrupt(reason: "visual" | "conversation" | "closed"): NarrationStep {
    if (this.phase === "idle") return {};
    const wasSpeaking = this.speaking, heard = this.phase === "speaking";
    if (reason === "conversation" && !wasSpeaking) return {};
    this.phase = "stopped"; this.sentence = -1;
    const outcome: NarrationOutcome | null = reason === "visual" ? "started" : heard ? "interrupted" : null;
    return { ...(wasSpeaking ? { cancel: true as const } : {}), ...(outcome ? this.finish(outcome) : {}) };
  }

  /** The welcome is put away (it stays complete if it was). */
  close(): NarrationStep {
    const wasSpeaking = this.speaking;
    this.phase = "idle"; this.sentence = -1;
    return wasSpeaking ? { cancel: true } : {};
  }

  private begin(now: number, gesture: boolean): NarrationStep {
    this.phase = "starting"; this.askedAt = now; this.gesture = gesture; this.sentence = -1;
    return { speak: true };
  }
  private refused(now: number): NarrationStep {
    // A gesture-started narration that still never began: the synthesizer does not work here.
    if (this.gesture) return { cancel: true, ...this.toText(now) };
    this.phase = "offered"; this.sentence = -1;
    return { cancel: true };
  }
  private toText(now: number): NarrationStep { this.phase = "text"; this.textAt = now; this.sentence = -1; return {}; }
  private finish(outcome: NarrationOutcome): NarrationStep {
    if (this.completed) return {};
    this.completed = outcome;
    return { complete: outcome };
  }
}
