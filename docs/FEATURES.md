# What Aion does

Aion is the visual presence of the Codex agent you already use. Codex does the reasoning and the work; Aion listens,
reflects what is happening, answers visibly and shows things. You never name a tool — ask to see something and Codex
picks the presentation. This page lists the capabilities by area, with things to say; each area links to its detailed
document. Release-by-release changes are in [CHANGELOG.md](../CHANGELOG.md).

## Presence and bodies

- **Three persistent bodies**, one Aion: the particle **Sphere** (abstract intelligence, visuals), **Aion Eyes**
  (conversation, attention, expression) and the **Particle Figure** (gesture, explanation). Every visual forms out of,
  and returns to, the chosen body; switching bodies is one particle transition. [EYES.md](EYES.md), [FIGURE.md](FIGURE.md)
- **A spoken welcome** (v0.7): the first time Aion's window opens, Aion introduces itself aloud in a few sentences
  (English or Chinese, the system's own on-device voice), its body answering as it speaks; Skip, Replay, captions.
  [HOST.md](HOST.md#v07-the-spoken-welcome)
- **Real state** from Codex's lifecycle hooks: listening (locally), thinking, reading, editing, testing, building,
  answering. [HOST.md](HOST.md)
- **Immersive mode**: "Open Aion" gives the cleanest Aion-only view the environment permits.
- **Your colours**, remembered. [COLORS.md](COLORS.md)

```text
"Open Aion."                         → Aion comes to the foreground, waves once and says hello
"Show your eyes." · "Look happy."    → two cartoon eyes, smiling: ^ ^
"Change your colour to blue."        → every particle turns blue (remembered); "Restore your original colour" → silver
"Explain a² + b² = c²."              → the figure looks at the equation, points at c² and explains with its hands
```

## Showing things

- **Portraits and pictures** of almost anything, from open sources (heritage oval portraits by default).
- **Maps** of any country, continent or region with markers at real coordinates; **terrain** from elevation data.
  [MAPS.md](MAPS.md), [GEO-COVERAGE.md](GEO-COVERAGE.md)
- **Routes** (v0.6): real walking, cycling and hiking routes drawn on the particle terrain, with the Route Explorer card —
  the exact map, an elevation profile linked to the body, distance, time and climbing. [ROUTE-EXPLORER.md](ROUTE-EXPLORER.md)
- **Aion's own forms**: Tao symbols, trigrams, constellations, zodiac and planetary signs, clocks, numbers, words,
  symbols, emoji, and genuine **3D objects** from validated primitives. [SCENES.md](SCENES.md)
- **Codex's work**, concisely: results, code excerpts, file changes, diagrams and local images in quiet cards. Logs
  never go into Aion.
- **The Presentation Router** decides body, card or both from what the information is. [architecture.md](architecture.md)

```text
"What did Nikola Tesla look like?"         → a heritage portrait beside the original photograph
"Show me where Los Angeles is in the USA." → the United States, a marker at Los Angeles; "Mark New York in yellow."
"What is the terrain of Scotland like?"    → Scotland's real relief
"Plan a cycling route from Glasgow to Edinburgh." → the route on that relief, the map and profile beside it;
                                              "Show me the highest point." "Reverse the route."
"Show me an Egyptian pyramid in 3D."       → a 3D pyramid that turns; drag it, zoom, reset
```

## Teaching

- **Handwriting**: about 9,500 Chinese characters (simplified and traditional, offline) written stroke by stroke in
  their true shapes beside a reference card; English letters, words and names; music symbols.
  [CHINESE-WRITING.md](CHINESE-WRITING.md), [STROKE-ANIMATION.md](STROKE-ANIMATION.md)
- **Music**: engraved notation, playback where each note lights as it sounds, lessons in English and Chinese, a
  glossary of introductory notation. [MUSIC.md](MUSIC.md)
- **Stories and short animations** of the figure. [STORYTELLING.md](STORYTELLING.md), [ANIMATION.md](ANIMATION.md)

```text
"Teach me how to write 永."            → the body writes 永's strokes in order, beside a card writing the same stroke
"Repeat the third stroke."             → strokes 1–2 stay; the third is written again
"Play the C major scale."              → the scale appears and plays; each note lights as it is heard
"Show a stick figure jumping over a box." → the figure gathers, jumps, lands soft, returns
```

## Interactive cards and generated scenes

- **Card 2.0** runs registered 3D applications beside the living body in an isolated sandbox: the **Earth–Moon
  system** and a **CAD viewer** for glTF/GLB models. [CARDS.md](CARDS.md), [EARTH-MOON.md](EARTH-MOON.md), [CAD-VIEWER.md](CAD-VIEWER.md)
- **Generated scenes**: describe what you want to see and Codex writes it as a Scene IR document; Aion validates it,
  says what it can honestly show, and builds it as a card, in the body, or both. Every later request is a validated
  patch of the same scene, with undo. Styles and material presets give engineering, scientific and presentation
  looks; you can move, rotate and resize objects by hand. Requests that need a numerical solver are refused plainly;
  illustrations say they are illustrations. [GENERATIVE-VISUAL-ENGINE.md](GENERATIVE-VISUAL-ENGINE.md)

```text
"Create a 3D solar system with the Sun and eight planets." → generated, animated, beside a body that forms it too
"Make Earth three times larger." · "Stop Mars." · "Undo that." → the same scene, changed in place
(click an object, press W, drag it) → moved by hand, as a new revision Codex sees
"Create a simplified Dual Active Bridge converter." → an engineering scene, labelled as not a simulation
"Calculate an accurate magnetic flux density field." → Aion says it has no field solver; nothing is faked
```

- **Parametric CAD in FreeCAD** (v0.7, with FreeCAD installed): Codex creates and changes real `.FCStd` documents —
  primitives, holes that follow the body's size, constrained sketches, pads, pockets, booleans, fillets, undo, save —
  and the CAD viewer shows each revision FreeCAD recomputed, keeping your view and selection. [FREECAD.md](FREECAD.md)

```text
"Create a 120 by 80 by 40 mm enclosure in FreeCAD." → a real FreeCAD box, shown in the CAD viewer
"Make it 20 mm longer." · "Add four 6 mm mounting holes near the corners." → recomputed in FreeCAD, shown in place
(click a hole) "Move this hole 5 mm inward." → that hole's insets change; "Undo that." → FreeCAD's own undo
"Save the model." → a native, editable .FCStd
```

- **Engineering simulation** (v0.8, with Gmsh and Elmer FEM installed): Codex sets up and runs real finite-element
  studies on the FreeCAD model — DC current conduction, steady heat conduction, electro-thermal — and the Simulation
  Card shows the computed fields with a legend, sections, vectors and probes. Change the part and run it again;
  unsupported analyses are refused, never estimated. [SIMULATION.md](SIMULATION.md), [SIMULATION-CARD.md](SIMULATION-CARD.md)

```text
"Create a copper busbar, 100 by 10 by 5 mm." → "Run a DC current-density analysis with 100 A." → R, losses, |J| shown
"Use the losses to calculate the steady-state temperature; the ends are held at 40 °C." → temperature, heat balance
"Show me the temperature inside the conductor." → a section · "Make it 8 mm thick and run it again." → compared
(click a face) "Apply 10 volts to this face." → that face becomes a terminal
```

## Sound

- One analyser for every source — the microphone, a shared tab, the Music Library, other apps and (on macOS, with
  permission) Codex's own voice — moves the sphere and draws a circular particle spectrum for music. Nothing is
  recorded or uploaded. [AUDIO-REACTIVE.md](AUDIO-REACTIVE.md), [AUDIO-BRIDGE.md](AUDIO-BRIDGE.md), [MICROPHONE.md](MICROPHONE.md)

```text
"Visualize the music."       → the music you play becomes a circular particle spectrum
"React to your own voice."   → on macOS, with your permission, Aion moves with Codex's real voice
```
