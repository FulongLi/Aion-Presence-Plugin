import { AION_IDENTITY } from "../core/identity";
import { WELCOME_EXAMPLES, welcomeText, type WelcomeLanguage } from "../core/guidance";
import type { NarrationPhase } from "../core/welcomeNarration";

/**
 * The first-run welcome (v0.6; voice-first since v0.7): the living body speaks a short introduction, and only a few
 * quiet things stand beneath it — a small title, the sentence being spoken (a caption), a speaking indicator, and
 * Skip / Replay / a "?" that opens the three example requests (copied to paste or say in Codex; no host lets a window
 * send a turn). When the browser wants a click before it speaks, one button offers "Listen to the welcome"; when no
 * on-device voice exists, the short script stands in as a few lines of text. The narration's lifecycle is
 * `WelcomeNarration` (core); this is only what is on screen.
 */
export interface WelcomeOptions {
  root: HTMLElement;
  /** "Listen to the welcome" (the user's gesture lets the browser speak). */
  listen(): void;
  replay(): void;
  /** Skip, Escape or Close. */
  skip(): void;
}

export class Welcome {
  readonly root: HTMLElement;
  private visibleSince: number | null = null;
  private copyTimer?: ReturnType<typeof setTimeout>;
  private readonly status: HTMLElement;
  private readonly caption: HTMLElement;
  private readonly indicator: HTMLElement;
  private readonly listenButton: HTMLButtonElement;
  private readonly replayButton: HTMLButtonElement;
  private readonly skipButton: HTMLButtonElement;
  private readonly helpButton: HTMLButtonElement;
  private readonly help: HTMLElement;
  private readonly transcript: HTMLElement;
  readonly language: WelcomeLanguage;

  constructor(private readonly options: WelcomeOptions, language = navigator.language, private readonly script: readonly string[] = []) {
    this.root = options.root;
    this.language = /^zh\b/i.test(language) ? "zh" : "en";
    const text = welcomeText(this.language);
    const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, content?: string) => { const e = document.createElement(tag); e.className = className; if (content !== undefined) e.textContent = content; return e; };
    const button = (className: string, label: string, run: () => void, aria?: string) => {
      const b = make("button", className, label); b.type = "button";
      if (aria) b.setAttribute("aria-label", aria);
      b.addEventListener("click", run);
      return b;
    };
    const title = make("p", "welcome-title", text.title);
    title.id = "welcome-title";
    this.indicator = make("span", "welcome-voice");
    this.indicator.setAttribute("aria-hidden", "true");
    this.indicator.append(make("i", ""), make("i", ""), make("i", ""));
    this.caption = make("p", "welcome-caption");
    this.caption.setAttribute("aria-live", "polite");
    this.transcript = make("p", "welcome-transcript", script.join(" "));
    this.transcript.hidden = true;
    this.listenButton = button("welcome-listen", text.listen, () => this.options.listen());
    this.replayButton = button("welcome-replay", text.replay, () => this.options.replay());
    this.skipButton = button("welcome-skip", text.skip, () => this.options.skip());
    this.helpButton = button("welcome-help-toggle", "?", () => this.toggleHelp(), text.help);
    this.helpButton.setAttribute("aria-expanded", "false");
    this.helpButton.setAttribute("aria-controls", "welcome-help");
    const actions = make("div", "welcome-actions");
    actions.append(this.indicator, this.listenButton, this.replayButton, this.skipButton, this.helpButton);

    // The examples: on request only (the welcome is a voice, not a panel).
    this.help = make("div", "welcome-help");
    this.help.id = "welcome-help";
    this.help.hidden = true;
    const list = make("ul", "welcome-examples");
    for (const example of WELCOME_EXAMPLES) {
      const item = make("li", "welcome-example");
      const prompt = example.prompt[this.language];
      const copy = button("welcome-copy", "", () => void this.copy(prompt), `${text.copy}: ${prompt}`);
      copy.append(make("span", "welcome-kind", example.title[this.language]), make("span", "welcome-prompt", `“${prompt}”`));
      item.append(copy);
      list.append(item);
    }
    this.status = make("p", "welcome-status");
    this.status.setAttribute("aria-live", "polite");
    this.help.append(list, make("p", "welcome-hint", text.hint), this.status);

    this.root.replaceChildren(title, this.caption, this.transcript, actions, this.help);
    this.root.setAttribute("role", "region");
    this.root.setAttribute("aria-labelledby", "welcome-title");
    this.root.setAttribute("aria-label", `${AION_IDENTITY.name}: ${text.title}`);
    this.root.addEventListener("keydown", event => { if (event.key === "Escape") { event.stopPropagation(); this.options.skip(); } });
    this.render("waiting");
  }

  get shown() { return this.visibleSince !== null; }
  /** How long it has been on screen (ms), or 0. */
  get shownFor() { return this.visibleSince === null ? 0 : Date.now() - this.visibleSince; }
  get helpOpen() { return !this.help.hidden; }

  show() {
    if (this.shown) return;
    this.visibleSince = Date.now();
    this.root.hidden = false;
    requestAnimationFrame(() => this.root.classList.add("visible"));
  }

  hide() {
    if (!this.shown) return;
    this.visibleSince = null;
    this.root.classList.remove("visible");
    setTimeout(() => { if (!this.shown) { this.root.hidden = true; this.setHelp(false); } }, 700);
  }

  /** What the narration is doing, and the sentence being spoken (index into the script). */
  render(phase: NarrationPhase, sentence = -1) {
    const text = welcomeText(this.language);
    this.root.dataset.phase = phase;
    const speaking = phase === "speaking" || phase === "starting";
    this.indicator.classList.toggle("on", phase === "speaking");
    this.caption.textContent = phase === "speaking" && sentence >= 0 ? this.script[sentence] ?? "" : phase === "offered" ? text.offered : "";
    this.transcript.hidden = phase !== "text";
    this.listenButton.hidden = phase !== "offered";
    this.replayButton.hidden = !(phase === "finished" || phase === "stopped" || phase === "skipped" || (phase === "text" && this.speechKnown));
    this.skipButton.textContent = phase === "finished" || phase === "text" ? text.close : text.skip;
    this.skipButton.hidden = false;
    this.root.classList.toggle("speaking", speaking);
  }

  /** Whether Replay makes sense in the text phase (a voice exists but failed): set by the view. */
  speechKnown = false;

  private toggleHelp() { this.setHelp(this.help.hidden); }
  private setHelp(open: boolean) {
    this.help.hidden = !open;
    this.helpButton.setAttribute("aria-expanded", String(open));
    this.root.classList.toggle("help-open", open);
  }

  private async copy(prompt: string) {
    const text = welcomeText(this.language);
    try {
      await navigator.clipboard.writeText(prompt);
      this.say(text.copied);
    } catch {
      // No clipboard here (a browser policy): the prompt is selected for the user to copy by hand.
      const range = document.createRange(), node = [...this.root.querySelectorAll(".welcome-prompt")].find(n => n.textContent === `“${prompt}”`);
      if (node) { range.selectNodeContents(node); getSelection()?.removeAllRanges(); getSelection()?.addRange(range); }
      this.say(text.select);
    }
  }

  private say(message: string) {
    clearTimeout(this.copyTimer);
    this.status.textContent = message;
    this.copyTimer = setTimeout(() => { this.status.textContent = ""; }, 4_000);
  }
}
