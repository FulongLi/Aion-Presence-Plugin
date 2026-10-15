# Presentation Router 2.0 (v0.5)

The v0.4 Presentation Router (`src/core/presentationRouter.ts`) decides BODY, CARD or HYBRID by *kind*: a
constellation is the body, code is a card, a portrait is both. Generated scenes have no fixed kind, since a "scene" can
be an hourglass of particles or an engineering assembly. Router 2.0 (`src/scene/router.ts`) decides from the scene
itself, and adds no second model or reasoning layer.

Codex has already interpreted the user and says so in the scene's `intent`. The router measures the scene's own
evidence, checks what each representation can really show, and applies fixed rules. The same scene therefore always
routes the same way (a unit test checks this), and every decision explains itself.

## Signals

| | from Codex (intent) | from the scene (evidence) |
| --- | --- | --- |
| **A. Concreteness** | `kind`: abstract 0.15 · concrete 0.7 · scientific 0.75 · structural 0.8 · engineering 0.9 | named or labelled objects, a hierarchy, real units |
| **B. Fidelity** | `fidelity`: symbolic 0.1 · illustrative 0.4 · approximate 0.7 · measured 1 | text (0.6), meshes, parametric surfaces and gears (0.65): things only exact rendering shows |
| **C. Interaction** | `interaction`: none 0 · view 0.3 · inspect 0.7 · edit 1 | metadata or annotations to inspect (0.6), a timeline to control (0.4) |
| **D. Capabilities** | | the particle adapter's `fit` (the share of objects the body can form) and whether a card can run (WebGL 2) |
| **E. Preference** | an explicit `presentation` (body, card, hybrid) from the user, or the scene's `presentation.mode` | |

## Rules

1. **Preference first, when possible.** `body` gives the body if the adapter can form anything; otherwise a card,
   with the reason. `card` gives a card. `hybrid` gives both if the body can form it; otherwise a card. A limitation is
   added when the user asked for the body but the scene is meant to be inspected.
2. **No card runtime → the body**, forming what it can (or nothing, said plainly).
3. **Abstract and look-only → BODY**: concreteness < 0.45, interaction < 0.5, fidelity < 0.6, and fit ≥ 0.6.
4. **Concrete but look-only → HYBRID** when the body forms it well (fit ≥ 0.6).
5. **Inspected, edited or exact** (interaction ≥ 0.5, fidelity ≥ 0.6, or an engineering intent) → **HYBRID** when the
   body forms it faithfully (fit ≥ 0.75), the scene is concrete (≥ 0.45), it is not engineering, and fidelity < 0.9.
   Otherwise → **CARD**.

So "the passage of time" (abstract, symbolic) is the body. A solar system (scientific, labelled, with metadata) is a
hybrid. A buck converter (engineering) is a card, because an engineering scene is never dissolved into particles
alone. A semantically abstract request still becomes a card when Codex declares it as something to inspect, and a
concrete object can still be the body when it is only to be looked at.

## Explanation

Every result includes `route` (in the tool's text and its structured output):

```json
{ "mode": "hybrid", "reason": "concrete and to be explored: the body forms it for a moment while the card stays for interaction",
  "transition": "the body keeps a particle form of the scene while the card opens beside it", "capability": "SUPPORTED",
  "signals": { "concreteness": 0.63, "fidelity": 0.7, "interaction": 0.7, "bodyFit": 0.88, "text": true },
  "requested": ["animation:path", "feature:labels", "geometry:arrow", "…"],
  "available": "modes body/card/hybrid; 20 geometries, 8 animations; compute backends: none",
  "limitations": ["body: text and labels are not formed in particles", "…"] }
```

## Capabilities

`src/scene/capabilities.ts` lists what a scene needs (implied by its content, plus its declared `requirements`) and
compares that with what the runtime has: SUPPORTED, PARTIALLY_SUPPORTED or UNSUPPORTED.

| Requirement | Without a backend |
| --- | --- |
| `geometry:*`, `animation:*`, `feature:*` | supported (all built-ins), or approximated (an unknown feature) |
| `render:shadows`, `post-processing`, `textures`, … | approximated, with a note of what is shown instead |
| `asset:model-url`, `asset:texture-url` | unsupported (the scene is shown without them: partial) |
| `compute:*`, `physics:*` with fidelity measured or approximate | **UNSUPPORTED**: refused, with what is missing ("accurate magnetic flux density needs a numerical field solver (FEM/BEM) …"); nothing is shown or substituted |
| `compute:*`, `physics:*` with fidelity illustrative | PARTIALLY_SUPPORTED: shown, with "Illustrative visualization: not computed by a numerical solver" added to its disclosures |

v0.5 has no computational backends. A future one (a field solver, a CAD kernel) registers its capabilities in
`RuntimeCapabilities.compute`, and the same request then routes as SUPPORTED (a unit test checks this).

## Transitions

| from → to | what the user sees |
| --- | --- |
| none → body | the body forms the scene |
| none → card | the card opens and the body steps aside, alive |
| body → card | the body releases its form and steps aside as the card opens (no particle-to-mesh morph: the two are different representations, and the router does not fake one into the other) |
| body → hybrid | the body keeps a particle form of the scene while the card opens beside it |
| card → card (same card) | the open card updates in place: a new revision, the same objects |
| card → body | the card closes and the body forms the scene |

While a card is open, Aion's body stays alive: it steps aside by layout, turns toward the selected object, calms its
background motion while the user drags, and keeps its audio-reactive behaviour. These are v0.4.5 behaviours that
generated scenes inherit unchanged.
