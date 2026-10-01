import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { MARKETPLACE, PLUGIN_ROOT, REPO_ROOT, validatePluginPackage } from "./lib/pluginPackage";

/**
 * `npm run release`: the installable package for a version (e.g. v0.2.0), reproducible from source.
 *
 *   dist/aion-presence-v<version>.tar.gz     a ready local marketplace: no Node modules, no build needed
 *     aion-presence-v<version>/
 *       .agents/plugins/marketplace.json     the spirit-connect marketplace
 *       plugins/aion-presence/               the plugin, built runtime included
 *       scripts/install.mjs                  the one-command installer
 *       INSTALL.md  README.md  LICENSE notes
 *   dist/aion-presence-v<version>.tar.gz.sha256
 *
 * Install from the archive: extract it and run `node scripts/install.mjs` inside (or `codex plugin marketplace
 * add <dir>` then `codex plugin add aion-presence@spirit-connect`). It refuses to package a stale runtime or an
 * invalid plugin, and (with --tag vX.Y.Z) a tag that does not match the version.
 */
const version = (JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version: string }).version;
const tagIndex = process.argv.indexOf("--tag");
const tag = tagIndex > 0 ? process.argv[tagIndex + 1].replace(/^refs\/tags\//, "") : null;
if (tag && tag !== `v${version}`) { console.error(`✗ tag ${tag} does not match package version v${version}`); process.exit(1); }

execFileSync(process.execPath, ["--import", "tsx", join(REPO_ROOT, "scripts", "runtime-check.ts")], { stdio: "inherit", cwd: REPO_ROOT });
const errors = validatePluginPackage({ requireRuntime: true }).filter(issue => issue.level === "error");
if (errors.length) { for (const issue of errors) console.error(`✗ ${issue.where}: ${issue.message}`); process.exit(1); }

const name = `aion-presence-v${version}`;
const dist = join(REPO_ROOT, "dist");
const stage = join(dist, name);
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, ".agents", "plugins"), { recursive: true });
mkdirSync(join(stage, "scripts"), { recursive: true });
cpSync(MARKETPLACE, join(stage, ".agents", "plugins", "marketplace.json"));
cpSync(PLUGIN_ROOT, join(stage, "plugins", "aion-presence"), { recursive: true });
cpSync(join(REPO_ROOT, "scripts", "install.mjs"), join(stage, "scripts", "install.mjs"));
for (const file of ["INSTALL.md", "README.md"]) cpSync(join(REPO_ROOT, file), join(stage, file));

// A valid package once more, in place, before it is archived.
const staged = validatePluginPackage({ root: join(stage, "plugins", "aion-presence"), marketplace: join(stage, ".agents", "plugins", "marketplace.json"), requireRuntime: true })
  .filter(issue => issue.level === "error");
if (staged.length) { for (const issue of staged) console.error(`✗ staged ${issue.where}: ${issue.message}`); process.exit(1); }

// Reproducible archive: written here (ustar), sorted, with fixed owner, mode and time, so the same sources
// give the same bytes on every machine.
const archive = join(dist, `${name}.tar.gz`);
const gzipped = gzipSync(tarball(dist, name), { level: 9 });
gzipped[9] = 3; // the gzip header's OS byte differs between zlib builds (macOS 19, Linux 3): fix it
writeFileSync(archive, gzipped);
const sha = createHash("sha256").update(readFileSync(archive)).digest("hex");
writeFileSync(`${archive}.sha256`, `${sha}  ${name}.tar.gz\n`);
rmSync(stage, { recursive: true, force: true });
console.log(`✓ dist/${name}.tar.gz  (sha256 ${sha.slice(0, 16)}…)`);

/** A minimal ustar archive of `dir/name`: directories and regular files, sorted, owner 0, fixed time. */
function tarball(dir: string, name: string): Buffer {
  const MTIME = Math.floor(Date.UTC(2026, 0, 1) / 1000);
  const entries: { path: string; data: Buffer | null; mode: number }[] = [];
  const walk = (path: string) => {
    const rel = relative(dir, path).split(sep).join("/");
    if (statSync(path).isDirectory()) {
      entries.push({ path: `${rel}/`, data: null, mode: 0o755 });
      for (const child of readdirSync(path).sort()) walk(join(path, child));
    } else entries.push({ path: rel, data: readFileSync(path), mode: statSync(path).mode & 0o111 ? 0o755 : 0o644 });
  };
  walk(join(dir, name));
  const blocks: Buffer[] = [];
  const octal = (value: number, width: number) => `${value.toString(8).padStart(width - 1, "0")}\0`;
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    let path = entry.path, prefix = "";
    if (Buffer.byteLength(path) > 100) { const cut = path.lastIndexOf("/", path.length - 2); prefix = path.slice(0, cut); path = path.slice(cut + 1); }
    if (Buffer.byteLength(path) > 100 || Buffer.byteLength(prefix) > 155) throw new Error(`path too long for ustar: ${entry.path}`);
    header.write(path, 0); header.write(octal(entry.mode, 8), 100); header.write(octal(0, 8), 108); header.write(octal(0, 8), 116);
    header.write(octal(entry.data?.length ?? 0, 12), 124); header.write(octal(MTIME, 12), 136); header.write("        ", 148);
    header.write(entry.data ? "0" : "5", 156); header.write("ustar\0", 257); header.write("00", 263); header.write(prefix, 345);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header);
    if (entry.data) { blocks.push(entry.data); blocks.push(Buffer.alloc((512 - (entry.data.length % 512)) % 512)); }
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}
