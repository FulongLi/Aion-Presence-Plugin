import { validateManifest, type CardAppManifest } from "./manifest";
import { EARTH_MOON_MANIFEST } from "./apps/earthMoon.manifest";
import { CAD_VIEWER_MANIFEST } from "./apps/cadViewer.manifest";
import { GENERATIVE_SCENE_MANIFEST } from "./apps/generativeScene.manifest";

/**
 * The Application Registry (v0.4.5): the only applications an interactive card may run. Registering validates the
 * manifest (src/cards/manifest.ts); nothing that is not registered can be launched, by Codex or by anything else. A
 * future application (a circuit simulation, a waveform viewer) is a manifest here and a module in the card runtime
 * (src/cards/runtime/apps.ts) — the presentation engine, the bridge and the MCP tools do not change.
 */
export class CardRegistry {
  private readonly apps = new Map<string, CardAppManifest>();

  constructor(private readonly checkHybrid: (scene: unknown) => boolean = () => true) {}

  /** Registers an application; throws with every problem when its manifest is invalid or its id is taken. */
  register(input: unknown): CardAppManifest {
    const checked = validateManifest(input, this.checkHybrid);
    if (!checked.ok) throw new Error(`card-manifest-invalid: ${checked.problems.join("; ")}`);
    if (this.apps.has(checked.manifest.id)) throw new Error(`card-app-duplicate: ${checked.manifest.id}`);
    const manifest = Object.freeze(structuredClone(checked.manifest));
    this.apps.set(manifest.id, manifest);
    return manifest;
  }

  get(id: string): CardAppManifest | undefined { return this.apps.get(id); }
  has(id: string): boolean { return this.apps.has(id); }
  ids(): string[] { return [...this.apps.keys()]; }
  list(): CardAppManifest[] { return [...this.apps.values()]; }
}

/** The applications Aion ships with. */
export const BUILTIN_CARD_APPS: readonly CardAppManifest[] = [EARTH_MOON_MANIFEST, CAD_VIEWER_MANIFEST, GENERATIVE_SCENE_MANIFEST];
export const CARD_APP_IDS = BUILTIN_CARD_APPS.map(app => app.id) as [string, ...string[]];

/** A registry with the built-in applications (the host passes the 3D scene validator for their body forms). */
export function defaultCardRegistry(checkHybrid?: (scene: unknown) => boolean): CardRegistry {
  const registry = new CardRegistry(checkHybrid);
  for (const app of BUILTIN_CARD_APPS) registry.register(app);
  return registry;
}
