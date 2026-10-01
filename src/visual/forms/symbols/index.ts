import type { Raster2DTarget } from "../../types";
import { InkCanvas, type Ink } from "../geometry/ink";
import { Path, type Point } from "../geometry/path";
import type { VisualFormEntry, VisualFormPack } from "../types";

/**
 * The symbol pack: plain marks the body can become, chiefly to present an outcome (a check for success,
 * a cross for failure, an exclamation for a partial result). They are painted procedurally with the same
 * ink painter as the Tao forms, as clean full strokes, so they need no canvas or font and look the same
 * on every device. (SCF Presence drew these on a 2D canvas; here they are ordinary visual forms.)
 */
const INK: Ink = { density: 1, tone: 0.92, grain: 0.06 };
const WIDTH = 0.2;

type Drawing = (canvas: InkCanvas) => void;

const stroke = (points: Point[], width = WIDTH): Drawing => canvas => { canvas.stroke(points, width, INK); };
const all = (...drawings: Drawing[]): Drawing => canvas => { for (const draw of drawings) draw(canvas); };
const arrow = (angle: number): Drawing => {
  const rad = angle * Math.PI / 180, c = Math.cos(rad), s = Math.sin(rad);
  const at = (x: number, y: number): Point => [x * c - y * s, x * s + y * c];
  return all(stroke([at(-0.66, 0), at(0.62, 0)]), stroke([at(0.2, 0.42), at(0.64, 0), at(0.2, -0.42)]));
};

/** The classic heart curve, scaled into the frame. */
const heart = (): Point[] => Array.from({ length: 121 }, (_, i) => {
  const t = i / 120 * Math.PI * 2;
  return [16 * Math.sin(t) ** 3 / 19, (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) / 19 + 0.08] as Point;
});
const star = (): Point[] => Array.from({ length: 10 }, (_, i) => {
  const angle = Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? 0.34 : 0.82;
  return [Math.cos(angle) * r, Math.sin(angle) * r - 0.04] as Point;
});

const SYMBOLS: { id: string; label: string; aliases: string[]; draw: Drawing }[] = [
  { id: "check", label: "Check ✓", aliases: ["check", "checkmark", "check mark", "tick", "done", "success", "✓", "✔"],
    draw: stroke([[-0.62, 0.02], [-0.18, -0.42], [0.66, 0.5]]) },
  { id: "cross", label: "Cross ✕", aliases: ["cross", "x mark", "fail", "failure", "✕", "✗", "✘"],
    draw: all(stroke([[-0.52, -0.52], [0.52, 0.52]]), stroke([[0.52, -0.52], [-0.52, 0.52]])) },
  { id: "exclamation", label: "Exclamation (attention)", aliases: ["exclamation", "exclamation mark", "attention", "warning", "partial"],
    draw: canvas => { canvas.stroke([[0, 0.72], [0, -0.2]], WIDTH, INK); canvas.disc(0, -0.6, 0.13, INK); } },
  { id: "question", label: "Question mark", aliases: ["question", "question mark", "unknown"],
    draw: canvas => {
      canvas.stroke(new Path().arc(0, 0.36, 0.34, 165, -60).lineTo(0, -0.1).lineTo(0, -0.2).lines[0], WIDTH, INK);
      canvas.disc(0, -0.6, 0.13, INK);
    } },
  { id: "plus", label: "Plus +", aliases: ["plus", "add", "+"], draw: all(stroke([[0, -0.62], [0, 0.62]]), stroke([[-0.62, 0], [0.62, 0]])) },
  { id: "minus", label: "Minus −", aliases: ["minus", "remove", "−"], draw: stroke([[-0.62, 0], [0.62, 0]]) },
  { id: "arrow-up", label: "Arrow up ↑", aliases: ["arrow up", "up arrow", "↑"], draw: arrow(90) },
  { id: "arrow-down", label: "Arrow down ↓", aliases: ["arrow down", "down arrow", "↓"], draw: arrow(-90) },
  { id: "arrow-left", label: "Arrow left ←", aliases: ["arrow left", "left arrow", "←"], draw: arrow(180) },
  { id: "arrow-right", label: "Arrow right →", aliases: ["arrow right", "right arrow", "→"], draw: arrow(0) },
  { id: "heart", label: "Heart ♥", aliases: ["heart", "♥", "♡", "❤"], draw: canvas => { canvas.polygon([heart()], INK); } },
  { id: "star", label: "Star ★", aliases: ["star", "★", "☆"], draw: canvas => { canvas.polygon([star()], INK); } },
  { id: "circle", label: "Circle ○", aliases: ["circle", "ring", "○"], draw: canvas => { canvas.stroke(new Path().circle(0, 0, 0.64).lines[0], WIDTH * 0.85, INK); } },
];

export function renderSymbol(draw: Drawing): Raster2DTarget {
  const canvas = new InkCanvas({ left: -1, right: 1, bottom: -1, top: 1 }, 200);
  draw(canvas);
  return { kind: "raster2d", style: "ink", raster: canvas.toRaster() };
}

export const SYMBOL_IDS = SYMBOLS.map(symbol => `symbol.${symbol.id}`);

export const symbolPack: VisualFormPack = {
  id: "symbols",
  categories: [{ id: "symbol", family: "symbol", label: "Symbols · outcome and direction marks", hints: ["mark", "marks"], transition: { form: 1.2, return: 1.1 } }],
  forms: SYMBOLS.map((symbol): VisualFormEntry => ({
    id: `symbol.${symbol.id}`, category: "symbol", renderer: "ink", label: symbol.label, aliases: symbol.aliases,
    render: () => ({ visual: renderSymbol(symbol.draw) }),
  })),
};
