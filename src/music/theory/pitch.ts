/**
 * Pitch in scientific pitch notation (C4 is middle C, A4 = 440 Hz by default): a letter, an accidental and an octave.
 * Everything else the Music Library knows (staff positions, frequencies, scales) is computed from this, exactly.
 */
export const LETTERS = ["C", "D", "E", "F", "G", "A", "B"] as const;
export type Letter = typeof LETTERS[number];
/** Semitones above C of each natural letter. */
const NATURAL: Record<Letter, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export interface Pitch {
  letter: Letter;
  /** −2 double flat, −1 flat, 0 natural, 1 sharp, 2 double sharp. */
  accidental: number;
  octave: number;
}

/** Default concert pitch. */
export const A4_HZ = 440;
/** The pitches a lesson or a melody may use: the 88 keys of a piano (A0…C8). */
export const PITCH_RANGE = { lowest: 21, highest: 108 } as const;

const ACCIDENTAL_TEXT: Record<string, number> = { "": 0, "#": 1, "♯": 1, "x": 2, "##": 2, "𝄪": 2, "b": -1, "♭": -1, "bb": -2, "♭♭": -2, "𝄫": -2, "n": 0, "♮": 0 };

/** "C4", "F#5", "Bb3", "e♭4", "C♮4" → a pitch; anything else → null. The octave is required. */
export function parsePitch(text: unknown): Pitch | null {
  if (typeof text !== "string") return null;
  const match = /^\s*([A-Ga-g])(##|bb|♭♭|[#♯b♭x𝄪𝄫n♮]?)(-?\d)\s*$/u.exec(text);
  if (!match) return null;
  const accidental = ACCIDENTAL_TEXT[match[2]];
  if (accidental === undefined) return null;
  const pitch = { letter: match[1].toUpperCase() as Letter, accidental, octave: Number(match[3]) };
  const m = midi(pitch);
  return m >= 0 && m <= 127 ? pitch : null;
}

/** MIDI note number: C4 = 60, A4 = 69. */
export function midi(pitch: Pitch): number {
  return (pitch.octave + 1) * 12 + NATURAL[pitch.letter] + pitch.accidental;
}

/** Equal-tempered frequency in Hz of a MIDI note (A4 = `a4` Hz, 440 by default). */
export function frequency(midiNote: number, a4: number = A4_HZ): number {
  return a4 * Math.pow(2, (midiNote - 69) / 12);
}

/** Steps up the white keys from C0: C4 → 28, D4 → 29 … The staff is drawn in these steps. */
export function diatonic(pitch: Pitch): number {
  return pitch.octave * 7 + LETTERS.indexOf(pitch.letter);
}

/** The natural pitch `steps` white keys above C0 (inverse of diatonic for naturals). */
export function fromDiatonic(steps: number): Pitch {
  const octave = Math.floor(steps / 7);
  return { letter: LETTERS[steps - octave * 7], accidental: 0, octave };
}

const ACCIDENTAL_SIGN = ["𝄫", "♭", "", "♯", "𝄪"];
const ACCIDENTAL_ASCII = ["bb", "b", "", "#", "##"];

/** "C♯4" (display) or "C#4" (ascii, for VexFlow keys and tool arguments). */
export function pitchName(pitch: Pitch, ascii = false): string {
  return `${pitch.letter}${(ascii ? ACCIDENTAL_ASCII : ACCIDENTAL_SIGN)[pitch.accidental + 2] ?? ""}${pitch.octave}`;
}

/** The pitch class without the octave ("C♯", "B♭"). */
export const pitchClassName = (pitch: Pitch) => pitchName(pitch).replace(/-?\d+$/, "");

/** Fixed-do solfège (do re mi fa sol la si), as taught in Chinese music education. */
export const SOLFEGE: Record<Letter, string> = { C: "do", D: "re", E: "mi", F: "fa", G: "sol", A: "la", B: "si" };
/** Numbered notation (简谱) degrees of C major. */
export const JIANPU: Record<Letter, string> = { C: "1", D: "2", E: "3", F: "4", G: "5", A: "6", B: "7" };

/** Two pitches sound the same (enharmonic: C♯4 = D♭4). */
export const sameSound = (a: Pitch, b: Pitch) => midi(a) === midi(b);
/** Two pitches are written the same. */
export const sameSpelling = (a: Pitch, b: Pitch) => a.letter === b.letter && a.accidental === b.accidental && a.octave === b.octave;
