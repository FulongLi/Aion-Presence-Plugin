/**
 * v0.8 Simulation Core: the material library. Nominal room-temperature (20 °C) properties of common power-electronics
 * materials, for constant-property analyses. They are typical handbook values, not a particular supplier's data: every
 * study that uses one reports it as nominal, and the user can override any property (or define a material) with their
 * own data sheet values. Electrical insulators carry no conductivity: in an electro-thermal study they conduct heat only.
 *
 * Basis: copper's conductivity is the IACS definition (100 % IACS = 58.0 MS/m at 20 °C); the alloys are given by their
 * typical % IACS; thermal conductivities and densities are typical handbook (ASM / manufacturer) values.
 */
export interface MaterialProperties {
  /** Electrical conductivity, S/m (absent: an electrical insulator). */
  electricConductivity?: number;
  /** Thermal conductivity, W/(m·K). */
  thermalConductivity?: number;
  /** Density, kg/m³ (reported; not needed by steady analyses). */
  density?: number;
}

export interface LibraryMaterial extends MaterialProperties {
  id: string;
  name: string;
  aliases: string[];
  basis: string;
}

export const MATERIAL_LIBRARY: readonly LibraryMaterial[] = [
  { id: "copper", name: "Copper (ETP, C11000, annealed)", aliases: ["cu", "etp copper", "c11000", "c110", "pure copper", "铜", "紫铜"],
    electricConductivity: 5.80e7, thermalConductivity: 390, density: 8940, basis: "100 % IACS (58.0 MS/m); k typical for C11000" },
  { id: "aluminium-1350", name: "Aluminium 1350 (EC grade)", aliases: ["aluminum 1350", "ec aluminium", "ec aluminum", "electrical aluminium", "al 1350"],
    electricConductivity: 3.54e7, thermalConductivity: 234, density: 2705, basis: "61 % IACS" },
  { id: "aluminium-6061", name: "Aluminium 6061-T6", aliases: ["aluminium", "aluminum", "al", "aluminum 6061", "6061", "al6061", "铝"],
    electricConductivity: 2.50e7, thermalConductivity: 167, density: 2700, basis: "43 % IACS" },
  { id: "aluminium-6063", name: "Aluminium 6063-T5 (extrusion, heat sinks)", aliases: ["aluminum 6063", "6063", "al6063"],
    electricConductivity: 3.19e7, thermalConductivity: 209, density: 2700, basis: "55 % IACS" },
  { id: "brass", name: "Brass (C26000, cartridge brass)", aliases: ["c26000", "黄铜"],
    electricConductivity: 1.62e7, thermalConductivity: 120, density: 8530, basis: "28 % IACS" },
  { id: "silver", name: "Silver", aliases: ["ag", "银"], electricConductivity: 6.30e7, thermalConductivity: 429, density: 10490, basis: "108 % IACS" },
  { id: "gold", name: "Gold", aliases: ["au", "金"], electricConductivity: 4.10e7, thermalConductivity: 318, density: 19300, basis: "71 % IACS" },
  { id: "nickel", name: "Nickel", aliases: ["ni", "镍"], electricConductivity: 1.43e7, thermalConductivity: 90.9, density: 8900, basis: "25 % IACS" },
  { id: "tin", name: "Tin", aliases: ["sn", "锡"], electricConductivity: 9.17e6, thermalConductivity: 66.8, density: 7310, basis: "15.8 % IACS" },
  { id: "steel-1010", name: "Carbon steel (AISI 1010)", aliases: ["steel", "mild steel", "1010", "钢"],
    electricConductivity: 6.99e6, thermalConductivity: 63.9, density: 7870, basis: "resistivity 0.143 µΩ·m" },
  { id: "stainless-304", name: "Stainless steel 304", aliases: ["stainless", "stainless steel", "ss304", "304", "不锈钢"],
    electricConductivity: 1.39e6, thermalConductivity: 16.2, density: 8000, basis: "resistivity 0.72 µΩ·m" },
  { id: "sac305", name: "Solder SAC305 (Sn96.5Ag3.0Cu0.5)", aliases: ["solder", "sac 305", "焊锡"],
    electricConductivity: 7.58e6, thermalConductivity: 58, density: 7380, basis: "resistivity 13.2 µΩ·cm" },
  { id: "fr4", name: "FR-4 laminate (electrical insulator)", aliases: ["fr-4", "pcb", "pcb laminate", "glass epoxy"],
    thermalConductivity: 0.3, density: 1850, basis: "through-plane k ≈ 0.3 W/(m·K); electrically insulating" },
  { id: "alumina", name: "Alumina 96 % (electrical insulator)", aliases: ["al2o3", "aluminium oxide", "aluminum oxide", "ceramic", "氧化铝"],
    thermalConductivity: 24, density: 3720, basis: "96 % Al₂O₃; electrically insulating" },
  { id: "thermal-pad", name: "Thermal interface pad (generic 3 W/(m·K), electrical insulator)", aliases: ["thermal pad", "gap pad", "tim", "thermal interface"],
    thermalConductivity: 3, density: 3000, basis: "generic; product-specific — use the data sheet" },
];

export function findMaterial(name: string): LibraryMaterial | null {
  const key = name.trim().toLowerCase().replace(/[_]/g, " ");
  return MATERIAL_LIBRARY.find(m => m.id === key || m.id.replace(/-/g, " ") === key || m.name.toLowerCase() === key || m.aliases.includes(key)) ?? null;
}

export const materialNames = () => MATERIAL_LIBRARY.map(m => m.id).join(", ");
