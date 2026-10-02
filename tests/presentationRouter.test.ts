import assert from "node:assert/strict";
import { test } from "node:test";
import { holdsFor, type MediaRef, type PresentationContent } from "../src/core/presentation";
import { PICTURE_QUALITY, routePresentation, type PresentationPreference } from "../src/core/presentationRouter";
import { PresenceStore } from "../src/core/store";
import { visualForms } from "../src/visual/forms";

/** The Presentation Router decides BODY, CARD or HYBRID deterministically, and overrides clearly bad requests. */
const media: MediaRef = { id: `m${"a".repeat(18)}`, mime: "image/jpeg", bytes: 1000 };
const heightfield: MediaRef = { ...media, mime: "application/vnd.aion.heightfield" };
const form = (id: string): PresentationContent => ({ kind: "form", form: id, label: visualForms.label(id) });
const tesla: PresentationContent = { kind: "image", media, fit: "portrait", origin: "lookup", width: 900, height: 1200, alt: "Nikola Tesla", credit: "Wikipedia" };
const photo: PresentationContent = { kind: "image", media, fit: "object", origin: "lookup", width: 1280, height: 853, alt: "Tesla Model Y" };
const longText = "Lorem ipsum dolor sit amet. ".repeat(20).trim();
const route = (content: PresentationContent, preference?: PresentationPreference, detail?: boolean) => routePresentation({ content, preference, detail });

test("BODY: Aion's own visual language and short information become the body itself", () => {
  assert.equal(route(form("tao.yin-yang")).route, "body", "yin-yang");
  assert.equal(route(form("astronomy.orion")).route, "body", "Orion");
  assert.equal(route(form("astrology.leo")).route, "body", "a zodiac sign");
  assert.equal(route({ kind: "number", value: "42%" }).route, "body", "42%");
  assert.equal(route({ kind: "clock", time: "09:05" }).route, "body");
  assert.equal(route({ kind: "text", text: "48/48" }).route, "body");
  assert.equal(route({ kind: "symbol", symbol: "check" }).route, "body");
  assert.equal(route({ kind: "emoji", emoji: "🚀" }).route, "body");
  const uk = route({ kind: "terrain", media: heightfield, style: "terrain", label: "United Kingdom" });
  assert.deepEqual([uk.route, uk.reason], ["body", "body-native"], "UK terrain");
});

test("CARD: exact content stays exact", () => {
  assert.deepEqual([route({ kind: "text", text: longText }).route, route({ kind: "text", text: longText }).reason], ["card", "fidelity"], "long text");
  assert.equal(route({ kind: "artifact", type: "code", title: "Fix", content: "const x = 1;", language: "ts" }).route, "card", "code");
  assert.equal(route({ kind: "artifact", type: "changes", title: "Changes", changes: [{ path: "src/a.ts", change: "modified", additions: 3 }] }).route, "card", "file changes");
  assert.equal(route({ kind: "result", title: "Tests", summary: "48 / 48 passed", status: "success", details: [] }).route, "card", "a test result");
  assert.equal(route({ kind: "artifact", type: "svg", title: "Architecture", media }).route, "card", "a diagram");
  assert.equal(route({ kind: "image", media, fit: "object", origin: "local", width: 2400, height: 1500 }).route, "card", "a screenshot from this machine");
});

test("HYBRID: a recognizable portrait forms in particles while the photograph stands beside it", () => {
  assert.deepEqual([route(tesla).route, route(tesla).reason], ["hybrid", "portrait-hybrid"], "Nikola Tesla");
  // A portrait too small to be worth a card stays a particle portrait.
  const small = { ...tesla, width: 160, height: 200 } as PresentationContent;
  assert.deepEqual([route(small).route, route(small).reason], ["body", "low-resolution"]);
  assert.equal(route({ ...tesla, width: undefined, height: undefined } as PresentationContent).route, "body", "unknown size: no card is promised");
});

test("photographs: a high-resolution picture is hybrid, a small one body, detail always a card", () => {
  assert.deepEqual([route(photo).route, route(photo).reason], ["hybrid", "picture-hybrid"]);
  const small = { ...photo, width: PICTURE_QUALITY.pictureMinLongSide - 1, height: 300 } as PresentationContent;
  assert.equal(route(small).route, "body");
  assert.deepEqual([route(photo, "auto", true).route, route(photo, "auto", true).reason], ["card", "detail-requested"]);
  assert.deepEqual([route(photo, "body", true).route, route(photo, "body", true).reason], ["card", "detail-requested"], "never dissolve a photo the user wants to inspect");
  assert.equal(route({ ...photo, fit: "logo" } as PresentationContent).route, "body", "a logo is a fine particle form");
});

test("explicit preferences are honoured where they are valid", () => {
  assert.deepEqual([route(tesla, "body").route, route(tesla, "body").reason], ["body", "requested"], "explicit body");
  assert.deepEqual([route(photo, "card").route, route(photo, "card").reason], ["card", "requested"], "explicit card");
  const terrain: PresentationContent = { kind: "terrain", media: heightfield, style: "relief", label: "Scotland" };
  assert.equal(route(terrain, "hybrid").route, "hybrid", "terrain with its map card");
  assert.equal(route(terrain, "card").route, "card");
  assert.equal(route({ kind: "number", value: "42%" }, "card").route, "card", "a number can stand in a card when asked");
  assert.equal(route({ kind: "result", title: "Tests", summary: "ok", status: "success", details: [] }, "hybrid").route, "hybrid", "a check mark and the card");
  assert.equal(route({ kind: "artifact", type: "svg", title: "Architecture", media }, "hybrid").route, "hybrid", "a diagram's impression and the diagram");
});

test("clearly bad requests are overridden safely", () => {
  const long = route({ kind: "text", text: longText }, "body");
  assert.deepEqual([long.route, long.reason, long.preference], ["card", "too-detailed-for-body", "body"], "long text never becomes particles");
  const huge = route({ kind: "text", text: "x".repeat(3000) }, "body");
  assert.equal(huge.route, "card", "3000 characters cannot become the body");
  assert.equal(route({ kind: "artifact", type: "code", title: "x", content: "y" }, "body").route, "card");
  assert.equal(route({ kind: "artifact", type: "code", title: "x", content: "y" }, "hybrid").route, "card");
  const yinYang = route(form("tao.yin-yang"), "card");
  assert.deepEqual([yinYang.route, yinYang.reason], ["body", "no-card-form"], "a form is only ever the body");
  assert.equal(route(form("tao.yin-yang"), "hybrid").route, "body", "no double presentation of a form");
});

test("surface capabilities are respected", () => {
  assert.deepEqual([routePresentation({ content: tesla, capabilities: { body: true, card: false } }).route, routePresentation({ content: tesla, capabilities: { body: true, card: false } }).reason], ["body", "surface-limited"]);
  assert.equal(routePresentation({ content: tesla, capabilities: { body: false, card: true } }).route, "card");
  assert.equal(routePresentation({ content: { kind: "text", text: longText }, capabilities: { body: true, card: false } }).route, "body", "nothing better exists");
});

test("restraint: hybrid is never the default for Aion's own forms or short information", () => {
  const contents: PresentationContent[] = [form("tao.yin-yang"), form("tao.bagua"), form("astronomy.orion"), { kind: "number", value: "42%" }, { kind: "clock", time: "12:00" },
    { kind: "terrain", media: heightfield, style: "terrain", label: "UK" }, { kind: "text", text: "Done" }, { kind: "emoji", emoji: "🎉" }];
  for (const content of contents) assert.notEqual(route(content).route, "hybrid", JSON.stringify(content).slice(0, 60));
});

test("lifecycle: the body is a moment, the card may stay, and a new topic retires temporary cards", () => {
  assert.deepEqual(holdsFor(tesla, "hybrid"), { total: 30, body: 14, card: 30 });
  assert.deepEqual(holdsFor(tesla, "hybrid", 0), { total: 0, body: 14, card: 0 }, "a persistent card; the particle portrait still returns");
  assert.deepEqual(holdsFor(form("astronomy.orion"), "body"), { total: 10, body: 10, card: 0 });
  assert.deepEqual(holdsFor({ kind: "artifact", type: "code", title: "x", content: "y" }, "card"), { total: 60, body: 0, card: 60 });
  let now = 0;
  const timers: { at: number; run: () => void }[] = [];
  const store = new PresenceStore({ now: () => now, schedule: (run, ms) => { const timer = { at: now + ms, run }; timers.push(timer); return () => { timers.splice(timers.indexOf(timer), 1); }; } });
  const advance = (ms: number) => { now += ms; for (const timer of timers.filter(t => t.at <= now)) { timers.splice(timers.indexOf(timer), 1); timer.run(); } };
  store.present({ kind: "artifact", type: "code", title: "x", content: "y" });
  advance(5_000);
  store.shorten(15);
  advance(15_100);
  assert.equal(store.snapshot().presentation, null, "a new prompt retired the stale card");
  store.present({ kind: "artifact", type: "code", title: "x", content: "y" }, 0);
  store.shorten(15);
  advance(120_000);
  assert.ok(store.snapshot().presentation, "a card kept until cleared stays");
  assert.equal(store.snapshot().presentation?.route, "card");
});

test("the v0.2 image mode still works as a preference", () => {
  const store = new PresenceStore();
  assert.equal(store.present({ ...photo, mode: "framed" } as PresentationContent).route, "card");
  assert.equal(store.present({ ...photo, mode: "particles" } as PresentationContent).route, "body");
  assert.equal(store.present({ ...photo, mode: "particles" } as PresentationContent, undefined, { preference: "hybrid" }).route, "hybrid", "an explicit preference wins");
  store.dispose();
});
