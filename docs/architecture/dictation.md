---
type: Reference
title: Dictation
description: How push-to-talk dictation resolves its target and refuses password fields, how the Best, Balanced and Light presets map to live and refinement models per language, when the kangentic-dictation worker is recycled for memory, and how Cloud refinement sends only the final clip.
tags: [dictation, speech, models, worker]
sources:
  - resource: src/main/transcription/dictation-worker.ts
  - resource: src/main/transcription/dictation-client.ts
  - resource: src/main/transcription/transcription-service.ts
  - resource: src/renderer/hooks/useDictation.ts
  - resource: src/renderer/utils/dictation-hold.ts
  - resource: src/renderer/utils/keybindings.ts
    title: matchesMouseRelease, matchesMouseChordPress
  - resource: src/main/ipc/handlers/transcription.ts
  - resource: src/renderer/components/dictation/LiveDictationChip.tsx
  - resource: src/main/transcription/engines/engine-selection.ts
  - resource: src/main/transcription/models/model-registry.ts
  - resource: src/shared/dictation-presets.ts
    title: DICTATION_PRESETS, resolveDictationSlots
---
# Dictation

Free, fully-local push-to-talk voice-to-text into whatever the user is focused in: hold a key
(default a mouse side button), speak, watch a live transcript stream into the target, and on release
the finalized text is inserted (and optionally submitted). The TARGET is resolved by precedence, and
a focused text field outranks every terminal tier - any input, textarea, or rich-text host anywhere
in the app, plus fields inside an embedded browser's guest page; a terminal is the fallback, not the
rule. A password field REFUSES outright rather than falling through to a terminal, and says so on the
chip. Because the default binding is a mouse button that also means "back", press DURATION separates
the two: a hold dictates, and a tap under `NAVIGATION_TAP_MS` instead navigates an active Browser
pane's history. See `docs/architecture/embedded-browser/decision-log.md` decisions 21 and 24 for the target rules in full.
Global-only (App Settings only; no per-project override).
Engines run on-device via `sherpa-onnx-node`; a Cloud refinement option routes only the final clip to
an OpenAI-compatible endpoint. The engines live in the `kangentic-dictation` utility process, which
is sized to its use: while dictation is enabled it keeps only the live (streaming) model
resident, the refinement model loads on the first press and overlaps the utterance, and a worker that
has loaded it is recycled 30 minutes after its last session (a process exit is what gives the
model's memory reservation back) and comes back live-only. On Windows, a worker whose memory has
grown past 1.5 GB of commit is recycled at the next two-minute gap instead, since the models grow
with use and a heavy user never leaves a half-hour gap. The commit figure is read when a request
finishes and once more at the two-minute mark, so a worker that kept growing after its last request
is caught too. That figure comes from Electron on Windows only, so macOS and Linux always use the
half-hour window. A worker that has only pre-warmed stays resident while under that ceiling. Each
language or preset switch pre-warms another engine, and a disposed engine's memory stays reserved,
so a worker that has warmed a second engine is recycled after the same half-hour window on every
platform, and on Windows, past 1.5 GB of commit, at the two-minute gap instead. Either recycle
re-warms only the engine in use. Each recycle logs its reason (`ceiling`, `served-session` or
`engine-switch`) and the commit it gave back. Turning dictation off releases the worker at once.
A renderer reload does not release it. The renderer sends no warm or release until its first
config load lands, so the warm worker survives and the reloaded renderer's warm finds it. Only the current
worker's exit counts as a crash. A killed worker's exit, which lands after the kill, is never one.
The status chip shows at idle only while a model downloads. A failed download shows on that
model's line in the Dictation tab. A background warm that fails to load the engine is only logged,
and the next warm or press retries it. A press that fails says so on the chip.

A model whose files the addon refuses replaces itself. Since sherpa-onnx 2.0 a corrupt file rejects
at load rather than aborting the worker (measured with truncated and garbage files through both
load paths), and installed means only that the files exist, so the same file would fail every press.
The worker names the model in a `model-load-failed` message, separate from any reply because a
refinement model fails behind the live fallback where no request sees it. Main waits for any prep
already running, since a prep past the delete would start a second download into the same `.part`
file. It then deletes the model, downloads it again with the usual progress, and re-warms. The
press that hit it shows its error
once, or commits its live text if only the refinement model was bad. Models carry no checksum, so a
load failure cannot be told from corruption, and an out-of-memory failure reads the same. Each model
is replaced at most once per run, which caps that at one download per launch. A delete Windows
refuses downloads nothing, so it spends no replacement and the next failed load tries again. A file
that parses but is the wrong kind of model still exits the worker, and this does not reach it.

The Mode choice is a preset for each language. Main resolves it to models each session
(`resolveDictationSlots` in `src/shared/dictation-presets.ts`), so a preset follows the lineup
when it changes, and a model it no longer runs is replaced by a download, as on a first install.
Each step up costs a bigger download for better text, and every preset transcribes in a fraction
of real time on a CPU:

| Mode (stored value) | English | Another language |
|---|---|---|
| Best (`accurate`) | Nemotron streaming live, Parakeet v3 refines | Nemotron 3.5 live; Parakeet v3 refines where it covers the language, else Whisper small (multilingual) |
| Balanced (`balanced`) | Parakeet v3 live (chunked), no refinement | Parakeet v3 live where it covers the language, else Nemotron 3.5; no refinement |
| Light (`fast`) | Streaming Zipformer live, no refinement | Whisper base (multilingual) live, no refinement |

Parakeet v3 covers English, Portuguese, Spanish, Italian, French, German, Dutch, Russian, Polish
and Ukrainian. A capable machine (the `accurate-base` tier) defaults to Best, a weak one
(`streaming-tiny`) to Light. Custom offers every model, among them Parakeet unified, Parakeet v2
and Cohere Transcribe (2,754 MB, refinement only). The lineup was chosen by measurement
(`node scripts/measure-dictation-models.mjs`), and the table of results is in the docblock of
`src/main/transcription/models/model-registry.ts`. That table predates sherpa-onnx 2.0, which
changed the offline NeMo features. Parakeet v3 on 20 synthesized prompts and 2 read clips (290
words) went from 3.45% to 3.79% word error at normal level, one word, and from 78.62% to 4.14% at
-50 dB, so a quiet microphone now works. Under the Mode choice, the tab lists the two
models that run, one line each (Live model, Refinement model) with its size, its download share
or None, and a License line links each running model's license. Parakeet unified and Nemotron
streaming are licensed by NVIDIA Corporation under the NVIDIA Open Model License.

## A hold and its release

A hold has to end exactly once, whatever else the mouse does, because the user clicks and draws
during one. Measured on Chromium through CDP, with Back and Left overlapping in all four orders: a
button that changes while another is down arrives as a `pointermove` naming it, and `pointerup` fires
only for the last button up. Back lifted under a held Left is a move, and the `pointerup` after it
names Left. That is the release a check on `pointerup`'s `button` missed, so a hold stayed on
recording until the next press, and that press was swallowed. A real mouse showed a second way to
lose one: the window lost OS focus for about 90 ms mid-hold, no `pointerup` for Back ever arrived, and
`buttons` read 0 when focus came back. What took the focus was not identified.

So a release is read from `buttons`: any mouse pointer event that lacks the bound button ends the
hold (`holdEndFromPointer` in `src/renderer/utils/dictation-hold.ts`). A left press adds a bit and
leaves the bound one set, so it never ends a hold, and a touch or a pen is ignored. A hold also ends
on `pointercancel`, on a press of the bound button (the release was missed), and when main reports
that the OS window lost focus. That report is `BrowserWindow` `blur`, not DOM `window` blur, which
also fires when a click moves focus into a Browser pane guest. A press during finalize is refused:
starting would drop the sink and the count of what it wrote, so the erase would remove nothing. Only
a lift of the bound button itself can be a navigation tap, so a press that recovers a hold never
navigates. The microphone prompt macOS shows on first use should take OS focus too, which would end
that first hold, and the next press records. That is unmeasured: the blur was seen on Windows only.

The press is not canceled. A canceled `pointerdown` suppresses every compat mouse event until the
last button lifts, so a click on a terminal during a hold never reached xterm's `mousedown`. The
bound button's own `mousedown` and `mouseup` are stopped by name instead. Stopping that `mouseup`
also matters on its own: on an unconsumed Back release Chromium went back through history in the
measuring harness.

A press with another button down is a `pointermove` too, so `useKeybinding` takes `chordedPress`,
which only dictation sets. A one-shot action such as the middle-click close stays on `pointerdown`.
The drawing overlay starts and ends a stroke on the same kind of move (`chordedStrokeChange`).

If a Back press lifts while Left is down, Chromium fires `auxclick` for Back and no `click` for
Left, with or without dictation. The left `mousedown` and `mouseup` still land.

A guest consumes the mouse, and Electron's `InputEvent` modifiers carry no back or forward flag, so
the `buttons` check is host only. A guest hold ends on the forwarded up, on `mouseLeave`, on the
guest's destruction, on main's blur, and on a second press.

Every press, refused press and hold end writes a `[dictation-hold]` line to
`.kangentic/logs/<date>.log` with how the hold ended and no spoken text. It is at `warn`, the one
level the log mirror keeps in a production build, and it is what names the cause of the next report.
Only a hold end carries a target, because a press comes before its target is known. Read it with `kangentic_tail_logs`, beside the `transcribe:*` timing in the IPC log.

## The live preview in a terminal

A terminal target types each partial into the agent's prompt and erases the last one with a run of
DELs, which eat what sits before the cursor. If the cursor moved, the head of the live text goes, the
tail survives, and the paste lands in front of it. Main therefore puts the adapter's `promptEndKeys`
at the head of every live write and of the submit's erase, in one write with the DELs.

For Claude that is Ctrl+E. Replayed on 2.1.319 on Windows with an Up arrow, a click and left arrows between
partials, every send came out clean, and a paste right behind the erase landed clean too. End stops
at the end of the visual row, Ctrl+End does nothing, and Ctrl+U would destroy a draft.

The keys lead the first partial too, so dictation always appends after a draft and a cursor placed
mid-draft is ignored. Nothing in Kangentic knows the TUI's cursor column, so no other rule keeps a
draft safe. In a multi-line draft Ctrl+E stops at the end of the cursor's own line, so the words land
there and later partials find them. A cursor moved to another line of that draft mid-hold is still
exposed, as is an agent with no measured keys, which keeps the old bytes. Typing during a hold lands
inside the erase range.

The `dictation.*` keys, with their types and defaults, are listed in
[App config keys](../settings/app-config.md#dictation).
