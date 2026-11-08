import { z } from "zod";
import { UP_AXES } from "./normalization";

/**
 * Model manifests (v0.9, schema "aion.model/1"): one record per model — what it is, where it came from, who made it, what
 * its licence allows, what rights the underlying design carries, and whether Aion may show it. The record is the same
 * for a bundled model, a model the user imported and a catalogue reference that was never downloaded; `availability`
 * separates the three states:
 *
 *   catalogued       the source is identified and recorded; no model file is distributed or kept.
 *   local            the user downloaded the file themselves (under its terms) and imported it; it stays on this machine.
 *   redistributable  both the model's licence and any underlying design rights allow Aion to ship it; it is bundled.
 *
 * A Creative Commons licence on a fan model covers the modeller's work, not the character it depicts: such entries record
 * `rights.underlyingIp: "third-party"` and are never redistributable unless the rights holder's permission is recorded.
 */
export const MODEL_SCHEMA = "aion.model/1";
export const CATALOGUE_SCHEMA = "aion.model-catalogue/1";

export const MODEL_CATEGORIES = ["character", "creature", "animal", "object", "vehicle", "building", "plant", "other"] as const;
export const AVAILABILITY = ["catalogued", "local", "redistributable"] as const;
export type Availability = typeof AVAILABILITY[number];
export const MODEL_COLORS = ["original", "silver"] as const;
export type ModelColors = typeof MODEL_COLORS[number];
export const MODEL_DETAILS = ["low", "medium", "high"] as const;
export type ModelDetail = typeof MODEL_DETAILS[number];
/** Particles per detail level. High is the renderer's own ceiling (its top quality tier). */
export const DETAIL_COUNTS: Record<ModelDetail, number> = { low: 12_000, medium: 30_000, high: 50_000 };

const permission = z.enum(["yes", "no", "unknown"]);
const line = (max: number) => z.string().trim().min(1).max(max);
const httpsUrl = z.string().max(400).url().refine(value => /^https:\/\//.test(value), "an https URL");
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const modelManifest = z.object({
  schema: z.literal(MODEL_SCHEMA),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
  name: line(80),
  aliases: z.array(line(60)).max(16).optional(),
  category: z.enum(MODEL_CATEGORIES),
  /** The franchise a character belongs to, if any (e.g. "Pokémon"). */
  franchise: line(60).optional(),
  /** The character or subject this is a model of, normalized (several models may depict one character). */
  subject: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).optional(),
  source: z.object({
    site: line(60), url: httpsUrl.optional(), title: line(120), author: line(160), authorUrl: httpsUrl.optional(),
    formats: z.array(z.string().regex(/^[a-z0-9]{2,8}$/)).max(12),
    published: date.optional(),
  }).strict(),
  licence: z.object({
    /** An SPDX identifier where one exists (CC-BY-4.0, CC0-1.0), otherwise the site's own name (Sketchfab-Standard), or "unknown". */
    id: z.string().regex(/^[A-Za-z0-9.+-]{2,40}$/),
    label: line(80),
    url: httpsUrl.optional(),
    /** The credit to show, as the licence asks for it. */
    attribution: line(240).optional(),
    modification: permission, redistribution: permission, commercial: permission,
  }).strict(),
  rights: z.object({
    underlyingIp: z.enum(["original", "third-party", "public-domain", "unknown"]),
    ipOwner: line(120).optional(),
    /** True only when every right needed to ship the model with Aion was checked and recorded. */
    redistributionVerified: z.boolean(),
    /** A model that looks extracted from a commercial game (a "rip") — never used. */
    extractedGameAsset: z.enum(["no", "suspected", "yes"]).optional(),
    notes: line(400).optional(),
  }).strict(),
  availability: z.enum(AVAILABILITY),
  download: z.object({
    available: z.boolean(),
    method: z.enum(["direct", "sketchfab-download-api", "manual", "none"]),
    requiresAccount: z.boolean(),
    status: z.enum(["not-downloaded", "downloaded", "not-permitted", "failed"]),
    bytes: z.number().int().min(0).max(4_000_000_000).optional(),
  }).strict(),
  checked: date,
  stats: z.object({
    triangles: z.number().int().min(0).optional(), vertices: z.number().int().min(0).optional(),
    textures: z.number().int().min(0).optional(), animations: z.number().int().min(0).optional(),
  }).strict().optional(),
  particle: z.object({
    colors: z.enum(MODEL_COLORS).optional(),
    detail: z.enum(MODEL_DETAILS).optional(),
    orientation: z.object({
      up: z.enum(UP_AXES).optional(), yaw: z.number().min(-360).max(360).optional(),
      rotate: z.array(z.number().min(-360).max(360)).length(3).optional(),
    }).strict().optional(),
    /** Material or node names to leave out (substrings, case-insensitive): a ground plane, a backdrop. */
    exclude: z.array(line(60)).max(16).optional(),
  }).strict().optional(),
  /** Bundled models only: the file, relative to the plugin's assets/models folder. */
  file: z.string().regex(/^[a-z0-9][a-z0-9._/-]{0,120}\.glb$/).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.availability === "redistributable") {
    if (!value.rights.redistributionVerified) ctx.addIssue({ code: "custom", message: "a redistributable model needs verified redistribution rights" });
    if (value.licence.redistribution !== "yes") ctx.addIssue({ code: "custom", message: "a redistributable model's licence must allow redistribution" });
    if (value.rights.underlyingIp === "third-party" || value.rights.underlyingIp === "unknown") ctx.addIssue({ code: "custom", message: "a redistributable model cannot depict third-party or unknown designs without recorded permission" });
    if (!value.file) ctx.addIssue({ code: "custom", message: "a redistributable model names its bundled file" });
  } else if (value.file) ctx.addIssue({ code: "custom", message: "only redistributable models are bundled" });
  if (value.availability !== "local" && !value.source.url) ctx.addIssue({ code: "custom", message: "a catalogued or bundled model records its source URL" });
  if (value.rights.extractedGameAsset === "yes" && value.availability !== "catalogued") ctx.addIssue({ code: "custom", message: "an extracted game asset is never imported" });
});
export type ModelManifest = z.infer<typeof modelManifest>;

export const modelCatalogue = z.object({
  schema: z.literal(CATALOGUE_SCHEMA),
  title: line(120),
  description: line(600).optional(),
  generated: date,
  entries: z.array(modelManifest).max(5_000),
}).strict().superRefine((value, ctx) => {
  const ids = new Set<string>();
  for (const entry of value.entries) {
    if (ids.has(entry.id)) ctx.addIssue({ code: "custom", message: `duplicate id ${entry.id}` });
    ids.add(entry.id);
  }
});
export type ModelCatalogue = z.infer<typeof modelCatalogue>;

/** A short credit line for a model ("Fox · PixelMannen, tomkranis · CC0 / CC-BY 4.0"). */
export function creditLine(manifest: ModelManifest): string {
  return (manifest.licence.attribution ?? `${manifest.source.title} by ${manifest.source.author} · ${manifest.licence.label}`).slice(0, 240);
}

export function validateManifest(value: unknown): { ok: true; manifest: ModelManifest } | { ok: false; problem: string } {
  const result = modelManifest.safeParse(value);
  if (result.success) return { ok: true, manifest: result.data };
  const issue = result.error.issues[0];
  return { ok: false, problem: `${issue.path.join(".") || "manifest"}: ${issue.message}` };
}
