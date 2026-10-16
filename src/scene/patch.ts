import { isSceneId, SELECTED, type SceneAnimation, type SceneDocument, type SceneNode, type Vec3 } from "./ir";
import { validateScene, type SceneErrorCode, type SceneStats } from "./validate";

/**
 * Scene patches (v0.5): the only way a scene changes after it was created. A patch is a short list of operations on
 * stable ids. It is transactional: every operation is applied to a copy, the result is validated as a whole document
 * (validate.ts), and only then does it replace the scene — a patch that fails anywhere changes nothing, and says which
 * operation failed and why. `"$selected"` in place of an id names the object the user selected in the card (resolved
 * from the card's reported selection before anything is applied).
 *
 *   add              { op, object }                    a new node (or `objects`: several)
 *   update           { op, id, set, unset? }           replace fields (material and metadata objects merge)
 *   transform        { op, id, position?, rotation?, scale?, translate?, rotateBy?, scaleBy? }
 *   remove           { op, id }                        the node, its descendants, and animations that need them
 *   reparent         { op, id, parent }                parent: an id, or null for the scene root
 *   material         { op, id, set }                   a shared material (created if new; else merged)
 *   add-animation    { op, animation }
 *   update-animation { op, id, set, unset? }           e.g. { paused: true } stops one motion where it is
 *   remove-animation { op, id }
 *   camera | environment | timeline | presentation    { op, set }
 *   meta             { op, title?, disclosure?, intent?, requirements? }
 */
export const PATCH_OPS = [
  "add", "update", "transform", "remove", "reparent", "material", "add-animation", "update-animation", "remove-animation",
  "camera", "environment", "timeline", "presentation", "meta",
] as const;
export type PatchOpName = typeof PATCH_OPS[number];
export type SceneOp = { op: PatchOpName } & Record<string, unknown>;

export const PATCH_LIMITS = { ops: 64 } as const;

export interface PatchContext {
  /** The object selected in the card now (for "$selected"). */
  selected?: string | null;
}

export type PatchResult =
  | { ok: true; document: SceneDocument; stats: SceneStats; changed: string[]; removed: string[]; summary: string }
  | { ok: false; code: SceneErrorCode | "invalid-patch" | "no-selection"; problem: string; op?: number };

class PatchProblem extends Error {
  constructor(readonly code: "invalid-patch" | "invalid-reference" | "no-selection", message: string) { super(message); }
}
const fail = (message: string, code: PatchProblem["code"] = "invalid-patch"): never => { throw new PatchProblem(code, message); };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const vec = (value: unknown, where: string): Vec3 => {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(v => typeof v === "number" && Number.isFinite(v))) fail(`${where} must be [x, y, z]`);
  return value as Vec3;
};

/** Fields a node's `set` may not change (the id is its identity; a new type is a new object: remove and add). */
const FROZEN = ["id", "type"];

/** Applies a patch to a document: the new document (validated) and what changed, or why nothing did. */
export function applyPatch(document: SceneDocument, ops: unknown, context: PatchContext = {}): PatchResult {
  if (!Array.isArray(ops) || ops.length === 0) return { ok: false, code: "invalid-patch", problem: "a patch is a list of 1 or more operations" };
  if (ops.length > PATCH_LIMITS.ops) return { ok: false, code: "resource-limit", problem: `at most ${PATCH_LIMITS.ops} operations in one patch` };
  const doc = structuredClone(document) as SceneDocument;
  const changed = new Set<string>(), removed = new Set<string>(), words: string[] = [];
  let index = 0;
  try {
    for (; index < ops.length; index++) {
      const op = ops[index] as Record<string, unknown>;
      if (!isRecord(op) || typeof op.op !== "string" || !(PATCH_OPS as readonly string[]).includes(op.op)) fail(`op must be one of ${PATCH_OPS.join(", ")}`);
      words.push(applyOp(doc, op as SceneOp, context, changed, removed));
    }
  } catch (error) {
    const problem = error instanceof Error ? error.message : "the patch failed";
    const code = error instanceof PatchProblem ? error.code : "invalid-patch";
    return { ok: false, code, problem: `operation ${index + 1}: ${problem}`, op: index };
  }
  const checked = validateScene(doc);
  if (!checked.ok) return { ok: false, code: checked.code, problem: `after the patch, ${checked.problem}` };
  return { ok: true, document: checked.document, stats: checked.stats, changed: [...changed].filter(id => !removed.has(id)), removed: [...removed], summary: summarize(words) };
}

function summarize(words: string[]): string {
  const unique = [...new Set(words)];
  const text = unique.slice(0, 4).join("; ") + (unique.length > 4 ? `; and ${unique.length - 4} more` : "");
  return text.slice(0, 160);
}

function resolveId(value: unknown, context: PatchContext, where = "id"): string {
  if (value === SELECTED) {
    if (!context.selected) fail("\"$selected\": nothing is selected in the card", "no-selection");
    return context.selected!;
  }
  if (!isSceneId(value)) fail(`${where} must be an object id or "$selected"`);
  return value as string;
}

const nodeOf = (doc: SceneDocument, id: string) => doc.objects.find(n => n.id === id) ?? fail(`no object "${id}"`, "invalid-reference");
const animationOf = (doc: SceneDocument, id: string) => (doc.animations ?? []).find(a => a.id === id) ?? fail(`no animation "${id}"`, "invalid-reference");

function setFields(target: Record<string, unknown>, set: unknown, unset: unknown, where: string, merge: readonly string[] = []) {
  if (set !== undefined && !isRecord(set)) fail(`${where}.set must be an object`);
  for (const [key, value] of Object.entries((set ?? {}) as Record<string, unknown>)) {
    if (FROZEN.includes(key)) fail(`${where}: ${key} cannot change (remove the object and add a new one)`);
    // Objects such as a node's own material or its metadata merge, so a colour change keeps the rest.
    if (merge.includes(key) && isRecord(value) && isRecord(target[key])) target[key] = { ...(target[key] as Record<string, unknown>), ...value };
    else target[key] = value;
  }
  if (unset !== undefined) {
    if (!Array.isArray(unset) || !unset.every(key => typeof key === "string")) fail(`${where}.unset must list field names`);
    for (const key of unset as string[]) { if (FROZEN.includes(key) || key === "target") fail(`${where}: ${key} cannot be removed`); delete target[key]; }
  }
}

const scaleOf = (scale: SceneNode["scale"]): Vec3 => scale === undefined ? [1, 1, 1] : typeof scale === "number" ? [scale, scale, scale] : [...scale] as Vec3;

function applyOp(doc: SceneDocument, op: SceneOp, context: PatchContext, changed: Set<string>, removed: Set<string>): string {
  const allow = (...keys: string[]) => { for (const key of Object.keys(op)) if (key !== "op" && !keys.includes(key)) fail(`${op.op} takes no "${key.slice(0, 24)}"`); };
  switch (op.op) {
    case "add": {
      allow("object", "objects");
      const list = op.objects !== undefined ? op.objects : [op.object];
      if (!Array.isArray(list) || !list.length || list.some(item => !isRecord(item))) fail("add needs object (or objects)");
      for (const item of list as Record<string, unknown>[]) {
        const node = { ...item };
        if (node.parent === SELECTED) node.parent = resolveId(SELECTED, context);
        if (doc.objects.some(n => n.id === node.id)) fail(`an object "${String(node.id)}" already exists (update it instead)`);
        doc.objects.push(node as unknown as SceneNode);
        if (typeof node.id === "string") changed.add(node.id);
      }
      return `add ${(list as { id?: unknown }[]).map(n => String(n.id)).join(", ")}`;
    }
    case "update": {
      allow("id", "set", "unset");
      const id = resolveId(op.id, context);
      const node = nodeOf(doc, id) as unknown as Record<string, unknown>;
      // Changing the colour of an object that uses a shared material gives it its own copy (the others keep theirs).
      const set = op.set as Record<string, unknown> | undefined;
      if (isRecord(set?.material) && typeof node.material === "string") {
        const shared = (doc.materials ?? []).find(m => m.id === node.material);
        if (shared) { const { id: _id, name: _name, ...props } = shared; node.material = props; }
      }
      setFields(node, set, op.unset, `update "${id}"`, ["material", "metadata"]);
      changed.add(id);
      return `update ${id} (${Object.keys(set ?? {}).concat((op.unset as string[] | undefined) ?? []).join(", ")})`;
    }
    case "transform": {
      allow("id", "position", "rotation", "scale", "translate", "rotateBy", "scaleBy");
      const id = resolveId(op.id, context);
      const node = nodeOf(doc, id);
      if (op.position !== undefined) node.position = vec(op.position, "position");
      if (op.rotation !== undefined) node.rotation = vec(op.rotation, "rotation");
      if (op.scale !== undefined) node.scale = typeof op.scale === "number" ? op.scale : vec(op.scale, "scale");
      if (op.translate !== undefined) { const t = vec(op.translate, "translate"), p = node.position ?? [0, 0, 0]; node.position = [p[0] + t[0], p[1] + t[1], p[2] + t[2]]; }
      if (op.rotateBy !== undefined) { const r = vec(op.rotateBy, "rotateBy"), q = node.rotation ?? [0, 0, 0]; node.rotation = [q[0] + r[0], q[1] + r[1], q[2] + r[2]]; }
      if (op.scaleBy !== undefined) {
        const by = typeof op.scaleBy === "number" ? [op.scaleBy, op.scaleBy, op.scaleBy] as Vec3 : vec(op.scaleBy, "scaleBy");
        if (by.some(v => v <= 0)) fail("scaleBy must be positive");
        const s = scaleOf(node.scale), next = [s[0] * by[0], s[1] * by[1], s[2] * by[2]] as Vec3;
        node.scale = next[0] === next[1] && next[1] === next[2] ? next[0] : next;
      }
      changed.add(id);
      return `transform ${id}`;
    }
    case "remove": {
      allow("id");
      const id = resolveId(op.id, context);
      nodeOf(doc, id);
      // The node and everything under it.
      const gone = new Set([id]);
      for (let grew = true; grew;) {
        grew = false;
        for (const n of doc.objects) if (n.parent && gone.has(n.parent) && !gone.has(n.id)) { gone.add(n.id); grew = true; }
      }
      doc.objects = doc.objects.filter(n => !gone.has(n.id));
      // Point clouds that lay along a removed path lose it only by failing validation: refuse instead of guessing.
      for (const n of doc.objects) if (n.particles?.path && gone.has(n.particles.path)) fail(`"${n.id}"'s particles lie along "${n.particles.path}": remove or change it first`, "invalid-reference");
      // Animations that need a removed object go with it.
      const needs = (a: SceneAnimation) => [a.target, typeof a.center === "string" ? a.center : undefined, a.path, a.lookAt].some(ref => ref !== undefined && gone.has(ref));
      const dropped = new Set((doc.animations ?? []).filter(needs).map(a => a.id));
      for (let grew = true; grew;) {
        grew = false;
        for (const a of doc.animations ?? []) if (a.type === "couple" && dropped.has(a.source!) && !dropped.has(a.id)) { dropped.add(a.id); grew = true; }
      }
      if (doc.animations) doc.animations = doc.animations.filter(a => !dropped.has(a.id));
      if (doc.camera?.frame) doc.camera.frame = doc.camera.frame.filter(f => !gone.has(f));
      if (doc.environment?.lightSource && gone.has(doc.environment.lightSource)) delete doc.environment.lightSource;
      for (const g of gone) removed.add(g);
      return `remove ${id}${gone.size > 1 ? ` (+${gone.size - 1})` : ""}`;
    }
    case "reparent": {
      allow("id", "parent");
      const id = resolveId(op.id, context);
      const node = nodeOf(doc, id);
      if (op.parent === null) delete node.parent;
      else { const parent = resolveId(op.parent, context, "parent"); nodeOf(doc, parent); node.parent = parent; }
      changed.add(id);
      return `reparent ${id}`;
    }
    case "material": {
      allow("id", "set");
      if (!isSceneId(op.id)) fail("material needs an id");
      if (!isRecord(op.set)) fail("material needs set");
      doc.materials ??= [];
      const existing = doc.materials.find(m => m.id === op.id);
      if (existing) Object.assign(existing, op.set);
      else doc.materials.push({ ...(op.set as object), id: op.id as string });
      for (const n of doc.objects) if (n.material === op.id) changed.add(n.id);
      return `material ${String(op.id)}`;
    }
    case "add-animation": {
      allow("animation");
      if (!isRecord(op.animation)) fail("add-animation needs animation");
      const animation = { ...(op.animation as Record<string, unknown>) };
      if (animation.target === SELECTED) animation.target = resolveId(SELECTED, context);
      if ((doc.animations ?? []).some(a => a.id === animation.id)) fail(`an animation "${String(animation.id)}" already exists`);
      (doc.animations ??= []).push(animation as unknown as SceneAnimation);
      if (typeof animation.target === "string") changed.add(animation.target);
      return `animate ${String(animation.target)} (${String(animation.type)})`;
    }
    case "update-animation": {
      allow("id", "set", "unset");
      const animation = animationOf(doc, String(op.id)) as unknown as Record<string, unknown>;
      if (isRecord(op.set) && "target" in op.set) fail("an animation's target cannot change (remove it and add a new one)");
      setFields(animation, op.set, op.unset, `update-animation "${String(op.id)}"`);
      changed.add(animation.target as string);
      const set = op.set as Record<string, unknown> | undefined;
      return set?.paused === true ? `stop ${String(op.id)}` : set?.paused === false ? `resume ${String(op.id)}` : `change ${String(op.id)}`;
    }
    case "remove-animation": {
      allow("id");
      const animation = animationOf(doc, String(op.id));
      if ((doc.animations ?? []).some(a => a.type === "couple" && a.source === animation.id)) fail(`"${animation.id}" drives another animation (remove that first)`, "invalid-reference");
      doc.animations = (doc.animations ?? []).filter(a => a.id !== animation.id);
      changed.add(animation.target);
      return `remove animation ${animation.id}`;
    }
    case "camera": case "environment": case "timeline": case "presentation": {
      allow("set", "unset");
      const key = op.op;
      const current = { ...((doc[key] ?? {}) as Record<string, unknown>) };
      setFields(current, op.set, op.unset, key);
      (doc as unknown as Record<string, unknown>)[key] = current;
      return key;
    }
    case "meta": {
      allow("title", "disclosure", "intent", "requirements");
      for (const key of ["title", "disclosure", "intent", "requirements"] as const) if (op[key] !== undefined) (doc as unknown as Record<string, unknown>)[key] = op[key];
      return "title and notes";
    }
  }
  return fail("unknown operation");
}
