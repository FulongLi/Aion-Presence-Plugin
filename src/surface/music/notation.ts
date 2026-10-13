import { Accidental, Annotation, AnnotationVerticalJustify, Beam, Dot, Formatter, Fraction, Renderer, Stave, StaveNote, Voice, VoiceMode, VexFlow, BarlineType } from "vexflow/core";
// The Bravura music font (SIL OFL 1.1), as VexFlow ships it. Loaded from its bytes (never a URL), so no font request is made.
// @ts-expect-error -- VexFlow publishes this module's types elsewhere (build/types); it exports one data: URL string.
import { Bravura as BravuraFont } from "../../../node_modules/vexflow/build/esm/src/fonts/bravura.js";

const Bravura = BravuraFont as string;
import { checkScore, type CheckedNote, type CheckedScore, type MusicHighlight, type MusicScore } from "../../music/notation/score";
import { VEXFLOW_DURATION, beatQuarters } from "../../music/theory/rhythm";

/**
 * The notation engine of the music card: VexFlow (MIT) with the Bravura font draws a validated score as SVG, so every
 * clef, note, stem, flag, beam, ledger line, accidental, rest, bar line and time signature is engraved by an established
 * renderer rather than approximated. Each note's group carries its index (class "note-N"), so the card can light it
 * up while it is explained or heard, and the figure can point at it.
 */
let fontReady: Promise<void> | null = null;

/** Loads Bravura once from the bundled bytes. */
export function loadMusicFont(): Promise<void> {
  fontReady ??= (async () => {
    const base64 = Bravura.slice(Bravura.indexOf("base64,") + 7);
    const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
    const face = new FontFace("Bravura", bytes.buffer, { display: "block" });
    document.fonts.add(await face.load());
    VexFlow.setFonts("Bravura");
  })();
  return fontReady;
}

export interface RenderedScore {
  svg: SVGSVGElement;
  /** The SVG group of each note, by index. */
  notes: (SVGElement | null)[];
  checked: CheckedScore;
  /** Each stave's extent and its five lines' y, bottom line first (from VexFlow's own geometry). */
  staves: { x: number; width: number; lines: number[] }[];
  /** The drawing's size in its own units (the svg scales to its box through a viewBox). */
  size: { width: number; height: number };
}

const LABEL_FONT = { family: "-apple-system, 'Segoe UI', 'PingFang SC', system-ui, sans-serif", size: 13 };

/** "c#/4" from "C#4"; a rest sits where VexFlow's rests belong in the clef. */
const vexKey = (note: CheckedNote, clef: string) => {
  if (!note.pitchValue) return clef === "bass" ? "d/3" : "b/4";
  const { letter, accidental, octave } = note.pitchValue;
  return `${letter.toLowerCase()}${["bb", "b", "", "#", "##"][accidental + 2]}/${octave}`;
};

/** Measures as groups of notes: by bar lines when there is a time signature, otherwise lines of at most 10 notes. */
function measures(score: CheckedScore): CheckedNote[][] {
  const out: CheckedNote[][] = [];
  if (score.time) for (const note of score.notes) (out[note.measure] ??= []).push(note);
  else for (let i = 0; i < score.notes.length; i += 10) out.push(score.notes.slice(i, i + 10));
  return out.length ? out : [[]];
}

/** Draws `input` into `host` (replacing what was there), `width` pixels wide. */
export async function renderScore(host: HTMLElement, input: MusicScore, width: number): Promise<RenderedScore> {
  const check = checkScore(input);
  if (!check.ok) throw new Error(`score-invalid: ${check.problem}`);
  await loadMusicFont();
  const score = check.value;
  host.replaceChildren();
  const groups = measures(score);
  // Each measure gets room for its notes; lines wrap so nothing is squeezed.
  const room = (group: CheckedNote[]) => Math.max(score.time ? 104 : 140, 40 + group.length * 34);
  const lines: CheckedNote[][][] = [[]];
  let used = 110;
  for (const group of groups) {
    const need = room(group);
    if (lines.at(-1)!.length && used + need > width - 16) { lines.push([]); used = 90; }
    lines.at(-1)!.push(group); used += need;
  }
  const lineHeight = 118, top = 14;
  const renderer = new Renderer(host as HTMLDivElement, Renderer.Backends.SVG);
  const size = { width, height: top + lines.length * lineHeight + 8 };
  renderer.resize(size.width, size.height);
  const context = renderer.getContext();
  context.setFillStyle("currentColor"); context.setStrokeStyle("currentColor");
  const notes: (SVGElement | null)[] = score.notes.map(() => null);
  const drawn: { note: StaveNote; index: number }[] = [];
  const staves: RenderedScore["staves"] = [];
  lines.forEach((line, row) => {
    let x = 8;
    const total = line.reduce((sum, group) => sum + room(group), 0);
    const extra = line.length ? (width - 16 - (row === 0 ? 102 : 82) - total) / line.length : 0;
    line.forEach((group, column) => {
      const first = column === 0;
      const header = first ? (row === 0 ? 102 : 82) : 0;
      const staveWidth = room(group) + header + Math.max(0, extra);
      const stave = new Stave(x, top + row * lineHeight, staveWidth);
      if (first) {
        stave.addClef(score.clef);
        if (row === 0 && score.score.time) stave.addTimeSignature(score.score.time);
      }
      const last = row === lines.length - 1 && column === line.length - 1;
      if (!score.time) stave.setEndBarType(last && group.length ? BarlineType.END : BarlineType.NONE);
      else if (last) stave.setEndBarType(BarlineType.END);
      stave.setContext(context).draw();
      staves.push({ x: stave.getX(), width: stave.getWidth(), lines: [4, 3, 2, 1, 0].map(line => stave.getYForLine(line)) });
      if (group.length) {
        const staveNotes = group.map(note => {
          const staveNote = new StaveNote({ clef: score.clef, keys: [vexKey(note, score.clef)], duration: `${VEXFLOW_DURATION[note.duration]}${note.pitchValue ? "" : "r"}`, autoStem: true });
          if (note.dotted) Dot.buildAndAttach([staveNote], { all: true });
          if (note.pitchValue && note.pitchValue.accidental !== 0) staveNote.addModifier(new Accidental(["bb", "b", "n", "#", "##"][note.pitchValue.accidental + 2]), 0);
          if (note.label) staveNote.addModifier(new Annotation(note.label).setFont(LABEL_FONT.family, LABEL_FONT.size).setVerticalJustification(AnnotationVerticalJustify.BOTTOM), 0);
          drawn.push({ note: staveNote, index: note.index });
          return staveNote;
        });
        const quarters = group.reduce((sum, note) => sum + note.quarters, 0);
        const voice = new Voice({ numBeats: Math.max(0.25, quarters) * 4, beatValue: 16 }).setMode(VoiceMode.SOFT).addTickables(staveNotes);
        const beams = Beam.generateBeams(staveNotes.filter(note => !note.isRest()), score.time ? { groups: beamGroups(score) } : {});
        new Formatter().joinVoices([voice]).format([voice], staveWidth - header - 28);
        voice.draw(context, stave);
        for (const beam of beams) beam.setContext(context).draw();
      }
      x += staveWidth;
    });
  });
  // VexFlow names each note's group by id: classes go on afterwards, so the card can find and light them.
  for (const { note, index } of drawn) {
    const group = host.querySelector<SVGElement>(`[id="vf-${note.getAttribute("id")}"]`);
    group?.classList.add("music-note", `note-${index}`);
    notes[index] = group ?? null;
  }
  host.querySelectorAll(".vf-clef").forEach(node => node.classList.add("music-clef"));
  host.querySelectorAll(".vf-timesignature").forEach(node => node.classList.add("music-time"));
  const svg = host.querySelector("svg") as SVGSVGElement;
  svg.setAttribute("role", "img");
  // Scales with the card: the drawing's own units through a viewBox, no fixed pixel size.
  svg.setAttribute("viewBox", `0 0 ${size.width} ${size.height}`);
  svg.removeAttribute("width"); svg.removeAttribute("height");
  svg.style.removeProperty("width"); svg.style.removeProperty("height");
  return { svg, notes, checked: score, staves, size };
}

/** Beams follow the felt beat: pairs of eighths in 4/4, threes in 6/8. */
function beamGroups(score: CheckedScore) {
  const beat = score.time ? beatQuarters(score.time) : 1;
  // Fractions of a whole note (VexFlow's beam groups): one beat.
  return [new Fraction(beat * 2, 8)];
}

/**
 * Lights up what the explanation is about: notes (by index), a staff line or space on every stave, the clef or the
 * time signature. Anything else goes dark again.
 */
export function highlight(rendered: RenderedScore, items: readonly MusicHighlight[], playing: number | null = null) {
  const svg = rendered.svg;
  svg.querySelectorAll(".lit, .sounding").forEach(node => node.classList.remove("lit", "sounding"));
  svg.querySelectorAll(".staff-mark").forEach(node => node.remove());
  for (const item of items) {
    if ("note" in item) rendered.notes[item.note]?.classList.add("lit");
    if ("clef" in item) svg.querySelectorAll(".music-clef").forEach(node => node.classList.add("lit"));
    if ("time" in item) svg.querySelectorAll(".music-time").forEach(node => node.classList.add("lit"));
    if ("line" in item || "space" in item) markStaff(rendered, "line" in item ? { line: item.line } : { space: (item as { space: number }).space });
  }
  if (playing !== null) rendered.notes[playing]?.classList.add("sounding");
}

/** A soft band over a staff line or space, on every stave. */
function markStaff(rendered: RenderedScore, which: { line: number } | { space: number }) {
  for (const stave of rendered.staves) {
    const spacing = stave.lines[0] - stave.lines[1];
    const y = "line" in which ? stave.lines[which.line - 1] : stave.lines[which.space - 1] - spacing / 2;
    const half = "line" in which ? 2.2 : spacing / 2 - 1.5;
    const band = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    band.setAttribute("class", "staff-mark");
    band.setAttribute("x", String(stave.x)); band.setAttribute("width", String(stave.width));
    band.setAttribute("y", String(y - half)); band.setAttribute("height", String(half * 2));
    band.setAttribute("rx", "2");
    rendered.svg.prepend(band);
  }
}
