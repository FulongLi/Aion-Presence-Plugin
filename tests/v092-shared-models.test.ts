import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ASSETS_DIR, tempHome } from "./helpers";
import { ModelLibrary, SIDECAR_SUFFIX } from "../src/host/models/library";
import { ModelService } from "../src/host/models/service";
import { sharedModelsDir } from "../src/host/paths";

const MODELS = join(ASSETS_DIR, "models");
const LUMEN = join(MODELS, "originals", "lumen.glb");
const FOX = join(MODELS, "khronos", "fox.glb");
/** Distinct, increasing modification times: a test never depends on the file system's clock resolution. */
let clock = Date.parse("2026-01-01T00:00:00Z") / 1000;
const touch = (path: string) => { clock += 10; utimesSync(path, clock, clock); };
const put = (dir: string, name: string, from: string, sidecar?: unknown) => {
  copyFileSync(from, join(dir, name)); touch(join(dir, name));
  if (sidecar !== undefined) { writeFileSync(join(dir, `${name}${SIDECAR_SUFFIX}`), typeof sidecar === "string" ? sidecar : JSON.stringify(sidecar)); touch(join(dir, `${name}${SIDECAR_SUFFIX}`)); }
};
const user = async (library: ModelLibrary) => (await library.registry()).all().filter(e => e.manifest.availability === "local");

test("shared models folder: outside every host's data directory, overridable, isolated under a development home", () => {
  assert.equal(sharedModelsDir({}), join(homedir(), ".aion-presence", "my-models"));
  assert.equal(sharedModelsDir({ PLUGIN_DATA: "/codex/data/aion" }), join(homedir(), ".aion-presence", "my-models"), "the same folder whichever host runs Aion");
  assert.equal(sharedModelsDir({ AION_PRESENCE_HOME: "/tmp/dev" }), join("/tmp/dev", "my-models"));
  assert.equal(sharedModelsDir({ AION_MODELS_DIR: "/Volumes/models", AION_PRESENCE_HOME: "/tmp/dev" }), "/Volumes/models");
});

test("shared models folder: imported automatically with the sidecar's rights, seen by every install, followed when it changes", async () => {
  const shared = join(tempHome(), "my-models");
  mkdirSync(shared, { recursive: true });
  put(shared, "critter.glb", LUMEN, { name: "Critter", category: "creature", underlyingIp: "third-party", ipOwner: "Example Studio", notes: "Fan likeness for private use." });
  const codex = new ModelLibrary({ home: tempHome(), assetsDir: ASSETS_DIR, shared });
  const [critter] = await user(codex);
  assert.equal(critter.manifest.id, "my-critter");
  assert.equal(critter.manifest.name, "Critter");
  assert.equal(critter.manifest.category, "creature");
  assert.equal(critter.manifest.availability, "local", "never redistributable: the user's folder is not part of the plugin");
  assert.equal(critter.manifest.rights.underlyingIp, "third-party");
  assert.equal(critter.manifest.rights.ipOwner, "Example Studio");
  assert.equal(critter.manifest.rights.redistributionVerified, false);
  assert.ok(critter.installed);
  assert.equal((await codex.particles("my-critter", "low")).count, 12_000, "it becomes particles like any import");

  // A second install (another host, its own data directory) finds the same model: one copy serves both.
  const other = new ModelLibrary({ home: tempHome(), assetsDir: ASSETS_DIR, shared });
  assert.deepEqual((await user(other)).map(e => e.manifest.id), ["my-critter"]);

  // Nothing changed: nothing is imported again (a later process reads the same library).
  const again = new ModelLibrary({ home: (codex as unknown as { root: string }).root.replace(/\/models$/, ""), assetsDir: ASSETS_DIR, shared });
  assert.deepEqual((await user(again)).map(e => e.manifest.id), ["my-critter"]);

  // The sidecar changes: re-imported under the same id with the new words.
  writeFileSync(join(shared, `critter.glb${SIDECAR_SUFFIX}`), JSON.stringify({ name: "Critter", category: "creature", underlyingIp: "third-party", notes: "Updated note." }));
  touch(join(shared, `critter.glb${SIDECAR_SUFFIX}`));
  assert.equal((await user(codex))[0].manifest.rights.notes, "Updated note.");

  // The file is replaced by another model: same id, the new model (its animations).
  put(shared, "critter.glb", FOX);
  const replaced = await user(codex);
  assert.deepEqual(replaced.map(e => e.manifest.id), ["my-critter"]);
  assert.deepEqual((await codex.particles("my-critter", "low")).info.animations, ["Survey", "Walk", "Run"]);

  // Added in a sub-folder; then the first is deleted: gone from the library with its file.
  mkdirSync(join(shared, "pets"));
  put(shared, "pets/blob.glb", LUMEN);
  assert.deepEqual((await user(codex)).map(e => e.manifest.id).sort(), ["my-blob", "my-critter"]);
  rmSync(join(shared, "critter.glb"));
  assert.deepEqual((await user(codex)).map(e => e.manifest.id), ["my-blob"]);
  await assert.rejects(codex.particles("my-critter", "low"), /model-not-installed/);
});

test("shared models folder: a bad file or sidecar is reported, the rest still load; a missing folder empties nothing", async () => {
  const home = tempHome(), shared = join(home, "my-models");
  mkdirSync(shared, { recursive: true });
  put(shared, "good.glb", LUMEN);
  writeFileSync(join(shared, "broken.glb"), "glTF not really"); touch(join(shared, "broken.glb"));
  put(shared, "typo.glb", FOX, { nmae: "Typo" });
  put(shared, "notjson.glb", FOX, "{ nope");
  writeFileSync(join(shared, "notes.txt"), "ignored");
  const library = new ModelLibrary({ home, assetsDir: ASSETS_DIR, shared });
  assert.deepEqual((await user(library)).map(e => e.manifest.id), ["my-good"]);
  const problems = library.sharedProblems.join("\n");
  assert.match(problems, /broken\.glb: model-invalid/);
  assert.match(problems, /typo\.glb: sidecar-invalid/);
  assert.match(problems, /notjson\.glb: sidecar-invalid: notjson\.glb\.aion\.json is not valid JSON/);
  const found = await new ModelService(library).handle({ action: "find" }, null);
  assert.equal(found.kind, "text");
  assert.ok(found.message.includes(`own models folder (imported automatically, kept on this machine): ${shared}`));
  assert.match(found.message, /Not imported from it: .*broken\.glb/);

  rmSync(shared, { recursive: true });
  assert.deepEqual((await user(library)).map(e => e.manifest.id), ["my-good"], "an absent (unmounted) folder removes nothing");
});

test("shared models folder: a model already imported by hand is adopted, not duplicated; concurrent requests import once", async () => {
  const home = tempHome(), shared = join(home, "my-models"), downloads = join(home, "downloads");
  mkdirSync(downloads, { recursive: true });
  copyFileSync(LUMEN, join(downloads, "lumen-copy.glb"));
  const byHand = new ModelLibrary({ home, assetsDir: ASSETS_DIR });
  await byHand.importFile(join(downloads, "lumen-copy.glb"), { name: "Lumen copy" });
  mkdirSync(shared);
  put(shared, "glow.glb", LUMEN, { name: "Glow", category: "creature" });
  const library = new ModelLibrary({ home, assetsDir: ASSETS_DIR, shared });
  const [one, two] = await Promise.all([library.registry(), library.registry()]);
  for (const registry of [one, two]) assert.equal(registry.all().filter(e => e.manifest.availability === "local").length, 1, "both requests waited for one import");
  const entries = await user(library);
  assert.deepEqual(entries.map(e => e.manifest.id), ["my-lumen-copy"], "the same file is one entry");
  assert.equal(entries[0].manifest.name, "Glow", "the folder's sidecar now describes it");
  const removal = await new ModelService(library).handle({ action: "remove", model: "my-lumen-copy" }, null);
  assert.equal(removal.kind, "error");
  assert.match(removal.message, /model-in-folder: .*glow\.glb/, "removing it from the library alone would not last: the folder is the source");
  rmSync(join(shared, "glow.glb"));
  assert.deepEqual(await user(library), [], "and the folder owns it: deleting the file removes it");
});
