import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cleanCode, cleanLine, cleanText, HOLD_SECONDS, holdFor, isGlyphText, LIMITS, planPresentation, type PresentationContent,
} from "../src/core/presentation";
import { ACTIVITY_TTL, PresenceStore, type StoreClock, FORMING_SECONDS } from "../src/core/store";
import { CARD_SECONDS } from "../src/core/presentationRouter";

/** A manual clock: time moves only when the test says so. */
function manualClock() {
  let now = 1_000_000;
  const timers: { at: number; run: () => void; live: boolean }[] = [];
  const clock: StoreClock = {
    now: () => now,
    schedule(run, ms) { const timer = { at: now + ms, run, live: true }; timers.push(timer); return () => { timer.live = false; }; },
  };
  const advance = (seconds: number) => {
    const until = now + seconds * 1000;
    for (;;) {
      const next = timers.filter(timer => timer.live && timer.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      now = next.at; next.live = false; next.run();
    }
    now = until;
  };
  return { clock, advance };
}

const result: PresentationContent = { kind: "result", title: "Tests", summary: "48 / 48 tests passed", status: "success", details: ["8 files changed", "Build successful"] };
const orion: PresentationContent = { kind: "form", form: "astronomy.orion", label: "Orion (constellation)" };

test("state changes are validated and bump the revision", () => {
  const store = new PresenceStore(manualClock().clock);
  const seen: number[] = [];
  store.subscribe(snapshot => seen.push(snapshot.revision));
  assert.equal(store.setActivity("testing", { label: "npm test", source: "hook" }), true);
  assert.deepEqual(store.snapshot().activity, { state: "testing", label: "npm test", source: "hook", since: 1_000_000 });
  assert.equal(store.setActivity("dancing" as never), false, "an invalid state is rejected, not coerced");
  assert.equal(store.snapshot().activity.state, "testing");
  assert.deepEqual(seen, [1]);
});

test("complete settles back to idle; errors fade; forgotten work states expire", () => {
  const { clock, advance } = manualClock();
  const store = new PresenceStore(clock);
  store.setActivity("complete");
  advance(ACTIVITY_TTL.complete! - 0.5);
  assert.equal(store.snapshot().activity.state, "complete");
  advance(1);
  assert.equal(store.snapshot().activity.state, "idle");
  assert.equal(store.snapshot().activity.source, "system");
  store.setActivity("building");
  advance(ACTIVITY_TTL.building! + 1);
  assert.equal(store.snapshot().activity.state, "idle", "a work state no signal ended does not shine forever");
  store.setActivity("thinking");
  advance(100);
  store.setActivity("thinking");
  advance(ACTIVITY_TTL.thinking! - 50);
  assert.equal(store.snapshot().activity.state, "thinking", "repeating a state refreshes it");
});

test("temporary visual lifecycle: present → hold → expire, back to the body", () => {
  const { clock, advance } = manualClock();
  const store = new PresenceStore(clock);
  const shown = store.present(result);
  assert.equal(shown.route, "card", "a result is a card");
  assert.equal(shown.hold, CARD_SECONDS.result);
  assert.equal(store.snapshot().presentation?.id, shown.id);
  // The hold is time spent formed, so the store keeps it for the forming time too.
  advance(CARD_SECONDS.result + FORMING_SECONDS - 1);
  assert.ok(store.snapshot().presentation);
  advance(2);
  assert.equal(store.snapshot().presentation, null);
});

test("a new presentation replaces the old one, and the old timer cannot clear the new one", () => {
  const { clock, advance } = manualClock();
  const store = new PresenceStore(clock);
  store.present(orion, 5);
  advance(4);
  const second = store.present(result, 10);
  advance(3);
  assert.equal(store.snapshot().presentation?.id, second.id);
  advance(9);
  assert.equal(store.snapshot().presentation, null);
});

test("hold 0 keeps a presentation until it is cleared", () => {
  const { clock, advance } = manualClock();
  const store = new PresenceStore(clock);
  store.present(orion, 0);
  advance(3600);
  assert.ok(store.snapshot().presentation);
  assert.equal(store.clearPresentation(), true);
  assert.equal(store.snapshot().presentation, null);
  assert.equal(store.clearPresentation(), false);
});

test("the persistent body survives every temporary visual; changing it releases the visual", () => {
  const { clock, advance } = manualClock();
  const store = new PresenceStore(clock);
  assert.equal(store.snapshot().body, "sphere");
  assert.equal(store.setBody("figure"), true);
  store.present(orion);
  advance(HOLD_SECONDS.form + FORMING_SECONDS + 1);
  assert.equal(store.snapshot().presentation, null);
  assert.equal(store.snapshot().body, "figure", "figure → Orion → figure, not the sphere");
  store.present(result);
  assert.equal(store.setBody("sphere"), true);
  assert.equal(store.snapshot().presentation, null, "a body change is seen at once");
  assert.equal(store.setBody("sphere"), false);
});

test("greeting requests are distinct gestures", () => {
  const store = new PresenceStore(manualClock().clock);
  store.greet();
  const first = store.snapshot().gesture!.id;
  store.greet();
  assert.equal(store.snapshot().gesture!.id, first + 1);
});

test("display text is cleaned and bounded", () => {
  assert.equal(cleanLine("  48 / 48   tests passed ", 40), "48 / 48 tests passed");
  assert.equal(cleanLine("x".repeat(LIMITS.title + 1), LIMITS.title), null);
  assert.equal(cleanLine("bad\u202etext", 40), null, "bidi overrides are rejected");
  assert.equal(cleanText("one\r\n\n\n\ntwo\t!", 40), "one\n\ntwo  !");
  assert.equal(cleanCode("\n  indented\n\n  kept\n\n", 100), "  indented\n\n  kept");
  assert.equal(cleanText("", 10), null);
});

test("hold durations default per kind (SCF's for its visuals) and are clamped", () => {
  assert.equal(holdFor(orion), HOLD_SECONDS.form);
  assert.equal(holdFor(result, 0), 0);
  assert.equal(holdFor(result, 1), LIMITS.hold.min);
  assert.equal(holdFor(result, 10_000), LIMITS.hold.max);
  const long = { kind: "text", text: "x ".repeat(200).trim() } as const;
  assert.ok(holdFor(long) > holdFor({ kind: "text", text: "short sentence that is shown beside the body" }));
  // SCF Presence's tuned holds, in seconds formed.
  const media = { id: "m000000000000000000", mime: "image/png", bytes: 10 };
  assert.deepEqual([
    holdFor({ kind: "clock", time: "12:30" }), holdFor({ kind: "number", value: "42%" }), holdFor({ kind: "text", text: "Paris" }),
    holdFor({ kind: "symbol", symbol: "check" }), holdFor({ kind: "emoji", emoji: "🎉" }), holdFor(orion),
    holdFor({ kind: "image", media, mode: "particles", fit: "portrait" }), holdFor({ kind: "image", media, mode: "particles" }),
    holdFor({ kind: "terrain", media: { ...media, mime: "application/vnd.aion.heightfield" }, style: "terrain", label: "Wales" }),
  ], [7, 7, 6, 5, 4, 10, 14, 12, 14]);
});

test("the body itself becomes short information; long content is presented beside it", () => {
  assert.deepEqual(planPresentation(orion), { body: { type: "form", form: "astronomy.orion", variant: undefined }, card: false });
  assert.deepEqual(planPresentation({ kind: "text", text: "Build passed" }), { body: { type: "text", text: "Build passed" }, card: false });
  assert.deepEqual(planPresentation({ kind: "text", text: "A longer sentence that cannot be particles" }), { body: { type: "none" }, card: true });
  assert.deepEqual(planPresentation(result), { body: { type: "none" }, card: true }, "a result is a card");
  assert.deepEqual(planPresentation(result, "hybrid").body, { type: "form", form: "symbol.check" }, "with the body, its mark forms");
  assert.equal(planPresentation({ ...result, status: "failure" } as PresentationContent, "hybrid").body.type, "form");
  assert.deepEqual(planPresentation({ ...result, status: "info" } as PresentationContent, "hybrid"), { body: { type: "none" }, card: true });
  assert.equal(planPresentation({ kind: "artifact", type: "code", title: "x", content: "y" }).card, true);
  assert.ok(isGlyphText("48/48") && isGlyphText("12:30") && !isGlyphText("a\nb") && !isGlyphText("<b>"));
});
