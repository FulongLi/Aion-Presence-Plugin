import { z } from "zod";

/**
 * v0.7: the CAD command schema — every operation Codex may ask of the FreeCAD backend, with its arguments, validated here
 * (in the MCP server) before the worker sees them, and again by the worker against the live document. Lengths are
 * millimetres, angles degrees. Nothing here is code: an unknown action or an unexpected argument is refused with what
 * was expected. See docs/FREECAD.md and the aion-presence skill's FreeCAD reference.
 */
const mm = z.number().finite().gt(0).lt(100_000);
const coord = z.number().finite().gt(-100_000).lt(100_000);
const vec3 = z.tuple([coord, coord, coord]);
const ref = z.string().trim().min(1).max(80);
const name = z.string().trim().min(1).max(60);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "a #rrggbb colour");
const rotate = z.object({ axis: vec3.optional(), angle: z.number().finite().gt(-3600).lt(3600) }).strict();
const fcstd = z.string().max(1024).refine(path => /^(\/|[A-Za-z]:[\\/])/.test(path) && /\.fcstd$/i.test(path), "an absolute path ending in .FCStd");

const placed = { name: name.optional(), at: vec3.optional(), rotate: rotate.optional(), color: color.optional() };
const radiusOrDiameter = (v: { radius?: number; diameter?: number }) => (v.radius === undefined) !== (v.diameter === undefined);
const primitive = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("box"), length: mm, width: mm, height: mm, ...placed }).strict(),
  z.object({ kind: z.literal("cylinder"), radius: mm.optional(), diameter: mm.optional(), height: mm, ...placed }).strict(),
  z.object({ kind: z.literal("sphere"), radius: mm.optional(), diameter: mm.optional(), ...placed }).strict(),
  z.object({ kind: z.literal("cone"), radius1: z.number().finite().min(0).lt(100_000), radius2: z.number().finite().min(0).lt(100_000), height: mm, ...placed }).strict(),
]).refine(v => (v.kind !== "cylinder" && v.kind !== "sphere") || radiusOrDiameter(v), "give radius or diameter");

const profile = z.union([
  z.object({ rectangle: z.object({ x: coord.optional(), y: coord.optional(), width: mm, height: mm }).strict() }).strict(),
  z.object({ circle: z.object({ x: coord.optional(), y: coord.optional(), diameter: mm }).strict() }).strict(),
]);

export const CAD_ARGUMENTS = {
  status: z.object({}).strict(),
  create_document: z.object({ name: name.optional() }).strict(),
  open_document: z.object({ path: fcstd }).strict(),
  inspect: z.object({}).strict(),
  add_primitive: primitive,
  add_holes: z.object({
    target: ref, diameter: mm, depth: z.number().finite().min(0).lt(100_000).optional(),
    face: z.enum(["top", "bottom", "front", "back", "left", "right"]).optional(),
    corners: mm.optional(), positions: z.array(z.tuple([coord, coord])).min(1).max(32).optional(),
  }).strict().refine(v => (v.corners === undefined) !== (v.positions === undefined), "give corners (inset in mm) or positions ([[u, v], …])"),
  add_sketch: z.object({ name: name.optional(), plane: z.enum(["XY", "XZ", "YZ"]).optional(), offset: coord.optional(), profiles: z.array(profile).min(1).max(16) }).strict(),
  pad: z.object({ sketch: ref, length: mm, name: name.optional(), reversed: z.boolean().optional(), color: color.optional() }).strict(),
  pocket: z.object({ sketch: ref, target: ref, depth: mm.optional(), through: z.boolean().optional(), reversed: z.boolean().optional() }).strict()
    .refine(v => v.through === true || v.depth !== undefined, "give depth (mm) or through: true"),
  set_constraint: z.object({ sketch: ref, constraint: name, value: z.number().finite() }).strict(),
  boolean: z.object({ operation: z.enum(["union", "subtract", "intersect"]), base: ref, tool: ref, name: name.optional() }).strict(),
  fillet: z.object({ target: ref, radius: mm, edges: z.enum(["all", "vertical", "top", "bottom"]).optional(), name: name.optional() }).strict(),
  chamfer: z.object({ target: ref, size: mm, edges: z.enum(["all", "vertical", "top", "bottom"]).optional(), name: name.optional() }).strict(),
  set_parameter: z.object({ component: ref, parameter: name, value: z.number().finite().optional(), delta: z.number().finite().optional() }).strict()
    .refine(v => (v.value === undefined) !== (v.delta === undefined), "give value or delta"),
  transform: z.object({ component: ref, move: vec3.optional(), to: vec3.optional(), rotate: rotate.optional() }).strict()
    .refine(v => v.move || v.to || v.rotate, "give move, to and/or rotate"),
  set_visibility: z.object({ component: ref, visible: z.boolean() }).strict(),
  set_appearance: z.object({ component: ref, color: color.optional(), material: name.optional() }).strict()
    .refine(v => v.color || v.material, "give color and/or material"),
  delete: z.object({ component: ref }).strict(),
  undo: z.object({}).strict(),
  redo: z.object({}).strict(),
  save: z.object({ path: fcstd.optional(), overwrite: z.boolean().optional() }).strict(),
  export: z.object({ format: z.enum(["step", "stl"]), path: z.string().max(1024), overwrite: z.boolean().optional() }).strict(),
  open_in_freecad: z.object({}).strict(),
  reload: z.object({}).strict(),
  close: z.object({ discard: z.boolean().optional() }).strict(),
} as const;

export type CadAction = keyof typeof CAD_ARGUMENTS;
export const CAD_ACTIONS = Object.keys(CAD_ARGUMENTS) as [CadAction, ...CadAction[]];

/** Actions that need an open document (all but status, create and open). */
export const NEEDS_DOCUMENT = new Set<CadAction>(CAD_ACTIONS.filter(a => !["status", "create_document", "open_document"].includes(a)));
/** Actions that change the model (they take `revision`, and the viewer follows). */
export const CHANGES_MODEL = new Set<CadAction>(["add_primitive", "add_holes", "add_sketch", "pad", "pocket", "set_constraint", "boolean", "fillet", "chamfer",
  "set_parameter", "transform", "set_visibility", "set_appearance", "delete", "undo", "redo"]);

/** Argument names that refer to a component: "$selected" there means the component selected in the CAD viewer. */
export const COMPONENT_FIELDS = ["component", "target", "base", "tool", "sketch"] as const;

/** The worker's operation for an action (the same name, except opening the FreeCAD application). */
export const WORKER_OP: Partial<Record<CadAction, string>> = { open_in_freecad: "handoff" };

/** Validates one action's arguments: the cleaned arguments, or a message listing what is wrong. */
export function checkCadArguments(action: CadAction, args: unknown): { ok: true; args: Record<string, unknown> } | { ok: false; problem: string } {
  const parsed = CAD_ARGUMENTS[action].safeParse(args ?? {});
  if (parsed.success) return { ok: true, args: parsed.data as Record<string, unknown> };
  const problems = parsed.error.issues.slice(0, 6).map(issue => `${issue.path.length ? issue.path.join(".") : "args"}: ${issue.message}`);
  return { ok: false, problem: problems.join("; ") };
}
