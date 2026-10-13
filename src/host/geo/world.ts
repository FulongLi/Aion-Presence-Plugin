import data from "./world-data.json" with { type: "json" };
import type { GeoPolygon } from "../../visual/geo/extent";

/**
 * Aion's small offline world (Natural Earth 1:50m, public domain; built by scripts/geo/build-world.ts): every
 * country and the parts people ask for by name (Scotland, England, Wales, Svalbard…), with names in English and
 * Chinese, continent and region, plus about 1,250 cities and towns. It answers the common questions instantly and
 * without the network — "Show me Africa", "展示一下中国的地形", "Show me Scotland", "mark Glasgow" — and gives every
 * map its neighbours for context. Anything it does not know (a state, a province, a mountain range, a small town)
 * is looked up on OpenStreetMap instead (see region.ts).
 */
export interface WorldRegion {
  id: string; name: string; names: string[]; zh: string[]; codes: string[]; parent?: string;
  continent: string; subregion: string; label: [number, number]; polygons: GeoPolygon[];
}
export interface WorldPlace { name: string; names: string[]; lat: number; lon: number; country: string; population: number; capital: boolean }

type RawRegion = Omit<WorldRegion, "polygons" | "label"> & { label: number[]; polygons: number[][][] };
const raw = data as unknown as { source: string; regions: RawRegion[]; places: (string | number)[][] };
export const WORLD_SOURCE = raw.source;

/** Lower case, accents and punctuation dropped, inner spaces collapsed; "the" and similar fillers removed. */
export function normalizeName(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}+/gu, "").normalize("NFKC").toLowerCase()
    .replace(/[\s_\-.,!?'"“”‘’()·&/]+/g, " ").trim()
    .replace(/^(?:the|la|le|el|republic of|kingdom of)\s+/, "").replace(/\s+(?:islands?|is)$/, " islands").trim();
}

const decodeRing = (encoded: number[]): [number, number][] => {
  const ring: [number, number][] = [];
  let x = 0, y = 0;
  for (let i = 0; i + 1 < encoded.length; i += 2) {
    x = i === 0 ? encoded[0] : x + encoded[i]; y = i === 0 ? encoded[1] : y + encoded[i + 1];
    ring.push([x / 100, y / 100]);
  }
  return ring;
};

let regions: WorldRegion[] | null = null;
let places: WorldPlace[] | null = null;

/** Every region, decoded once on first use. */
export function worldRegions(): WorldRegion[] {
  regions ??= raw.regions.map(region => ({
    ...region, label: [region.label[0], region.label[1]] as [number, number],
    polygons: region.polygons.map(polygon => polygon.map(decodeRing)),
  }));
  return regions;
}

export function worldPlaces(): WorldPlace[] {
  places ??= raw.places.map(([name, ascii, alternative, lat, lon, country, population, capital]) => ({
    name: String(name), names: [String(ascii), ...String(alternative).split(/[|,]/)].map(s => s.trim()).filter(Boolean),
    lat: Number(lat), lon: Number(lon), country: String(country), population: Number(population), capital: capital === 1,
  }));
  return places;
}

/** Common names Natural Earth does not carry (English and Chinese), by region id. */
const ALIASES: Record<string, string[]> = {
  USA: ["usa", "us", "u s a", "u s", "united states", "america", "the states", "美国", "美國", "美利坚合众国"],
  GBR: ["uk", "u k", "britain", "great britain", "gb", "英国", "英國", "大不列颠"],
  CHN: ["china", "prc", "mainland china", "中国", "中國", "中华人民共和国"],
  TWN: ["taiwan", "台湾", "台灣"],
  RUS: ["russia", "russian federation", "俄罗斯", "俄羅斯"],
  KOR: ["south korea", "korea", "republic of korea", "韩国", "韓國", "南韩"],
  PRK: ["north korea", "dprk", "朝鲜", "北韩"],
  JPN: ["japan", "日本"], FRA: ["france", "法国"], DEU: ["germany", "德国"], ITA: ["italy", "意大利"], ESP: ["spain", "西班牙"],
  IND: ["india", "印度"], AUS: ["australia", "澳大利亚", "澳洲"], CAN: ["canada", "加拿大"], BRA: ["brazil", "巴西"], MEX: ["mexico", "墨西哥"],
  NLD: ["holland", "netherlands", "荷兰"], CZE: ["czech republic", "czechia"], CIV: ["ivory coast", "cote d ivoire"],
  COD: ["drc", "dr congo", "congo kinshasa", "democratic republic of the congo"], COG: ["congo brazzaville", "republic of the congo"],
  ARE: ["uae", "u a e", "emirates"], NZL: ["new zealand", "新西兰", "紐西蘭"], EGY: ["egypt", "埃及"], ZAF: ["south africa", "南非"],
  "GBR.SCT": ["scotland", "苏格兰", "蘇格蘭"], "GBR.ENG": ["england", "英格兰", "英格蘭"], "GBR.WLS": ["wales", "cymru", "威尔士", "威爾士"],
  "GBR.NIR": ["northern ireland", "北爱尔兰"], IRL: ["ireland", "eire", "爱尔兰"], ISL: ["iceland", "冰岛"], GRL: ["greenland", "格陵兰"],
  "NOR.NSV": ["svalbard", "svalbard islands", "斯瓦尔巴"], CHE: ["switzerland", "瑞士"], NOR: ["norway", "挪威"], SWE: ["sweden", "瑞典"], FIN: ["finland", "芬兰"],
};

/** Continents and well-known groups of countries: their members and the window they are seen through. */
export interface RegionGroup {
  id: string; label: string; names: string[];
  members: (region: WorldRegion) => boolean;
  /** The window (degrees: west, south, east, north) and an optional fixed projection centre (polar views). */
  window?: [number, number, number, number]; centre?: [number, number];
}
const inContinent = (name: string) => (region: WorldRegion) => region.continent === name && !region.parent;
const ids = (...list: string[]) => (region: WorldRegion) => list.includes(region.id);
const sub = (...list: string[]) => (region: WorldRegion) => list.includes(region.subregion) && !region.parent;
export const REGION_GROUPS: RegionGroup[] = [
  { id: "africa", label: "Africa", names: ["africa", "african continent", "非洲"], members: inContinent("Africa"), window: [-26, -36, 60, 38.5] },
  { id: "europe", label: "Europe", names: ["europe", "欧洲", "歐洲"], members: inContinent("Europe"), window: [-25, 34, 45, 71.5] },
  { id: "asia", label: "Asia", names: ["asia", "亚洲", "亞洲"], members: region => (region.continent === "Asia" || region.id === "RUS") && !region.parent, window: [25, -11, 180, 78] },
  { id: "north-america", label: "North America", names: ["north america", "北美洲", "北美"], members: inContinent("North America"), window: [-170, 5, -50, 84] },
  { id: "south-america", label: "South America", names: ["south america", "南美洲", "南美"], members: inContinent("South America"), window: [-93, -57, -32, 14] },
  { id: "oceania", label: "Oceania", names: ["oceania", "australasia", "australia and oceania", "大洋洲"], members: inContinent("Oceania"), window: [110, -50, 180, 2] },
  { id: "antarctica", label: "Antarctica", names: ["antarctica", "antarctic", "南极洲", "南极"], members: ids("ATA"), window: [-180, -90, 180, -60], centre: [0, -90] },
  { id: "arctic", label: "The Arctic", names: ["arctic", "arctic circle", "north pole", "北极", "北极圈"], members: region => region.label[1] > 66 || ["GRL", "NOR.NSV", "ISL"].includes(region.id), window: [-180, 62, 180, 90], centre: [0, 90] },
  { id: "world", label: "The world", names: ["world", "whole world", "earth", "globe", "world map", "世界", "全世界", "地球", "世界地图"], members: region => !region.parent },
  { id: "middle-east", label: "The Middle East", names: ["middle east", "near east", "中东"], members: ids("SAU", "IRN", "IRQ", "SYR", "JOR", "ISR", "PSX", "LBN", "TUR", "YEM", "OMN", "ARE", "QAT", "BHR", "KWT", "EGY", "CYP", "CYN") },
  { id: "southeast-asia", label: "Southeast Asia", names: ["southeast asia", "south east asia", "东南亚"], members: sub("South-Eastern Asia") },
  { id: "east-asia", label: "East Asia", names: ["east asia", "东亚"], members: sub("Eastern Asia") },
  { id: "south-asia", label: "South Asia", names: ["south asia", "indian subcontinent", "南亚"], members: sub("Southern Asia") },
  { id: "central-asia", label: "Central Asia", names: ["central asia", "中亚"], members: sub("Central Asia") },
  { id: "central-america", label: "Central America", names: ["central america", "中美洲"], members: sub("Central America") },
  { id: "caribbean", label: "The Caribbean", names: ["caribbean", "caribbean islands", "west indies", "加勒比", "加勒比海"], members: sub("Caribbean") },
  { id: "scandinavia", label: "Scandinavia", names: ["scandinavia", "斯堪的纳维亚"], members: ids("NOR", "SWE", "DNK") },
  { id: "nordic", label: "The Nordic countries", names: ["nordic countries", "nordics", "北欧"], members: ids("NOR", "SWE", "DNK", "FIN", "ISL") },
  { id: "balkans", label: "The Balkans", names: ["balkans", "balkan peninsula", "巴尔干"], members: ids("ALB", "BIH", "BGR", "HRV", "GRC", "KOS", "MNE", "MKD", "SRB", "SVN", "ROU") },
  { id: "british-isles", label: "The British Isles", names: ["british isles", "不列颠群岛"], members: ids("GBR", "IRL", "IMN") },
  { id: "benelux", label: "Benelux", names: ["benelux", "比荷卢"], members: ids("BEL", "NLD", "LUX") },
  { id: "iberia", label: "The Iberian Peninsula", names: ["iberia", "iberian peninsula", "伊比利亚半岛"], members: ids("ESP", "PRT", "AND", "GIB") },
  { id: "korean-peninsula", label: "The Korean Peninsula", names: ["korean peninsula", "朝鲜半岛"], members: ids("KOR", "PRK") },
];

let index: Map<string, WorldRegion> | null = null;
/** Finds a region by any of its names, codes or aliases (English or Chinese). */
export function findRegion(name: string): WorldRegion | null {
  if (!index) {
    index = new Map();
    const add = (key: string, region: WorldRegion, strong = false) => {
      const k = normalizeName(key);
      if (k && (strong || !index!.has(k))) index!.set(k, region);
    };
    const all = worldRegions();
    // Weaker names first, so the stronger ones (a country's own name, an alias) win any clash.
    for (const region of all) { for (const n of region.names) add(n, region); for (const z of region.zh) add(z, region); }
    for (const region of all) { add(region.name, region, !region.parent); for (const code of region.codes) if (code.length === 3) add(code, region); }
    for (const [id, names] of Object.entries(ALIASES)) { const region = all.find(r => r.id === id); if (region) for (const n of names) add(n, region, true); }
  }
  return index.get(normalizeName(name)) ?? null;
}

export function findGroup(name: string): RegionGroup | null {
  const key = normalizeName(name);
  return REGION_GROUPS.find(group => group.names.some(n => normalizeName(n) === key) || normalizeName(group.label) === key) ?? null;
}

/**
 * A city or town by name from the gazetteer, preferring places inside `within` (a country id, or a test) and then the
 * most populous: "Glasgow" on a map of Scotland is Glasgow, Scotland, never Glasgow, Kentucky.
 */
export function findPlace(name: string, within?: (place: WorldPlace) => boolean): WorldPlace | null {
  const key = normalizeName(name);
  if (!key) return null;
  const matches = worldPlaces().filter(place => normalizeName(place.name) === key || place.names.some(n => normalizeName(n) === key));
  if (!matches.length) return null;
  const inside = within ? matches.filter(within) : [];
  return (inside.length ? inside : within ? [] : matches).sort((a, b) => b.population - a.population)[0] ?? null;
}
