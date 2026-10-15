import type { SceneDocument } from "./ir";

/**
 * Scene history (v0.5): every accepted change is a new revision. Revisions only ever increase — undoing restores an
 * earlier document as a *new* revision, so a modification based on an old revision is always detectable (stale) and
 * nothing newer is ever silently overwritten. The history is bounded (the oldest entries go first) and plain data, so
 * the hub can keep it and report it.
 */
export interface HistoryEntry { revision: number; label: string; at: number }

export interface SceneHistoryState {
  /** The document as it is now and its revision. */
  document: SceneDocument;
  revision: number;
  label: string;
  /** Earlier documents (most recent last) and undone ones (most recently undone last). */
  undo: { document: SceneDocument; revision: number; label: string }[];
  redo: { document: SceneDocument; revision: number; label: string }[];
  /** The first document (reset returns to it). */
  origin: SceneDocument;
  /** Every revision made, newest last (bounded). */
  log: HistoryEntry[];
}

export const HISTORY_LIMITS = { undo: 32, log: 48 } as const;

export type HistoryResult = { ok: true; state: SceneHistoryState } | { ok: false; code: "stale-revision" | "nothing-to-undo" | "nothing-to-redo"; problem: string };

/** A new history: the scene as created, revision 1 (or after `revision` when a card replaces its scene). */
export function startHistory(document: SceneDocument, now: number, label = "created", revision = 1): SceneHistoryState {
  return { document, revision, label, undo: [], redo: [], origin: document, log: [{ revision, label, at: now }] };
}

const logged = (log: HistoryEntry[], entry: HistoryEntry) => [...log, entry].slice(-HISTORY_LIMITS.log);

/**
 * Commits a new document. `base` is the revision the change was made from: when the scene has moved on since, the change
 * is refused (stale-revision) instead of overwriting the newer state.
 */
export function commit(state: SceneHistoryState, document: SceneDocument, label: string, now: number, base?: number): HistoryResult {
  if (base !== undefined && base !== state.revision) {
    return { ok: false, code: "stale-revision", problem: `the change was made from revision ${base}, but the scene is at revision ${state.revision} now (inspect it and try again)` };
  }
  const revision = state.revision + 1;
  return {
    ok: true,
    state: {
      ...state, document, revision, label,
      undo: [...state.undo, { document: state.document, revision: state.revision, label: state.label }].slice(-HISTORY_LIMITS.undo),
      redo: [],
      log: logged(state.log, { revision, label, at: now }),
    },
  };
}

/** Restores the document before the last change, as a new revision. */
export function undo(state: SceneHistoryState, now: number): HistoryResult {
  const previous = state.undo.at(-1);
  if (!previous) return { ok: false, code: "nothing-to-undo", problem: "there is no earlier change to undo" };
  const revision = state.revision + 1;
  const label = `undo: ${state.label}`;
  return {
    ok: true,
    state: {
      ...state, document: previous.document, revision, label: previous.label,
      undo: state.undo.slice(0, -1),
      redo: [...state.redo, { document: state.document, revision: state.revision, label: state.label }].slice(-HISTORY_LIMITS.undo),
      log: logged(state.log, { revision, label, at: now }),
    },
  };
}

/** Re-applies the last undone change, as a new revision. */
export function redo(state: SceneHistoryState, now: number): HistoryResult {
  const next = state.redo.at(-1);
  if (!next) return { ok: false, code: "nothing-to-redo", problem: "there is no undone change to redo" };
  const revision = state.revision + 1;
  return {
    ok: true,
    state: {
      ...state, document: next.document, revision, label: next.label,
      undo: [...state.undo, { document: state.document, revision: state.revision, label: state.label }].slice(-HISTORY_LIMITS.undo),
      redo: state.redo.slice(0, -1),
      log: logged(state.log, { revision, label: `redo: ${next.label}`, at: now }),
    },
  };
}

/** Back to the scene as it was created (itself undoable). */
export function resetHistory(state: SceneHistoryState, now: number): HistoryResult {
  return commit(state, state.origin, "reset to the original scene", now);
}
