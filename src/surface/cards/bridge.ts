import { CARD_LIMITS, type CardAppManifest } from "../../cards/manifest";
import { CARD_PROTOCOL_VERSION, parseFromCard, RateLimiter, type FromCardMessage, type ToCardPayloads, type ToCardType } from "../../cards/protocol";

/**
 * The page's end of the Aion Card Bridge (v0.4.5). It owns one MessagePort, made for one card instance and handed to its
 * sandboxed frame once. Everything that arrives is validated against the protocol and the application's manifest before
 * anything else sees it; malformed, stale or undeclared messages are dropped and counted. Messages beyond the rate are
 * dropped too, and a card that keeps flooding is cut off. Requests are correlated with their RESULT and time out.
 */
export interface BridgeHandlers {
  message(message: FromCardMessage): void;
  /** A message was refused (for diagnostics and the security tests). */
  dropped?(problem: string): void;
  /** The card flooded the bridge and was cut off. */
  flooded?(): void;
}

export type RequestResult = { ok: true } | { ok: false; problem: string };

let requestCounter = 0;

export class ParentBridge {
  private readonly pending = new Map<string, { resolve: (result: RequestResult) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly limiter: RateLimiter;
  private closed = false;
  /** Counters for diagnostics and tests. */
  readonly stats = { received: 0, dropped: 0, rateLimited: 0 };

  constructor(private readonly port: MessagePort, readonly instance: string, private readonly manifest: CardAppManifest, private readonly handlers: BridgeHandlers,
    options: { now?: () => number; burst?: number; rate?: number } = {}) {
    this.limiter = new RateLimiter(options.burst ?? CARD_LIMITS.messageBurst, options.rate ?? CARD_LIMITS.messagesPerSecond, options.now);
    port.onmessage = event => this.receive(event.data);
    port.onmessageerror = () => this.drop("message could not be read");
    port.start();
  }

  get open() { return !this.closed; }

  private drop(problem: string) { this.stats.dropped++; this.handlers.dropped?.(problem); }

  private receive(raw: unknown) {
    if (this.closed) return;
    if (!this.limiter.take()) {
      this.stats.rateLimited++;
      if (this.limiter.dropped >= CARD_LIMITS.floodDrops) { this.close(); this.handlers.flooded?.(); }
      return;
    }
    const parsed = parseFromCard(raw, this.instance, this.manifest);
    if (!parsed.ok) return this.drop(parsed.problem);
    this.stats.received++;
    const message = parsed.message;
    if (message.type === "RESULT") {
      const waiting = this.pending.get(message.re!);
      if (!waiting) return this.drop("RESULT answers no request");
      this.pending.delete(message.re!);
      clearTimeout(waiting.timer);
      waiting.resolve(message.payload.ok ? { ok: true } : { ok: false, problem: message.payload.problem ?? "failed" });
      return;
    }
    this.handlers.message(message);
  }

  /** Sends a message and waits for the card's RESULT (or a timeout). */
  request<T extends ToCardType>(type: T, payload: ToCardPayloads[T], options: { transfer?: Transferable[]; seconds?: number } = {}): Promise<RequestResult> {
    if (this.closed) return Promise.resolve({ ok: false, problem: "the card is closed" });
    const id = `r${(++requestCounter).toString(36)}`;
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ ok: false, problem: "the card did not answer in time" }); }, (options.seconds ?? CARD_LIMITS.commandSeconds) * 1000);
      this.pending.set(id, { resolve, timer });
      try {
        this.port.postMessage({ v: CARD_PROTOCOL_VERSION, instance: this.instance, type, id, payload }, options.transfer ?? []);
      } catch {
        clearTimeout(timer); this.pending.delete(id);
        resolve({ ok: false, problem: "the message could not be sent" });
      }
    });
  }

  /** Sends a message without waiting. */
  post<T extends ToCardType>(type: T, payload: ToCardPayloads[T]) {
    if (this.closed) return;
    try { this.port.postMessage({ v: CARD_PROTOCOL_VERSION, instance: this.instance, type, payload }); } catch { /* the frame is gone */ }
  }

  /** Closes the channel: pending requests fail, later messages are ignored. */
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const { resolve, timer } of this.pending.values()) { clearTimeout(timer); resolve({ ok: false, problem: "the card is closed" }); }
    this.pending.clear();
    this.port.onmessage = null;
    this.port.close();
  }
}
