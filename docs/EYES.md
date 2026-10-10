# Aion Eyes

The third persistent body (v0.4), for daily conversation, attention and expression. It is the same Aion and the same
particles as the sphere and the figure: switching bodies is one particle transition, and every temporary visual
still forms out of the eyes and returns to them.

```text
set_body_form { "body": "eyes" }        "Show your eyes."
express { "expression": "happy" }        "Look happy."
```

## Design

Two lenses of light, in Aion's silver-white particle language on black. Minimal, friendly and calm rather than
cartoonish. Each eye is drawn procedurally (no image asset) from five components:

| Component | Share | What it is |
| --- | --- | --- |
| rim | 27 % | A fine bright outline of a superellipse (n = 2.6, between an ellipse and a rounded square). The lids reshape it. |
| fill | 11 % | A faint glassy interior, a little denser toward the middle. |
| iris | 44 % | A ring from the pupil's edge to the iris rim, densest at both edges, with fine radial texture and a slow shimmer. The dark pupil is where there are no grains. |
| glint | 6 % | The spark of life: a bright point up and to the left, a smaller one opposite. |
| brow | 12 % | Rests on the top of the rim, thickening the upper lid line, until an expression lifts it out into an arc. |

Geometry: `src/core/eyes/layout.ts` (binding and the CPU reference `eyesPoint`), evaluated identically on the GPU by
`src/render/physics/eyes.ts`. Per eye, 16 live parameters: centre and size; upper and lower lid closure; upper lid
slope; lower lid smile; gaze; iris size; glint; brow lift, slope, arch and amount. The lids clip the shape and
squash it into the visible band. A blink flattens the eye to a line. A smile lifts the lower edge into a crescent.
The iris squashes with the lids, as robot eyes do, so no particle ever disappears.

## Expressions

`src/core/eyes/expression.ts`. Each is a shape for each eye, plus a roll and a bounce of the pair. Slopes are
"inner-positive", so each eye mirrors the other naturally.

| Expression | Shape |
| --- | --- |
| neutral | Open, centred. |
| attentive | A little wider, irises open, brows lifted slightly out of the rims. |
| thinking | Gaze up and aside, lids lower, one brow raised more than the other. |
| curious | A tilt; one eye larger with its brow up. |
| happy | Lower lids curve up into crescents, smaller irises, soft brows, a little bounce. |
| surprised | Wide and tall, small irises, brows high. |
| confused | One eye narrowed under a lowered brow, the other open under a raised one, a tilt. |
| sleepy | Heavy lids, drooping outer corners, the gaze lowered, slow blinks. |
| concerned | Inner brows up, soft outer lids, the gaze a little down (errors). |

## Behaviour

| Aion's state | Eyes |
| --- | --- |
| idle | Neutral, blinks every 2.5–6 s (sometimes twice), saccades every 1.2–3.2 s with stillness between. After two quiet minutes they grow sleepy; anything wakes them. |
| listening | Attentive, holding the user's gaze (small saccades). The user's loudness widens them, opens the irises and lifts the brows a little. |
| thinking, working… | Thinking: the gaze drifts up and aside. |
| reading | The gaze scans along a line in small steps, then returns to the start of the next. |
| responding | Lids and brows move a little with the thought, each on its own slow rhythm: never a loop. |
| complete | A brief happy moment, then neutral. |
| error | Concerned. |
| greeting | Happy. |
| a card appears | A glance toward it; with an emphasised term, a curious look. |

A state change is met with a blink, as people blink when their attention shifts. An acknowledgement dips both eyes
like a nod.

**Manual expressions.** `express` with an expression, or a gesture mapped to its nearest expression (wave → happy,
jump → happy, shrug → confused…). It is held for about four seconds (`seconds`, 1–30), then the state's expression
returns. Blinking and gaze continue throughout.

## Proof

- Real renderer: `npm run showcase -- eyes transitions` (all nine expressions; sphere → eyes → figure → sphere).
- Tests: `tests/v4.test.ts` (distinct, bounded expressions; blink and smile geometry; blinks, saccades, voice and
  requests over time; three-body switching; `express` on each body).
- Smoke: the eyes body forms and `express` reaches it, in WebGPU and in the canvas fallback.
