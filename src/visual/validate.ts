/**
 * Allowlist validation for the open parts of visual requests (from SCF's visual-actions/validate.ts and the
 * tool executor). Queries, regions and names are generous, but never markup, a URL or control text; emoji are
 * validated as whole grapheme sequences, never by `.length`.
 */

/** Control, zero-width and bidirectional-override characters: never part of a name, query or label. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
export const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/u;

export const CLOCK_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const NUMBER = /^[+\-−]?\p{Sc}?\d[\d.,:/ ]*(?:%|°[CF]?|\p{Sc}|[a-zA-Z]{1,3})?$/u;
const PERSON = /^[\p{L}\p{M} .'’·-]+$/u;
/** Free-text visual queries: words, numbers and ordinary punctuation. No markup, URLs or code. */
const QUERY = /^[\p{L}\p{M}\p{N} .,'’·\-&()/:+#!?"]+$/u;
const LINKISH = /(?:\/\/|www\.|\b(?:javascript|data|file|https?):(?!\s))/i;

/** Limits from SCF's tool definitions. */
export const VISUAL_LIMITS = { query: 100, region: 80, person: 60, number: 12 } as const;

/**
 * One emoji is an allowlist of the RGI constructions, so ordinary text, markup, URLs and control characters
 * cannot match:
 * - an emoji character (Extended_Pictographic that is also Emoji, so digits, letters and unassigned
 *   pictographic code points are excluded), optionally with a skin-tone modifier and/or VS-16;
 * - up to four of those joined by ZWJ (👨‍🚀, 👨‍👩‍👧‍👦, 👩‍❤️‍💋‍👨);
 * - a regional-indicator pair (🇬🇧), a keycap (1️⃣, #️⃣) or a tag sequence (🏴󠁧󠁢󠁷󠁬󠁳󠁿).
 */
const EMOJI_ELEMENT = String.raw`(?:(?=\p{Emoji})\p{Extended_Pictographic}(?:\p{Emoji_Modifier}️?|️)?)`;
const EMOJI = new RegExp(String.raw`^(?:${EMOJI_ELEMENT}(?:‍${EMOJI_ELEMENT}){0,3}`
  + String.raw`|\p{Regional_Indicator}{2}|[0-9#*]️?⃣|\u{1F3F4}[\u{E0020}-\u{E007E}]{1,8}\u{E007F})$`, "u");
const graphemeSegmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/**
 * Exactly one emoji: a single grapheme cluster (Unicode segmentation) that is an emoji sequence. Rejects
 * empty strings, text, markup, URLs, control characters and several emoji ("😊😂").
 */
export function isSingleEmojiGrapheme(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 32 || !EMOJI.test(value)) return false;
  if (!graphemeSegmenter) return true;
  const segments = graphemeSegmenter.segment(value)[Symbol.iterator]();
  return !segments.next().done && Boolean(segments.next().done);
}

/** Open text for image queries and terrain regions: never markup, a URL or control text. */
export function validQuery(value: unknown, max: number): value is string {
  return typeof value === "string" && value === value.trim() && value.length > 0 && Array.from(value).length <= max
    && QUERY.test(value) && !LINKISH.test(value) && !CONTROL.test(value) && /[\p{L}\p{N}]/u.test(value);
}

export function validPerson(value: unknown): value is string {
  return typeof value === "string" && value === value.trim() && value.length > 0 && value.length <= VISUAL_LIMITS.person
    && PERSON.test(value) && !CONTROL.test(value);
}

/** A short key number with an optional sign, currency, % or unit ("42%", "£28,000", "23°C", "3.14", "8 km"). */
export function validNumber(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Array.from(value).length <= VISUAL_LIMITS.number && NUMBER.test(value);
}

/** Collapses inner whitespace and trims; non-strings pass through for the validators to reject. */
export const tidy = <T>(value: T) => (typeof value === "string" ? value.trim().replace(/\s+/g, " ") : value) as T;

const pad = (value: number) => String(value).padStart(2, "0");

/**
 * Models sometimes say "3:42 PM" or "7:05" where HH:MM is asked for. Unambiguous forms are normalized;
 * anything else is rejected rather than guessed (SCF's executor).
 */
export function normalizeClockTime(value: string): string | null {
  const match = /^\s*(\d{1,2})[:.](\d{2})(?::\d{2})?\s*([ap])?\.?\s*m?\.?\s*$/i.exec(value);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const meridiem = match[3]?.toLowerCase();
  if (minutes > 59) return null;
  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    hours = (hours % 12) + (meridiem === "p" ? 12 : 0);
  } else if (hours > 23) return null;
  return `${pad(hours)}:${pad(minutes)}`;
}

/** The local time as HH:MM. */
export const clockText = (date = new Date()) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;
