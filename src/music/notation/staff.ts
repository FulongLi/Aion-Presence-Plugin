import { diatonic, fromDiatonic, parsePitch, type Pitch } from "../theory/pitch";

/**
 * Where notes sit on the five-line staff. A staff position counts lines and spaces from the bottom line: 0 is the
 * bottom (first) line, 1 the first space, 2 the second line … 8 the top (fifth) line. Below the staff positions are
 * negative, above they exceed 8, and every even position outside 0…8 needs a ledger line.
 *
 *   treble clef (G clef): its curl circles the second line, G4. Lines E4 G4 B4 D5 F5, spaces F4 A4 C5 E5.
 *   bass clef (F clef): its two dots surround the fourth line, F3. Lines G2 B2 D3 F3 A3, spaces A2 C3 E3 G3.
 *   middle C (C4) sits on the first ledger line below the treble staff and the first above the bass staff.
 */
export const CLEFS = ["treble", "bass"] as const;
export type Clef = typeof CLEFS[number];

/** The pitch on each clef's bottom line. */
const BOTTOM_LINE: Record<Clef, Pitch> = { treble: { letter: "E", accidental: 0, octave: 4 }, bass: { letter: "G", accidental: 0, octave: 2 } };
/** The line each clef marks (staff position) and the pitch it names: the G clef curls round G4, the F clef's dots frame F3. */
export const CLEF_REFERENCE: Record<Clef, { position: number; pitch: string }> = { treble: { position: 2, pitch: "G4" }, bass: { position: 6, pitch: "F3" } };

export const CLEF_NAMES: Record<Clef, { en: string; zh: string; other: { en: string; zh: string } }> = {
  treble: { en: "treble clef", zh: "高音谱号", other: { en: "G clef", zh: "G谱号" } },
  bass: { en: "bass clef", zh: "低音谱号", other: { en: "F clef", zh: "F谱号" } },
};

/** Staff position of a pitch in a clef (accidentals do not move a note: C♯4 sits where C4 does). */
export function staffPosition(pitch: Pitch, clef: Clef): number {
  return diatonic(pitch) - diatonic(BOTTOM_LINE[clef]);
}

/** The natural pitch written at a staff position. */
export function pitchAt(position: number, clef: Clef): Pitch {
  return fromDiatonic(diatonic(BOTTOM_LINE[clef]) + position);
}

/** Lines are even positions, spaces odd. */
export const onLine = (position: number) => position % 2 === 0;

/** The ledger lines a note at this position needs (their positions), nearest the staff first. */
export function ledgerLines(position: number): number[] {
  const out: number[] = [];
  for (let p = -2; p >= position; p -= 2) out.push(p);
  for (let p = 10; p <= position; p += 2) out.push(p);
  return out;
}

/** The five lines, bottom to top (line 1 … line 5), and the four spaces. */
export const lineNotes = (clef: Clef) => [0, 2, 4, 6, 8].map(position => pitchAt(position, clef));
export const spaceNotes = (clef: Clef) => [1, 3, 5, 7].map(position => pitchAt(position, clef));

/**
 * How a teacher names a position: "line 3", "space 2", "the first ledger line below the staff"; in Chinese 第三线, 第二间,
 * 下加一线 (the first added line below), 下加一间 (the space between the first line and it), 上加二线 …
 */
export function describePosition(position: number, language: "en" | "zh" = "en"): string {
  const zhNumber = (n: number) => "一二三四五六七八九"[n - 1] ?? String(n);
  if (position >= 0 && position <= 8) {
    const n = Math.floor(position / 2) + 1;
    if (language === "zh") return onLine(position) ? `第${zhNumber(n)}线` : `第${zhNumber(n)}间`;
    return onLine(position) ? `line ${n}` : `space ${n}`;
  }
  const below = position < 0;
  const beyond = below ? -position : position - 8;
  const k = Math.ceil(beyond / 2);
  if (language === "zh") return `${below ? "下" : "上"}加${zhNumber(k)}${onLine(position) ? "线" : "间"}`;
  const side = below ? "below" : "above";
  if (onLine(position)) return `the ${ordinal(k)} ledger line ${side} the staff`;
  return k === 1 ? `the space just ${side} the staff` : `the space ${side} the ${ordinal(k - 1)} ledger line ${side} the staff`;
}

const ordinal = (n: number) => ["first", "second", "third", "fourth", "fifth", "sixth"][n - 1] ?? `${n}th`;

/** How far below or above the staff a written note may go (four ledger lines either way). */
export const STAFF_LIMITS = { lowest: -9, highest: 17 } as const;

/** Whether a pitch can be written readably in this clef. */
export const writable = (pitch: Pitch, clef: Clef) => {
  const position = staffPosition(pitch, clef);
  return position >= STAFF_LIMITS.lowest && position <= STAFF_LIMITS.highest;
};

/** Middle C, the landmark between the two staves. */
export const MIDDLE_C = parsePitch("C4")!;
