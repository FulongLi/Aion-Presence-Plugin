import { AION_IDENTITY } from "../core/identity";
import { WELCOME_EXAMPLES, welcomeText, type WelcomeLanguage } from "../core/guidance";

/**
 * The first-run welcome (v0.6): a short, quiet introduction over the living body the first time Aion's window opens —
 * who Aion is (Codex's visual presence, not a second AI), a line of what to try, three example requests that work in
 * this build, and Get started / Skip. No host lets a window send a turn to Codex, so the examples are copied (to paste
 * or say in Codex), never sent. Shown once per installation (the hub remembers), and again when the user asks.
 */
export interface WelcomeOptions {
  root: HTMLElement;
  /** The user dismissed it (Get started, Skip or Escape). */
  dismissed(): void;
}

export class Welcome {
  readonly root: HTMLElement;
  private visibleSince: number | null = null;
  private copyTimer?: ReturnType<typeof setTimeout>;
  private readonly status: HTMLElement;
  readonly language: WelcomeLanguage;

  constructor(private readonly options: WelcomeOptions, language = navigator.language) {
    this.root = options.root;
    this.language = /^zh\b/i.test(language) ? "zh" : "en";
    const text = welcomeText(this.language);
    const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, content?: string) => { const e = document.createElement(tag); e.className = className; if (content !== undefined) e.textContent = content; return e; };
    const title = make("h2", "welcome-title", text.title);
    title.id = "welcome-title";
    const tagline = make("p", "welcome-tagline", text.tagline);
    const intro = make("p", "welcome-intro", text.intro);
    const list = make("ul", "welcome-examples");
    for (const example of WELCOME_EXAMPLES) {
      const item = make("li", "welcome-example");
      const copy = make("button", "welcome-copy");
      copy.type = "button";
      const prompt = example.prompt[this.language];
      copy.setAttribute("aria-label", `${text.copy}: ${prompt}`);
      copy.append(make("span", "welcome-kind", example.title[this.language]), make("span", "welcome-prompt", `“${prompt}”`));
      copy.addEventListener("click", () => void this.copy(prompt));
      item.append(copy);
      list.append(item);
    }
    const hint = make("p", "welcome-hint", text.hint);
    this.status = make("p", "welcome-status");
    this.status.setAttribute("aria-live", "polite");
    const start = make("button", "welcome-start", text.start);
    start.type = "button";
    start.addEventListener("click", () => this.dismiss());
    const skip = make("button", "welcome-skip", text.skip);
    skip.type = "button";
    skip.addEventListener("click", () => this.dismiss());
    const actions = make("div", "welcome-actions");
    actions.append(start, skip);
    this.root.replaceChildren(title, tagline, intro, list, hint, this.status, actions);
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-labelledby", "welcome-title");
    this.root.setAttribute("aria-label", `${AION_IDENTITY.name}: ${text.title}`);
    this.root.addEventListener("keydown", event => { if (event.key === "Escape") { event.stopPropagation(); this.dismiss(); } });
  }

  get shown() { return this.visibleSince !== null; }
  /** How long it has been on screen (ms), or 0. */
  get shownFor() { return this.visibleSince === null ? 0 : Date.now() - this.visibleSince; }

  show() {
    if (this.shown) return;
    this.visibleSince = Date.now();
    this.root.hidden = false;
    requestAnimationFrame(() => this.root.classList.add("visible"));
  }

  /** Hides it (the user went on to something, or dismissed it). */
  hide() {
    if (!this.shown) return;
    this.visibleSince = null;
    this.root.classList.remove("visible");
    setTimeout(() => { if (!this.shown) this.root.hidden = true; }, 700);
  }

  private dismiss() {
    this.hide();
    this.options.dismissed();
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
