import type { SceneDocument } from "./ir";
import type { HistoryEntry } from "./history";

/**
 * What Codex sees of a scene (v0.5): compact enough for every tool result, complete enough to patch it — every object's
 * id, name, type and parent, every animation and whether it runs, the notes the user must hear, and the revision a patch
 * should be based on. The whole document is available on request (inspect_interactive_card with full).
 */
export interface SceneSummary {
  sceneId: string;
  title: string;
  revision: number;
  intent?: SceneDocument["intent"];
  units: string;
  objects: { id: string; type: string; name?: string; parent?: string; hidden?: true; material?: string }[];
  objects_more?: number;
  materials?: string[];
  animations: { id: string; type: string; target: string; paused?: true }[];
  disclosure?: string[];
  history?: HistoryEntry[];
  can_undo: boolean;
  can_redo: boolean;
}

export function summarizeScene(doc: SceneDocument, revision: number, history?: { log: HistoryEntry[]; undo: number; redo: number }, max = 60): SceneSummary {
  const objects = doc.objects.slice(0, max).map(n => ({
    id: n.id, type: n.type, ...(n.name ? { name: n.name } : {}), ...(n.parent ? { parent: n.parent } : {}), ...(n.visible === false ? { hidden: true as const } : {}),
    ...(typeof n.material === "string" ? { material: n.material } : {}),
  }));
  return {
    sceneId: doc.sceneId, title: doc.title, revision, ...(doc.intent ? { intent: doc.intent } : {}),
    units: `${doc.units?.length ?? "unit"}, s, deg; y up`,
    objects, ...(doc.objects.length > max ? { objects_more: doc.objects.length - max } : {}),
    ...(doc.materials?.length ? { materials: doc.materials.map(m => m.id) } : {}),
    animations: (doc.animations ?? []).map(a => ({ id: a.id, type: a.type, target: a.target, ...(a.paused ? { paused: true as const } : {}) })),
    ...(doc.disclosure?.length ? { disclosure: doc.disclosure } : {}),
    ...(history ? { history: history.log.slice(-8) } : {}),
    can_undo: (history?.undo ?? 0) > 0, can_redo: (history?.redo ?? 0) > 0,
  };
}
