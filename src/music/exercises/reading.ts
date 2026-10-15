import { LETTERS, parsePitch, pitchName, SOLFEGE, type Letter, type Pitch } from "../theory/pitch";
import { pitchAt, type Clef } from "../notation/staff";

/**
 * Note-reading practice: a note on the staff, the user names it, Aion checks. Questions are deterministic for a seed
 * (the same practice can be repeated), never repeat the previous note, and stay on the staff or its first ledger line
 * so they read like real music.
 */
export interface ReadingQuestion { clef: Clef; pitch: string; position: number }

/** Positions asked: the staff plus one ledger line either way (treble: C4…A5; bass: E2…C4). */
const POSITIONS = Array.from({ length: 13 }, (_, i) => i - 2);

/** A small deterministic generator (mulberry32). */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The `count` questions of practice `seed` in a clef. */
export function readingQuestions(seed: number, clef: Clef, count = 8): ReadingQuestion[] {
  const next = random(seed * 7919 + (clef === "bass" ? 17 : clef === "alto" ? 11 : 3));
  const out: ReadingQuestion[] = [];
  let last = Infinity;
  while (out.length < count) {
    const position = POSITIONS[Math.floor(next() * POSITIONS.length)];
    if (position === last) continue;
    last = position;
    out.push({ clef, pitch: pitchName(pitchAt(position, clef), true), position });
  }
  return out;
}

const SOLFEGE_LETTER: Record<string, Letter> = Object.fromEntries(Object.entries(SOLFEGE).map(([letter, name]) => [name, letter as Letter]));
SOLFEGE_LETTER.so = "G"; SOLFEGE_LETTER.ti = "B";

export interface ReadingAnswer {
  correct: boolean;
  /** The note it is, written and named. */
  expected: string;
  /** What the answer was taken to mean (null: not a note name). */
  heard: string | null;
  /** The answer named the letter but not the octave (still correct when the letter is). */
  octaveGiven: boolean;
}

/**
 * Checks an answer: a letter ("E", "e"), a letter with octave ("E4"), solfège ("mi"), with optional "note"/"音" and
 * accidental words. A letter alone is correct when the letter matches; an octave, when given, must match too.
 */
export function checkReading(question: ReadingQuestion, answer: string): ReadingAnswer {
  const expected = parsePitch(question.pitch)!;
  const text = answer.normalize("NFKC").trim().toLowerCase()
    .replace(/^(?:it(?:'s| is)|that(?:'s| is)|the note is|这是|是)\s*/, "").replace(/\s*(?:note|音)$/, "").replace(/[.!。！]$/, "").trim();
  const sharp = /(?:\s*sharp|♯|#|升)/.test(text), flat = /(?:\s*flat|♭|降)/.test(text) || /^[a-g]b\d?$/.test(text);
  const core = text.replace(/\s*(?:sharp|flat)|[♯#♭升降]/g, "").replace(/^([a-g])b(\d?)$/, "$1$2").trim();
  let letter: Letter | undefined, octave: number | undefined;
  const lettered = /^([a-g])\s*(-?\d)?$/.exec(core);
  if (lettered) { letter = lettered[1].toUpperCase() as Letter; octave = lettered[2] === undefined ? undefined : Number(lettered[2]); }
  else if (SOLFEGE_LETTER[core]) letter = SOLFEGE_LETTER[core];
  const expectedName = pitchName(expected);
  if (!letter) return { correct: false, expected: expectedName, heard: null, octaveGiven: false };
  const heard: Pitch = { letter, accidental: sharp ? 1 : flat ? -1 : 0, octave: octave ?? expected.octave };
  const correct = heard.letter === expected.letter && heard.accidental === expected.accidental && (octave === undefined || octave === expected.octave);
  return { correct, expected: expectedName, heard: octave === undefined ? pitchName(heard).replace(/-?\d+$/, "") : pitchName(heard), octaveGiven: octave !== undefined };
}

export const LETTER_ORDER = LETTERS;
