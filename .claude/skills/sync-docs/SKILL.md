---
description: Review and update documentation to match current source code
allowed-tools: Read, Edit, Write, Glob, Grep, Bash(git:*), Agent
---

# Sync Docs

Review and update `docs/` to match the current source code. This skill contains the source-to-doc mapping, anchor point definitions, doc conventions, and the executable workflow for keeping documentation in sync.

## Source-to-Doc Mapping

Each doc file and the source files that are its authority:

| Doc | Primary Source Files |
|-----|---------------------|
| `architecture.md` | `src/shared/ipc-channels.ts`, `src/preload/preload.ts`, `src/renderer/stores/`, `src/main/pty/session-manager.ts`, `src/main/transition-engine/transition-engine.ts`, `src/main/boards/board-registry.ts` |
| `session-lifecycle.md` | `src/main/pty/session-manager.ts`, `src/main/pty/session-queue.ts`, `src/main/transition-engine/session-lifecycle.ts`, `src/main/transition-engine/resource-cleanup.ts` |
| `configuration.md` | `src/shared/types.ts` (AppConfig, DEFAULT_CONFIG, GLOBAL_ONLY_PATHS), `src/main/config/config-manager.ts` |
| `agent-integration.md` | `src/main/agent/agent-adapter.ts`, `src/main/agent/agent-registry.ts`, `src/main/agent/adapters/**` (per-adapter command builders, hook managers, trust managers, capability-discovery, detectors), `src/main/transition-engine/agent-resolver.ts` |
| `handoff.md` | `src/main/agent/handoff/**`, `src/main/db/repositories/handoff-repository.ts`, `src/main/ipc/helpers/agent-spawn.ts` (handoff path) |
| `transition-engine.md` | `src/main/transition-engine/transition-engine.ts`, `src/shared/types.ts` (ActionType, ActionConfig) |
| `command-injection.md` | `src/main/transition-engine/injection-plan.ts`, `src/main/transition-engine/terminal-submit-scheduler.ts`, `src/main/pty/terminal-submit.ts`, `src/main/agent/adapters/claude/slash-command-verifier.ts` |
| `database.md` | `src/main/db/migrations/**`, `src/main/db/database.ts`, `src/main/db/repositories/*.ts` |
| `cross-platform.md` | `src/main/pty/spawn/shell-resolver.ts`, `src/main/pty/session-manager.ts` (adaptCommandForShell), `electron-builder.yml`, `scripts/build.js` |
| `worktree-strategy.md` | `src/main/git/worktree-manager.ts`, `src/main/agent/adapters/claude/hook-manager.ts`, `src/main/agent/adapters/claude/trust-manager.ts` |
| `activity-detection.md` | `src/main/agent/event-bridge.js`, `src/shared/types.ts` (EventType, EventTypeActivity, HookEvent), `src/main/activity-engine/engine/shapes.ts` (TransitionTrigger, default thresholds), `src/main/activity-engine/engine/watchdog.ts` (hold table) |
| `mcp-server.md` | `src/main/agent/mcp-http-server.ts`, `src/main/agent/mcp-http/**`, `src/main/agent/commands/`, `src/main/ipc/handlers/sessions.ts`, `src/shared/types.ts` (MCP types) |
| `overview.md` | `README.md`, high-level features |
| `user-guide.md` | `src/renderer/components/`, `src/renderer/stores/`, `src/shared/types.ts` |
| `developer-guide.md` | `scripts/`, `tests/`, `electron-builder.yml`, `package.json` |
| `docs/README.md` | All other docs (index) |

## Website Cross-Reference

The marketing website (`../kangentic.com/`) mirrors much of `docs/` as MDX pages. When updating internal docs, note which changes also affect the website. The website's `/sync-docs` command handles the actual website updates, but flagging drift here saves a round trip.

| Internal Doc | Website Page(s) |
|-------------|-----------------|
| `user-guide.md` | Multiple: `guide/creating-tasks.mdx`, `guide/backlog.mdx`, `guide/command-terminal.mdx`, `features/agent-orchestration.mdx`, `features/sessions.mdx`, `features/notifications.mdx`, `features/settings.mdx` |
| `configuration.md` | `configuration.mdx`, `features/settings.mdx` |
| `activity-detection.md` | `features/activity-detection.mdx` |
| `transition-engine.md` | `features/workflows.mdx` |
| `worktree-strategy.md` | `features/git-worktrees.mdx` |
| `session-lifecycle.md` | `features/sessions.mdx` |
| `cross-platform.md` | `dev/shell-support.mdx` |
| `architecture.md` | `architecture.mdx` |
| `developer-guide.md` | `dev/contributing.mdx`, `dev/testing.mdx`, `dev/packaging.mdx` |
| `mcp-server.md` | `features/agent-orchestration.mdx` (MCP section) |

When the Step 7 report lists updated docs, append a note: "Website may need update: [list of affected website pages from this table]".

## Doc Conventions

- Flat structure in `docs/` - no subdirectories
- Each doc has a clear H1 title and opening paragraph stating purpose
- Cross-reference other docs with relative links (`[Title](filename.md)`)
- Technical docs include "See Also" sections at the bottom
- No emojis
- Tables for structured data (schema, config keys, constants)
- Code blocks for CLI commands and file structures

## When to Create a New Doc

- A new major subsystem is added (new directory under `src/main/`)
- An existing doc exceeds ~500 lines and covers two distinct topics
- A new integration point is added (new agent type, new build target)

## When to Delete a Doc

- The subsystem it documents has been removed entirely
- Its content has been fully merged into another doc
- Always update `docs/README.md` and `README.md` when adding/removing

## Anchor Points

Anchors are enumerable source-code structures that must be exhaustively listed in docs. A mechanical audit counts items in source, counts items in docs, and reports the diff.

### Type System Anchors (src/shared/types.ts)

| Anchor | What to extract | Target doc |
|--------|----------------|------------|
| `PermissionMode` | Union variants | configuration.md, database.md |
| `ActionType` | Union variants | transition-engine.md |
| `SessionStatus` | Union variants | session-lifecycle.md |
| `SessionRecordStatus` | Union variants | session-lifecycle.md, database.md |
| `SwimlaneRole` | Union variants | database.md |
| `SuspendedBy` | Union variants | database.md |
| `ThemeMode` | Union variants | configuration.md |
| `EventType` | Object keys | activity-detection.md |
| `EventTypeActivity` | Mapping entries | activity-detection.md |
| `ActivityDetectionStrategy` | Discriminated union variants | activity-detection.md |
| `AdapterRuntimeStrategy` | Interface fields | agent-integration.md |
| `AppConfig` / `DEFAULT_CONFIG` | Flattened dot-paths + defaults | configuration.md |
| `BoardConfig` | Interface fields | configuration.md |
| `BoardColumnConfig` | Interface fields | configuration.md |

### IPC Anchors (src/shared/ipc-channels.ts)

| Anchor | What to extract | Target doc |
|--------|----------------|------------|
| IPC channels | All string values from `IPC` object | architecture.md (per-group tables) |
| IPC group counts | Count per section header | architecture.md (section headers) |

### Database Anchors (src/main/db/migrations/)

| Anchor | What to extract | Target doc |
|--------|----------------|------------|
| Table schemas | All `CREATE TABLE` columns + `ALTER TABLE ADD COLUMN` | database.md (schema tables) |
| Seed data | Default swimlanes, actions, transitions | database.md |
| Migration list | Numbered migrations with descriptions | database.md (migration history) |

### UI Anchors

| Anchor | Source file | Target doc |
|--------|-----------|------------|
| Settings tabs | `src/renderer/components/settings/AppSettingsPanel.tsx` tab array | user-guide.md, configuration.md |
| Settings registry | `src/renderer/components/settings/settings-registry.ts` entries | configuration.md |

### Agent Adapter Anchors

| Anchor | Source file(s) | Target doc |
|--------|---------------|------------|
| AgentAdapter interface methods | `src/main/agent/agent-adapter.ts` | agent-integration.md (interface table) |
| AgentAdapter required properties | `src/main/agent/agent-adapter.ts` | agent-integration.md (properties table) |
| Registered adapters list | `src/main/agent/agent-registry.ts` | agent-integration.md (supported agents table) |
| Supported agents table | `src/main/agent/adapters/*/` (one adapter per agent) | agent-integration.md (supported agents table) |
| Per-agent permission modes | `src/main/agent/adapters/claude/claude-adapter.ts`, `src/main/agent/adapters/codex/codex-adapter.ts`, `src/main/agent/adapters/gemini/gemini-adapter.ts`, `src/main/agent/adapters/aider/aider-adapter.ts` | agent-integration.md (per-agent permission tables) |
| Per-agent CLI flag mappings | `src/main/agent/adapters/codex/command-builder.ts`, `src/main/agent/adapters/gemini/command-builder.ts`, `src/main/agent/adapters/aider/aider-adapter.ts` | agent-integration.md (per-agent permission tables) |
| Per-agent capability discovery | `src/main/agent/adapters/*/capability-discovery.ts` | agent-integration.md (model/effort tables) |
| First-output detection strategies | All adapter files (`detectFirstOutput` method) | agent-integration.md (first-output detection table) |
| Exit sequences | All adapter files (`getExitSequence` method) | agent-integration.md (exit sequences table) |
| Handoff prompt transforms | All adapter files (`transformHandoffPrompt` method) | agent-integration.md (handoff prompt transform table) |
| Per-agent transcript cleanup | `src/main/agent/handoff/transcript-cleanup.ts`, `src/main/agent/adapters/*/transcript-cleanup.ts` | handoff.md (per-agent transcript cleanup section) |
| Handoff DB columns | `src/main/db/repositories/handoff-repository.ts` | handoff.md (database storage table) |

### Template Anchors

| Anchor | Source file | Target doc |
|--------|-----------|------------|
| Template variables | `src/shared/template-vars.ts` | configuration.md (canonical), transition-engine.md and agent-integration.md (cross-reference only) |

### Verification Procedures

See `references/verification-procedures.md` for step-by-step extraction instructions per anchor type.

## Categories of Drift

Anchors catch ~70% of drift (missing enumerable items). The remaining ~30% is prose drift that requires reading and comparing:

- Changed behavior or algorithm descriptions
- Stale default value explanations
- Feature interaction descriptions
- Renamed parameters or function signatures
- New or removed CLI flags in command builder
- Altered shell detection order or platform-specific logic

## Workflow

### Step 1 - Scope Detection

Determine what source files changed:

1. Check if on a branch with unpushed commits:
   - Run `git log origin/HEAD..HEAD --name-only --pretty=format:""` to get changed files
   - If that produces results, use those files as the scope
2. If no unpushed commits (e.g., on main after pushing), diff against the latest release tag:
   - Run `git describe --tags --abbrev=0` to find the latest release tag
   - Run `git diff --name-only <tag>..HEAD` to get all files changed since that release
3. Filter to source files only (exclude `docs/`, `.claude/`, `tests/`)
4. Map changed source files to affected docs using the Source-to-Doc Mapping above
5. If no source files changed (docs-only or config-only commit), report "No source changes detected - skipping doc review" and stop

### Step 2 - Anchor Point Verification

This is the **canonical anchor source list**. `/sync-docs`, `/pull-request`, `/merge-pull-request`, and `/merge-back` all consult this list. When updating, never duplicate - they read it from here.

Each entry has a one-line rationale so future edits know what the entry was protecting. Do not remove an entry without checking that its rationale no longer applies.

**Single-file anchors:**

- `src/shared/types.ts`
  WHY: union types, interfaces, and config defaults (PermissionMode, ActionType, SessionStatus, AppConfig, BoardConfig, EventType, etc.) are enumerated across configuration.md, database.md, session-lifecycle.md, transition-engine.md, agent-integration.md, activity-detection.md.

- `src/shared/ipc-channels.ts`
  WHY: every IPC channel string is enumerated by group in architecture.md (per-group tables, group counts in section headers).

- `src/shared/template-vars.ts`
  WHY: template variable list is mirrored in configuration.md (canonical) and cross-referenced in transition-engine.md and agent-integration.md.

- `src/main/agent/agent-adapter.ts`
  WHY: AgentAdapter interface methods (discoverCapabilities, getInjectionSequence, getCommandInjectionVerifier, summarize, transformHandoffPrompt, getExitSequence, detectFirstOutput) are tabulated in agent-integration.md. Catches drift that types.ts re-exports miss.

- `src/main/agent/agent-registry.ts`
  WHY: canonical list of registered adapters; adding/removing an adapter is a docs-affecting event for agent-integration.md "Supported agents" table.

- `src/main/agent/mcp-http-server.ts`
  WHY: MCP server entry point and tool registration; backs mcp-server.md component table.

- `src/main/db/repositories/handoff-repository.ts`
  WHY: handoff DB column list is tabulated in handoff.md "Database Storage" table.

- `src/main/transition-engine/transition-engine.ts`
  WHY: spawn/transition/handoff state machine is described in transition-engine.md and architecture.md. Action types and transition flow are enumerated here.

- `src/main/transition-engine/injection-plan.ts`
  WHY: command-injection precedence rules (per-task model/effort overrides, swimlane defaults) are described in command-injection.md and architecture.md.

- `src/main/transition-engine/terminal-submit-scheduler.ts`
  WHY: keystroke submission lifecycle wrapper enumerated in command-injection.md pipeline table.

- `src/main/transition-engine/session-lifecycle.ts`
  WHY: session state transitions enumerated in session-lifecycle.md.

- `src/main/pty/session-manager.ts`
  WHY: session lifecycle states, events, and shell adaptations are enumerated in session-lifecycle.md, architecture.md, cross-platform.md.

- `src/main/pty/spawn/shell-resolver.ts`
  WHY: per-platform shell detection order is enumerated in cross-platform.md.

- `src/main/git/worktree-manager.ts`
  WHY: worktree lifecycle (create, cleanup, slug generation) is described in worktree-strategy.md.

- `src/main/config/config-manager.ts`
  WHY: config load/save/merge logic backs configuration.md.

- `src/main/agent/event-bridge.js`
  WHY: hook → JSONL → store pipeline backs activity-detection.md.

- `src/main/activity-engine/engine/shapes.ts`
  WHY: the TransitionTrigger label vocabulary and ActivityEngineOptions default thresholds are enumerated in activity-detection.md ("Reading a transition trace", "Configuration").

- `src/main/activity-engine/engine/watchdog.ts`
  WHY: the four watchdog holds (predicates, thresholds, anchors) are enumerated in activity-detection.md "Four safety nets (the watchdog table)".

- `src/renderer/components/settings/AppSettingsPanel.tsx`
  WHY: settings tab order, separator position, and visibility rules are mirrored in user-guide.md and configuration.md.

- `src/renderer/components/settings/settings-registry.ts`
  WHY: settings registry entries and their defaults are enumerated in configuration.md.

- `electron-builder.yml`
  WHY: native deps allowlist, asarUnpack, signing, and packaging targets are described in cross-platform.md and developer-guide.md.

- `package.json`
  WHY: version, native deps, build scripts surface in developer-guide.md.

**Glob anchors** (any file in the directory tree):

- `src/main/db/migrations/**`
  WHY: every CREATE TABLE column, ALTER TABLE, and seed data block is enumerated in database.md schema tables and migration history. Glob covers global-schema.ts, project-schema.ts, default-data.ts, spawn-agent-config-migration.ts, and any future migration file. (Note: `src/main/db/migrations.ts` is a 2-line re-export shim — do not rely on it.)

- `src/main/agent/adapters/**`
  WHY: per-adapter capability declarations (claude-adapter.ts, codex-adapter.ts, etc.), command-builders, capability-discovery.ts, detectors, hook-managers, trust-managers, transcript-cleanup.ts all drive per-adapter tables in agent-integration.md, adapter-session-history.md, command-injection.md, and handoff.md. Glob covers all 11 adapters and all their internal files.

- `src/main/agent/handoff/**`
  WHY: handoff orchestration (session-history-reference.ts, transcript-cleanup.ts) backs handoff.md sections. Small directory; safe to glob.

- `src/main/agent/shared/**`
  WHY: shared agent helpers (auto-name.ts, prompt-xml.ts, agent-detector.ts, bridge-utils.ts, hook-utils.ts, exec-version.ts) back multiple feature docs (configuration.md, agent-integration.md, cross-platform.md). Small directory; safe to glob.

- `src/main/agent/mcp-http/**`
  WHY: MCP tool registrations (task-tools.ts, session-tools.ts, search-tools.ts, project-tools.ts) are enumerated in mcp-server.md. Adding a new tool is a docs-affecting event.

- `src/main/agent/commands/**`
  WHY: MCP command implementations (column-resolver.ts, handoff-commands.ts, task-commands.ts, backlog-commands.ts, search-commands.ts, etc.) are cited in mcp-server.md component table and architecture.md board-integration section. Adding or renaming a command file is a docs-affecting event. Small directory (13 files); safe to glob.

- `src/main/ipc/handlers/**`
  WHY: handler files register IPC channels, emit event payloads, and define handler-level behavior. A new handler that registers a channel without changing ipc-channels.ts (e.g., event-only ipcMain.on) would slip through the channel-constants anchor. Currently 17 files; glob avoids list-rot.

If any anchor source files appear in the changed-file list:

1. Spawn a `doc-auditor` agent with the list of changed anchor source files
2. The agent returns a structured gap report listing missing and extra items per anchor
3. Save the gap report for use in Step 4

If no anchor source files changed, skip this step.

### Step 3 - Prose Audit

For each affected doc (from Step 1 mapping):

1. Read the doc file
2. Read the source files it references (from the mapping)
3. Check for prose staleness - details that are no longer accurate:
   - Changed behavior or algorithm descriptions
   - Stale default value explanations
   - Feature interaction descriptions that no longer hold
   - Renamed parameters or function signatures
   - New or removed CLI flags
   - Changed function signatures or behavior

This step focuses on prose accuracy only. Enumerable completeness is handled by the anchor audit in Step 2.

### Step 4 - Update Pass

For each doc with stale content (from Steps 2 and 3):

1. Fix all anchor gaps reported by the doc-auditor:
   - Add missing items to tables/lists
   - Remove extra items no longer in source
   - Update counts in section headers if applicable
2. Fix prose staleness found in Step 3:
   - Update stale facts (numbers, type names, default values, descriptions)
   - Add sections for significant new features not yet documented
   - Remove sections for removed features
3. Update cross-references if docs were added/removed
4. Update `docs/README.md` index if docs were added/removed

**Constraints:**
- Only edit files in `docs/` and `README.md` (Documentation section only)
- Never modify source code, tests, or config files
- Respect the single-command Bash rule

### Step 5 - Feature Summary

Scan for undocumented features and determine where to document them:

1. Find the latest release tag: `git describe --tags --abbrev=0`
2. List `feat:` and `feat!:` commits since that tag: `git log <tag>..HEAD --oneline --grep="^feat"` (use `--grep` flag, not a pipe)
3. For each feature commit:
   - Extract the feature description from the commit message
   - Check if it appears in `docs/user-guide.md` or `docs/overview.md`
4. For each undocumented feature, determine placement:
   - Read the source files touched by the commit to understand the feature scope
   - Use the Source-to-Doc Mapping above to identify the target doc
   - Identify the specific section within the target doc where the feature belongs (e.g., "user-guide.md > Task Detail Dialog")
   - Only create a new doc when the feature introduces a new subsystem or integration point (per "When to Create a New Doc" above). Otherwise append to the existing doc.
5. For each undocumented feature, write the documentation into the target doc in the identified section. Use the Edit tool to add content inline, matching the existing style and level of detail.
6. Report what was written in the Step 7 report (feature, target doc, section, what was added).

### Step 6 - Structural Review

Check overall doc health:

1. Verify all internal links between docs resolve (no broken `[text](file.md)` links)
2. Check that `docs/README.md` lists all docs in `docs/`
3. Check that the `README.md` Documentation section is current
4. Flag any doc over 500 lines that could benefit from splitting

### Step 7 - Report

Summarize what was done:

- Anchor audit results (if run): anchors checked, gaps found, gaps fixed
- Prose updates: list of docs updated with brief change descriptions
- Docs created or deleted (if any)
- Feature documentation: list of features documented, where they were placed, and what was written
- Items that need human review (ambiguous changes, major restructuring)
- "No changes needed" if everything is current
