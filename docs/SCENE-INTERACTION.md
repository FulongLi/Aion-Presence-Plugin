# Scene interaction, state and editing (v0.5, v0.5.1)

## Four kinds of state, kept apart

| | What | Where | Authoritative |
| --- | --- | --- | --- |
| Scene definition | the Scene IR document, its revision and history | hub: `card.scene` (document, revision, log); earlier documents in the store | the hub |
| Runtime state | timeline time and speed, playing, built objects, triangles, the last change (`changes`, `buildMs`) | the card, reported as declared state | the card |
| Interaction state | the selection (id, name, kind, metadata, screen position), the camera view | the card, reported as `selection` and `view` | the card |
| Presentation state | route (body, card, hybrid), layout, lifecycle | hub: `presentation`, `card.layout`, `card.lifecycle` | the hub (router), the card (lifecycle) |

Per-frame render state (poses, particle positions) is never stored or streamed. The scene document holds only the
definition.

## Every object is addressable

Every node has a stable id, a type, a display name, a transform, material values, metadata, a parent and the
operations a patch can apply to it. A click (pointer down and up within 5 px) picks the nearest selectable object.
The card highlights it (an accent box that follows it as it moves), shows an inspector (name, type, note, parent,
world position, colour, metadata, Focus, Clear), and reports `SELECTION_CHANGED` with those properties and its exact
screen position. Aion's body then turns toward it. Lines, labels and point clouds are not selectable by default
(`selectable: true` makes them so).

Direct interaction: orbit (drag), zoom (wheel or pinch), pan (right-drag), focus (the inspector's button or `focus`),
standard views (`set-view` iso, top, front, side; the bar's Fit and Top), reset camera, select and clear, a labels
toggle, timeline speed and a seek slider. Moving objects by dragging is not offered: geometry changes go through
patches.

## "Make this object twice as large"

1. The user clicks Earth. The selection reaches the hub (`card.selection.objectId: "earth"`).
2. The user says "Make this object twice as large." This is a new turn. A click cannot start one: no host offers
   that without undocumented APIs, so the selection waits for the next turn.
3. Codex calls `inspect_interactive_card`: "Selected: Earth (id "earth"; "$selected" in a patch)", with its metadata.
4. Codex patches `{ "op": "transform", "id": "$selected", "scaleBy": 2 }` with the revision it saw.
5. The hub resolves `$selected` from the reported selection, applies the patch to a copy, validates the whole
   document, checks the base revision and commits a new revision.
6. The page sends `LOAD_SCENE` (that revision) to the card. The compiler updates Earth's holder (same object, same
   geometry, same material). The card reports `changes: "0 created, 1 updated, 0 rebuilt, 0 removed"` and acknowledges
   the revision.
7. The tool returns "Done and rendered (revision N): transform earth (earth)" and only then. An accepted change that
   is not yet built says "Accepted … not confirmed", and with no window open it says "not displayed yet".

## Patches

A patch is a list of operations (`src/scene/patch.ts`): `add`, `update`, `transform`, `remove`, `reparent`,
`material`, `add-animation`, `update-animation`, `remove-animation`, `camera`, `environment`, `timeline`,
`presentation`, `meta`. Selection, clearing it, viewing and playback are card commands (`select`, `clear-selection`,
`focus`, `reset-camera`, `set-view`, `set-speed`, `seek`, `show-labels`, `pause`, `resume`, `reset`), because they
are interaction state and not scene definition.

- **Transactional**: all operations or none. A failure names the operation and why (`operation 2: no object
  "pluto"`), and the scene is exactly as it was.
- **Validated as a whole**: after the operations, the result must pass `validateScene`.
- **Copy on write for shared materials**: recolouring one object that uses a shared material gives it its own copy
  and the others keep theirs. Recolouring the shared material (`material` op) changes all of its users in place.
- **Removal cascades**: removing a node removes its descendants and any animation that needs them (target, centre,
  path, look-at, or a coupling to a removed spin). A point cloud along a removed path makes the patch fail instead of
  guessing.

## Revisions and history

Every accepted change is a new revision (`src/scene/history.ts`). Undo restores an earlier document **as a new
revision** and does not rewind the number, so a change based on an old revision is always detectable. A patch sent
with `revision` (its base) that no longer matches is refused with `stale-revision`, and a newer state is never
silently overwritten. The history keeps 32 undo steps and a 48-entry log (revision, label, time), which
`inspect_interactive_card` reports. `revert` returns to the scene as created, and that is undoable too. Showing the
open card a different scene is also a revision of the same history.

## Editing by hand (v0.5.1)

Select an object (click it) and the inspector shows its transform (in the document's units), material (swatch and
preset), the motions acting on it (with stopped ones marked) and its facts; the object is tinted and outlined in the
accent colour and its label is highlighted. **Move**, **Rotate** and **Scale** (or W, E, R; Esc leaves the tool) attach
a transform gizmo. When the drag ends, the card *proposes* the new transform (`EDIT`, see
[CARD-BRIDGE.md](CARD-BRIDGE.md)) against the revision on show:

- the hub turns it into a `transform` patch, validates it like any other, and records a revision labelled
  "moved Inductor (by hand)" — so it is undoable, appears in Codex's history and makes Codex's older revisions stale;
- the object stays where it was dropped for up to four seconds; when the new revision arrives the card says
  "Moved Inductor · revision 3"; if the change is refused (stale, invalid) the page says why and the object returns to
  the document's transform;
- tools are refused where the scene's own motion would undo them every frame (moving an object on an orbit or path,
  turning one that tracks a target, resizing one with scale keyframes) — the card says so;
- **Undo** and **Redo** in the card's bar are the same history Codex uses (`control_interactive_card` undo/redo).

The card never edits its own scene: a direct manipulation is always a validated Scene Patch.

## Readable labels and framing (v0.5.1)

Labels sit beside their object (below, above, right or left — the first free place), the selected object's first,
then the largest; a label with no free place is hidden rather than stacked over another. The camera frames the drawn
shapes (sampled vertices, not bounding-box corners) across the scene's motion (eight moments of its longest cycle),
keeps a grown or moved scene in view after a revision (a framed view is framed again; the user's own view keeps its
angle and only moves back), and sets near and far planes from the scene's size.

## The card confirms; the hub records

```
MCP tool ──scene command (request id)──► hub store ── outcome {request, ok, revision, summary | code, problem}
                                              │
                         snapshot (card.scene.document, revision)
                                              ▼
page card host ── LOAD_SCENE {revision, document} ──► card (validates again, compiles)
       ▲                                                   │
       └── report {scene: {revision, ok, problem?}} ◄── RESULT (after the state it changed)
                                              │
                hub: card.scene.rendered ── the tool waits for it, then answers
```

If the card cannot build a revision (a resource limit inside the card, an internal failure), the previous scene stays
on show, the card reports why, and the tool undoes that revision so the document and the picture agree. The answer
says so.
