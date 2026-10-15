import HanziWriter from "hanzi-writer";
import type { WritingSource } from "../animation/stroke/compose";
import type { WritingFrame } from "../animation/stroke/timeline";
import type { StrokeSequence } from "../animation/stroke/types";

/**
 * The writing reference card (v0.4.3; v0.4.4 true outlines, words, radicals, practice): the exact reference beside the
 * body that writes.
 *
 * It draws strokes the way Hanzi Writer does — each stroke's outline as a clip path, revealed by a wide brush drawn
 * along the stroke's median — but driven by Aion's own writing frame, so the card and the particles show the same
 * moment at every speed, pause, seek and repeat (Hanzi Writer's animator runs on its own clock and cannot be seeked).
 * Pen strokes (letters, digits, music, mathematics) are drawn as round-ended lines revealed along their length.
 *
 * The stroke being written is lit in the accent; written strokes are solid; the rest wait as a faint ghost. Each stroke of
 * the symbol in hand is numbered at its start, and its directions are listed. With `highlight: "radical"` the radical's
 * strokes are tinted. In the reference view (`reference`) with `practice`, the Hanzi Writer library itself runs its
 * tracing quiz for the character: the user writes each stroke and it is checked against the same data.
 */
export interface StrokeCard { root: HTMLElement; update(frame: WritingFrame | null): void; dispose?(): void }

const SVG = "http://www.w3.org/2000/svg";
const svg = <K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number>) => {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
};
const html = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) => {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

let cardSerial = 0;

export function buildStrokeCard(sequence: StrokeSequence, options: { highlight?: "radical"; practice?: boolean; reference?: boolean; source?: WritingSource } = {}): StrokeCard {
  const serial = ++cardSerial;
  const root = html("div", `stroke-card${options.reference ? " reference" : ""}`);
  const head = html("div", "stroke-head");
  const glyph = html("span", "stroke-symbol", sequence.symbol);
  const title = html("h2", "", `${sequence.title} · ${sequence.strokes.length} stroke${sequence.strokes.length > 1 ? "s" : ""}`);
  head.append(glyph, title);

  // ── The drawing: normalized space (y up) → SVG units (y down) ─────────────────────────────────────────────────────
  const boxes = sequence.items.map(item => item.box);
  const left = Math.min(...boxes.map(b => b[0])), right = Math.max(...boxes.map(b => b[2]));
  const bottom = Math.min(...boxes.map(b => b[1])), top = Math.max(...boxes.map(b => b[3]));
  const pad = 0.05 * Math.max(right - left, top - bottom);
  const P = (x: number, y: number) => `${(x * 100).toFixed(2)},${(-y * 100).toFixed(2)}`;
  const line = (points: readonly number[]) => points.reduce((d, v, i) => i % 2 ? d : `${d}${i ? "L" : "M"}${P(v, points[i + 1])}`, "");
  const rings = (outline: readonly (readonly number[])[]) => outline.map(ring => `${line(ring)}Z`).join("");
  const drawing = svg("svg", {
    viewBox: `${((left - pad) * 100).toFixed(1)} ${((-top - pad) * 100).toFixed(1)} ${((right - left + 2 * pad) * 100).toFixed(1)} ${((top - bottom + 2 * pad) * 100).toFixed(1)}`,
    class: "stroke-diagram", role: "img", "aria-label": `${sequence.symbol}: stroke order`,
  });
  const defs = svg("defs", {});
  drawing.append(defs);
  for (const guide of sequence.guides) drawing.append(svg("path", { d: line(guide), class: "stroke-guide" }));
  const radical = new Set<number>();
  if (options.highlight === "radical") for (const item of sequence.items) for (const k of item.radical ?? []) radical.add(item.first + k);

  interface Drawn { ghost: SVGPathElement; ink: SVGPathElement; brush: SVGPathElement | null; state: string; u: number }
  const drawn: Drawn[] = sequence.strokes.map((stroke, i) => {
    const mark = radical.has(i) ? " radical" : "";
    if (stroke.outline) {
      const d = rings(stroke.outline);
      const ghost = svg("path", { d, class: `stroke-ghost${mark}` });
      const clip = svg("clipPath", { id: `aion-stroke-${serial}-${i}` });
      clip.append(svg("path", { d }));
      defs.append(clip);
      // The brush is wide enough to cover the whole outline from its median (Hanzi Writer uses the same idea).
      const brush = svg("path", {
        d: line(stroke.path), class: `stroke-brush${mark}`, "clip-path": `url(#aion-stroke-${serial}-${i})`, pathLength: 1,
        "stroke-dasharray": "1 1", "stroke-dashoffset": 1, "stroke-width": (Math.max(0.12, stroke.width[0] * 3.2) * 100).toFixed(1),
      });
      const ink = svg("path", { d, class: `stroke-ink waiting${mark}` });
      drawing.append(ghost, ink, brush);
      return { ghost, ink, brush, state: "", u: -1 };
    }
    const width = ((stroke.width[0] + stroke.width[1]) / 2 * 100).toFixed(2);
    const ghost = svg("path", { d: line(stroke.path), class: `stroke-line ghost${mark}`, "stroke-width": width });
    const ink = svg("path", { d: line(stroke.path), class: `stroke-line waiting${mark}`, "stroke-width": width, pathLength: 1, "stroke-dasharray": "1 1", "stroke-dashoffset": 1 });
    drawing.append(ghost, ink);
    return { ghost, ink, brush: null, state: "", u: -1 };
  });

  // Numbers at each stroke's start, just before it against the direction of travel, so they never cover the stroke.
  const numberSize = Math.min(...sequence.items.map(item => item.box[2] - item.box[0])) * 100 * 0.055;
  const badges = sequence.strokes.map(stroke => {
    const [sx, sy] = stroke.startPoint;
    const dx = stroke.path[2] - sx, dy = stroke.path[3] - sy, len = Math.hypot(dx, dy) || 1;
    const back = numberSize / 100 * 1.6;
    const nx = sx - dx / len * back - dy / len * back * 0.5, ny = sy - dy / len * back + dx / len * back * 0.5;
    const group = svg("g", { class: "stroke-badge-group" });
    const [cx, cy] = P(nx, ny).split(",");
    group.append(svg("circle", { cx, cy, r: numberSize.toFixed(2), class: "stroke-badge" }));
    const label = svg("text", { x: cx, y: (Number(cy) + numberSize * 0.42).toFixed(2), class: "stroke-number", "font-size": (numberSize * 1.25).toFixed(2) });
    label.textContent = String(stroke.local);
    group.append(label);
    drawing.append(group);
    return group;
  });

  const itemTitle = html("p", "stroke-item");
  const list = html("ol", "stroke-list");
  const caption = html("p", "caption", [sequence.convention, sequence.note].filter(Boolean).join(" · "));
  root.append(head, drawing, itemTitle, list);
  if (options.practice) root.classList.add("practicing");

  // ── Practice: Hanzi Writer's quiz on the same character data ─────────────────────────────────────────────────────
  let writer: HanziWriter | null = null;
  const hanzi = (options.source?.pieces ?? []).filter((piece): piece is Extract<WritingSource["pieces"][number], { type: "hanzi" }> => piece.type === "hanzi");
  if (options.practice) {
    const box = html("div", "stroke-practice");
    const status = html("p", "practice-status");
    if (hanzi.length) {
      const target = html("div", "practice-target");
      box.append(target, status);
      const piece = hanzi[0];
      const size = options.reference ? 300 : 220;
      const remaining = () => `Trace ${piece.char} stroke by stroke`;
      status.textContent = remaining();
      queueMicrotask(() => {
        try {
          writer = HanziWriter.create(target, piece.char, {
            width: size, height: size, padding: 10, showOutline: true, showCharacter: false, renderer: "svg",
            strokeColor: "#e8eff6", outlineColor: "rgba(205,220,236,0.18)", drawingColor: "#9fc4ea", highlightColor: "#ffd27a",
            drawingWidth: 18, showHintAfterMisses: 2, highlightOnComplete: true,
            charDataLoader: (_char, onLoad) => { onLoad(piece.data as never); },
          });
          let mistakes = 0;
          void writer.quiz({
            onMistake: () => { mistakes++; status.textContent = `Not quite — try that stroke again (${mistakes} miss${mistakes > 1 ? "es" : ""})`; },
            onCorrectStroke: data => { status.textContent = `Stroke ${data.strokeNum + 1} of ${piece.data.strokes.length} ✓`; },
            onComplete: summary => { status.textContent = `${piece.char} written · ${summary.totalMistakes} miss${summary.totalMistakes === 1 ? "" : "es"}`; root.dataset.practice = "complete"; },
          });
          root.dataset.practice = "active";
        } catch { status.textContent = "Practice could not start."; }
      });
    } else {
      status.textContent = "Tracing practice is available for Chinese characters; watch the strokes and copy them on paper.";
      box.append(status);
    }
    // Practice comes first: the character to trace, then the small stroke-order reference below it.
    head.after(box);
  }
  root.append(caption);
  if (sequence.writingSystem === "chinese") root.append(html("p", "caption credit", "Stroke data: Hanzi Writer · Make Me a Hanzi (Arphic PL)"));

  // The symbol in hand: its title and its strokes' directions.
  let listed = -1;
  const showItem = (index: number) => {
    if (index === listed) return;
    listed = index;
    const item = sequence.items[index];
    itemTitle.textContent = sequence.items.length > 1 ? `${index + 1} / ${sequence.items.length} · ${item.title}` : item.title !== sequence.title ? item.title : "";
    list.replaceChildren(...sequence.strokes.slice(item.first, item.first + item.count).map(stroke => {
      const entry = html("li", "", `${stroke.name ? `${stroke.name.zh ? `${stroke.name.zh} ` : ""}${stroke.name.en} — ` : ""}${stroke.direction}`);
      entry.value = stroke.local;
      return entry;
    }));
  };
  /** Numbers: the stroke being written; every stroke of the symbol in hand only while nothing is being written and it is simple enough to stay legible. */
  let badgeKey = "";
  const showBadges = (current: number, resting: boolean) => {
    const item = sequence.items[listed];
    const all = resting && item.count <= 12;
    const key = `${listed}|${current}|${all}`;
    if (key === badgeKey) return;
    badgeKey = key;
    badges.forEach((badge, i) => badge.classList.toggle("hidden", !(i === current || (all && sequence.strokes[i].item === listed))));
  };
  showItem(0);

  return {
    root,
    update(frame) {
      const current = frame && frame.stroke >= 0 ? frame.stroke : -1;
      showItem(current >= 0 ? sequence.strokes[current].item : listed);
      showBadges(frame?.phase === "stroke" || frame?.phase === "gap" ? current : -1, !frame || frame.phase === "forming" || frame.phase === "preview" || frame.phase === "done");
      const item = sequence.items[listed];
      sequence.strokes.forEach((_, i) => {
        const d = drawn[i];
        // Without a frame (nothing written yet, or the reference alone): every stroke solid.
        const writing = frame && frame.phase === "stroke" && Math.floor(frame.progress) === i;
        const u = !frame ? 1 : frame.complete > 0.5 ? 1 : writing ? frame.progress - i : frame.progress >= i + 1 ? 1 : 0;
        const state = !frame || u >= 1 ? (i === current ? "current written" : "written") : writing ? "current" : "waiting";
        if (state !== d.state) {
          d.state = state;
          const mark = radical.has(i) ? " radical" : "";
          if (d.brush) { d.ink.setAttribute("class", `stroke-ink ${state}${mark}`); d.brush.setAttribute("class", `stroke-brush ${state}${mark}`); }
          else d.ink.setAttribute("class", `stroke-line ${state}${mark}`);
        }
        const shown = writing ? u : u >= 1 ? 1 : 0;
        if (Math.abs(shown - d.u) > 1e-3) {
          d.u = shown;
          (d.brush ?? d.ink).setAttribute("stroke-dashoffset", (1 - shown).toFixed(4));
        }
      });
      [...list.children].forEach((entry, k) => {
        const i = item.first + k;
        entry.className = i === current ? "current" : drawn[i].u >= 1 ? "written" : "waiting";
      });
    },
    dispose() { try { (writer as unknown as { cancelQuiz?: () => void } | null)?.cancelQuiz?.(); } catch { /* gone */ } },
  };
}
