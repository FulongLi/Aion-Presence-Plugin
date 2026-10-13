import type { WritingFrame } from "../animation/stroke/timeline";
import type { StrokeSequence } from "../animation/stroke/types";

/**
 * The stroke-order card (v0.4.3): the exact reference beside the body that writes. The symbol's strokes as clean vector
 * lines on their guide (a practice grid, a staff, writing lines), each numbered at its start with a small arrow for the
 * pen's direction, and the list of strokes by name. As the body writes, the stroke being written is lit in the accent,
 * those already written are solid, the rest wait faintly — the same moment the particles show.
 */
export interface StrokeCard { root: HTMLElement; update(frame: WritingFrame | null): void }

const SVG = "http://www.w3.org/2000/svg";
const svg = <K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number>) => {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
};

export function buildStrokeCard(sequence: StrokeSequence): StrokeCard {
  const root = document.createElement("div");
  root.className = "stroke-card";
  const head = document.createElement("div");
  head.className = "stroke-head";
  const glyph = document.createElement("span");
  glyph.className = "stroke-symbol";
  glyph.textContent = sequence.symbol;
  const title = document.createElement("h2");
  title.textContent = `${sequence.title} · ${sequence.strokes.length} stroke${sequence.strokes.length > 1 ? "s" : ""}`;
  head.append(glyph, title);
  // The drawing: normalized −1…1 (y up) → a 200 × 200 view.
  const size = 200, k = size / 2 * 0.98;
  const x = (v: number) => (size / 2 + v * k).toFixed(1), y = (v: number) => (size / 2 - v * k).toFixed(1);
  const path = (points: readonly number[]) => points.reduce((d, v, i) => i % 2 ? d : `${d}${i ? "L" : "M"}${x(v)},${y(points[i + 1])}`, "");
  const drawing = svg("svg", { viewBox: `0 0 ${size} ${size}`, class: "stroke-diagram", role: "img", "aria-label": `${sequence.symbol}: stroke order` });
  for (const guide of sequence.guides) drawing.append(svg("path", { d: path(guide), class: "stroke-guide" }));
  const lines = sequence.strokes.map(stroke => {
    const line = svg("path", { d: path(stroke.path), class: "stroke-line waiting", "stroke-width": ((stroke.width[0] + stroke.width[1]) / 2 * k).toFixed(2) });
    drawing.append(line);
    return line;
  });
  // Numbers at each stroke's start, with a small arrow along the pen's first direction.
  sequence.strokes.forEach(stroke => {
    const [sx, sy] = stroke.startPoint;
    const dx = stroke.path[2] - sx, dy = stroke.path[3] - sy, len = Math.hypot(dx, dy) || 1;
    // The number sits just before the start, against the direction of travel, so it never covers the stroke.
    const nx = sx - dx / len * 0.1 - dy / len * 0.06, ny = sy - dy / len * 0.1 + dx / len * 0.06;
    drawing.append(svg("circle", { cx: x(nx), cy: y(ny), r: 7.5, class: "stroke-badge" }));
    const label = svg("text", { x: x(nx), y: (Number(y(ny)) + 3.4).toFixed(1), class: "stroke-number" });
    label.textContent = String(stroke.order);
    drawing.append(label);
  });
  const list = document.createElement("ol");
  list.className = "stroke-list";
  const items = sequence.strokes.map(stroke => {
    const item = document.createElement("li");
    item.textContent = `${stroke.name ? `${stroke.name.zh ? `${stroke.name.zh} ` : ""}${stroke.name.en} — ` : ""}${stroke.direction}`;
    list.append(item);
    return item;
  });
  const caption = document.createElement("p");
  caption.className = "caption";
  caption.textContent = [sequence.convention, sequence.note].filter(Boolean).join(" · ");
  root.append(head, drawing, list, caption);
  let shown = "";
  return {
    root,
    update(frame) {
      // Each stroke: waiting, written, or being written (lit). Without a frame (not writing yet): all solid.
      const states = sequence.strokes.map((_, i) => !frame ? "written" : i === frame.stroke ? "current"
        : frame.complete > 0.5 || i < Math.floor(frame.progress) ? "written" : "waiting");
      const key = states.join();
      if (key === shown) return;
      shown = key;
      states.forEach((state, i) => {
        lines[i].setAttribute("class", `stroke-line ${state}`);
        items[i].className = state;
      });
    },
  };
}
