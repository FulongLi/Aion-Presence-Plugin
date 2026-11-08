import type { Availability, ModelManifest } from "./manifest";

/**
 * The model registry (v0.9): every known model — bundled, imported and catalogued — indexed by id, name, aliases and
 * subject, so "Pikachu", "pikachu", "皮卡丘" and "025 Pikachu" all find the same character, and a slightly misspelt name
 * ("Pickachu") still does. Pure and cheap: a catalogue of thousands of references is a few hundred KB of JSON and is
 * indexed on first use, never loaded into the renderer. `resolve` answers the question Aion asks before it transforms:
 * is there a model of this I may show (local or redistributable), and if not, what is catalogued and how could the user
 * import it?
 */
export interface RegistryEntry { manifest: ModelManifest; /** A model file Aion can convert now (bundled or imported). */ installed: boolean }

export const normalizeName = (value: string) => value.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/[^\p{Letter}\p{Number}]+/gu, " ").trim();

function distance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, row[j]);
    }
    if (best > limit) return limit + 1;
    previous = row;
  }
  return previous[b.length];
}

const AVAILABILITY_RANK: Record<Availability, number> = { local: 0, redistributable: 1, catalogued: 2 };

export interface Match { entry: RegistryEntry; score: number }

export class ModelRegistry {
  private readonly entries = new Map<string, RegistryEntry>();

  constructor(entries: RegistryEntry[] = []) { for (const entry of entries) this.add(entry); }

  /** Adds or replaces an entry (an imported model replaces its catalogue reference of the same id). */
  add(entry: RegistryEntry) {
    const existing = this.entries.get(entry.manifest.id);
    if (existing && existing.installed && !entry.installed) return;
    this.entries.set(entry.manifest.id, entry);
  }

  get(id: string) { return this.entries.get(id); }
  get size() { return this.entries.size; }
  all(): RegistryEntry[] { return [...this.entries.values()]; }

  private names(manifest: ModelManifest): string[] {
    return [manifest.name, manifest.id.replace(/-/g, " "), manifest.subject?.replace(/-/g, " "), ...(manifest.aliases ?? [])]
      .filter((value): value is string => Boolean(value)).map(normalizeName).filter(Boolean);
  }

  /** Ranked matches for a name or description (best first); an empty query lists everything installed first. */
  search(query: string, limit = 20): Match[] {
    const q = normalizeName(query);
    const out: Match[] = [];
    for (const entry of this.entries.values()) {
      const names = this.names(entry.manifest);
      let score = 0;
      if (!q) score = 1;
      else {
        for (const name of names) {
          if (name === q) score = Math.max(score, 100);
          else if (name.split(" ").includes(q) || q.split(" ").includes(name)) score = Math.max(score, 70);
          else if (name.startsWith(q) || q.startsWith(name)) score = Math.max(score, 55);
          else if (q.length >= 4 && name.includes(q)) score = Math.max(score, 45);
          else {
            const limit = q.length >= 8 ? 2 : q.length >= 5 ? 1 : 0;
            if (limit) for (const word of [name, ...name.split(" ")]) if (distance(word, q, limit) <= limit) score = Math.max(score, 35);
          }
        }
        if (!score && entry.manifest.franchise && normalizeName(entry.manifest.franchise) === q) score = 10;
        if (!score && entry.manifest.category === q) score = 8;
      }
      if (score) out.push({ entry, score: score + (entry.installed ? 5 : 0) - AVAILABILITY_RANK[entry.manifest.availability] });
    }
    return out.sort((a, b) => b.score - a.score || a.entry.manifest.name.localeCompare(b.entry.manifest.name)).slice(0, limit);
  }

  /**
   * What "show me X" can do: the best installed model of X (null if none), and the catalogued references of the same
   * subject (or name), which Aion offers as an import rather than pretending.
   */
  resolve(query: string): { model: RegistryEntry | null; references: RegistryEntry[]; matches: Match[] } {
    const matches = this.search(query, 60).filter(match => match.score >= 30);
    if (!matches.length) return { model: null, references: [], matches };
    const best = matches[0].entry.manifest;
    const subject = best.subject ?? normalizeName(best.name);
    const same = matches.filter(match => (match.entry.manifest.subject ?? normalizeName(match.entry.manifest.name)) === subject);
    const model = same.find(match => match.entry.installed)?.entry ?? matches.find(match => match.entry.installed && match.score >= 70)?.entry ?? null;
    const references = same.filter(match => !match.entry.installed).map(match => match.entry);
    return { model, references, matches };
  }

  categories(): { category: string; count: number; installed: number }[] {
    const counts = new Map<string, { count: number; installed: number }>();
    for (const entry of this.entries.values()) {
      const c = counts.get(entry.manifest.category) ?? { count: 0, installed: 0 };
      c.count++; if (entry.installed) c.installed++;
      counts.set(entry.manifest.category, c);
    }
    return [...counts].map(([category, c]) => ({ category, ...c })).sort((a, b) => b.count - a.count);
  }

  /** Entries that describe the same source model (one URL), or one author's same-named model twice. */
  duplicates(): string[][] {
    const groups = new Map<string, string[]>();
    for (const entry of this.entries.values()) {
      const m = entry.manifest;
      for (const key of [m.source.url ? `url:${m.source.url.replace(/[?#].*$/, "").replace(/\/$/, "").toLowerCase()}` : `id:${m.id}`, `name:${normalizeName(m.source.author)}|${normalizeName(m.source.title)}`]) {
        groups.set(key, [...(groups.get(key) ?? []), m.id]);
      }
    }
    const seen = new Set<string>();
    return [...groups.values()].filter(ids => ids.length > 1).map(ids => [...new Set(ids)].sort()).filter(ids => {
      const key = ids.join(","); if (seen.has(key) || ids.length < 2) return false; seen.add(key); return true;
    });
  }
}
