import type { MusicHighlight, MusicScore } from "./notation/score";

/**
 * The Music Education Pack's glossary (v0.4.4): the complete introductory vocabulary of Western staff notation, each
 * concept as a small validated score the notation engine (VexFlow + Bravura) engraves exactly, what to light up, and a
 * one-line teaching point in English and Chinese. "Show me a tie", "什么是反复记号", "show a 6/8 measure" each find one.
 *
 * `writing`: the curated handwriting demonstration of the symbol, when one exists (animation/stroke/packs/symbols.ts);
 * `form`: the symbol Aion's body can become beside the card. Concepts without a validated handwriting sequence are shown
 * engraved only — an engraved outline is never presented as a way to write it.
 */
export interface MusicConcept {
  id: string;
  category: "clefs" | "staff" | "notes" | "rests" | "accidentals" | "time" | "more";
  title: { en: string; zh: string };
  names: readonly string[];
  score: MusicScore;
  highlight?: MusicHighlight[];
  caption: { en: string; zh: string };
  writing?: string;
  form?: string;
  tempo?: number;
}

const q = (pitch: string, extra: Partial<MusicScore["notes"][number]> = {}) => ({ pitch, duration: "quarter" as const, ...extra });

export const MUSIC_CONCEPTS: readonly MusicConcept[] = [
  // ── Clefs ──
  { id: "treble-clef", category: "clefs", title: { en: "Treble clef", zh: "高音谱号" }, names: ["treble clef", "g clef", "𝄞", "高音谱号", "g谱号"],
    score: { clef: "treble", notes: [{ pitch: "G4", duration: "whole", label: "G4" }] }, highlight: [{ clef: true }, { line: 2 }, { note: 0 }],
    caption: { en: "The G clef curls around line 2 and names it G4.", zh: "高音谱号绕着第二线，表示这条线是 G4。" }, writing: "music:𝄞", form: "music.treble-clef" },
  { id: "bass-clef", category: "clefs", title: { en: "Bass clef", zh: "低音谱号" }, names: ["bass clef", "f clef", "𝄢", "低音谱号", "f谱号"],
    score: { clef: "bass", notes: [{ pitch: "F3", duration: "whole", label: "F3" }] }, highlight: [{ clef: true }, { line: 4 }, { note: 0 }],
    caption: { en: "The F clef's two dots sit either side of line 4: F3.", zh: "低音谱号的两个点夹着第四线：F3。" }, writing: "music:𝄢", form: "music.bass-clef" },
  { id: "alto-clef", category: "clefs", title: { en: "Alto clef", zh: "中音谱号" }, names: ["alto clef", "c clef", "viola clef", "𝄡", "中音谱号", "c谱号"],
    score: { clef: "alto", notes: [{ pitch: "C4", duration: "whole", label: "C4" }] }, highlight: [{ clef: true }, { line: 3 }, { note: 0 }],
    caption: { en: "The C clef's centre points at the middle line: middle C (the viola reads it).", zh: "中音谱号的中心指向第三线：中央C（中提琴用它）。" }, writing: "music:𝄡" },
  // ── The staff ──
  { id: "staff-lines", category: "staff", title: { en: "The staff: five lines", zh: "五线谱的五条线" }, names: ["staff", "stave", "five lines", "staff lines", "lines", "五线谱", "线"],
    score: { clef: "treble", notes: [] }, highlight: [1, 2, 3, 4, 5].map(line => ({ line })),
    caption: { en: "Five lines, counted from the bottom: line 1 to line 5.", zh: "五条线从下往上数：第一线到第五线。" } },
  { id: "staff-spaces", category: "staff", title: { en: "The staff: four spaces", zh: "五线谱的四个间" }, names: ["spaces", "staff spaces", "间"],
    score: { clef: "treble", notes: [] }, highlight: [1, 2, 3, 4].map(space => ({ space })),
    caption: { en: "Between the lines, four spaces: space 1 to space 4 (in treble, F A C E).", zh: "线与线之间有四个间：第一间到第四间（高音谱表是 F A C E）。" } },
  { id: "ledger-lines", category: "staff", title: { en: "Ledger lines", zh: "加线" }, names: ["ledger lines", "ledger line", "leger lines", "加线"],
    score: { clef: "treble", notes: [{ pitch: "A3", duration: "half", label: "A3" }, { pitch: "C4", duration: "half", label: "C4" }, { pitch: "A5", duration: "half", label: "A5" }, { pitch: "C6", duration: "half", label: "C6" }] },
    highlight: [{ note: 0 }, { note: 1 }, { note: 2 }, { note: 3 }],
    caption: { en: "Short extra lines extend the staff below and above.", zh: "短小的加线把五线谱向下、向上延伸。" } },
  { id: "bar-line", category: "staff", title: { en: "Bar lines", zh: "小节线" }, names: ["bar line", "bar lines", "barline", "measure", "bar", "小节线", "小节"],
    score: { clef: "treble", time: "4/4", end: "single", notes: ["C4", "D4", "E4", "F4", "G4", "A4", "B4", "C5"].map(p => q(p)) },
    caption: { en: "Bar lines divide the music into bars (measures) of equal length.", zh: "小节线把音乐分成等长的小节。" } },
  { id: "double-bar-line", category: "staff", title: { en: "Double bar line", zh: "段落线（双纵线）" }, names: ["double bar line", "double bar", "双纵线", "段落线"],
    score: { clef: "treble", time: "4/4", end: "double", notes: ["E4", "G4", "C5", "G4"].map(p => q(p)) },
    caption: { en: "Two thin lines: the end of a section.", zh: "两条细线：一个段落结束。" }, writing: "music:𝄁" },
  { id: "final-bar-line", category: "staff", title: { en: "Final bar line", zh: "终止线" }, names: ["final bar line", "final bar", "end bar", "终止线"],
    score: { clef: "treble", time: "4/4", end: "final", notes: [{ pitch: "C5", duration: "whole" }] },
    caption: { en: "A thin line and a thick line: the end of the piece.", zh: "一细一粗两条线：乐曲结束。" }, writing: "music:𝄂" },
  // ── Notes ──
  { id: "whole-note", category: "notes", title: { en: "Whole note", zh: "全音符" }, names: ["whole note", "semibreve", "𝅝", "全音符"],
    score: { clef: "treble", time: "4/4", notes: [{ pitch: "G4", duration: "whole", label: "4 beats" }] }, highlight: [{ note: 0 }],
    caption: { en: "An open oval with no stem: four beats in 4/4.", zh: "空心、无符干：在 4/4 拍里占四拍。" }, writing: "music:𝅝", form: "music.whole-note", tempo: 72 },
  { id: "half-note", category: "notes", title: { en: "Half note", zh: "二分音符" }, names: ["half note", "minim", "𝅗𝅥", "二分音符"],
    score: { clef: "treble", time: "4/4", notes: [{ pitch: "G4", duration: "half", label: "2" }, { pitch: "G4", duration: "half", label: "2" }] }, highlight: [{ note: 0 }],
    caption: { en: "An open notehead with a stem: two beats.", zh: "空心符头加符干：两拍。" }, writing: "music:𝅗𝅥", form: "music.half-note", tempo: 72 },
  { id: "quarter-note", category: "notes", title: { en: "Quarter note", zh: "四分音符" }, names: ["quarter note", "crotchet", "♩", "四分音符"],
    score: { clef: "treble", time: "4/4", notes: ["G4", "G4", "G4", "G4"].map(p => q(p, { label: "1" })) }, highlight: [{ note: 0 }],
    caption: { en: "A filled notehead with a stem: one beat.", zh: "实心符头加符干：一拍。" }, writing: "music:♩", form: "music.quarter-note" },
  { id: "eighth-note", category: "notes", title: { en: "Eighth note", zh: "八分音符" }, names: ["eighth note", "quaver", "♪", "八分音符"],
    score: { clef: "treble", time: "4/4", notes: [{ pitch: "G4", duration: "eighth", label: "½" }, { pitch: "G4", duration: "eighth", label: "½" }, { pitch: "G4", duration: "half" }, { pitch: "G4", duration: "quarter" }] },
    highlight: [{ note: 0 }, { note: 1 }],
    caption: { en: "A stem with one flag (or one beam when grouped): half a beat.", zh: "符干带一条符尾（成组时用一条符杠）：半拍。" }, writing: "music:♪", form: "music.eighth-note" },
  { id: "sixteenth-note", category: "notes", title: { en: "Sixteenth note", zh: "十六分音符" }, names: ["sixteenth note", "semiquaver", "𝅘𝅥𝅯", "十六分音符"],
    score: { clef: "treble", time: "4/4", notes: [...Array.from({ length: 4 }, () => ({ pitch: "G4", duration: "sixteenth" as const, label: "¼" })), { pitch: "G4", duration: "quarter" }, { pitch: "G4", duration: "half" }] },
    highlight: [0, 1, 2, 3].map(note => ({ note })),
    caption: { en: "Two flags (or two beams): a quarter of a beat.", zh: "两条符尾（或两条符杠）：四分之一拍。" }, writing: "music:𝅘𝅥𝅯" },
  { id: "stems", category: "notes", title: { en: "Stem direction", zh: "符干方向" }, names: ["stem", "stems", "stem direction", "符干"],
    score: { clef: "treble", notes: [q("E4", { label: "up" }), q("G4", { label: "up" }), q("B4", { label: "either" }), q("D5", { label: "down" }), q("F5", { label: "down" })] },
    highlight: [{ line: 3 }],
    caption: { en: "Below the middle line stems go up on the right; above it, down on the left.", zh: "第三线以下符干朝上写在右边，以上朝下写在左边。" } },
  { id: "flags", category: "notes", title: { en: "Flags", zh: "符尾" }, names: ["flag", "flags", "符尾"],
    score: { clef: "treble", notes: [{ pitch: "A4", duration: "eighth" }, { pitch: "A4", duration: "sixteenth" }, { pitch: "D5", duration: "eighth" }, { pitch: "D5", duration: "sixteenth" }] },
    highlight: [0, 1, 2, 3].map(note => ({ note })),
    caption: { en: "Each flag halves the value; flags always point to the right.", zh: "每加一条符尾时值减半；符尾总是朝右。" } },
  { id: "beams", category: "notes", title: { en: "Beams", zh: "符杠" }, names: ["beam", "beams", "beamed notes", "符杠"],
    score: { clef: "treble", time: "4/4", notes: ["C5", "B4", "A4", "G4", "F4", "E4", "D4", "C4"].map(p => ({ pitch: p, duration: "eighth" as const })) },
    caption: { en: "Beams join eighth notes in beat groups instead of separate flags.", zh: "符杠按拍把八分音符连在一起，代替单独的符尾。" } },
  { id: "dotted-notes", category: "notes", title: { en: "Dotted notes", zh: "附点音符" }, names: ["dot", "dotted note", "dotted notes", "dotted half", "dotted quarter", "附点", "附点音符"],
    score: { clef: "treble", time: "4/4", notes: [{ pitch: "G4", duration: "half", dotted: true, label: "3" }, { pitch: "G4", duration: "quarter", label: "1" }, { pitch: "E4", duration: "quarter", dotted: true, label: "1½" }, { pitch: "F4", duration: "eighth", label: "½" }, { pitch: "G4", duration: "half" }] },
    highlight: [{ note: 0 }, { note: 2 }],
    caption: { en: "A dot adds half the note's value again: a dotted half note is three beats.", zh: "附点把时值增加一半：附点二分音符是三拍。" } },
  { id: "note-values", category: "notes", title: { en: "Note values", zh: "音符时值" }, names: ["note values", "rhythm values", "note lengths", "rhythm", "时值", "音符时值"],
    score: { clef: "treble", notes: [{ pitch: "G4", duration: "whole", label: "4" }, { pitch: "G4", duration: "half", label: "2" }, { pitch: "G4", duration: "quarter", label: "1" }, { pitch: "G4", duration: "eighth", label: "½" }, { pitch: "G4", duration: "sixteenth", label: "¼" }] },
    caption: { en: "Whole, half, quarter, eighth, sixteenth: each lasts half as long as the one before.", zh: "全、二分、四分、八分、十六分：每一个是前一个的一半。" } },
  { id: "note-position", category: "notes", title: { en: "Notes on the staff", zh: "音符在五线谱上的位置" }, names: ["note position", "notes on the staff", "line notes", "space notes", "音的位置"],
    score: { clef: "treble", notes: ["E4", "F4", "G4", "A4", "B4", "C5", "D5", "E5", "F5"].map(p => q(p, { label: p[0] })) },
    caption: { en: "Each step up moves from a line to the next space, or a space to the next line.", zh: "每升高一级，就从线到间或从间到线。" } },
  // ── Rests ──
  { id: "whole-rest", category: "rests", title: { en: "Whole rest", zh: "全休止符" }, names: ["whole rest", "semibreve rest", "全休止符"],
    score: { clef: "treble", time: "4/4", notes: [{ duration: "whole" }] }, highlight: [{ note: 0 }, { line: 4 }],
    caption: { en: "A block hanging from line 4: a whole bar of silence.", zh: "挂在第四线下的小方块：整小节休止。" }, writing: "music:𝄻", form: "music.whole-rest" },
  { id: "half-rest", category: "rests", title: { en: "Half rest", zh: "二分休止符" }, names: ["half rest", "minim rest", "二分休止符"],
    score: { clef: "treble", time: "4/4", notes: [{ duration: "half" }, { pitch: "G4", duration: "half" }] }, highlight: [{ note: 0 }, { line: 3 }],
    caption: { en: "A block sitting on line 3: two beats of silence.", zh: "坐在第三线上的小方块：两拍休止。" }, writing: "music:𝄼", form: "music.half-rest" },
  { id: "quarter-rest", category: "rests", title: { en: "Quarter rest", zh: "四分休止符" }, names: ["quarter rest", "crotchet rest", "𝄽", "四分休止符"],
    score: { clef: "treble", time: "4/4", notes: [q("G4"), { duration: "quarter" }, q("G4"), { duration: "quarter" }] }, highlight: [{ note: 1 }, { note: 3 }],
    caption: { en: "One beat of silence.", zh: "一拍休止。" }, writing: "music:𝄽", form: "music.quarter-rest" },
  { id: "eighth-rest", category: "rests", title: { en: "Eighth rest", zh: "八分休止符" }, names: ["eighth rest", "quaver rest", "𝄾", "八分休止符"],
    score: { clef: "treble", time: "4/4", notes: [{ duration: "eighth" }, { pitch: "G4", duration: "eighth" }, q("G4"), { pitch: "G4", duration: "half" }] }, highlight: [{ note: 0 }],
    caption: { en: "Half a beat of silence.", zh: "半拍休止。" }, writing: "music:𝄾", form: "music.eighth-rest" },
  { id: "sixteenth-rest", category: "rests", title: { en: "Sixteenth rest", zh: "十六分休止符" }, names: ["sixteenth rest", "semiquaver rest", "𝄿", "十六分休止符"],
    score: { clef: "treble", time: "4/4", notes: [{ duration: "sixteenth" }, { pitch: "G4", duration: "sixteenth" }, { pitch: "G4", duration: "eighth" }, q("G4"), { pitch: "G4", duration: "half" }] }, highlight: [{ note: 0 }],
    caption: { en: "A quarter of a beat of silence (two flags).", zh: "四分之一拍休止（两条符尾）。" } },
  // ── Accidentals ──
  { id: "sharp", category: "accidentals", title: { en: "Sharp", zh: "升号" }, names: ["sharp", "♯", "升号", "升记号"],
    score: { clef: "treble", time: "4/4", notes: [q("F4", { label: "F" }), q("F#4", { label: "F♯" }), q("F#4", { label: "F♯" }), q("G4")] }, highlight: [{ note: 1 }],
    caption: { en: "Raises a note a semitone, until the bar line (the next F♯ needs no sign).", zh: "把音升高半音，直到小节线（同小节后面的 F♯ 不再写）。" }, writing: "music:♯", form: "music.sharp" },
  { id: "flat", category: "accidentals", title: { en: "Flat", zh: "降号" }, names: ["flat", "♭", "降号", "降记号"],
    score: { clef: "treble", time: "4/4", notes: [q("B4", { label: "B" }), q("Bb4", { label: "B♭" }), q("A4"), q("G4")] }, highlight: [{ note: 1 }],
    caption: { en: "Lowers a note a semitone.", zh: "把音降低半音。" }, writing: "music:♭", form: "music.flat" },
  { id: "natural", category: "accidentals", title: { en: "Natural", zh: "还原号" }, names: ["natural", "♮", "还原号", "还原记号"],
    score: { clef: "treble", time: "4/4", notes: [q("F#4", { label: "F♯" }), q("F4", { label: "F♮" }), q("G4"), q("A4")] }, highlight: [{ note: 1 }],
    caption: { en: "Cancels a sharp or flat: back to the plain note.", zh: "取消升降号，回到本音。" }, writing: "music:♮", form: "music.natural" },
  // ── Time signatures ──
  ...(["2/4", "3/4", "4/4", "6/8"] as const).map((time): MusicConcept => ({
    id: `time-${time.replace("/", "-")}`, category: "time", title: { en: `${time} time`, zh: `${time} 拍` },
    names: [`${time}`, `${time} time`, `${time} measure`, `${time} time signature`, `${time.replace("/", "")}拍`, `${time}拍`],
    score: { clef: "treble", time, end: "single", notes: time === "6/8" ? ["G4", "A4", "B4", "C5", "B4", "A4"].map(p => ({ pitch: p, duration: "eighth" as const, label: "" })) : ["G4", "A4", "B4", "C5"].slice(0, Number(time[0])).map((p, i) => q(p, { label: String(i + 1) })) },
    highlight: [{ time: true }],
    caption: time === "6/8" ? { en: "Six eighth notes a bar, felt in two groups of three.", zh: "每小节六个八分音符，分成两组三拍来感觉。" }
      : { en: `${time[0]} quarter-note beats in every bar: top number beats, bottom number the beat's value.`, zh: `每小节 ${time[0]} 拍，以四分音符为一拍：上面的数是拍数，下面的是拍的单位。` },
    tempo: 84,
  })),
  { id: "common-time", category: "time", title: { en: "Common time", zh: "四四拍记号 C" }, names: ["common time", "𝄴", "c time", "四四拍记号"],
    score: { clef: "treble", time: "C", end: "single", notes: ["C5", "B4", "A4", "G4"].map(p => q(p)) }, highlight: [{ time: true }],
    caption: { en: "The C means 4/4.", zh: "C 就是 4/4 拍。" }, writing: "music:𝄴", form: "music.common-time" },
  // ── More ──
  { id: "key-signature", category: "more", title: { en: "Key signature (G major)", zh: "调号（G 大调）" }, names: ["key signature", "key", "g major key signature", "调号"],
    score: { clef: "treble", time: "4/4", key: "G", notes: ["G4", "A4", "B4", "C5", "D5", "E5", "F#5", "G5"].map(p => ({ pitch: p, duration: "quarter" as const, label: p.replace(/\d/, "").replace("#", "♯") })), end: "final" },
    highlight: [{ note: 6 }],
    caption: { en: "One sharp on the F line: every F is F♯, without writing it each time.", zh: "F 线上一个升号：每个 F 都是 F♯，不必每次都写。" } },
  { id: "tie", category: "more", title: { en: "Tie", zh: "延音线" }, names: ["tie", "tied notes", "延音线"],
    score: { clef: "treble", time: "4/4", notes: [{ pitch: "G4", duration: "half" }, { pitch: "G4", duration: "half", tie: true }, { pitch: "G4", duration: "half" }, { pitch: "E4", duration: "half" }] },
    highlight: [{ note: 1 }, { note: 2 }],
    caption: { en: "A curve joining two notes of the same pitch: hold one sound for both.", zh: "连接两个同音高音符的弧线：两音合成一个长音。" } },
  { id: "slur", category: "more", title: { en: "Slur", zh: "连音线" }, names: ["slur", "legato", "连音线", "圆滑线"],
    score: { clef: "treble", time: "4/4", notes: [q("C5", { slur: "start" }), q("D5"), q("E5"), q("D5", { slur: "end" }), { pitch: "C5", duration: "whole" }] },
    caption: { en: "A curve over different notes: play them smoothly, connected.", zh: "跨在不同音上的弧线：连贯、圆滑地演奏。" } },
  { id: "repeat-sign", category: "more", title: { en: "Repeat signs", zh: "反复记号" }, names: ["repeat", "repeat sign", "repeat signs", "反复", "反复记号"],
    score: { clef: "treble", time: "4/4", repeatStart: true, end: "repeat", notes: ["E4", "F4", "G4", "E4", "G4", "F4", "E4", "D4"].map(p => q(p)) },
    caption: { en: "Two dots by a double bar: go back to the matching sign and play it again.", zh: "双纵线旁的两个点：回到对应的记号再演奏一遍。" } },
  { id: "dynamics", category: "more", title: { en: "Dynamics", zh: "力度记号" }, names: ["dynamics", "dynamic", "piano", "forte", "loud and soft", "力度", "力度记号"],
    score: { clef: "treble", notes: [q("G4", { dynamic: "pp" }), q("G4", { dynamic: "p" }), q("G4", { dynamic: "mp" }), q("G4", { dynamic: "mf" }), q("G4", { dynamic: "f" }), q("G4", { dynamic: "ff" })] },
    caption: { en: "pp very soft · p soft · mp moderately soft · mf moderately loud · f loud · ff very loud.", zh: "pp 很弱 · p 弱 · mp 中弱 · mf 中强 · f 强 · ff 很强。" } },
];

const normalize = (value: string) => value.normalize("NFKC").trim().toLowerCase().replace(/[\s_\-.,'"!?]+/g, " ").replace(/^(?:the|a|an)\s+/, "").replace(/\s+(?:sign|symbol)$/, "");

/** A concept by id or by any of its names ("tie", "反复记号", "6/8", "common time"). */
export function lookupConcept(query: string): MusicConcept | null {
  const wanted = normalize(query);
  return MUSIC_CONCEPTS.find(concept => concept.id === query || normalize(concept.id) === wanted || concept.names.some(name => normalize(name) === wanted)) ?? null;
}

export const CONCEPT_IDS = MUSIC_CONCEPTS.map(concept => concept.id);
