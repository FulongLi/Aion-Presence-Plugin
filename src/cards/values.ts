/**
 * The values that cross the Card Bridge (v0.4.5): command arguments, reported state, selection properties. Every value
 * has a declared type in the application's manifest, and every receiver checks it against that declaration — nothing
 * crosses as free-form data. Pure and dependency-free (the host, the page and the sandboxed card all use it).
 */
export type CardValue = string | number | boolean | null | CardValue[] | CardTreeNode[];

/** One entry of a reported hierarchy (the CAD viewer's components). */
export interface CardTreeNode { id: string; name: string; depth: number; visible: boolean; selectable?: boolean }

/** Object ids: a path of names ("assembly/winding-primary"), letters of any script, digits and a few separators. */
export const OBJECT_ID = /^[\p{L}\p{N}_.\-#/ ]{1,120}$/u;

export type ValueSpec =
  | { type: "none" }
  | { type: "boolean" }
  | { type: "number"; min: number; max: number; integer?: boolean }
  | { type: "enum"; values: readonly string[] }
  /** An object id (see OBJECT_ID). */
  | { type: "id" }
  /** Display text: one line, no control characters, at most `max` characters. */
  | { type: "text"; max: number }
  /** A list of object ids. */
  | { type: "ids"; max: number }
  /** A hierarchy (see CardTreeNode), at most `max` entries. */
  | { type: "tree"; max: number };

export const VALUE_TYPES = ["none", "boolean", "number", "enum", "id", "text", "ids", "tree"] as const;

// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/u;

/** One line of display text, or null. */
export function cleanCardText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text && Array.from(text).length <= max && !CONTROL.test(text) ? text : null;
}

export const isObjectId = (value: unknown): value is string => typeof value === "string" && OBJECT_ID.test(value) && !CONTROL.test(value);

/** Checks a value against its declared type: the value itself (normalized) or why not. */
export function checkValue(spec: ValueSpec, value: unknown): { ok: true; value: CardValue | undefined } | { ok: false; problem: string } {
  switch (spec.type) {
    case "none":
      return value === undefined || value === null ? { ok: true, value: undefined } : { ok: false, problem: "takes no value" };
    case "boolean":
      return typeof value === "boolean" ? { ok: true, value } : { ok: false, problem: "must be true or false" };
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false, problem: "must be a number" };
      if (spec.integer && !Number.isInteger(value)) return { ok: false, problem: "must be a whole number" };
      return value >= spec.min && value <= spec.max ? { ok: true, value } : { ok: false, problem: `must be between ${spec.min} and ${spec.max}` };
    case "enum":
      return typeof value === "string" && spec.values.includes(value) ? { ok: true, value } : { ok: false, problem: `must be one of ${spec.values.join(", ")}` };
    case "id":
      return isObjectId(value) ? { ok: true, value } : { ok: false, problem: "must be an object id" };
    case "text": {
      const text = cleanCardText(value, spec.max);
      return text !== null ? { ok: true, value: text } : { ok: false, problem: `must be one line of at most ${spec.max} characters` };
    }
    case "ids":
      return Array.isArray(value) && value.length <= spec.max && value.every(isObjectId) ? { ok: true, value: [...value] } : { ok: false, problem: `must be at most ${spec.max} object ids` };
    case "tree": {
      if (!Array.isArray(value) || value.length > spec.max) return { ok: false, problem: `must be at most ${spec.max} entries` };
      const nodes: CardTreeNode[] = [];
      for (const item of value) {
        const node = item as Partial<CardTreeNode> | null;
        if (!node || typeof node !== "object" || Array.isArray(node)) return { ok: false, problem: "entries must be objects" };
        const keys = Object.keys(node);
        if (keys.some(key => !["id", "name", "depth", "visible", "selectable"].includes(key))) return { ok: false, problem: "entries have unknown fields" };
        const name = cleanCardText(node.name, 80);
        if (!isObjectId(node.id) || name === null || !Number.isInteger(node.depth) || node.depth! < 0 || node.depth! > 32 || typeof node.visible !== "boolean"
          || (node.selectable !== undefined && typeof node.selectable !== "boolean")) return { ok: false, problem: "entries need an id, a name, a depth and visibility" };
        nodes.push({ id: node.id!, name, depth: node.depth!, visible: node.visible!, ...(node.selectable !== undefined ? { selectable: node.selectable } : {}) });
      }
      return { ok: true, value: nodes };
    }
  }
}

/** Whether a value spec is itself well formed (a manifest's declarations are checked before an app is registered). */
export function validSpec(spec: unknown): spec is ValueSpec {
  const s = spec as Partial<ValueSpec> & Record<string, unknown> | null;
  if (!s || typeof s !== "object" || !VALUE_TYPES.includes(s.type as typeof VALUE_TYPES[number])) return false;
  const keys = Object.keys(s);
  const only = (...allowed: string[]) => keys.every(key => key === "type" || allowed.includes(key));
  switch (s.type) {
    case "none": case "boolean": case "id": return only();
    case "number": return only("min", "max", "integer") && Number.isFinite(s.min) && Number.isFinite(s.max) && (s.min as number) <= (s.max as number) && (s.integer === undefined || typeof s.integer === "boolean");
    case "enum": return only("values") && Array.isArray(s.values) && s.values.length >= 1 && s.values.length <= 32 && s.values.every(v => typeof v === "string" && /^[a-z0-9-]{1,32}$/.test(v));
    case "text": case "ids": case "tree": return only("max") && Number.isInteger(s.max) && (s.max as number) >= 1 && (s.max as number) <= (s.type === "text" ? 400 : 500);
    default: return false;
  }
}

/** A short human description of what a spec accepts (for tool results and docs). */
export function describeSpec(spec: ValueSpec): string {
  switch (spec.type) {
    case "none": return "";
    case "boolean": return "true|false";
    case "number": return `${spec.min}…${spec.max}`;
    case "enum": return spec.values.join("|");
    case "id": return "object id";
    case "text": return "text";
    case "ids": return "object ids";
    case "tree": return "hierarchy";
  }
}
