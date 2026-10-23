import { z } from "zod";
import type { FaceSelector, FaceSignature } from "./geometry";
import { SIDES } from "./geometry";
import type { MaterialProperties } from "./materials";

/**
 * v0.8 Simulation Core: the simulation study — a versioned, schema-checked description of one engineering analysis on
 * one CAD document: which bodies, which physics, the materials, boundary conditions and sources, the mesh and solver
 * settings, and the results it produced. It is independent of any visualization (the Simulation Card shows a result; the
 * study outlives it) and of Aion itself (another host can run the same study).
 *
 * Units: every physical value is SI (V, A, K, S/m, W/(m·K), W/(m²·K), W/m², W/m³, W); CAD lengths (mesh sizes, points)
 * are the CAD document's millimetres. What the user said ("25 °C") is kept beside the converted value for reports.
 */
export const STUDY_FORMAT = "aion.sim.study/1";
export const ANALYSES = ["electric", "thermal", "electrothermal"] as const;
export type Analysis = typeof ANALYSES[number];
export const ANALYSIS_LABEL: Record<Analysis, string> = {
  electric: "stationary current conduction (DC)",
  thermal: "steady-state heat conduction",
  electrothermal: "DC current conduction → Joule heating → steady-state heat conduction (sequential, one-way)",
};

export const CONDITION_TYPES = ["voltage", "ground", "current", "insulated", "temperature", "convection", "heat_flux", "heat_flow", "adiabatic"] as const;
export type ConditionType = typeof CONDITION_TYPES[number];
export type Condition =
  | { type: "voltage"; voltage: number }
  | { type: "ground" }
  | { type: "current"; current: number }
  | { type: "insulated" }
  | { type: "temperature"; temperature: number }
  | { type: "convection"; h: number; ambient: number }
  | { type: "heat_flux"; flux: number }
  | { type: "heat_flow"; power: number }
  | { type: "adiabatic" };

export type Physics = "electric" | "thermal";
export const physicsOf = (type: ConditionType): Physics => (["voltage", "ground", "current", "insulated"].includes(type) ? "electric" : "thermal");
export const needsPhysics = (analysis: Analysis, physics: Physics) => analysis === "electrothermal" || analysis === physics;

export function describeCondition(c: Condition): string {
  switch (c.type) {
    case "voltage": return `potential ${c.voltage} V`;
    case "ground": return "ground (0 V)";
    case "current": return `terminal current ${c.current} A (equipotential terminal)`;
    case "insulated": return "electrically insulated";
    case "temperature": return `fixed temperature ${round(c.temperature)} K (${round(c.temperature - 273.15)} °C)`;
    case "convection": return `convection h = ${c.h} W/(m²·K) to ${round(c.ambient)} K (${round(c.ambient - 273.15)} °C)`;
    case "heat_flux": return `heat flux ${c.flux} W/m² into the body`;
    case "heat_flow": return `heat flow ${c.power} W into the body (spread uniformly over the faces)`;
    case "adiabatic": return "adiabatic (no heat flow)";
  }
}
const round = (v: number) => Number(v.toPrecision(6));

export interface MaterialAssignment {
  id: string;
  /** Body references as given (CAD ids or labels, "S2" for a solid); resolved against the geometry. */
  bodies: string[];
  name: string;
  /** "library:copper", or "user" for values the user gave. */
  source: string;
  properties: MaterialProperties;
  /** What the user said, for reports ("conductivity 5.8e7 S/m"). */
  inputs?: Record<string, string>;
  nominal: boolean;
}

export interface BoundaryAssignment {
  id: string;
  name: string;
  selector: FaceSelector;
  condition: Condition;
  inputs?: Record<string, string>;
  /** The faces the selector resolved to, on which geometry revision, and what they were. */
  resolved?: { revision: number; faces: number[]; signatures: FaceSignature[] };
  /** Set when a geometry change left this assignment pointing at faces that no longer match (not applied). */
  stale?: string;
  /** Picked in the Simulation Card (the selection was resolved to face numbers). */
  picked?: boolean;
}

export interface SourceAssignment {
  id: string;
  bodies: string[];
  /** W/m³, uniform in the bodies; or a total power in W spread uniformly over their volume. */
  density?: number;
  power?: number;
  inputs?: Record<string, string>;
}

export const MESH_SIZES = ["coarse", "normal", "fine", "very_fine"] as const;
export type MeshSize = typeof MESH_SIZES[number];
export interface MeshConfig {
  size: MeshSize;
  /** Overrides, mm. */
  max_mm?: number;
  min_mm?: number;
  /** Elements per full circle on curved surfaces. */
  curvature?: number;
  order: 1 | 2;
  refine: { id: string; selector?: FaceSelector; bodies?: string[]; size_mm: number }[];
}

export interface SolverConfig {
  /** Linear solver: an iterative Krylov method with ILU preconditioning, or a direct sparse factorization (UMFPACK). */
  linear: "iterative" | "direct";
  tolerance: number;
  maxIterations: number;
  timeoutSeconds: number;
  /** The initial temperature (K); also the reference for reports. */
  referenceTemperature: number;
}

export interface ResultRecord {
  run: number;
  studyRevision: number;
  geometryRevision: number;
  meshId: string;
  created: string;
  status: "solved" | "failed";
  /** Key numbers (resistance, losses, temperatures…) for listing and comparison. */
  headline: Record<string, number>;
  problem?: string;
}

export interface SimulationStudy {
  format: typeof STUDY_FORMAT;
  id: string;
  name: string;
  created: string;
  updated: string;
  /** Monotonic: every change of the setup adds one. */
  revision: number;
  analysis: Analysis;
  geometry: { backend: "freecad"; document: string; documentName?: string; revision: number; bodies: string[] | "visible" };
  materials: MaterialAssignment[];
  boundaries: BoundaryAssignment[];
  sources: SourceAssignment[];
  mesh: MeshConfig;
  solver: SolverConfig;
  results: ResultRecord[];
  history: { revision: number; description: string }[];
  nextId: number;
}

export const DEFAULT_MESH: MeshConfig = { size: "normal", order: 1, refine: [] };
export const DEFAULT_SOLVER: SolverConfig = { linear: "iterative", tolerance: 1e-10, maxIterations: 5000, timeoutSeconds: 600, referenceTemperature: 293.15 };

// ── Schema of a stored study (checked whenever one is read from disk) ────────────────────────────────────────────────
const finite = z.number().finite();
const vec3 = z.tuple([finite, finite, finite]);
const side = z.enum(SIDES);
const bodyRef = z.string().trim().min(1).max(80);
export const faceSelectorSchema: z.ZodType<FaceSelector> = z.union([
  z.object({ side, body: bodyRef.optional() }).strict(),
  z.object({ facing: side, body: bodyRef.optional() }).strict(),
  z.object({ feature: bodyRef }).strict(),
  z.object({ faces: z.array(z.number().int().min(1).max(100_000)).min(1).max(500) }).strict(),
  z.object({ at: vec3, body: bodyRef.optional() }).strict(),
  z.object({ exterior: z.literal(true), body: bodyRef.optional() }).strict(),
  z.object({ remaining: z.literal(true), body: bodyRef.optional() }).strict(),
]) as z.ZodType<FaceSelector>;

const positive = finite.gt(0);
const kelvin = finite.gt(0).lt(10_000);
export const conditionSchema: z.ZodType<Condition> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("voltage"), voltage: finite.gt(-1e6).lt(1e6) }).strict(),
  z.object({ type: z.literal("ground") }).strict(),
  z.object({ type: z.literal("current"), current: finite.gt(-1e6).lt(1e6).refine(v => v !== 0, "a terminal current must not be 0") }).strict(),
  z.object({ type: z.literal("insulated") }).strict(),
  z.object({ type: z.literal("temperature"), temperature: kelvin }).strict(),
  z.object({ type: z.literal("convection"), h: positive.lt(1e7), ambient: kelvin }).strict(),
  z.object({ type: z.literal("heat_flux"), flux: finite.gt(-1e10).lt(1e10) }).strict(),
  z.object({ type: z.literal("heat_flow"), power: finite.gt(-1e7).lt(1e7) }).strict(),
  z.object({ type: z.literal("adiabatic") }).strict(),
]) as z.ZodType<Condition>;

const signature = z.object({ index: z.number().int(), surface: z.string(), area_mm2: finite, center: vec3, normal: vec3.optional() }).strict();
const properties = z.object({ electricConductivity: positive.optional(), thermalConductivity: positive.optional(), density: positive.optional() }).strict();
const inputs = z.record(z.string(), z.string()).optional();

export const studySchema = z.object({
  format: z.literal(STUDY_FORMAT),
  id: z.string().regex(/^sim-[a-z0-9]{4,16}$/),
  name: z.string().min(1).max(80),
  created: z.string(), updated: z.string(),
  revision: z.number().int().min(1),
  analysis: z.enum(ANALYSES),
  geometry: z.object({
    backend: z.literal("freecad"), document: z.string().min(1).max(40), documentName: z.string().max(80).optional(), revision: z.number().int().min(0),
    bodies: z.union([z.literal("visible"), z.array(bodyRef).min(1).max(64)]),
  }).strict(),
  materials: z.array(z.object({
    id: z.string(), bodies: z.array(bodyRef).min(1).max(64), name: z.string().min(1).max(80), source: z.string().max(80), properties, inputs, nominal: z.boolean(),
  }).strict()).max(64),
  boundaries: z.array(z.object({
    id: z.string(), name: z.string().min(1).max(80), selector: faceSelectorSchema, condition: conditionSchema, inputs,
    resolved: z.object({ revision: z.number().int(), faces: z.array(z.number().int()), signatures: z.array(signature) }).strict().optional(),
    stale: z.string().max(400).optional(), picked: z.boolean().optional(),
  }).strict()).max(128),
  sources: z.array(z.object({
    id: z.string(), bodies: z.array(bodyRef).min(1).max(64), density: finite.optional(), power: finite.optional(), inputs,
  }).strict()).max(32),
  mesh: z.object({
    size: z.enum(MESH_SIZES), max_mm: positive.optional(), min_mm: positive.optional(), curvature: z.number().int().min(4).max(64).optional(),
    order: z.union([z.literal(1), z.literal(2)]),
    refine: z.array(z.object({ id: z.string(), selector: faceSelectorSchema.optional(), bodies: z.array(bodyRef).optional(), size_mm: positive }).strict()).max(16),
  }).strict(),
  solver: z.object({
    linear: z.enum(["iterative", "direct"]), tolerance: finite.gt(0).lt(1), maxIterations: z.number().int().min(10).max(100_000),
    timeoutSeconds: z.number().int().min(10).max(7200), referenceTemperature: kelvin,
  }).strict(),
  results: z.array(z.object({
    run: z.number().int().min(1), studyRevision: z.number().int(), geometryRevision: z.number().int(), meshId: z.string(), created: z.string(),
    status: z.enum(["solved", "failed"]), headline: z.record(z.string(), finite), problem: z.string().optional(),
  }).strict()).max(1000),
  history: z.array(z.object({ revision: z.number().int(), description: z.string().max(200) }).strict()).max(1000),
  nextId: z.number().int().min(1),
}).strict();

export function parseStudy(data: unknown): { ok: true; study: SimulationStudy } | { ok: false; problem: string } {
  const parsed = studySchema.safeParse(data);
  if (parsed.success) return { ok: true, study: parsed.data as SimulationStudy };
  return { ok: false, problem: parsed.error.issues.slice(0, 4).map(i => `${i.path.join(".") || "study"}: ${i.message}`).join("; ") };
}

export function newStudy(id: string, name: string, analysis: Analysis, geometry: SimulationStudy["geometry"], now = new Date().toISOString()): SimulationStudy {
  return {
    format: STUDY_FORMAT, id, name, created: now, updated: now, revision: 1, analysis, geometry,
    materials: [], boundaries: [], sources: [], mesh: structuredClone(DEFAULT_MESH), solver: { ...DEFAULT_SOLVER }, results: [],
    history: [{ revision: 1, description: `Created: ${ANALYSIS_LABEL[analysis]}` }], nextId: 1,
  };
}

/** Records one change of the setup (a new study revision). */
export function touch(study: SimulationStudy, description: string, now = new Date().toISOString()) {
  study.revision += 1;
  study.updated = now;
  study.history.push({ revision: study.revision, description: description.slice(0, 200) });
  if (study.history.length > 200) study.history.splice(0, study.history.length - 200);
}

export function nextId(study: SimulationStudy, prefix: string): string {
  return `${prefix}${study.nextId++}`;
}
