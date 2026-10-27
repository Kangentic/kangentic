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
`src/main/transcription/models/model-registry.ts`. Under the Mode choice, the tab lists the two
models that run, one line each (Live model, Refinement model) with its size, its download share
or None, and a License line links each running model's license. Parakeet unified and Nemotron
streaming are licensed by NVIDIA Corporation under the NVIDIA Open Model License.

The `dictation.*` keys, with their types and defaults, are listed in
[App config keys](../settings/app-config.md#dictation).
