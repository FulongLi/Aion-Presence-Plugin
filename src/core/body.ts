/**
 * Aion's body: which persistent visual form it occupies. Separate from identity (who Aion is) and state
 * (what it is doing).
 *
 *   persistent body     sphere | figure | eyes — stays until changed (set_body_form); what Aion rests as
 *   temporary visual    image, terrain, form, clock, emoji… — shown briefly, then the body returns to
 *                       whichever persistent body was active (see VisualActionController)
 *
 * The particle runtime renders the persistent body as a rest layer under every temporary visual, so a
 * visual always dissolves out of, and reforms into, the current body: figure → Orion → figure.
 */
export const AION_BODIES = ["sphere", "figure", "eyes"] as const;
export type AionBodyId = typeof AION_BODIES[number];
export const DEFAULT_BODY: AionBodyId = "sphere";

export interface PersistentBody {
  id: AionBodyId;
  label: string;
  /** For the model: what this body is. */
  description: string;
  /** Plain names a request may use, in English and Chinese (normalized: lower case, no punctuation). */
  aliases: readonly string[];
}

/**
 * The registered persistent bodies: three embodiments of the same Aion, each with its own purpose. The sphere is
 * abstract intelligence (it becomes visuals and information); the eyes are conversation, attention and
 * expression; the figure is gesture, explanation and demonstration. A future body is one entry here plus one rest
 * layer in the particle system; conversation, tools and prompts read this list and need no edit.
 */
export const PERSISTENT_BODIES: readonly PersistentBody[] = [
  {
    id: "sphere", label: "Sphere", description: "your original abstract body, a sphere of particles",
    aliases: ["sphere", "ball", "orb", "globe", "original", "default", "abstract", "球", "球体", "球形", "圆球", "原来的样子", "原形"],
  },
  {
    id: "figure", label: "Particle Figure", description: "a clean, articulated stick figure of particles, for gesture and explanation",
    aliases: ["figure", "particle figure", "stick figure", "human", "humanoid", "person", "human being", "body", "人形", "人", "人体", "人的样子", "小人", "火柴人"],
  },
  {
    id: "eyes", label: "Aion Eyes", description: "two expressive eyes of light, for conversation, attention and expression",
    aliases: ["eyes", "aion eyes", "eye", "your eyes", "face", "眼睛", "双眼", "眼", "你的眼睛"],
  },
];

/** Lower case, punctuation dropped, and the filler around a body name ("a", "the", "… form", "… shape"). */
const normalize = (value: string) => value.normalize("NFKC").toLowerCase()
  .replace(/[\s_\-.,!?'"“”‘’。，！？、]+/g, " ").trim()
  .replace(/^(?:a|an|the)\s+/, "").replace(/\s+(?:form|shape)$/, "");

export const isBodyId = (value: unknown): value is AionBodyId => typeof value === "string" && (AION_BODIES as readonly string[]).includes(value);

/** A body id or a plain name ("human form", "人形", "the sphere") → its id; anything else → null. */
export function resolveBodyForm(value: unknown): AionBodyId | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 40) return null;
  const name = normalize(value);
  if (isBodyId(name)) return name;
  return PERSISTENT_BODIES.find(body => body.aliases.some(alias => normalize(alias) === name))?.id ?? null;
}

export const bodyLabel = (id: AionBodyId) => PERSISTENT_BODIES.find(body => body.id === id)?.label ?? id;

export const bodyTransition = {
  /** Seconds for the particles to re-form from one persistent body into another. */
  seconds: 2.2,
};
const ease = (x: number) => Math.min(1, Math.max(0, x * x * x * (x * (x * 6 - 15) + 10)));

/**
 * The persistent body and its transition. Each body besides the sphere has a layer weight (the sphere is what is
 * left); the runtime blends the same particles between them, so any change — sphere → eyes, eyes → figure,
 * figure → sphere — reads as one body re-forming. `level` is the eased weight of the figure layer, `eyes` of the
 * eyes layer. The chosen body is remembered across temporary visuals and reconnects.
 */
export class AionBody {
  form: AionBodyId = DEFAULT_BODY;
  private readonly progress = { figure: 0, eyes: 0 };
  /** Eased weight of the figure layer. */
  level = 0;
  /** Eased weight of the eyes layer. */
  eyes = 0;

  /** Changes the persistent body. Returns false when it already is that body. */
  set(form: AionBodyId): boolean {
    if (!isBodyId(form) || form === this.form) return false;
    this.form = form;
    return true;
  }

  /** Whether the particles are still moving between bodies. */
  get transitioning() { return this.progress.figure !== (this.form === "figure" ? 1 : 0) || this.progress.eyes !== (this.form === "eyes" ? 1 : 0); }

  sample(elapsed: number) {
    const dt = Number.isFinite(elapsed) ? Math.max(0, Math.min(0.1, elapsed)) : 0;
    const step = dt / bodyTransition.seconds;
    for (const layer of ["figure", "eyes"] as const) {
      const goal = this.form === layer ? 1 : 0, value = this.progress[layer];
      this.progress[layer] = goal > value ? Math.min(goal, value + step) : Math.max(goal, value - step);
    }
    this.level = ease(this.progress.figure);
    this.eyes = ease(this.progress.eyes);
    return this.level;
  }
}
