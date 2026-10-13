import { LETTERS, midi, type Pitch } from "./pitch";

/**
 * Scales spelled correctly: each letter once, in order, with whatever accidental the step pattern needs (so G major
 * has F♯, never G♭; F major has B♭, never A♯). Patterns are semitone steps.
 */
export const SCALE_PATTERNS = {
  major: [2, 2, 1, 2, 2, 2, 1],
  "natural-minor": [2, 1, 2, 2, 1, 2, 2],
  "harmonic-minor": [2, 1, 2, 2, 1, 3, 1],
} as const;
export type ScaleKind = keyof typeof SCALE_PATTERNS;
export const SCALE_KINDS = Object.keys(SCALE_PATTERNS) as ScaleKind[];

export const SCALE_NAMES: Record<ScaleKind, { en: string; zh: string }> = {
  major: { en: "major", zh: "大调" }, "natural-minor": { en: "natural minor", zh: "自然小调" }, "harmonic-minor": { en: "harmonic minor", zh: "和声小调" },
};

/** The scale from `tonic`, ascending, `octaves` octaves, ending on the tonic (C major from C4: C4 D4 E4 F4 G4 A4 B4 C5). */
export function scale(tonic: Pitch, kind: ScaleKind = "major", octaves = 1): Pitch[] {
  const pattern = SCALE_PATTERNS[kind];
  const out: Pitch[] = [tonic];
  let letter = LETTERS.indexOf(tonic.letter), octave = tonic.octave, semis = midi(tonic);
  for (let i = 0; i < pattern.length * octaves; i++) {
    semis += pattern[i % pattern.length];
    letter++;
    if (letter === 7) { letter = 0; octave++; }
    const natural = midi({ letter: LETTERS[letter], accidental: 0, octave });
    const accidental = semis - natural;
    if (accidental < -2 || accidental > 2) throw new Error("scale-spelling");
    out.push({ letter: LETTERS[letter], accidental, octave });
  }
  return out;
}

/** Whole (W) and half (H) steps between successive notes: the major scale is W W H W W W H. */
export function stepPattern(pitches: readonly Pitch[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < pitches.length; i++) {
    const d = midi(pitches[i]) - midi(pitches[i - 1]);
    out.push(d === 1 ? "H" : d === 2 ? "W" : d === 3 ? "W+H" : `${d}`);
  }
  return out;
}
