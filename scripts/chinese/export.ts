import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ChinesePack } from "../../src/host/writing/chinesePack";
import { CHINESE_PACK_DIR } from "../../src/writing/hanzi/sources";
import { REPO_ROOT } from "../lib/pluginPackage";

/**
 * `npm run chinese:export -- <dir> [--check <upstream package dir>]`: writes every character of the Chinese Writing Pack
 * back out as the original hanzi-writer-data JSON file (<char>.json), byte for byte — the pack's data in its upstream,
 * editable form. With --check, compares each file to an extracted upstream package and fails on any difference.
 */
const args = process.argv.slice(2);
const out = args[0] && !args[0].startsWith("--") ? resolve(args[0]) : null;
const check = args.includes("--check") ? resolve(args[args.indexOf("--check") + 1]) : null;
if (!out && !check) { console.error("usage: npm run chinese:export -- <dir> [--check <upstream package dir>]"); process.exit(2); }
const pack = new ChinesePack(join(REPO_ROOT, CHINESE_PACK_DIR), { cache: 1 });
if (out) mkdirSync(out, { recursive: true });
const { readFileSync, existsSync } = await import("node:fs");
let count = 0, same = 0;
const differ: string[] = [];
const digest = createHash("sha256");
for (const char of pack.characters()) {
  const text = pack.upstreamText(char)!;
  digest.update(text);
  count++;
  if (out) writeFileSync(join(out, `${char}.json`), text);
  if (check) {
    const file = join(check, `${char}.json`);
    if (existsSync(file) && readFileSync(file, "utf8") === text) same++; else differ.push(char);
  }
}
console.log(`${count} characters${out ? ` written to ${out}` : ""}; sha256 of all texts ${digest.digest("hex")}`);
if (check) {
  console.log(`${same} identical to ${check}${differ.length ? `; differ: ${differ.join("")}` : ""}`);
  if (differ.length) process.exitCode = 1;
}
