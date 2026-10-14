/**
 * Simplified and traditional forms (v0.4.4), from OpenCC's character tables (Apache-2.0), reduced to the characters the
 * Chinese Writing Pack holds. They answer two questions: which form a character belongs to (for the coverage report,
 * counting each character once), and what a character's other form is ("show the traditional form of 国" → 國).
 *
 *   simplified   it changes when written traditionally (国 → 國); used only in simplified writing
 *   traditional  it changes when written simplified (國 → 国); used only in traditional writing
 *   shared       written the same in both (永, 人, 大) — or a pair where each is also a form of the other
 *   component    not a character but a radical or component form (⺀, ⺈), in the data for its strokes
 */
export interface VariantTables {
  /** simplified → its traditional forms, most common first (OpenCC STCharacters). */
  s2t: Record<string, string[]>;
  /** traditional → its simplified forms (OpenCC TSCharacters). */
  t2s: Record<string, string[]>;
}

export type CharacterForm = "simplified" | "traditional" | "shared" | "component";

/** CJK Radicals Supplement, Kangxi Radicals, CJK Strokes: component forms rather than characters. */
const isComponent = (char: string) => {
  const cp = char.codePointAt(0) ?? 0;
  return (cp >= 0x2e80 && cp <= 0x2fdf) || (cp >= 0x31c0 && cp <= 0x31ef);
};

export function characterForm(char: string, tables: VariantTables): CharacterForm {
  if (isComponent(char)) return "component";
  const s2t = tables.s2t[char], t2s = tables.t2s[char];
  const simplifiedOnly = !!s2t && !s2t.includes(char);
  const traditionalOnly = !!t2s && !t2s.includes(char);
  if (simplifiedOnly && !traditionalOnly) return "simplified";
  if (traditionalOnly && !simplifiedOnly) return "traditional";
  return "shared";
}

/** The other form(s) of a character, toward `target`; empty when it is already written that way. */
export function otherForms(char: string, target: "traditional" | "simplified", tables: VariantTables): string[] {
  const forms = (target === "traditional" ? tables.s2t[char] : tables.t2s[char]) ?? [];
  return forms.filter(form => form !== char);
}

/** Parses an OpenCC character table ("key<TAB>value value …", "#" comments). */
export function parseOpenccTable(text: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const [key, values] = line.split("\t");
    if (!key || !values) continue;
    out[key] = values.trim().split(/\s+/).filter(Boolean);
  }
  return out;
}
