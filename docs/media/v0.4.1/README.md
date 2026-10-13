# v0.4.1 visual review

Everything here is from the real renderer (Chrome, WebGPU; the canvas fallback where named), produced by
`npm run showcase -- bodies-motion portrait-default map-usa terrain-scotland geo-coverage colors eyes eyes-motion`, which
drives the page through the **real MCP tools** (as Codex calls them). Animations are filmed frames at their real pace,
assembled by `scripts/media/gif.py`; the full recordings are `.e2e/showcase/*.webm`.

| File | Shows |
| --- | --- |
| [portrait-default.png](portrait-default.png) | Test A: "Show me Nikola Tesla" with no style → a heritage oval portrait and the original photograph; the classic portrait on request; Einstein and Newton by default |
| [eyes-expressions.png](eyes-expressions.png) | Test B: the redesigned cartoon eyes — neutral, attentive, thinking, curious, happy, surprised, confused, sleepy, concerned |
| [eyes-expressions-canvas.png](eyes-expressions-canvas.png) | The same in the Canvas 2D fallback |
| [eyes-motion.gif](eyes-motion.gif) | Eyes animation: blink (squash and rebound), happy hop, surprise pop, confused wobble, thinking narrow-then-glance, curious tilt, falling asleep |
| [body-transitions.gif](body-transitions.gif) | Sphere → eyes → figure → sphere: one particle body re-forming |
| [map-usa.png](map-usa.png) | Test C: the United States; Los Angeles in red; New York in yellow; San Francisco highlighted; Los Angeles recoloured blue; New York removed — one map throughout |
| [marker-pop.gif](marker-pop.gif) | A marker appearing on the formed map |
| [map-usa-hybrid.png](map-usa-hybrid.png) | The hybrid route: the particle map and a crisp reference map card with coordinates |
| [terrain-scotland-glasgow.png](terrain-scotland-glasgow.png) | Test D: Scotland's terrain; Glasgow in red; Edinburgh and Ben Nevis — pins standing on the relief |
| [geo-coverage.png](geo-coverage.png) | Maps of Africa, Europe, Japan, China (中国), Russia, Fiji (date line), Antarctica (pole), the world, Svalbard, California (OpenStreetMap); terrain of Africa, China, Japan, Iceland |
| [colors.png](colors.png) · [colors.gif](colors.gif) | Test E: Aion Silver → blue → purple (紫色) on the sphere, eyes and figure; warm gold with a #00BFFF accent marker; back to silver |
