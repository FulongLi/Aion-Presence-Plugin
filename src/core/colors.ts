/**
 * Aion's colours (v0.4.1). Two independent choices, both remembered across sessions:
 *
 *   base     the particles themselves: sphere, eyes, figure, every visual they form, 3D objects. Default: Aion Silver.
 *   accent   what is pointed out: map markers, highlighted places, an emphasised term. Default: Aion Coral.
 *
 * A colour is given in words ("blue", "warm gold", "紫色"), as a preset, or as #RGB / #RRGGBB. The particle palette
 * derived from it keeps the shading Aion's light gives the body, and is lifted until it stands out on black (navy is
 * still visibly navy, never invisible). Photographs and cards are never tinted. Pure, no DOM: the host validates with
 * it, the hub stores the result, every renderer draws from the same palette.
 */
export interface NamedColor { hex: string; name: string }

/** The defaults. Aion Silver is exactly the colours the renderer has always used. */
export const AION_SILVER: NamedColor = { hex: "#a8bed1", name: "Aion Silver" };
export const AION_CORAL: NamedColor = { hex: "#ff5a4f", name: "Aion Coral" };

/** Common colour names (English and Chinese) and presets, normalized (lower case, single spaces). */
const NAMES: Record<string, NamedColor> = {};
const define = (hex: string, name: string, ...aliases: string[]) => { for (const alias of [name, ...aliases]) NAMES[alias.toLowerCase()] = { hex, name }; };
define("#a8bed1", "Aion Silver", "silver", "aion silver", "original", "default", "银色", "银白", "银白色", "原来的颜色", "默认", "默认颜色");
define("#ff5a4f", "Aion Coral", "coral", "aion coral", "珊瑚色", "珊瑚红");
define("#ff3b30", "red", "red", "红", "红色", "紅色", "大红");
define("#ff9f0a", "orange", "orange", "橙", "橙色", "桔色");
define("#ffd60a", "yellow", "yellow", "黄", "黄色", "黃色");
define("#f2c14e", "gold", "gold", "golden", "金", "金色", "金黄", "金黄色");
define("#e8b86a", "warm gold", "warm gold", "warm golden", "warm", "amber", "暖金", "暖金色", "琥珀色");
define("#34c759", "green", "green", "绿", "绿色", "綠色");
define("#7ee081", "mint", "mint", "light green", "薄荷绿", "浅绿", "浅绿色");
define("#2dd4bf", "teal", "teal", "turquoise", "青绿", "青绿色", "松石绿");
define("#22d3ee", "cyan", "cyan", "aqua", "青", "青色");
define("#3b82f6", "blue", "blue", "蓝", "蓝色", "藍色");
define("#7cc4ff", "sky blue", "sky blue", "light blue", "ice blue", "baby blue", "天蓝", "天蓝色", "浅蓝", "浅蓝色", "冰蓝");
define("#00bfff", "deep sky blue", "deep sky blue", "深天蓝");
define("#1e3a8a", "navy", "navy", "navy blue", "dark blue", "深蓝", "深蓝色", "藏青", "藏青色");
define("#6366f1", "indigo", "indigo", "靛蓝", "靛蓝色", "靛青");
define("#a855f7", "purple", "purple", "紫", "紫色");
define("#8b5cf6", "violet", "violet", "lavender", "紫罗兰", "紫罗兰色", "薰衣草紫");
define("#ec4899", "pink", "pink", "magenta", "hot pink", "粉", "粉色", "粉红", "粉红色", "洋红");
define("#fb7185", "rose", "rose", "rose pink", "玫瑰", "玫瑰色", "玫瑰红");
define("#f5f5f4", "white", "white", "pure white", "白", "白色");
define("#9ca3af", "grey", "grey", "gray", "灰", "灰色");
define("#e7d7c1", "champagne", "champagne", "cream", "ivory", "香槟色", "米色", "象牙白");
define("#111111", "black", "black", "黑", "黑色");

/** A named preset list for the Skill and the tool description. */
export const COLOR_PRESETS = ["Aion Silver", "Aion Coral", "warm gold", "sky blue", "blue", "purple", "teal", "rose", "red", "green", "white"] as const;
export const COLOR_NAMES = Object.keys(NAMES);

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;
const normalize = (value: string) => value.normalize("NFKC").toLowerCase()
  .replace(/[“”"'.!?。，！？]/g, "").replace(/\s+/g, " ").trim()
  .replace(/^(?:the colou?r |colou?r )/, "").replace(/ (?:colou?r|particles?)$/, "").replace(/^(?:a |an )/, "");

/**
 * A colour from words or hex. "#00BFFF", "00bfff", "#0bf", "blue", "warm golden", "紫色", "light purple" (a lighter
 * purple), "dark green". Null when it is not a colour Aion knows.
 */
export function parseColor(input: unknown): NamedColor | null {
  if (typeof input !== "string" || input.length > 40) return null;
  const value = normalize(input);
  if (!value) return null;
  const hex = HEX.exec(value);
  if (hex) {
    const digits = hex[1].length === 3 ? hex[1].split("").map(d => d + d).join("") : hex[1];
    return { hex: `#${digits.toLowerCase()}`, name: `#${digits.toUpperCase()}` };
  }
  if (NAMES[value]) return NAMES[value];
  // "light X" / "dark X" / "pale X" / "deep X", in English or with 浅 / 深 / 淡.
  const shade = /^(light|pale|soft|bright|dark|deep)\s+(.+)$/.exec(value) ?? /^(浅|淡|亮|深|暗)(.+)$/.exec(value);
  if (shade && NAMES[shade[2]]) {
    const lighter = ["light", "pale", "soft", "bright", "浅", "淡", "亮"].includes(shade[1]);
    const base = hexToRgb(NAMES[shade[2]].hex);
    const mixed = base.map(c => lighter ? c + (1 - c) * 0.45 : c * 0.6) as Rgb;
    return { hex: rgbToHex(mixed), name: `${lighter ? "light" : "dark"} ${NAMES[shade[2]].name}` };
  }
  return null;
}

export type Rgb = [number, number, number];
export const hexToRgb = (hex: string): Rgb => {
  const h = hex.replace("#", "");
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255) as Rgb;
};
export const rgbToHex = (rgb: Rgb) => `#${rgb.map(c => Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16).padStart(2, "0")).join("")}`;
const linear = (c: number) => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
/** WCAG relative luminance (0 black … 1 white). */
export const luminance = ([r, g, b]: Rgb) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
/** WCAG contrast ratio against Aion's black stage (#090e16). */
export const contrastOnBlack = (rgb: Rgb) => (luminance(rgb) + 0.05) / (luminance(hexToRgb("#090e16")) + 0.05);

/** Lifts a colour toward white, keeping its hue, until it has at least `ratio` contrast on the black stage. */
export function visibleOnBlack(rgb: Rgb, ratio: number): Rgb {
  let out = rgb;
  for (let t = 0; t <= 1.0001 && contrastOnBlack(out) < ratio; t += 0.02) out = rgb.map(c => c + (1 - c) * t) as Rgb;
  return out;
}

/**
 * What the renderer needs for a base colour: the body's colour (`cool`, the light the sphere and bodies are tinted
 * with), its warm variant (answering's faint warm light), and the tint formed visuals take. Aion Silver gives exactly
 * the renderer's original colours. Any other colour is scaled to the same peak brightness (so shading and bloom
 * behave as they always have) and lifted until it is clearly visible on black.
 */
export interface ParticlePalette { cool: Rgb; warm: Rgb; formed: Rgb }
export const SILVER_PALETTE: ParticlePalette = { cool: hexToRgb("#a8bed1"), warm: hexToRgb("#d5c5bb"), formed: [0.78, 0.9, 1] };

export function particlePalette(hex: string): ParticlePalette {
  if (hex.toLowerCase() === AION_SILVER.hex) return SILVER_PALETTE;
  const rgb = hexToRgb(hex);
  const peak = Math.max(...rgb, 1e-3);
  const scaled = rgb.map(c => c / peak * 0.84) as Rgb;
  // The body is lit brightly and tone-mapped, which pales a colour toward white: its chroma is raised a little in
  // advance, so "blue" still reads as blue on the brightest grains (greys stay grey).
  const grey = (scaled[0] + scaled[1] + scaled[2]) / 3;
  const vivid = scaled.map(c => Math.max(0, Math.min(1, grey + (c - grey) * 1.35))) as Rgb;
  const cool = visibleOnBlack(vivid, 4.5);
  const warm = visibleOnBlack(cool.map((c, k) => Math.min(1, c * [1.1, 1, 0.88][k] + 0.04)) as Rgb, 4.5);
  const fpeak = Math.max(...cool, 1e-3);
  return { cool, warm, formed: cool.map(c => Math.min(1, c / fpeak)) as Rgb };
}

/** An accent as drawn: lifted until it reads on black (markers must never vanish). */
export const accentColor = (hex: string): string => rgbToHex(visibleOnBlack(hexToRgb(hex), 4));

/** The remembered choice (what the hub stores and every surface receives). */
export interface Appearance { base: NamedColor; accent: NamedColor }
export const DEFAULT_APPEARANCE: Appearance = { base: AION_SILVER, accent: AION_CORAL };
export const isHexColor = (value: unknown): value is string => typeof value === "string" && /^#[0-9a-f]{6}$/.test(value);
