import { chooseVoice, WELCOME_SPEECH_LANG, type VoiceInfo } from "../core/welcomeNarration";
import type { WelcomeLanguage } from "../core/guidance";

/**
 * v0.7: the welcome's voice — a small adapter over the browser's Speech Synthesis API (on macOS, the system's own
 * on-device voices). It speaks the fixed welcome sentence by sentence (captions follow, and no engine cuts a long
 * utterance short), reports what really happened (started, each sentence, each word boundary, ended, refused, failed),
 * and stops at once when asked or when the window goes away. It never chooses a network voice and never works around
 * the browser's autoplay policy: a refusal is reported, and the welcome offers a button.
 */
export interface WelcomeSpeechEvents {
  started(): void;
  sentence(index: number): void;
  /** A word boundary the synthesizer reported (real timing, not amplitude). */
  word(): void;
  ended(): void;
  /** `notAllowed`: the browser refused to speak without a user gesture. */
  failed(notAllowed: boolean, detail: string): void;
}

export interface WelcomeSpeech {
  /** Whether an on-device voice for this language exists here (resolved once the voice list has loaded). */
  ready(language: WelcomeLanguage): Promise<boolean>;
  readonly voice: string | null;
  /** Diagnostics: how many voices the synthesizer lists, and how many are on-device in this language. */
  readonly inventory: string;
  speak(sentences: readonly string[], events: WelcomeSpeechEvents): void;
  stop(): void;
  dispose(): void;
}

/** The Speech Synthesis API's voices as plain data. */
const listVoices = (synth: SpeechSynthesis): VoiceInfo[] => synth.getVoices().map(v => ({ name: v.name, lang: v.lang, localService: v.localService, default: v.default }));

export class BrowserWelcomeSpeech implements WelcomeSpeech {
  voice: string | null = null;
  inventory = "not checked";
  private chosen: SpeechSynthesisVoice | null = null;
  private language: WelcomeLanguage = "en";
  private run = 0;
  private readonly synth: SpeechSynthesis | null;
  private readonly onHide = () => this.stop();

  constructor(private readonly scope: { speechSynthesis?: SpeechSynthesis; SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance; navigator?: Navigator } = globalThis as never) {
    this.synth = scope.speechSynthesis && scope.SpeechSynthesisUtterance ? scope.speechSynthesis : null;
    // Closing (or navigating away from) the window stops the voice at once.
    globalThis.addEventListener?.("pagehide", this.onHide);
  }

  async ready(language: WelcomeLanguage) {
    this.language = language;
    const synth = this.synth;
    if (!synth) return false;
    // Voices load asynchronously in Chromium (in a real profile, seconds after the page): wait for the list, and for a
    // voice in this language, up to a few seconds.
    const want = language === "zh" ? "zh" : "en";
    const usable = () => synth.getVoices().some(v => v.localService && v.lang.toLowerCase().startsWith(want));
    for (let waited = 0; !usable() && waited < 5_000; waited += 250) {
      await new Promise<void>(resolve => {
        const done = () => { synth.removeEventListener?.("voiceschanged", done); clearTimeout(timer); resolve(); };
        const timer = setTimeout(done, 250);
        synth.addEventListener?.("voiceschanged", done);
      });
    }
    const voices = synth.getVoices();
    const local = voices.filter(v => v.localService && v.lang.toLowerCase().startsWith(want)).length;
    this.inventory = `${voices.length} voices, ${local} on-device ${want}`;
    const info = chooseVoice(listVoices(synth), language, this.scope.navigator?.language ?? "");
    this.chosen = info ? voices.find(v => v.name === info.name && v.lang === info.lang) ?? null : null;
    this.voice = this.chosen ? `${this.chosen.name} (${this.chosen.lang})` : null;
    return this.chosen !== null;
  }

  speak(sentences: readonly string[], events: WelcomeSpeechEvents) {
    const synth = this.synth, Utterance = this.scope.SpeechSynthesisUtterance;
    if (!synth || !Utterance || !this.chosen) { events.failed(false, "no-voice"); return; }
    this.stop();
    const run = ++this.run;
    let begun = false;
    const say = (index: number) => {
      if (run !== this.run) return;
      if (index >= sentences.length) { this.run++; events.ended(); return; }
      const utterance = new Utterance(sentences[index]);
      utterance.voice = this.chosen;
      utterance.lang = this.chosen!.lang || WELCOME_SPEECH_LANG[this.language];
      utterance.rate = this.language === "zh" ? 0.95 : 0.97;
      utterance.pitch = 1;
      utterance.volume = 1;
      utterance.onstart = () => {
        if (run !== this.run) return;
        if (!begun) { begun = true; events.started(); }
        events.sentence(index);
      };
      utterance.onboundary = event => { if (run === this.run && event.name !== "sentence") events.word(); };
      utterance.onend = () => { if (run === this.run) setTimeout(() => say(index + 1), 260); };
      utterance.onerror = event => {
        if (run !== this.run) return;
        // "interrupted"/"canceled" are our own stop().
        if (event.error === "interrupted" || event.error === "canceled") return;
        this.run++;
        events.failed(event.error === "not-allowed", event.error);
      };
      synth.speak(utterance);
    };
    say(0);
  }

  stop() {
    this.run++;
    try { this.synth?.cancel(); } catch { /* nothing is speaking */ }
  }

  dispose() {
    this.stop();
    globalThis.removeEventListener?.("pagehide", this.onHide);
  }
}
