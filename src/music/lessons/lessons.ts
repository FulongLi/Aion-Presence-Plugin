import { CLEF_NAMES, describePosition, lineNotes, pitchAt, spaceNotes, type Clef } from "../notation/staff";
import type { MusicHighlight, MusicScore } from "../notation/score";
import { scale } from "../theory/scales";
import { readingQuestions } from "../exercises/reading";
import { parsePitch, pitchClassName, pitchName, SOLFEGE } from "../theory/pitch";

/**
 * The Music Library's first lessons, in English and Chinese. Each step is what Aion shows (a validated score, what to
 * highlight, which notes to play, a symbol the body may form) and the point to make, which Codex says in its own
 * words: the text is the teaching content, not a script. Switching language keeps the lesson and the step.
 */
export const LANGUAGES = ["en", "zh"] as const;
export type Language = typeof LANGUAGES[number];
type Text = Record<Language, string>;

export interface LessonStep {
  text: Text;
  score: (language: Language) => MusicScore;
  highlight?: MusicHighlight[];
  /** Notes to play after showing (indices), or "all". */
  play?: "all" | number[];
  /** Tempo for this step's playback (quarter notes a minute). */
  tempo?: number;
  /** A music symbol the body may form beside the card (a visual form id), e.g. the clef being explained. */
  symbol?: string;
  /** A practice question: the user names the note (see exercises/reading.ts). */
  question?: { clef: Clef; index: number };
}

export interface Lesson { id: number; slug: string; title: Text; steps: LessonStep[] }

const T = (en: string, zh: string): Text => ({ en, zh });
const notes = (clef: Clef, pitches: string[], duration: MusicScore["notes"][number]["duration"] = "whole", label?: (pitch: string, i: number) => string | undefined): MusicScore => ({
  clef, notes: pitches.map((pitch, i) => ({ pitch, duration, ...(label?.(pitch, i) ? { label: label(pitch, i) } : {}) })),
});
const names = (clef: Clef, list: "lines" | "spaces") => (list === "lines" ? lineNotes(clef) : spaceNotes(clef)).map(p => pitchName(p, true));
const letter = (pitch: string) => pitchClassName(parsePitch(pitch)!);
const cMajor = scale(parsePitch("C4")!).map(p => pitchName(p, true));

export const LESSONS: readonly Lesson[] = [
  {
    id: 1, slug: "staff", title: T("The five-line staff", "认识五线谱"),
    steps: [
      { text: T("Music is written on a staff: five horizontal lines with four spaces between them. We count both from the bottom up: line 1 is the lowest line, line 5 the highest.",
        "音乐写在五线谱上：五条平行的横线，线与线之间有四个间。线和间都从下往上数：最下面是第一线，最上面是第五线。"),
        score: () => ({ clef: "treble", notes: [] }), highlight: [1, 2, 3, 4, 5].map(line => ({ line })) },
      { text: T("The four spaces are counted the same way: space 1 is between lines 1 and 2, space 4 between lines 4 and 5.",
        "四个间也从下往上数：第一间在第一线和第二线之间，第四间在第四线和第五线之间。"),
        score: () => ({ clef: "treble", notes: [] }), highlight: [1, 2, 3, 4].map(space => ({ space })) },
      { text: T("A note sits either on a line (the line runs through its head) or in a space. The higher a note sits, the higher it sounds: these climb step by step, line, space, line…",
        "音符要么在线上（线穿过符头），要么在间里。位置越高，声音越高：这些音符一级一级往上走，线、间、线……"),
        score: () => notes("treble", ["E4", "F4", "G4", "A4", "B4", "C5", "D5", "E5", "F5"], "quarter"), play: "all", tempo: 96 },
      { text: T("Notes above or below the staff get short extra lines of their own, ledger lines. This note sits on one ledger line below the staff.",
        "超出五线谱的音符要加上短短的加线。这个音符在下加一线上。"),
        score: () => notes("treble", ["C4"]), highlight: [{ note: 0 }], play: [0] },
    ],
  },
  {
    id: 2, slug: "clefs", title: T("Treble and bass clefs", "高音谱号与低音谱号"),
    steps: [
      { text: T(`The clef at the start of the staff says which notes the lines mean. The treble clef, or G clef, curls around line 2 and names it G: the G above middle C, G4.`,
        "谱表开头的谱号决定每条线代表哪个音。高音谱号又叫G谱号，它的中心圈绕着第二线，把第二线定为G，也就是中央C上面的G（G4）。"),
        score: () => notes("treble", ["G4"]), highlight: [{ clef: true }, { line: 2 }, { note: 0 }], play: [0], symbol: "music.treble-clef" },
      { text: T(`The bass clef, or F clef, is used for lower notes. Its two dots sit either side of line 4 and name it F: the F below middle C, F3.`,
        "低音谱号又叫F谱号，用来写较低的音。它的两个点夹住第四线，把第四线定为F，也就是中央C下面的F（F3）。"),
        score: () => notes("bass", ["F3"]), highlight: [{ clef: true }, { line: 4 }, { note: 0 }], play: [0], symbol: "music.bass-clef" },
      { text: T("Middle C joins the two: in the treble clef it sits on one ledger line below the staff…",
        "中央C连接着两个谱表：在高音谱表里，它在下加一线上……"),
        score: language => notes("treble", ["C4"], "whole", () => language === "zh" ? "中央C" : "middle C"), highlight: [{ note: 0 }], play: [0] },
      { text: T("…and in the bass clef on one ledger line above it. Same note, same sound, written from the other side.",
        "……在低音谱表里，它在上加一线上。同一个音、同一个声音，只是从另一边写出来。"),
        score: language => notes("bass", ["C4"], "whole", () => language === "zh" ? "中央C" : "middle C"), highlight: [{ note: 0 }], play: [0] },
    ],
  },
  {
    id: 3, slug: "note-names", title: T("Note names and pitch", "音名与音高"),
    steps: [
      { text: T("Notes are named with seven letters, A B C D E F G, then the names repeat higher up. On the treble lines, from the bottom: E G B D F (Every Good Boy Does Fine).",
        "音名用七个字母：C D E F G A B，然后在更高的地方重复。高音谱表的五条线，从下往上是 E G B D F。"),
        score: () => notes("treble", names("treble", "lines"), "whole", p => letter(p)), highlight: [0, 1, 2, 3, 4].map(note => ({ note })), play: "all", tempo: 100 },
      { text: T("The treble spaces spell F A C E, from the bottom up.", "高音谱表的四个间，从下往上是 F A C E。"),
        score: () => notes("treble", names("treble", "spaces"), "whole", p => letter(p)), highlight: [0, 1, 2, 3].map(note => ({ note })), play: "all", tempo: 100 },
      { text: T("In the bass clef the lines are G B D F A (Good Boys Do Fine Always) and the spaces A C E G (All Cows Eat Grass).",
        "低音谱表的五条线是 G B D F A，四个间是 A C E G。"),
        score: () => notes("bass", Array.from({ length: 9 }, (_, position) => pitchName(pitchAt(position, "bass"), true)), "quarter", p => letter(p)), play: "all", tempo: 100 },
      { text: T("Pitch is how high a sound is, its frequency. This A is 440 vibrations a second (A4 = 440 Hz, the tuning note). The A an octave higher is exactly twice that, 880 Hz.",
        "音高就是声音的高低，也就是频率。这个A每秒振动440次（A4 = 440赫兹，乐队调音用的标准音）。高八度的A正好是它的两倍：880赫兹。"),
        score: () => notes("treble", ["A4", "A5"], "half", (_, i) => i ? "880 Hz" : "440 Hz"), play: "all", tempo: 60 },
    ],
  },
  {
    id: 4, slug: "note-values", title: T("Whole, half, quarter and eighth notes", "全音符、二分音符、四分音符与八分音符"),
    steps: [
      { text: T("How long a note lasts is shown by its shape. A whole note, an open head with no stem, lasts four beats in 4/4.",
        "音符的形状告诉我们它持续多久。全音符是空心符头、没有符干，在4/4拍里持续四拍。"),
        score: () => ({ clef: "treble", time: "4/4", notes: [{ pitch: "G4", duration: "whole" }] }), highlight: [{ note: 0 }], play: "all", tempo: 72, symbol: "music.whole-note" },
      { text: T("A half note adds a stem: two beats, so two fill a bar.", "二分音符加了符干：两拍，所以两个二分音符填满一小节。"),
        score: () => ({ clef: "treble", time: "4/4", notes: [{ pitch: "G4", duration: "half" }, { pitch: "B4", duration: "half" }] }), highlight: [{ note: 0 }, { note: 1 }], play: "all", tempo: 72, symbol: "music.half-note" },
      { text: T("A quarter note has a filled head: one beat. Four quarter notes make a bar of 4/4.", "四分音符是实心符头：一拍。四个四分音符组成一个4/4小节。"),
        score: () => ({ clef: "treble", time: "4/4", notes: ["G4", "A4", "B4", "C5"].map(pitch => ({ pitch, duration: "quarter" as const })) }), highlight: [0, 1, 2, 3].map(note => ({ note })), play: "all", tempo: 72, symbol: "music.quarter-note" },
      { text: T("An eighth note adds a flag: half a beat. Next to each other, eighth notes are joined by a beam instead.", "八分音符加了符尾：半拍。几个八分音符在一起时，用符杠连起来。"),
        score: () => ({ clef: "treble", time: "4/4", notes: ["G4", "A4", "B4", "C5", "D5", "C5", "B4", "A4"].map(pitch => ({ pitch, duration: "eighth" as const })) }), play: "all", tempo: 72, symbol: "music.eighth-note" },
      { text: T("All four together: 4 = 2 + 2 = 1 + 1 + 1 + 1 = eight halves. Every bar holds the same four beats.", "放在一起：4 = 2 + 2 = 1 + 1 + 1 + 1 = 八个半拍。每一小节都是四拍。"),
        score: () => ({ clef: "treble", time: "4/4", notes: [
          { pitch: "C5", duration: "whole" }, { pitch: "C5", duration: "half" }, { pitch: "C5", duration: "half" },
          ...Array.from({ length: 4 }, () => ({ pitch: "C5", duration: "quarter" as const })), ...Array.from({ length: 8 }, () => ({ pitch: "C5", duration: "eighth" as const })),
        ] }), play: "all", tempo: 76 },
    ],
  },
  {
    id: 5, slug: "rests", title: T("Musical rests", "休止符"),
    steps: [
      { text: T("A rest is a measured silence: it lasts exactly as long as the note it matches. Here: note, quarter rest, note, quarter rest. Listen for the gaps.",
        "休止符是有长度的安静：它和对应的音符一样长。这里是：音符、四分休止符、音符、四分休止符。听听其中的空拍。"),
        score: () => ({ clef: "treble", time: "4/4", notes: [{ pitch: "C5", duration: "quarter" }, { duration: "quarter" }, { pitch: "C5", duration: "quarter" }, { duration: "quarter" }] }),
        highlight: [{ note: 1 }, { note: 3 }], play: "all", tempo: 76, symbol: "music.quarter-rest" },
      { text: T("A half rest sits on line 3 like a hat; a whole rest hangs below line 4 like a hole. (Hat: half. Hole: whole.)",
        "二分休止符像帽子一样放在第三线上面；全休止符像洞一样挂在第四线下面。"),
        score: () => ({ clef: "treble", time: "4/4", notes: [{ duration: "half" }, { pitch: "G4", duration: "half" }, { duration: "whole" }] }), highlight: [{ note: 0 }, { note: 2 }], play: "all", tempo: 76 },
      { text: T("An eighth rest is half a beat of silence.", "八分休止符是半拍的安静。"),
        score: () => ({ clef: "treble", time: "4/4", notes: [{ pitch: "E5", duration: "eighth" }, { duration: "eighth" }, { pitch: "E5", duration: "eighth" }, { duration: "eighth" }, { pitch: "E5", duration: "half" }] }),
        highlight: [{ note: 1 }, { note: 3 }], play: "all", tempo: 76, symbol: "music.eighth-rest" },
    ],
  },
  {
    id: 6, slug: "time-signatures", title: T("Basic time signatures", "基本拍号"),
    steps: [
      { text: T("The time signature's top number is how many beats a bar has; the bottom number which note gets one beat (4 = a quarter note). 4/4: four quarter-note beats a bar.",
        "拍号的上面数字表示每小节有几拍，下面数字表示以什么音符为一拍（4 = 四分音符）。4/4拍：每小节四拍，以四分音符为一拍。"),
        score: () => ({ clef: "treble", time: "4/4", notes: ["C5", "G4", "G4", "G4", "C5", "G4", "G4", "G4"].map(pitch => ({ pitch, duration: "quarter" as const })) }), highlight: [{ time: true }], play: "all", tempo: 96 },
      { text: T("3/4: three beats a bar, strong-weak-weak, the waltz.", "3/4拍：每小节三拍，强、弱、弱，就是圆舞曲的拍子。"),
        score: () => ({ clef: "treble", time: "3/4", notes: ["C5", "G4", "G4", "C5", "G4", "G4"].map(pitch => ({ pitch, duration: "quarter" as const })) }), highlight: [{ time: true }], play: "all", tempo: 108 },
      { text: T("2/4: two beats a bar, strong-weak, a march.", "2/4拍：每小节两拍，强、弱，像进行曲。"),
        score: () => ({ clef: "treble", time: "2/4", notes: ["C5", "G4", "C5", "G4"].map(pitch => ({ pitch, duration: "quarter" as const })) }), highlight: [{ time: true }], play: "all", tempo: 100 },
      { text: T("6/8: six eighth notes a bar, felt as two beats of three.", "6/8拍：每小节六个八分音符，感觉上是两大拍，每拍三个八分音符。"),
        score: () => ({ clef: "treble", time: "6/8", notes: ["C5", "G4", "G4", "C5", "G4", "G4", "C5", "G4", "G4", "C5", "G4", "G4"].map(pitch => ({ pitch, duration: "eighth" as const })) }), highlight: [{ time: true }], play: "all", tempo: 132 },
    ],
  },
  {
    id: 7, slug: "c-major-scale", title: T("The C major scale", "C大调音阶"),
    steps: [
      { text: T("A scale climbs through every letter in order. The C major scale is all the white keys from C to C: C D E F G A B C.",
        "音阶就是按顺序经过每个音名。C大调音阶就是从C到C的所有白键：C D E F G A B C。"),
        score: language => notes("treble", cMajor, "quarter", p => language === "zh" ? SOLFEGE[parsePitch(p)!.letter] : letter(p)), play: "all", tempo: 92 },
      { text: T("Most steps are whole steps; two are half steps: E to F, and B to C. The pattern whole, whole, half, whole, whole, whole, half makes every major scale.",
        "大部分是全音，只有两个是半音：E到F，B到C。全、全、半、全、全、全、半，这个规律构成所有的大调音阶。"),
        score: () => notes("treble", cMajor, "quarter", p => letter(p)), highlight: [{ note: 2 }, { note: 3 }, { note: 6 }, { note: 7 }], play: [2, 3, 6, 7], tempo: 76 },
      { text: T("And down again, from C5 back to middle C.", "再从高音C下行回到中央C。"),
        score: () => notes("treble", [...cMajor].reverse(), "quarter", p => letter(p)), play: "all", tempo: 92 },
    ],
  },
  {
    id: 8, slug: "note-reading", title: T("Note-reading practice", "识谱练习"),
    steps: readingQuestions(8, "treble", 6).map((question, index): LessonStep => ({
      text: T(`Practice ${index + 1}: what is this note? (${describePosition(question.position)})`, `练习${index + 1}：这是什么音？（${describePosition(question.position, "zh")}）`),
      score: () => ({ clef: question.clef, notes: [{ pitch: question.pitch, duration: "whole" }] }), highlight: [{ note: 0 }],
      question: { clef: question.clef, index },
    })).concat(readingQuestions(8, "bass", 4).map((question, index): LessonStep => ({
      text: T(`Bass clef ${index + 1}: what is this note? (${describePosition(question.position)})`, `低音谱号${index + 1}：这是什么音？（${describePosition(question.position, "zh")}）`),
      score: () => ({ clef: question.clef, notes: [{ pitch: question.pitch, duration: "whole" }] }), highlight: [{ note: 0 }],
      question: { clef: question.clef, index },
    }))),
  },
];

export const lessonById = (id: number) => LESSONS.find(lesson => lesson.id === id) ?? null;

/** A lesson by number, slug or a few words ("clefs", "C major", "休止符"). */
export function findLesson(query: string | number): Lesson | null {
  if (typeof query === "number") return lessonById(query);
  const text = query.trim().toLowerCase();
  const number = /^(?:lesson\s*|第)?(\d)(?:课)?$/.exec(text);
  if (number) return lessonById(Number(number[1]));
  return LESSONS.find(lesson => lesson.slug === text || lesson.title.en.toLowerCase().includes(text) || lesson.title.zh.includes(query.trim())
    || text.split(/\s+/).every(word => word.length > 2 && `${lesson.slug} ${lesson.title.en.toLowerCase()}`.includes(word))) ?? null;
}

/** The clef name in a language, for lesson text. */
export const clefName = (clef: Clef, language: Language) => CLEF_NAMES[clef][language];
