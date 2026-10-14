import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { STROKE_PACKS, symbolSource, writingSequence } from "../../src/animation/stroke/registry";
import { REPO_ROOT } from "../lib/pluginPackage";

/**
 * `npm run writing:sheet [-- latin digits music math]`: every curated symbol on one sheet, drawn from the composer's own
 * output — strokes in order (colour by order), a dot at each start and an arrow at each end — for reviewing shapes,
 * proportions, start points and directions. Output: .e2e/writing/<pack>-sheet.png (and .html).
 */
const wanted = process.argv.slice(2);
const OUT = join(REPO_ROOT, ".e2e", "writing");
mkdirSync(OUT, { recursive: true });
const hues = ["#7fd3ff", "#ffd27a", "#9effa6", "#ff9ebd", "#c7a6ff", "#ffb37a"];
for (const pack of STROKE_PACKS.filter(p => !wanted.length || wanted.includes(p.system))) {
  const cells = pack.symbols.map(spec => {
    const seq = writingSequence(symbolSource(pack, spec));
    const P = (x: number, y: number) => `${(x * 100).toFixed(1)},${(-y * 100).toFixed(1)}`;
    const line = (pts: readonly number[]) => pts.reduce((d, v, i) => i % 2 ? d : `${d}${i ? "L" : "M"}${P(v, pts[i + 1])}`, "");
    const guides = seq.guides.map(g => `<path d="${line(g)}" stroke="#4a5868" stroke-width="0.8" fill="none"/>`).join("");
    const strokes = seq.strokes.map((s, i) => {
      const n = s.path.length;
      const [ex, ey, px, py] = [s.path[n - 2], s.path[n - 1], s.path[n - 4], s.path[n - 3]];
      const a = Math.atan2(ey - py, ex - px), h = 0.07;
      const arrow = `M${P(ex, ey)}L${P(ex - Math.cos(a - 0.5) * h, ey - Math.sin(a - 0.5) * h)}M${P(ex, ey)}L${P(ex - Math.cos(a + 0.5) * h, ey - Math.sin(a + 0.5) * h)}`;
      const c = hues[i % hues.length];
      return `<path d="${line(s.path)}" stroke="${c}" stroke-width="${(s.width[0] * 100).toFixed(1)}" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity="0.85"/>`
        + `<path d="${arrow}" stroke="#fff" stroke-width="1.4" fill="none"/><circle cx="${P(...s.startPoint).split(",")[0]}" cy="${P(...s.startPoint).split(",")[1]}" r="3.2" fill="#fff"/>`
        + `<text x="${(s.startPoint[0] * 100 - 9).toFixed(1)}" y="${(-s.startPoint[1] * 100 - 5).toFixed(1)}" fill="#fff" font-size="9">${i + 1}</text>`;
    }).join("");
    return `<figure><svg viewBox="-100 -100 200 200">${guides}${strokes}</svg><figcaption>${spec.symbol} · ${seq.strokes.map(s => s.direction).join(" / ")}</figcaption></figure>`;
  }).join("");
  const html = `<!doctype html><meta charset=utf-8><style>body{background:#0a0e15;color:#cfd8e3;font:11px system-ui;margin:12px}main{display:grid;grid-template-columns:repeat(8,1fr);gap:8px}figure{margin:0;background:#0f1520;border-radius:8px;padding:4px}svg{width:100%;display:block}figcaption{height:28px;overflow:hidden}</style><h3>${pack.system} — ${pack.convention}</h3><main>${cells}</main>`;
  const file = join(OUT, `${pack.system}-sheet.html`);
  writeFileSync(file, html);
  const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(`file://${file}`);
  await page.screenshot({ path: join(OUT, `${pack.system}-sheet.png`), fullPage: true });
  await browser.close();
  console.log(join(OUT, `${pack.system}-sheet.png`));
}
