import { A4_HZ, frequency, midi, parsePitch, pitchName, PITCH_RANGE, type Pitch } from "../theory/pitch";
import { barQuarters, DURATIONS, parseTimeSignature, quarters, TEMPO, type Duration, type TimeSignature } from "../theory/rhythm";
import { CLEFS, staffPosition, writable, type Clef } from "./staff";

/**
 * A score: the validated, structured music every surface draws and plays. Never a picture: notes are pitches and
 * durations, so the notation engine places each one where music theory says it belongs, the playback engine sounds
 * the exact frequency, and a highlight names a note by its index.
 */
export interface ScoreNote {
  /** Scientific pitch ("C4", "F#5", "Bb3"); absent for a rest. */
  pitch?: string;
  duration: Duration;
  dotted?: boolean;
  /** A short label under the note ("C", "do", "1", "middle C"). */
  label?: string;
}

export interface MusicScore {
  clef: Clef;
  /** "4/4", "3/4", "6/8", "C"… Absent: no time signature and no bar lines (a scale or single notes). */
  time?: string;
  notes: ScoreNote[];
}

/** What can be highlighted: notes by index, a staff line (1–5) or space (1–4), the clef or the time signature. */
export type MusicHighlight =
  | { note: number }
  | { line: number }
  | { space: number }
  | { clef: true }
  | { time: true };

export const SCORE_LIMITS = { notes: 48, label: 16, highlights: 12 } as const;

export interface CheckedNote extends ScoreNote { index: number; pitchValue: Pitch | null; quarters: number; start: number; measure: number; position: number | null; midi: number | null }
export interface CheckedScore { score: MusicScore; clef: Clef; time: TimeSignature | null; notes: CheckedNote[]; measures: number; totalQuarters: number }

export type ScoreCheck = { ok: true; value: CheckedScore } | { ok: false; problem: string };

/** Validates a score strictly: every pitch real and writable in its clef, every bar exactly full (the last may be short). */
export function checkScore(input: unknown): ScoreCheck {
  const fail = (problem: string): ScoreCheck => ({ ok: false, problem });
  const raw = input as Partial<MusicScore> | null;
  if (!raw || typeof raw !== "object") return fail("a score needs clef and notes");
  if (!CLEFS.includes(raw.clef as Clef)) return fail(`clef must be one of ${CLEFS.join(", ")}`);
  const clef = raw.clef as Clef;
  let time: TimeSignature | null = null;
  if (raw.time !== undefined) { time = parseTimeSignature(raw.time); if (!time) return fail(`time "${String(raw.time)}" is not a supported time signature (2/4, 3/4, 4/4, 3/8, 6/8, 9/8, 12/8, 2/2, C)`); }
  // An empty staff is a real thing to show (the five lines and four spaces, a clef on its own).
  if (!Array.isArray(raw.notes)) return fail("notes must be a list (it may be empty: a staff on its own)");
  if (raw.notes.length > SCORE_LIMITS.notes) return fail(`at most ${SCORE_LIMITS.notes} notes`);
  const bar = time ? barQuarters(time) : Infinity;
  const notes: CheckedNote[] = [];
  let start = 0;
  for (const [index, note] of raw.notes.entries()) {
    const at = `note ${index + 1}`;
    if (!note || typeof note !== "object") return fail(`${at} is not a note`);
    if (!DURATIONS.includes(note.duration)) return fail(`${at}: duration must be one of ${DURATIONS.join(", ")}`);
    if (note.dotted !== undefined && typeof note.dotted !== "boolean") return fail(`${at}: dotted must be true or false`);
    // eslint-disable-next-line no-control-regex -- a label must hold no control characters
    if (note.label !== undefined && (typeof note.label !== "string" || note.label.length > SCORE_LIMITS.label || /[\u0000-\u001f]/.test(note.label))) return fail(`${at}: label is at most ${SCORE_LIMITS.label} plain characters`);
    let pitchValue: Pitch | null = null, position: number | null = null, m: number | null = null;
    if (note.pitch !== undefined && note.pitch !== null) {
      pitchValue = parsePitch(note.pitch);
      if (!pitchValue) return fail(`${at}: "${String(note.pitch)}" is not a pitch (write it like C4, F#5 or Bb3)`);
      m = midi(pitchValue);
      if (m < PITCH_RANGE.lowest || m > PITCH_RANGE.highest) return fail(`${at}: ${note.pitch} is outside a piano's range (A0–C8)`);
      if (!writable(pitchValue, clef)) return fail(`${at}: ${note.pitch} is too far from the ${clef} staff to read; use the other clef`);
      position = staffPosition(pitchValue, clef);
    }
    const length = quarters(note.duration, note.dotted);
    // A note may not cross a bar line: bars are exact.
    const measure = Math.floor(start / bar + 1e-9);
    if (time && start + length > (measure + 1) * bar + 1e-9) return fail(`${at} crosses a bar line: each ${raw.time} bar holds ${bar} quarter notes`);
    notes.push({ ...note, ...(pitchValue ? { pitch: pitchName(pitchValue, true) } : { pitch: undefined }), index, pitchValue, quarters: length, start, measure: time ? measure : 0, position, midi: m });
    start += length;
  }
  const measures = time ? Math.ceil(start / bar - 1e-9) : 1;
  const score: MusicScore = { clef, ...(raw.time !== undefined ? { time: raw.time } : {}), notes: notes.map(({ pitch, duration, dotted, label }) => ({ ...(pitch ? { pitch } : {}), duration, ...(dotted ? { dotted } : {}), ...(label ? { label } : {}) })) };
  return { ok: true, value: { score, clef, time, notes, measures, totalQuarters: start } };
}

/** Validates highlights against a checked score. */
export function checkHighlights(input: unknown, score: CheckedScore): { ok: true; value: MusicHighlight[] } | { ok: false; problem: string } {
  if (input === undefined) return { ok: true, value: [] };
  if (!Array.isArray(input) || input.length > SCORE_LIMITS.highlights) return { ok: false, problem: `highlight is a list of at most ${SCORE_LIMITS.highlights} items` };
  const out: MusicHighlight[] = [];
  for (const item of input as Record<string, unknown>[]) {
    if (item && Number.isInteger(item.note) && (item.note as number) >= 0 && (item.note as number) < score.notes.length) out.push({ note: item.note as number });
    else if (item && Number.isInteger(item.line) && (item.line as number) >= 1 && (item.line as number) <= 5) out.push({ line: item.line as number });
    else if (item && Number.isInteger(item.space) && (item.space as number) >= 1 && (item.space as number) <= 4) out.push({ space: item.space as number });
    else if (item && item.clef === true) out.push({ clef: true });
    else if (item && item.time === true) out.push({ time: true });
    else return { ok: false, problem: `highlight items are {note: index from 0}, {line: 1–5}, {space: 1–4}, {clef: true} or {time: true}` };
  }
  return { ok: true, value: out };
}

/** One sounding event of a playback: a pitch (or a rest) at a time, in quarter notes from the start. */
export interface PlaybackEvent { index: number; midi: number | null; start: number; length: number }

/** The score as playback events (rests included, so the highlight can rest on them too). */
export const playbackEvents = (score: CheckedScore, only?: readonly number[]): PlaybackEvent[] => {
  const chosen = only?.length ? score.notes.filter(note => only.includes(note.index)) : score.notes;
  let start = 0;
  return chosen.map(note => {
    // Played on their own, chosen notes follow one another without the gaps between them.
    const event = { index: note.index, midi: note.midi, start: only?.length ? start : note.start, length: note.quarters };
    start += note.quarters;
    return event;
  });
};

export interface ScheduledNote { index: number; frequency: number | null; at: number; until: number }

/**
 * When each event sounds, in seconds from `origin` on an audio clock, at `tempo` quarter notes a minute. Deterministic:
 * the audio graph is scheduled from this, and the highlight follows the same numbers read from the same clock.
 */
export function schedule(events: readonly PlaybackEvent[], tempo: number, origin = 0, a4 = A4_HZ): ScheduledNote[] {
  const bpm = Math.max(TEMPO.min, Math.min(TEMPO.max, Number.isFinite(tempo) ? tempo : TEMPO.default));
  const beat = 60 / bpm;
  return events.map(event => ({
    index: event.index, frequency: event.midi === null ? null : frequency(event.midi, a4),
    at: origin + event.start * beat, until: origin + (event.start + event.length) * beat,
  }));
}

/** The note sounding at clock time `t` (null between or after). */
export function noteAt(scheduled: readonly ScheduledNote[], t: number): ScheduledNote | null {
  for (const note of scheduled) if (t >= note.at && t < note.until) return note;
  return null;
}

/** A score from pitch names, all one duration (for "play C D E" and scales). */
export function scoreOf(pitches: readonly string[], clef: Clef, duration: Duration = "quarter", time?: string): MusicScore {
  return { clef, ...(time ? { time } : {}), notes: pitches.map(pitch => ({ pitch, duration })) };
}
