import { z } from "zod";
import { SIDES, type FaceSelector } from "../../sim/geometry";
import { ANALYSES, CONDITION_TYPES, faceSelectorSchema, MESH_SIZES } from "../../sim/study";

/**
 * v0.8: the `simulate` command schema — every operation Codex may ask of the simulation backend, with its arguments,
 * validated here before anything runs (and the study is checked again before a solve). Quantities take a unit ("10 V",
 * "25 °C", "10 W/(m2*K)"); a bare number is the SI unit (millimetres for lengths). Nothing here is code or solver input:
 * the Elmer and Gmsh files are generated from the validated study. See docs/SIMULATION.md and the skill's simulation
 * reference.
 */
const ref = z.string().trim().min(1).max(80);
const quantity = z.union([z.number().finite(), z.string().trim().min(1).max(40), z.object({ value: z.number().finite(), unit: z.string().max(24).optional() }).strict()]);
const bodies = z.union([z.literal("all"), ref, z.array(ref).min(1).max(64)]);
/** Faces: a selector object, a side ("left"), "$selected" (the face picked in the Simulation Card), "remaining", "exterior", "feature:Hole1" or face numbers. */
export const facesArgument = z.union([
  faceSelectorSchema, z.enum(SIDES), z.literal("$selected"), z.literal("remaining"), z.literal("exterior"),
  z.string().regex(/^feature:.{1,80}$/), z.array(z.number().int().min(1).max(100_000)).min(1).max(500), z.number().int().min(1).max(100_000),
]);
export type FacesArgument = z.infer<typeof facesArgument>;

export const SIM_ARGUMENTS = {
  status: z.object({}).strict(),
  list: z.object({}).strict(),
  create: z.object({ name: z.string().trim().min(1).max(80).optional(), analysis: z.enum(ANALYSES), document: z.string().max(40).optional(), bodies: z.array(ref).min(1).max(64).optional() }).strict(),
  open: z.object({}).strict(),
  inspect: z.object({ faces: z.boolean().optional() }).strict(),
  set_physics: z.object({
    analysis: z.enum(ANALYSES).optional(), reference_temperature: quantity.optional(), linear: z.enum(["iterative", "direct"]).optional(),
    tolerance: z.number().finite().gt(0).lt(1e-3).optional(), timeout_s: z.number().int().min(10).max(7200).optional(),
  }).strict().refine(v => Object.keys(v).length > 0, "give something to change"),
  set_material: z.object({
    bodies, material: z.string().trim().min(1).max(60).optional(), name: z.string().trim().min(1).max(60).optional(),
    conductivity: quantity.optional(), resistivity: quantity.optional(), thermal_conductivity: quantity.optional(), density: quantity.optional(),
    insulator: z.boolean().optional(),
  }).strict().refine(v => v.material || v.conductivity !== undefined || v.resistivity !== undefined || v.thermal_conductivity !== undefined, "give a material (library name) or its properties")
    .refine(v => v.conductivity === undefined || v.resistivity === undefined, "give conductivity or resistivity, not both"),
  set_boundary: z.object({
    name: z.string().trim().min(1).max(60).optional(), faces: facesArgument, type: z.enum(CONDITION_TYPES),
    voltage: quantity.optional(), current: quantity.optional(), temperature: quantity.optional(), h: quantity.optional(), ambient: quantity.optional(),
    flux: quantity.optional(), power: quantity.optional(), replace: z.string().max(20).optional(),
  }).strict(),
  set_source: z.object({ bodies, power_density: quantity.optional(), power: quantity.optional() }).strict()
    .refine(v => (v.power_density === undefined) !== (v.power === undefined), "give power_density (W/m3) or power (W)"),
  remove: z.object({ id: z.string().trim().min(1).max(20) }).strict(),
  set_mesh: z.object({
    size: z.enum(MESH_SIZES).optional(), max_mm: z.number().finite().gt(0).lt(100_000).optional(), min_mm: z.number().finite().gt(0).lt(100_000).optional(),
    curvature: z.number().int().min(4).max(64).optional(), order: z.union([z.literal(1), z.literal(2)]).optional(),
    refine: z.object({ faces: facesArgument.optional(), bodies: bodies.optional(), size_mm: z.number().finite().gt(0).lt(100_000) }).strict()
      .refine(v => v.faces !== undefined || v.bodies !== undefined, "refine faces or bodies").optional(),
    clear_refinement: z.boolean().optional(), auto: z.boolean().optional(),
  }).strict().refine(v => Object.keys(v).length > 0, "give something to change"),
  mesh: z.object({}).strict(),
  validate: z.object({}).strict(),
  run: z.object({ wait_s: z.number().min(0).max(50).optional() }).strict(),
  results: z.object({ run: z.number().int().min(1).optional(), probe: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]).optional() }).strict(),
  show: z.object({ run: z.number().int().min(1).optional(), setup: z.boolean().optional(), field: z.string().max(40).optional() }).strict(),
  sync: z.object({}).strict(),
  compare: z.object({ runs: z.tuple([z.number().int().min(1), z.number().int().min(1)]).optional() }).strict(),
} as const;

export type SimAction = keyof typeof SIM_ARGUMENTS;
export const SIM_ACTIONS = Object.keys(SIM_ARGUMENTS) as [SimAction, ...SimAction[]];

export function checkSimArguments(action: SimAction, args: unknown): { ok: true; args: Record<string, unknown> } | { ok: false; problem: string } {
  const parsed = SIM_ARGUMENTS[action].safeParse(args ?? {});
  if (parsed.success) return { ok: true, args: parsed.data as Record<string, unknown> };
  return { ok: false, problem: parsed.error.issues.slice(0, 6).map(i => `${i.path.length ? i.path.join(".") : "args"}: ${i.message}`).join("; ") };
}

/** A faces argument as a selector ("$selected" must have been resolved to face numbers by then). */
export function toSelector(faces: FacesArgument): FaceSelector {
  if (typeof faces === "number") return { faces: [faces] };
  if (Array.isArray(faces)) return { faces };
  if (typeof faces === "string") {
    if ((SIDES as readonly string[]).includes(faces)) return { side: faces as typeof SIDES[number] };
    if (faces === "remaining") return { remaining: true };
    if (faces === "exterior") return { exterior: true };
    if (faces.startsWith("feature:")) return { feature: faces.slice(8).trim() };
    throw new Error(`"${faces}" must be resolved before use`);
  }
  return faces;
}

export const bodyList = (value: unknown): string[] => (value === "all" || value === undefined ? ["all"] : Array.isArray(value) ? value as string[] : [String(value)]);
