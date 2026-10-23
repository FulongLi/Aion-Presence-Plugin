/**
 * v0.8 Simulation Core: physical quantities and their units. Every value in a simulation study is stored in SI (with the
 * one exception of CAD lengths, which stay in the CAD document's millimetres until the mesher scales the geometry), and
 * every value Codex sends is converted here, explicitly: a bare number means the SI unit of its kind (millimetres for
 * lengths, as in cad_model); a string ("10 V", "25 °C", "10 W/(m2*K)") or { value, unit } names its unit. An unknown unit
 * is refused with the units that are accepted — never guessed.
 *
 * This module (like all of src/sim) has no Aion dependency, so another host (AIPE) can use the same core.
 */
export const QUANTITY_KINDS = [
  "voltage", "current", "length", "temperature", "conductivity", "resistivity", "thermalConductivity", "heatTransfer", "heatFlux",
  "powerDensity", "power", "density",
] as const;
export type QuantityKind = typeof QUANTITY_KINDS[number];

/** The unit stored for each kind (lengths are the CAD document's millimetres). */
export const STORED_UNIT: Record<QuantityKind, string> = {
  voltage: "V", current: "A", length: "mm", temperature: "K", conductivity: "S/m", resistivity: "Ω·m", thermalConductivity: "W/(m·K)",
  heatTransfer: "W/(m²·K)", heatFlux: "W/m²", powerDensity: "W/m³", power: "W", density: "kg/m³",
};

/** Accepted units per kind: factor to the stored unit (temperature: K = value × factor + offset). Keys are normalized. */
const UNITS: Record<QuantityKind, Record<string, number | [number, number]>> = {
  voltage: { v: 1, mv: 1e-3, uv: 1e-6, kv: 1e3 },
  current: { a: 1, ma: 1e-3, ua: 1e-6, ka: 1e3 },
  length: { mm: 1, m: 1e3, cm: 10, um: 1e-3, in: 25.4 },
  temperature: { k: 1, degc: [1, 273.15], c: [1, 273.15], degf: [5 / 9, 273.15 - 32 * 5 / 9], f: [5 / 9, 273.15 - 32 * 5 / 9] },
  conductivity: { "s/m": 1, "ms/m": 1e6, "ms/cm": 1e2, "1/(ohm*m)": 1, "siemens/m": 1 },
  resistivity: { "ohm*m": 1, "ohm*cm": 1e-2, "uohm*cm": 1e-8, "uohm*m": 1e-6, "nohm*m": 1e-9, "ohm*mm2/m": 1e-6 },
  thermalConductivity: { "w/(m*k)": 1, "w/m/k": 1, "w/mk": 1, "w/(m*degc)": 1, "w/(mm*k)": 1e3 },
  heatTransfer: { "w/(m2*k)": 1, "w/m2/k": 1, "w/m2k": 1, "w/(m2*degc)": 1, "w/(cm2*k)": 1e4, "w/(mm2*k)": 1e6 },
  heatFlux: { "w/m2": 1, "w/cm2": 1e4, "w/mm2": 1e6, "kw/m2": 1e3 },
  powerDensity: { "w/m3": 1, "w/cm3": 1e6, "w/mm3": 1e9, "kw/m3": 1e3, "mw/m3": 1e6 },
  power: { w: 1, mw: 1e-3, kw: 1e3, uw: 1e-6 },
  density: { "kg/m3": 1, "g/cm3": 1e3 },
};

/** "MS/m" and "mS/m" differ only in case: the units where case matters, mapped before lower-casing. */
const CASED: Record<string, string> = { "MS/m": "megas/m", "mS/m": "millis/m", "MW/m3": "megaw/m3", "mW": "milliw", "MW": "megaw" };
const CASED_FACTORS: Record<string, [QuantityKind, number]> = {
  "megas/m": ["conductivity", 1e6], "millis/m": ["conductivity", 1e-3], "megaw/m3": ["powerDensity", 1e6], "milliw": ["power", 1e-3], "megaw": ["power", 1e6],
};

export function normalizeUnit(unit: string): string {
  return unit.trim()
    .replace(/[²]/g, "2").replace(/[³]/g, "3").replace(/[·×⋅]/g, "*").replace(/[µμ]/g, "u").replace(/Ω/g, "ohm").replace(/°\s*/g, "deg")
    .replace(/\s+/g, "").replace(/\^/g, "").replace(/\bdeg(?=[cCfF]\b)/g, "deg");
}

export type QuantityInput = number | string | { value: number; unit?: string };

export type Converted = { ok: true; value: number; input: string } | { ok: false; problem: string };

/** Converts one value of a kind to its stored unit. */
export function toStored(kind: QuantityKind, input: QuantityInput): Converted {
  let value: number, unit = "";
  if (typeof input === "number") value = input;
  else if (typeof input === "string") {
    const match = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*(.*)$/.exec(input);
    if (!match) return { ok: false, problem: `"${input}" is not a number with a unit (e.g. "10 ${STORED_UNIT[kind]}")` };
    value = Number(match[1]);
    unit = match[2];
  } else if (input && typeof input === "object" && typeof input.value === "number") {
    value = input.value;
    unit = input.unit ?? "";
  } else return { ok: false, problem: `expected a number or "value unit" for a ${kind}` };
  if (!Number.isFinite(value)) return { ok: false, problem: `${kind} must be a finite number` };
  const shown = `${value}${unit ? ` ${unit.trim()}` : ` ${STORED_UNIT[kind]}`}`;
  if (!unit.trim()) return { ok: true, value, input: shown };
  const raw = normalizeUnit(unit);
  const cased = CASED[raw];
  if (cased) {
    const [k, factor] = CASED_FACTORS[cased];
    if (k === kind) return { ok: true, value: value * factor, input: shown };
  }
  const key = raw.toLowerCase();
  const table = UNITS[kind];
  const factor = table[key] ?? table[key.replace(/\(|\)/g, "").replace(/\*/g, "/")] ?? undefined;
  if (factor === undefined) {
    return { ok: false, problem: `unknown ${kind} unit "${unit.trim()}" (accepted: ${acceptedUnits(kind)})` };
  }
  if (Array.isArray(factor)) return { ok: true, value: value * factor[0] + factor[1], input: shown };
  return { ok: true, value: value * factor, input: shown };
}

export function acceptedUnits(kind: QuantityKind): string {
  const shown: Record<QuantityKind, string> = {
    voltage: "V, mV, kV", current: "A, mA, kA", length: "mm, m, cm, um, in", temperature: "K, °C, °F",
    conductivity: "S/m, MS/m", resistivity: "ohm*m, uohm*cm, ohm*mm2/m", thermalConductivity: "W/(m*K)",
    heatTransfer: "W/(m2*K)", heatFlux: "W/m2, W/cm2", powerDensity: "W/m3, W/cm3, W/mm3", power: "W, mW, kW", density: "kg/m3, g/cm3",
  };
  return shown[kind];
}

/** Kelvin as Celsius, for display. */
export const celsius = (kelvin: number) => kelvin - 273.15;

const PREFIXES: [number, string][] = [[1e9, "G"], [1e6, "M"], [1e3, "k"], [1, ""], [1e-3, "m"], [1e-6, "µ"], [1e-9, "n"]];

/**
 * A readable number with a sensible SI prefix and significant digits (no false precision): 4 significant digits by
 * default. `unit` is the SI unit; prefixes are not applied to K, °C or units that already carry a prefix-like base.
 */
export function formatQuantity(value: number, unit: string, digits = 4): string {
  if (!Number.isFinite(value)) return `${value} ${unit}`;
  if (value === 0) return `0 ${unit}`;
  if (unit === "K" || unit === "°C" || unit === "" || unit === "%") return `${round(value, digits)} ${unit}`.trim();
  const magnitude = Math.abs(value);
  const [scale, prefix] = PREFIXES.find(([s]) => magnitude >= s * 0.9999) ?? PREFIXES[PREFIXES.length - 1];
  // Prefix on the leading unit only (A/m² → MA/m², W/m³ → MW/m³, Ω → mΩ).
  return `${round(value / scale, digits)} ${prefix}${unit}`;
}

/** A number to `digits` significant digits, as a plain string. */
export function round(value: number, digits = 4): string {
  if (!Number.isFinite(value) || value === 0) return String(value);
  const text = Number(value.toPrecision(digits));
  const abs = Math.abs(text);
  return abs !== 0 && (abs < 1e-4 || abs >= 1e7) ? text.toExponential(digits - 1) : String(text);
}
