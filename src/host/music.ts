import { checkHighlights, checkScore, playbackEvents, type Barline, type CheckedScore, type MusicHighlight, type MusicScore, type PlaybackEvent, type ScoreNote } from "../music/notation/score";
import { describePosition, MIDDLE_C, type Clef } from "../music/notation/staff";
import { frequency, midi, parsePitch, pitchClassName, pitchName, SOLFEGE } from "../music/theory/pitch";
import { DURATION_NAMES, REST_NAMES, TEMPO, type Duration } from "../music/theory/rhythm";
import { scale, SCALE_NAMES, type ScaleKind } from "../music/theory/scales";
import { checkReading, type ReadingAnswer } from "../music/exercises/reading";
import { findLesson, lessonById, LESSONS, type Language, type Lesson, type LessonStep } from "../music/lessons/lessons";

/**
 * The host side of the Music Library: tool arguments become a validated score, a lesson step becomes a presentation,
 * an answer is checked. Pure (no hub, no MCP), so the tools stay small and all of it is tested.
 */
export interface MusicArgs {
  clef?: Clef; time?: string; key?: string; end?: Barline; notes?: (Omit<ScoreNote, "duration"> & { duration?: Duration })[]; staff?: boolean;
  scale?: { tonic: string; kind?: ScaleKind; octaves?: number; direction?: "up" | "down" | "up-down"; duration?: Duration };
}

export type Built = { ok: true; score: CheckedScore; title: string } | { ok: false; problem: string };

/** Notes or a scale (or an empty staff) → a checked score with a sensible default title. */
export function buildScore(args: MusicArgs, title?: string): Built {
  let notes: ScoreNote[] | undefined = args.notes?.map(note => ({ ...note, duration: note.duration ?? "quarter" }));
  let name = title;
  if (args.scale) {
    if (notes?.length) return { ok: false, problem: "give notes or a scale, not both" };
    const tonic = parsePitch(args.scale.tonic);
    if (!tonic) return { ok: false, problem: `"${args.scale.tonic}" is not a starting note (write it like C4)` };
    let pitches = scale(tonic, args.scale.kind ?? "major", args.scale.octaves ?? 1);
    if (args.scale.direction === "down") pitches = [...pitches].reverse();
    if (args.scale.direction === "up-down") pitches = [...pitches, ...[...pitches].reverse().slice(1)];
    notes = pitches.map(pitch => ({ pitch: pitchName(pitch, true), duration: args.scale!.duration ?? "quarter", label: pitchClassName(pitch) }));
    name ??= `${pitchClassName(tonic)} ${SCALE_NAMES[args.scale.kind ?? "major"].en} scale`;
  }
  if (!notes?.length && !args.staff) return { ok: false, problem: "give notes, a scale, or staff: true for an empty staff" };
  notes ??= [];
  // A clef that suits the notes: bass when every note is below middle C.
  const pitched = notes.map(note => note.pitch && parsePitch(note.pitch)).filter(Boolean) as NonNullable<ReturnType<typeof parsePitch>>[];
  const clef: Clef = args.clef ?? (pitched.length && pitched.every(pitch => midi(pitch) < midi(MIDDLE_C)) ? "bass" : "treble");
  const check = checkScore({ clef, ...(args.time ? { time: args.time } : {}), ...(args.key ? { key: args.key } : {}), ...(args.end ? { end: args.end } : {}), notes } as MusicScore);
  if (!check.ok) return check;
  name ??= pitched.length === 1 ? pitchName(pitched[0]) : pitched.length ? `${pitched.length} notes` : `The ${clef} staff`;
  return { ok: true, score: check.value, title: name };
}

export function highlights(input: unknown, score: CheckedScore): { ok: true; value: MusicHighlight[] } | { ok: false; problem: string } {
  return checkHighlights(input, score);
}

/** What Codex may say about each note: its name, where it sits, how long, how high. */
export function noteFacts(score: CheckedScore, language: Language = "en") {
  return score.notes.map(note => {
    const pitch = note.pitchValue;
    const duration = `${note.dotted ? (language === "zh" ? "附点" : "dotted ") : ""}${(pitch ? DURATION_NAMES : REST_NAMES)[note.duration][language]}`;
    if (!pitch) return { index: note.index, rest: true, duration, beats: note.quarters };
    return {
      index: note.index, pitch: pitchName(pitch), name: pitchClassName(pitch), solfege: SOLFEGE[pitch.letter],
      frequency: Math.round(frequency(midi(pitch)) * 100) / 100, duration, beats: note.quarters,
      where: describePosition(note.position!, language), ...(midi(pitch) === midi(MIDDLE_C) ? { middleC: true } : {}),
    };
  });
}

export function events(score: CheckedScore, only?: readonly number[]): { ok: true; value: PlaybackEvent[] } | { ok: false; problem: string } {
  if (only?.some(index => index >= score.notes.length)) return { ok: false, problem: `only names notes 0–${score.notes.length - 1}` };
  const value = playbackEvents(score, only);
  return value.some(event => event.midi !== null) ? { ok: true, value } : { ok: false, problem: "there is nothing to play (rests only)" };
}

export const defaultTempo = (tempo?: number) => tempo ?? TEMPO.default;

// ── Lessons ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface LessonPosition { id: number; step: number; language: Language }

export type LessonMove = { ok: true; lesson: Lesson; step: LessonStep; position: LessonPosition } | { ok: false; problem: string };

/** Where the lesson goes next: a lesson (by number or words) and a step (a number, first, next, previous, repeat). */
export function moveLesson(current: LessonPosition | null, request: { lesson?: number | string; step?: number | "first" | "next" | "previous" | "repeat"; language?: Language }): LessonMove {
  const language = request.language ?? current?.language ?? "en";
  let lesson: Lesson | null;
  let index: number;
  if (request.lesson !== undefined) {
    lesson = findLesson(request.lesson);
    if (!lesson) return { ok: false, problem: `no lesson "${request.lesson}". Lessons: ${LESSONS.map(l => `${l.id} ${l.title.en}`).join("; ")}` };
    const same = current?.id === lesson.id;
    index = typeof request.step === "number" ? request.step - 1
      : request.step === "next" && same ? current!.step : request.step === "previous" && same ? current!.step - 2
        : request.step === "repeat" && same ? current!.step - 1 : 0;
  } else {
    if (!current) return { ok: false, problem: "no lesson is under way: give lesson (1–8)" };
    lesson = lessonById(current.id)!;
    const step = request.step ?? (request.language && request.language !== current.language ? "repeat" : "next");
    index = typeof step === "number" ? step - 1 : step === "first" ? 0 : step === "next" ? current.step : step === "previous" ? current.step - 2 : current.step - 1;
  }
  if (index >= lesson.steps.length) {
    const next = lessonById(lesson.id + 1);
    return { ok: false, problem: `lesson ${lesson.id} is complete (${lesson.steps.length} steps).${next ? ` Next: lesson ${next.id}, ${next.title.en}.` : " That was the last lesson."}` };
  }
  index = Math.max(0, index);
  return { ok: true, lesson, step: lesson.steps[index], position: { id: lesson.id, step: index + 1, language } };
}

/** Checks an answer to the step's practice question. */
export function answerStep(step: LessonStep, answer: string): ReadingAnswer | null {
  if (!step.question) return null;
  // The question is the note the step shows.
  const pitch = step.score("en").notes[0]?.pitch;
  const parsed = pitch ? parsePitch(pitch) : null;
  if (!parsed) return null;
  return checkReading({ clef: step.question.clef, pitch: pitchName(parsed, true), position: 0 }, answer);
}
