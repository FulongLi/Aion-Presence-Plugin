/**
 * Note values and time signatures. Durations are measured in quarter notes (a quarter note = 1 beat in 4/4), so
 * every rhythm, bar and tempo calculation is exact arithmetic on small fractions of two.
 */
export const DURATIONS = ["whole", "half", "quarter", "eighth", "sixteenth"] as const;
export type Duration = typeof DURATIONS[number];

/** Quarter notes in each value (undotted). */
export const QUARTERS: Record<Duration, number> = { whole: 4, half: 2, quarter: 1, eighth: 0.5, sixteenth: 0.25 };
/** VexFlow's duration codes. */
export const VEXFLOW_DURATION: Record<Duration, string> = { whole: "w", half: "h", quarter: "q", eighth: "8", sixteenth: "16" };

export const DURATION_NAMES: Record<Duration, { en: string; zh: string; us: string }> = {
  whole: { en: "whole note", us: "whole note", zh: "全音符" },
  half: { en: "half note", us: "half note", zh: "二分音符" },
  quarter: { en: "quarter note", us: "quarter note", zh: "四分音符" },
  eighth: { en: "eighth note", us: "eighth note", zh: "八分音符" },
  sixteenth: { en: "sixteenth note", us: "sixteenth note", zh: "十六分音符" },
};
export const REST_NAMES: Record<Duration, { en: string; zh: string }> = {
  whole: { en: "whole rest", zh: "全休止符" }, half: { en: "half rest", zh: "二分休止符" }, quarter: { en: "quarter rest", zh: "四分休止符" },
  eighth: { en: "eighth rest", zh: "八分休止符" }, sixteenth: { en: "sixteenth rest", zh: "十六分休止符" },
};

/** Length in quarter notes, a dot adding half again. */
export const quarters = (duration: Duration, dotted = false) => QUARTERS[duration] * (dotted ? 1.5 : 1);

export interface TimeSignature { beats: number; unit: number }
export const TIME_SIGNATURES = ["2/4", "3/4", "4/4", "3/8", "6/8", "9/8", "12/8", "2/2"] as const;

/** "4/4", "3/4", "6/8", "C" (common time, 4/4), "¢" (cut time, 2/2) → a time signature; anything else → null. */
export function parseTimeSignature(text: unknown): TimeSignature | null {
  if (typeof text !== "string") return null;
  const value = text.trim();
  if (value === "C" || value === "c") return { beats: 4, unit: 4 };
  if (value === "¢") return { beats: 2, unit: 2 };
  const match = /^(\d{1,2})\s*\/\s*(\d{1,2})$/.exec(value);
  if (!match) return null;
  const signature = { beats: Number(match[1]), unit: Number(match[2]) };
  return (TIME_SIGNATURES as readonly string[]).includes(`${signature.beats}/${signature.unit}`) ? signature : null;
}

/** Quarter notes in one bar: 4/4 → 4, 3/4 → 3, 6/8 → 3. */
export const barQuarters = (time: TimeSignature) => time.beats * 4 / time.unit;

/** Compound metres (6/8, 9/8, 12/8) are felt in dotted-quarter beats of three eighths. */
export const isCompound = (time: TimeSignature) => time.unit === 8 && time.beats % 3 === 0 && time.beats > 3;

/** Quarter notes per felt beat: 1 in 4/4, 1.5 in 6/8, 2 in 2/2. */
export const beatQuarters = (time: TimeSignature) => isCompound(time) ? 1.5 : 4 / time.unit;

/** Seconds a value lasts at a tempo given in quarter notes per minute. */
export const seconds = (quarterNotes: number, tempo: number) => quarterNotes * 60 / tempo;

export const TEMPO = { min: 30, max: 240, default: 80 } as const;
