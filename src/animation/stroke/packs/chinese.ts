import type { StrokeName, StrokePack, StrokeSpec } from "../types";

/**
 * Pack A — Chinese characters: a small curated set of commonly taught characters, in the stroke order of the mainland
 * China standard (现代汉语通用字笔顺规范; GB 13000.1 order). Centre lines are drawn by hand in a 100 × 100 practice
 * square (y up), so no font outline and no third-party dataset is bundled (see docs/STROKE-ANIMATION.md for the
 * datasets evaluated and why). Regional conventions that differ (Taiwan, Hong Kong, Japan) would be further entries
 * with their own `variant`; none is bundled yet.
 */
const name = (zh: string, en: string): StrokeName => ({ zh, en });
const N = {
  heng: name("横", "horizontal"), shu: name("竖", "vertical"), pie: name("撇", "left-falling"), na: name("捺", "right-falling"),
  dian: name("点", "dot"), hengzhe: name("横折", "horizontal-turn"), shuzhe: name("竖折", "vertical-turn"),
  hengzhegou: name("横折钩", "horizontal-turn-hook"), hengpie: name("横撇", "horizontal-left-falling"),
  shugou: name("竖钩", "vertical-hook"), shupie: name("竖撇", "vertical-left-falling"),
};
const PIE: [number, number] = [1, 0.32], NA: [number, number] = [0.6, 1.3], DIAN: [number, number] = [0.75, 1.15];
const s = (d: string, stroke: StrokeName, taper?: [number, number]): StrokeSpec => ({ d, name: stroke, ...(taper ? { taper } : {}) });

export const CHINESE_PACK: StrokePack = {
  system: "chinese",
  variant: "zh-Hans",
  convention: "Mainland China standard stroke order (现代汉语通用字笔顺规范)",
  box: [0, 0, 100, 100],
  width: 0.1,
  guide: "grid",
  symbols: [
    { symbol: "一", names: ["yi", "one"], title: "one", strokes: [s("M 14 50 L 86 52", N.heng)] },
    { symbol: "二", names: ["er", "two"], title: "two", strokes: [s("M 26 68 L 74 70", N.heng), s("M 12 30 L 88 32", N.heng)] },
    { symbol: "三", names: ["san", "three"], title: "three", strokes: [s("M 24 78 L 76 80", N.heng), s("M 30 52 L 70 53", N.heng), s("M 12 22 L 88 24", N.heng)] },
    { symbol: "十", names: ["shi", "ten"], title: "ten", strokes: [s("M 12 56 L 88 58", N.heng), s("M 50 90 L 50 8", N.shu)] },
    {
      symbol: "人", names: ["ren", "person", "people"], title: "person",
      strokes: [s("M 50 90 C 50 60 40 30 12 12", N.pie, PIE), s("M 47 56 C 58 38 70 22 90 12", N.na, NA)],
    },
    {
      symbol: "大", names: ["da", "big"], title: "big",
      strokes: [s("M 14 62 L 86 64", N.heng), s("M 50 92 L 50 66 C 48 40 34 24 12 10", N.pie, PIE), s("M 51 58 C 60 38 72 22 90 10", N.na, NA)],
    },
    {
      symbol: "天", names: ["tian", "sky", "heaven", "day"], title: "sky",
      strokes: [
        s("M 24 80 L 76 82", N.heng), s("M 12 56 L 88 58", N.heng),
        s("M 50 81 L 50 60 C 48 36 34 22 12 8", N.pie, PIE), s("M 51 50 C 60 32 72 20 90 8", N.na, NA),
      ],
    },
    {
      symbol: "口", names: ["kou", "mouth"], title: "mouth",
      strokes: [s("M 22 80 L 26 18", N.shu), s("M 22 80 L 76 80 L 72 18", N.hengzhe), s("M 25 21 L 73 21", N.heng)],
    },
    {
      symbol: "日", names: ["ri", "sun", "day"], title: "sun",
      strokes: [s("M 28 90 L 28 8", N.shu), s("M 28 90 L 72 90 L 72 8", N.hengzhe), s("M 28 50 L 72 50", N.heng), s("M 28 10 L 72 10", N.heng)],
    },
    {
      symbol: "月", names: ["yue", "moon", "month"], title: "moon",
      strokes: [
        s("M 30 90 L 30 44 C 30 26 24 14 12 6", N.shupie, [1, 0.4]), s("M 30 90 L 72 90 L 72 12 L 62 18", N.hengzhegou, [1, 0.7]),
        s("M 30 66 L 72 66", N.heng), s("M 30 42 L 72 42", N.heng),
      ],
    },
    {
      symbol: "中", names: ["zhong", "middle", "centre", "center", "china"], title: "middle",
      strokes: [s("M 18 72 L 20 32", N.shu), s("M 18 72 L 82 72 L 80 32", N.hengzhe), s("M 20 34 L 80 34", N.heng), s("M 50 94 L 50 6", N.shu)],
    },
    {
      symbol: "木", names: ["mu", "tree", "wood"], title: "tree",
      strokes: [s("M 12 66 L 88 68", N.heng), s("M 50 94 L 50 6", N.shu), s("M 49 64 C 40 44 28 30 10 18", N.pie, PIE), s("M 52 62 C 62 44 74 32 90 20", N.na, NA)],
    },
    {
      symbol: "山", names: ["shan", "mountain"], title: "mountain",
      strokes: [s("M 50 92 L 50 14", N.shu), s("M 18 68 L 18 12 L 82 12", N.shuzhe), s("M 82 68 L 82 13", N.shu)],
    },
    {
      symbol: "水", names: ["shui", "water"], title: "water",
      strokes: [
        s("M 50 94 L 50 12 L 40 18", N.shugou, [1, 0.7]), s("M 16 66 L 38 66 C 32 46 24 32 12 22", N.hengpie, [1, 0.4]),
        s("M 82 76 C 74 64 64 56 54 52", N.pie, [1, 0.5]), s("M 54 54 C 62 36 74 24 90 12", N.na, NA),
      ],
    },
    {
      symbol: "火", names: ["huo", "fire"], title: "fire",
      strokes: [
        s("M 20 68 L 30 52", N.dian, DIAN), s("M 80 72 L 68 52", N.pie, [1, 0.6]),
        s("M 50 94 L 50 62 C 46 34 32 18 12 8", N.pie, PIE), s("M 51 52 C 62 30 74 20 90 8", N.na, NA),
      ],
    },
    {
      symbol: "永", names: ["yong", "eternity", "eternal", "forever", "permanence"], title: "eternity",
      note: "永 holds the eight basic brush movements (永字八法), which is why it is traditionally taught first.",
      strokes: [
        s("M 46 94 L 55 84", N.dian, DIAN), s("M 34 74 L 56 74 L 56 14 L 46 20", N.hengzhegou, [1, 0.7]),
        s("M 16 54 L 38 54 C 32 38 24 28 12 18", N.hengpie, [1, 0.4]), s("M 84 70 C 76 60 66 52 56 48", N.pie, [1, 0.5]),
        s("M 56 50 C 64 34 76 22 90 12", N.na, NA),
      ],
    },
    {
      symbol: "上", names: ["shang", "up", "above"], title: "up",
      strokes: [s("M 44 92 L 44 12", N.shu), s("M 44 54 L 76 54", N.heng), s("M 12 12 L 88 12", N.heng)],
    },
    {
      symbol: "下", names: ["xia", "down", "below"], title: "down",
      strokes: [s("M 12 86 L 88 86", N.heng), s("M 46 86 L 46 6", N.shu), s("M 54 66 L 66 52", N.dian, DIAN)],
    },
    {
      symbol: "小", names: ["xiao", "small", "little"], title: "small",
      strokes: [s("M 50 94 L 50 12 L 40 18", N.shugou, [1, 0.7]), s("M 32 64 L 18 36", N.dian, DIAN), s("M 68 64 L 84 36", N.dian, DIAN)],
    },
  ],
};
