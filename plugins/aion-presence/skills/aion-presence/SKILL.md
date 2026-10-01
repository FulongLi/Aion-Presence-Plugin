---
name: aion-presence
description: Use Aion, the visual body of this Codex session, when the user asks to open, see or talk to Aion, or when an open Aion should reflect meaningful work or present a concise result, image, diagram or visual form. Aion is not another AI model; Codex stays the intelligence.
---

# Aion Presence

Aion is the embodied presentation surface for **you, the Codex agent**. You do all reasoning and all work, as
usual. Aion is your body: a quiet particle presence (a sphere, or a minimal particle figure) that reflects
what you are doing and presents what you produce.

- Aion is **not** a second AI, assistant or personality. Never speak "as Aion" to a different agent, never
  hand work to Aion, and never describe Aion as thinking for itself.
- Aion makes no model calls and needs no API key. Never ask the user for an OpenAI key, a token or a login
  for Aion, and never try to start a microphone or voice session for it. If the user talks to you by voice
  in Codex, that conversation stays yours; Aion only shows its state.
- If asked who Aion is: Aion is the visual presence of Intelligent Presence, created by Spirit Connect (led
  by Fulong). Here it is the body through which the user sees Codex working. Keep these names unchanged in
  every language.

## Opening Aion

When the user says "Open Aion" (or "show Aion", "wake Aion", "打开 Aion"), call `open_presence` once. Pass
`body: "figure"` if they ask for the human form, and `display: "fullscreen"` if they ask for fullscreen.

Read the result and tell the user in one short sentence what happened:

- `surface.mode: "embedded"`: Aion is shown inside the host.
- `surface.mode: "companion"` with `window_opened: true`: Aion opened in its own window.
- `window_opened: false` and not open: give the user the `url` to open; do not retry in a loop.

Fullscreen exists only where the host offers it. Never claim Aion is fullscreen, or embedded, unless the result
says so. Do not call `open_presence` again on later turns: Aion stays open.

## Reflecting real work

Only reflect activity that is actually happening. Never invent a state.

- `surface.hooks: "active"`: Codex's lifecycle hooks already show thinking, reading, editing, testing,
  building and completion automatically. Do **not** call `set_presence_state` for those. Use it only for
  phases the hooks cannot see, for example `thinking` while you reason through a design before touching
  files, or `error` when you have diagnosed a failure that blocks the task.
- `surface.hooks: "not-detected"`: set the state at the start of each meaningful phase only: `thinking`
  when you start on the task, `reading` when you survey the repository, `editing` when you change files,
  `testing` / `building` when you run them, and `complete` or `error` at the end. A handful of calls per task,
  not one per command.

A short `label` (e.g. "Running the test suite") is optional. Never put logs, paths with secrets, or long text
in it.

## Presenting results

Aion's body becomes information and then returns to its persistent body (sphere or figure). Present when
seeing it helps the user, typically once per meaningful outcome:

| Situation | Tool |
| --- | --- |
| Tests, a build or a task finished | `show_result` with a title, a one-line summary, `status` and ≤ 8 short details |
| A single figure or word matters ("48/48", "Done") | `show_text` (≤ 16 plain characters become the body itself) |
| You generated or found an image, screenshot or diagram | `show_image` with its absolute local path (`mode: "framed"` when detail matters) |
| Architecture or structure is easier seen than read | `show_artifact` `type: "svg"` with a small SVG you write |
| The key code change, the files touched, a short list | `show_artifact` `type: "code"`, `"changes"` or `"list"` |
| The user asks for a concept Aion can draw | `show_visual_form` (yin-yang, bagua, trigrams, constellations, zodiac and planetary signs, symbols) |
| The user asks for the human form or the sphere | `set_body_form` |

Example after a successful change:

```json
{ "title": "Done", "summary": "48 / 48 tests passed", "status": "success",
  "details": ["8 files changed", "Build successful"] }
```

Keep presentations concise. Never dump terminal output, whole files or long explanations into Aion: the
details belong in your reply in Codex. Presentations end by themselves; use `clear_presentation` only when the
user asks or the content became wrong.

## Restraint

- Aion is quiet. If Aion is not open, do not open it just to present something unless the user asked for
  Aion or for something visual.
- Do not call Aion tools for internal steps, retries or every file you read.
- Do not narrate the tool calls ("I am now setting Aion's state to…"). Mention Aion only when it helps the user.
- If an Aion tool fails, carry on with the task; Aion is never a reason to stop working.
