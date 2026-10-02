/**
 * How long an answer takes to say. Codex's Stop hook carries the final assistant message; the hook reduces it to
 * this one number on the spot, so Aion can keep answering for as long as the answer is being spoken (Codex's
 * voice has no signal a plugin can read). The text itself never leaves the hook.
 *
 * Spoken rates: about 2.6 words a second in English-like scripts, about 4.2 characters a second in Chinese,
 * Japanese and Korean. Code blocks, URLs and markup are not read aloud, so they are not counted.
 */
export const SPEECH_RATE = { words: 2.6, cjk: 4.2 };
/** The longest tail any answer gets. */
export const SPEECH_MAX_SECONDS = 60;

const CJK = /[぀-ヿ㐀-鿿가-힯]/gu;

export function estimateSpeechSeconds(message: unknown): number {
  if (typeof message !== "string" || !message.trim()) return 0;
  const spoken = message.slice(0, 200_000)
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[#>*_|[\]()-]+/g, " ");
  const cjk = spoken.match(CJK)?.length ?? 0;
  const words = spoken.replace(CJK, " ").split(/\s+/).filter(word => /[\p{L}\p{N}]/u.test(word)).length;
  const seconds = words / SPEECH_RATE.words + cjk / SPEECH_RATE.cjk;
  return Math.round(Math.min(SPEECH_MAX_SECONDS, seconds) * 10) / 10;
}
