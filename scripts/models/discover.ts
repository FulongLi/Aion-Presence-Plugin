/**
 * Catalogue discovery (v0.9): finds downloadable models of a list of subjects through Sketchfab's public Data API search
 * (https://api.sketchfab.com/v3/search — no account, no token, no download) and records each as a *catalogued reference*:
 * title, author, URL, formats, size, licence and what it permits, the rights of the depicted design, and the date checked.
 * Nothing is downloaded. Requests are sequential and paced (one every 1.5 s by default) and identify the client.
 *
 *   npm run models:discover -- --set pokemon [--limit 3] [--only pikachu,eevee] [--out <file>]
 *
 * The Pokémon set writes plugins/aion-presence/assets/models/catalogue/pokemon.json: fan-made models of characters whose
 * design belongs to Nintendo / Creatures Inc. / GAME FREAK inc. (The Pokémon Company). Their Creative Commons licences
 * cover the modellers' work only, so every entry is `catalogued`, never redistributable, and models that look extracted
 * from a game are marked restricted.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelLibrary } from "../../src/host/models/library";
import { MODEL_SCHEMA, validateManifest, type ModelManifest } from "../../src/visual/models/manifest";
import { normalizeName } from "../../src/visual/models/registry";
import { POKEMON } from "./pokemon";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const set = option("set") ?? "pokemon";
const limit = Number(option("limit") ?? 3);
const pace = Number(option("pace") ?? 1500);
const only = option("only")?.split(",").map(normalizeName);
const out = option("out") ?? join(root, "plugins/aion-presence/assets/models/catalogue", `${set}.json`);
if (set !== "pokemon") throw new Error("Only the pokemon set is defined (scripts/models/pokemon.ts).");

const USER_AGENT = "AionPresence-ModelCatalogue/0.9 (+https://github.com/FulongLi/Aion-Presence-Plugin)";
const IP_OWNER = "Nintendo / Creatures Inc. / GAME FREAK inc. (The Pokémon Company)";
/** Names, tags or descriptions that suggest a model was extracted from a commercial game. */
const RIP = /\b(ssbb|ssb4|ssbu|smash ?bros|brawl|ripped|game ?rip|rip(?:ped)? from|models?[- ]resource|extracted|pok[eé]mon ?(go|masters|unite|stadium|colosseum|snap|rumble|sleep|home|xd)|x ?and ?y|oras|sun ?(and|&) ?moon|usum|sword ?(and|&) ?shield|let'?s ?go|scarlet|violet|legends ?arceus|bdsp|from the game|in-game model|game model|3ds model)\b/i;

interface SketchfabModel {
  uid: string; name: string; viewerUrl: string; isDownloadable: boolean; publishedAt?: string; faceCount?: number; vertexCount?: number; animationCount?: number;
  likeCount?: number; description?: string; tags?: { name: string }[];
  user: { username: string; displayName?: string; profileUrl?: string };
  license?: { label?: string } | null;
  archives?: Record<string, { size?: number | null; textureCount?: number | null } | undefined>;
}

const LICENCES: Record<string, { id: string; label: string; url: string; modification: "yes" | "no"; redistribution: "yes" | "no"; commercial: "yes" | "no" }> = {
  "CC Attribution": { id: "CC-BY-4.0", label: "CC BY 4.0", url: "https://creativecommons.org/licenses/by/4.0/", modification: "yes", redistribution: "yes", commercial: "yes" },
  "CC Attribution-ShareAlike": { id: "CC-BY-SA-4.0", label: "CC BY-SA 4.0", url: "https://creativecommons.org/licenses/by-sa/4.0/", modification: "yes", redistribution: "yes", commercial: "yes" },
  "CC Attribution-NoDerivs": { id: "CC-BY-ND-4.0", label: "CC BY-ND 4.0", url: "https://creativecommons.org/licenses/by-nd/4.0/", modification: "no", redistribution: "yes", commercial: "yes" },
  "CC Attribution-NonCommercial": { id: "CC-BY-NC-4.0", label: "CC BY-NC 4.0", url: "https://creativecommons.org/licenses/by-nc/4.0/", modification: "yes", redistribution: "yes", commercial: "no" },
  "CC Attribution-NonCommercial-ShareAlike": { id: "CC-BY-NC-SA-4.0", label: "CC BY-NC-SA 4.0", url: "https://creativecommons.org/licenses/by-nc-sa/4.0/", modification: "yes", redistribution: "yes", commercial: "no" },
  "CC Attribution-NonCommercial-NoDerivs": { id: "CC-BY-NC-ND-4.0", label: "CC BY-NC-ND 4.0", url: "https://creativecommons.org/licenses/by-nc-nd/4.0/", modification: "no", redistribution: "yes", commercial: "no" },
  "CC0 Public Domain": { id: "CC0-1.0", label: "CC0 1.0", url: "https://creativecommons.org/publicdomain/zero/1.0/", modification: "yes", redistribution: "yes", commercial: "yes" },
  // Sketchfab's own licence: use in a project, no redistribution of the model itself.
  "Free Standard": { id: "Sketchfab-Free-Standard", label: "Sketchfab Free Standard", url: "https://sketchfab.com/licenses", modification: "yes", redistribution: "no", commercial: "yes" },
};

const today = new Date().toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const slug = (value: string) => normalizeName(value).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const clip = (value: string, max: number) => value.replace(/\s+/g, " ").trim().slice(0, max) || "untitled";

async function search(query: string): Promise<SketchfabModel[]> {
  const url = `https://api.sketchfab.com/v3/search?type=models&downloadable=true&count=24&q=${encodeURIComponent(query)}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    if (response.status === 429) { await sleep(30_000 * (attempt + 1)); continue; }
    if (!response.ok) throw new Error(`search ${query}: HTTP ${response.status}`);
    const body = await response.json() as { results?: SketchfabModel[] };
    return body.results ?? [];
  }
  throw new Error(`search ${query}: rate limited`);
}

function entry(model: SketchfabModel, subject: { name: string; dex: number; aliases: string[] }): ModelManifest | null {
  const licence = LICENCES[model.license?.label ?? ""];
  if (!licence) return null;
  const text = `${model.name} ${model.description ?? ""} ${(model.tags ?? []).map(t => t.name).join(" ")}`;
  const rip = RIP.test(text);
  const glb = model.archives?.glb;
  const formats = Object.entries(model.archives ?? {}).filter(([, value]) => value).map(([key]) => key).filter(key => /^[a-z0-9]{2,8}$/.test(key));
  return {
    schema: MODEL_SCHEMA,
    // Sketchfab ids are hexadecimal or (newer) mixed-case base 62; the catalogue id keeps 10 of their characters, lowercased.
    id: `pokemon-${slug(subject.name)}-${model.uid.replace(/[^A-Za-z0-9]/g, "").toLowerCase().slice(0, 10)}`,
    name: subject.name,
    aliases: [...new Set([clip(model.name, 60), `#${String(subject.dex).padStart(4, "0")}`, ...subject.aliases])].slice(0, 16),
    category: "character",
    franchise: "Pokémon",
    subject: slug(subject.name),
    source: {
      site: "Sketchfab", url: `https://sketchfab.com/3d-models/${model.uid}`, title: clip(model.name, 120), author: clip(model.user.displayName || model.user.username, 160),
      ...(model.user.profileUrl?.startsWith("https://") ? { authorUrl: model.user.profileUrl } : {}),
      formats: formats.length ? formats : ["glb"],
      ...(model.publishedAt ? { published: model.publishedAt.slice(0, 10) } : {}),
    },
    licence: {
      id: licence.id, label: licence.label, url: licence.url,
      attribution: clip(`"${model.name}" by ${model.user.displayName || model.user.username} (Sketchfab) · ${licence.label}`, 240),
      modification: licence.modification, redistribution: licence.redistribution, commercial: licence.commercial,
    },
    rights: {
      underlyingIp: "third-party", ipOwner: IP_OWNER, redistributionVerified: false, extractedGameAsset: rip ? "suspected" : "no",
      notes: rip
        ? "Restricted: the title, tags or description suggest a model extracted from a commercial game. Not to be imported."
        : "Fan-made model of a franchise character: the licence covers the modeller's work, not the character's design. Catalogued as a reference only.",
    },
    availability: "catalogued",
    download: { available: model.isDownloadable, method: "sketchfab-download-api", requiresAccount: true, status: "not-downloaded", ...(glb?.size ? { bytes: glb.size } : {}) },
    checked: today,
    stats: {
      ...(model.faceCount ? { triangles: model.faceCount } : {}), ...(model.vertexCount ? { vertices: model.vertexCount } : {}),
      ...(glb?.textureCount !== undefined && glb?.textureCount !== null ? { textures: glb.textureCount } : {}), animations: model.animationCount ?? 0,
    },
  };
}

const previous: ModelManifest[] = (() => { try { return JSON.parse(readFileSync(out, "utf8")).entries as ModelManifest[]; } catch { return []; } })();
const kept = new Map(previous.map(e => [e.id, e]));
let searched = 0, found = 0, saved = 0;
const empty: string[] = [];
const save = () => {
  const entries = [...kept.values()].sort((a, b) => (POKEMON.findIndex(p => slug(p.name) === a.subject) - POKEMON.findIndex(p => slug(p.name) === b.subject)) || a.id.localeCompare(b.id));
  writeFileSync(out, ModelLibrary.catalogueText("Pokémon model references (catalogued only)", entries,
    "Fan-made Pokémon models found through Sketchfab's public search API. References only: no file is bundled or downloaded. The characters' designs belong to Nintendo / Creatures Inc. / GAME FREAK inc. (The Pokémon Company); each modeller's licence covers their own work only. A user may download a model under its terms for private use and import it into their own library."));
  return entries;
};
for (const subject of POKEMON) {
  if (only && !only.includes(normalizeName(subject.name))) continue;
  const wanted = normalizeName(subject.name);
  let results: SketchfabModel[];
  try { results = await search(`${subject.name} pokemon`); } catch (error) { console.warn(String(error)); await sleep(pace); continue; }
  searched++;
  // The model's own name must name the character (a word of it), not a scene or a different Pokémon that mentions it.
  const matching = results.filter(model => {
    const name = normalizeName(model.name);
    return model.isDownloadable && (name === wanted || name.split(" ").includes(wanted) || (wanted.includes(" ") && name.includes(wanted)));
  });
  const ranked = matching.map(model => ({ model, score: (model.archives?.glb ? 2 : 0) + (normalizeName(model.name) === wanted ? 3 : 0) + Math.log10(1 + (model.likeCount ?? 0))
    - ((model.faceCount ?? 0) > 400_000 ? 3 : 0) - (RIP.test(`${model.name} ${model.description ?? ""}`) ? 1 : 0) }))
    .sort((a, b) => b.score - a.score).slice(0, limit);
  for (const { model } of ranked) {
    const record = entry(model, subject);
    // The same author's same-titled model uploaded again is one model (a duplicate), not another reference.
    if (record && [...kept.values()].some(e => e.id !== record.id && normalizeName(e.source.author) === normalizeName(record.source.author) && normalizeName(e.source.title) === normalizeName(record.source.title))) continue;
    const checked = record ? validateManifest(record) : null;
    if (checked?.ok) { kept.set(checked.manifest.id, checked.manifest); found++; }
    else if (checked) console.warn(`\n  skipped ${model.uid} (${model.name}): ${checked.problem}`);
  }
  if (!ranked.length) empty.push(subject.name);
  process.stdout.write(`${subject.name}: ${ranked.length}  `);
  if (++saved % 10 === 0) save();
  await sleep(pace);
}
const entries = save();
console.log(`\n${searched} searches, ${found} references written (${entries.length} in the catalogue, ${new Set(entries.map(e => e.subject)).size} characters). No match: ${empty.join(", ") || "none"}.`);
