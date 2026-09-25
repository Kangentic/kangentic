---
paths:
  - "src/main/agent/**"
---
# Rule: prefer an agent CLI's native features over Kangentic custom layers

When an agent CLI already exposes its own controls for model selection, permission / autonomy
mode, or default settings, do not shadow them with Kangentic-side flags or per-spawn settings
injection. Spawn the binary with the minimum needed and let the CLI's native UX handle the rest.
Adding a Kangentic-managed layer on top of working CLI features is wasted code and a maintenance
burden.

## The rule

- For a new agent adapter, prefer a thin command builder: spawn with `cwd`, resume id, and
  prompt only. Inject custom config ONLY when the CLI cannot be configured interactively at all
  (e.g. Claude's hook system, which is genuinely required for activity tracking and has no in-TUI
  alternative).
- Do not pin `model` via per-spawn settings if the CLI has its own model picker with
  default-pinning. Tell the user to set the default in the CLI once.
- For permissions, when an agent manages autonomy in its TUI, expose at most a single "Default"
  entry and document that the user controls it via the agent's own controls.
- For BYOK or env config, rely on the CLI's documented config file rather than duplicating it
  through Kangentic-managed overrides.
- **Never keep a list of model names or ids.** We do not track model releases, and a stale list
  is worse than none: it offers models the CLI no longer serves and hides the ones it does. An
  adapter gets its models one of two ways. Ask the CLI, when it can be asked (`cursor-agent
  --list-models`, `agy models`, `ollama list`, grok's own models cache); or derive the label from
  the id (`humanizeModelId`), which needs no table. When neither is possible, report no list and
  let the renderer fall back to its free-form model input. Degrade to nothing, never to a guess:
  the user acts on what the picker shows. The same applies to any per-model table, such as a
  model-to-context-window lookup - emit the "unknown" sentinel instead of a guessed limit.

  A model-name RECOGNIZER is not a picker and is not covered. Copilot's `MODEL_PATTERNS` reads a
  name back out of TUI text; going stale there degrades a label, it does not misdirect a
  `--model` call.

## Enforcement (self-maintaining)

- **Test:** `tests/unit/agent-model-tables.test.ts` scans `src/main/agent/adapters/**` for vendor
  model strings in live code and fails on a new curated list or per-model table. Comments are
  stripped first (adapters legitimately quote sample session JSON). Two different mechanisms keep
  the sanctioned cases green, and they are not interchangeable: the id-derivation helpers are
  excluded by pattern design, because every pattern requires a version component and a helper
  matches on a bare family prefix; Copilot's recognizer is the one entry allowlisted by name, with
  its reason recorded next to it. The patterns' version requirement is also the scan's known blind
  spot - a curated list of names carrying no digit reads as clean. Runs in CI via
  `npm run test:unit`. This is the backstop the `paths:` scoping needs: the rule loads only when
  an `src/main/agent/**` file is read into context, so it does not fire when a new adapter file
  is created.
- **Review:** `/code-review` and the `migration-safety` agent flag new per-spawn settings
  injection that duplicates a CLI's native control. The model-discovery bullet's judgment half
  (is this really a recognizer?) stays review-only; the scan only sees the strings.

## Scope

Agent adapters and command builders under `src/main/agent/`. Complements
`agent-adapters-boundary.md` (where agent-specific code lives); this rule is about not adding a
custom layer in the first place.
