---
name: sync-docs
description: Review and update documentation to match current source code
---

# Sync Docs

Review and update `docs/` to match the current source code. This skill holds how a changed source
file finds its docs, the anchor point definitions, doc conventions, and the executable workflow for
keeping documentation in sync. Doc paths below are relative to `docs/`.

## Source-to-Doc Mapping

`docs/` is one Open Knowledge Format bundle, and every concept names the code it documents in its
`sources:` frontmatter: a file, or a folder ending in `/` when every file in it is documented there.
To find the concepts a change affects, run

```
node scripts/docs-bundle.mjs sources <changed file>...
```

which prints, per file, each concept whose sources list the file or a folder above it. A concept
followed by brackets lists the file only for the parts named there, as in
`docs/settings/app-config.md [AppConfig, DEFAULT_CONFIG]` for `src/shared/types.ts`. Check the
concepts whose brackets name something the diff touches first. A title can miss a symbol the
concept documents, so before skipping any other bracketed concept, grep it for the identifiers the
diff changed, and skip it only when that finds nothing. That lookup replaces a hand-kept mapping
table. When a change touches a file no concept lists, decide which
concept documents it and add the file to that concept's `sources:` in the same change, so the next
lookup finds it.

Two areas map by judgment instead, because no source list can name them:

- **User-facing behavior** (`src/renderer/components/`, `src/renderer/stores/`) belongs in the
  `user-guide/` concept for the feature, found from `user-guide/index.md`.
- **`README.md`** and high-level features belong in `user-guide/overview.md`.

## Website Cross-Reference

The marketing website (`../kangentic.com/`) mirrors much of `docs/` as MDX pages. When updating
internal docs, note which changes also affect the website. The website's `/sync-docs` command
handles the actual website updates, but flagging drift here saves a round trip.

| Internal concepts | Website Page(s) |
|-------------------|-----------------|
| `user-guide/` | Multiple: `guide/creating-tasks.mdx`, `guide/backlog.mdx`, `guide/command-terminal.mdx`, `features/agent-orchestration.mdx`, `features/sessions.mdx`, `features/notifications.mdx`, `features/settings.mdx` |
| `settings/` | `configuration.mdx`, `features/settings.mdx` |
| `architecture/activity/` | `features/activity-detection.mdx` |
| `architecture/automations/transition-engine.md`, `triggers.md` | `features/workflows.mdx` |
| `architecture/worktrees/` | `features/git-worktrees.mdx` |
| `architecture/sessions/` | `features/sessions.mdx` |
| `platforms/shells-and-paths.md` | `dev/shell-support.mdx` |
| `architecture/system-overview.md`, `architecture/ipc/` | `architecture.mdx` |
| `contributing/developer-guide.md` | `dev/contributing.mdx`, `dev/testing.mdx`, `dev/packaging.mdx` |
| `integrations/mcp-server/` | `features/agent-orchestration.mdx` (MCP section) |

When the Step 7 report lists updated docs, append a note: "Website may need update: [list of affected website pages from this table]".

## Doc Conventions

The bundle's shape is enforced by `tests/unit/okf-docs-conformance.test.ts`; the reasons behind
each rule are in `research/okf-knowledge-format.md`.

- Every markdown file but `index.md` and `log.md` is a concept with YAML frontmatter: `type` (one
  of `CONCEPT_TYPES` in `scripts/docs-bundle.mjs`), `title`, a one-line `description`, `tags`, and
  `sources:`.
- The `description` is the routing key an agent picks the concept by. Name what only this concept
  holds (the specific mechanisms, values and names), never a summary that would fit its siblings.
  No two concepts may share one.
- `sources:` stay narrow: the files the concept documents, or a folder only when every file in it
  is documented there. A whole subsystem folder or a shared mega-file (`src/shared/types.ts`)
  flags the concept on unrelated changes; name the symbols in `title` when a shared file is
  unavoidable, so the lookup prints them and a change to other symbols skips the concept. A file
  that a parity test already ties to the docs (`src/shared/mcp-tool-manifest.ts`, checked by
  `mcp-tool-list-parity.test.ts`) belongs only to the concept that documents the file itself.
- Every folder holding markdown has an `index.md` listing each concept as
  `* [Title](file.md) - description` with the concept's exact description, and linking each
  subfolder's `index.md`. Only `docs/index.md` carries frontmatter (`okf_version: "0.2"`).
- A concept's H1 is its `title`. Headings are specific enough to grep for (`## kangentic_move_task`,
  not `## Usage`), and one concept covers one topic.
- `docs/log.md` records dated changes to the bundle's layout, newest first (`## YYYY-MM-DD`).
- Never name a docs file like an agent instruction file (`claude.md`, `gemini.md`, `agents.md`,
  `warp.md`): on a case-insensitive filesystem the agent loads it as instructions.
- Cross-reference other concepts with relative links (`[Title](file.md)`, `../area/file.md`).
- No emojis. Tables for structured data (schema, config keys, constants). Code blocks for CLI
  commands and file structures.

## When to Create a New Concept

- A new major subsystem is added (new directory under `src/main/`): give it a concept, or a folder
  of concepts with an `index.md`, under the area it belongs to.
- A concept grows past about 40 KB and its headings fall into two topics a question would ask
  separately: split it along those headings.
- A new integration point is added (new agent type, new MCP tool family, new build target).

Every new concept gets frontmatter, a line in its folder's `index.md`, and its sources; a new
folder also gets its parent index's link.

## When to Delete a Concept

- The subsystem it documents has been removed entirely.
- Its content has been fully merged into another concept.

Remove its `index.md` line, and update every link and `docs/<path>.md` citation to it
(`tests/unit/docs-path-citations.test.ts` fails on a citation of a missing doc).

## Anchor Points

Anchors are enumerable source-code structures that must be exhaustively listed in docs. A mechanical audit counts items in source, counts items in docs, and reports the diff.

### Type System Anchors (src/shared/types.ts)

| Anchor | What to extract | Target doc |
|--------|----------------|------------|
| `PermissionMode` | Union variants | settings/cascade.md (canonical, the user-facing setting and its resolution order), database/session-tables.md and database/board-tables.md (the same variants again as stored column values; each must enumerate all of them) |
| `TaskRunMode` | Union variants | database/board-tables.md (`tasks.run_mode`) |
| `AutomationType` | Union variants | architecture/automations/transition-engine.md (canonical, one heading per adapter), settings/cascade.md and integrations/mcp-server/automation-tools.md (the 5 stable types plus the `send_command` alias and the legacy `spawn_agent`) |
| `AutomationTrigger` | Union variants | architecture/automations/triggers.md |
| `AutomationRunStatus` | Union variants | architecture/automations/transition-engine.md (canonical), database/board-tables.md (the same variants as stored column values) |
| `ColumnAutomation` | Interface fields | database/board-tables.md (`column_automations` table) |
| `AutomationRun` | Interface fields | database/board-tables.md (`automation_runs` table) |
| `ActionType` | Union variants | RETIRED. The engine no longer branches on it; it survives only for the retired `actions` / `swimlane_transitions` tables and legacy `kangentic.json` reads. database/board-tables.md and settings/board-config.md mark it retired; do not report it as a missing-doc gap against architecture/automations/transition-engine.md |
| `SessionStatus` | Union variants | architecture/sessions/state-machine.md |
| `SessionRecordStatus` | Union variants | architecture/sessions/state-machine.md (canonical), database/session-tables.md (the same variants again as stored column values; both must enumerate all of them) |
| `SwimlaneRole` | Union variants | database/board-tables.md |
| `SuspendedBy` | Union variants | database/session-tables.md |
| `ThemeMode` | Union variants | settings/app-config.md |
| `EventType` | Object keys | architecture/activity/event-types.md |
| `EventTypeActivity` | Mapping entries | architecture/activity/event-types.md |
| `ActivityDetectionStrategy` | Discriminated union variants | architecture/activity/activity-engine.md |
| `AdapterRuntimeStrategy` | Interface fields | integrations/agents/adapter-types.md |
| `AppConfig` / `DEFAULT_CONFIG` | Flattened dot-paths + defaults | settings/app-config.md (every key, the Knowledge Graph, dictation, workflows and automation keys included) |
| `BoardConfig` | Interface fields | settings/board-config.md |
| `BoardColumnConfig` | Interface fields | settings/board-config.md |
| `KnowledgeGraphStatus` | Interface fields | architecture/ipc/session-channels.md (`knowledgeGraph:status` row) |
| `KnowledgeGraphSummaryCounts` / `KnowledgeGraphSummaryStatus` | Interface fields | architecture/ipc/session-channels.md (`knowledgeGraph:status` and `knowledgeGraph:graphSnapshot` rows), user-guide/knowledge-graph.md (the Task summaries line's states) |
| `KnowledgeGraphIndexCounts` / `KnowledgeGraphIndexSummary` | Interface fields | architecture/ipc/session-channels.md (`knowledgeGraph:graphSnapshot` row's `index`), architecture/knowledge-graph.md (what the Index card and the map's Index panel sum) |

### IPC Anchors (src/shared/ipc-channels.ts)

| Anchor | What to extract | Target doc |
|--------|----------------|------------|
| IPC channels | All string values from `IPC` object | architecture/ipc/board-channels.md, session-channels.md and app-channels.md (per-group tables; each group lives in exactly one) |
| IPC group counts | Count per section header | the same three concepts (section headers) |

### Database Anchors (src/main/db/migrations/)

| Anchor | What to extract | Target doc |
|--------|----------------|------------|
| Table schemas | All `CREATE TABLE` columns + `ALTER TABLE ADD COLUMN` | database/board-tables.md, session-tables.md and knowledge-graph-tables.md (per-project tables), database/storage-model.md (global tables) |
| Seed data | Default swimlanes, actions, transitions | database/storage-model.md (Default Seed Data) |
| Migration list | Numbered migrations with descriptions | database/migrations.md |

### UI Anchors

| Anchor | Source file | Target doc |
|--------|-----------|------------|
| Settings tabs | `src/renderer/components/settings/settings-tabs.ts` (`SETTINGS_TABS` array) | user-guide/settings.md (canonical prose), settings/settings-panel.md (groups, tiers and what each tab holds) |
| Settings registry | `src/renderer/components/settings/settings-registry.ts` entries | settings/app-config.md |
| Pop-out surfaces | `src/shared/pop-out.ts` (`PopOutKind`) | architecture/ipc/app-channels.md (Pop-out Windows section) |

### Agent Adapter Anchors

| Anchor | Source file(s) | Target doc |
|--------|---------------|------------|
| AgentAdapter interface methods | `src/main/agent/agent-adapter.ts` | integrations/agents/adapter-interface.md (interface table) |
| AgentAdapter required properties | `src/main/agent/agent-adapter.ts` | integrations/agents/adapter-interface.md (properties table) |
| AgentAdapter optional properties | `src/main/agent/agent-adapter.ts` | integrations/agents/optional-properties.md |
| Registered adapters list | `src/main/agent/agent-registry.ts` | integrations/agents/adapter-interface.md (supported agents table) and integrations/agents/index.md (one concept per adapter) |
| Supported agents table | `src/main/agent/adapters/*/` (one adapter per agent) | integrations/agents/adapter-interface.md (supported agents table) |
| Per-agent permission modes | `src/main/agent/adapters/claude/claude-adapter.ts`, `src/main/agent/adapters/codex/codex-adapter.ts`, `src/main/agent/adapters/gemini/gemini-adapter.ts`, `src/main/agent/adapters/aider/aider-adapter.ts` | Each adapter's concept in integrations/agents/ (its Permission Modes table) |
| Per-agent CLI flag mappings | `src/main/agent/adapters/codex/command-builder.ts`, `src/main/agent/adapters/gemini/command-builder.ts`, `src/main/agent/adapters/aider/aider-adapter.ts` | Each adapter's concept in integrations/agents/ (its Permission Modes table) |
| Per-agent capability discovery | `src/main/agent/adapters/*/capability-discovery.ts` | integrations/agents/adapter-types.md (model/effort tables) |
| First-output detection strategies | All adapter files (`detectFirstOutput` method) | integrations/agents/adapter-interface.md (first-output detection table) |
| Exit sequences | All adapter files (`getExitSequence` method) | integrations/agents/adapter-interface.md (Exit Sequences table) |
| Session history file location | All adapter files (`locateSessionHistoryFile` method) | integrations/agents/adapter-interface.md (session history file location table) |
| Per-agent transcript cleanup | `src/main/agent/handoff/transcript-cleanup.ts`, `src/main/agent/adapters/*/transcript-cleanup.ts` | integrations/agents/handoff.md (per-agent transcript cleanup section) |
| Handoff DB columns | `src/main/db/repositories/handoff-repository.ts` | integrations/agents/handoff.md (database storage table) |

### Template Anchors

| Anchor | Source file | Target doc |
|--------|-----------|------------|
| Template variables | `src/shared/template-vars.ts` | settings/board-config.md (canonical, the Shortcuts section), user-guide/settings.md and integrations/agents/adapter-interface.md (cross-reference only) |
| Task template variables (auto_command / promptTemplate) | `src/shared/task-template-vars.ts` | architecture/automations/transition-engine.md (canonical, "Template Variables"), architecture/system-overview.md (cross-reference only) |

### Integration Anchors

| Anchor | Source file | Target doc |
|--------|-----------|------------|
| MCP tool manifest | `src/shared/mcp-tool-manifest.ts` (`MCP_TOOL_MANIFEST`) | integrations/mcp-server/ (one heading per tool, in the concept for its family). Also enforced mechanically by `tests/unit/mcp-tool-list-parity.test.ts`. |
| Automation adapters | `src/shared/automation-manifest.ts` (`AUTOMATION_MANIFEST`) and `src/main/automations/automation-registry.ts` | architecture/automations/transition-engine.md (canonical, one heading per type with its fields, escaping, timeout and retry), architecture/system-overview.md (the folder layout beside `pr/` and `boards/`), settings/cascade.md and integrations/mcp-server/automation-tools.md (type summary tables). Registry-to-manifest parity is enforced by `tests/unit/automation-adapter-parity.test.ts`; the DOCS side is not mechanically checked. |
| Board adapters | `src/main/boards/board-registry.ts` (registered providers) | integrations/boards.md (provider table, including each provider's stable/stub status), user-guide/backlog.md (the sources a user can import from) |
| PR adapters | `src/main/pr/pr-registry.ts` (`connectors`) | integrations/pull-requests/connector-model.md (Connector Status; keep planned-but-unimplemented providers marked as such) |
| External scripts registry | `scripts/copy-external-scripts.js` (`EXTERNAL_SCRIPTS`) | No `docs/` target by design. Enforced by `tests/unit/external-scripts-parity.test.ts` and `.cursor/rules/external-scripts-parity.mdc`; listed here so an auditor does not report it as a missing-doc gap. |

### Deliberately Not Anchored

Enumerable structures that intentionally have no `docs/` target, so an auditor does not report
them as a missing-doc gap:

| Structure | Source | Why it is not a docs anchor |
|-----------|--------|------------------------------|
| Activity marks (`ACTIVITY_MARK_NAMES`) | `src/renderer/components/ActivityMark.tsx` | The eleven names are owned upstream in `@kangentic/branding`, so no `docs/` file enumerates them and a table of them would drift from the package. `architecture/renderer/activity-marks.md` exists but records design history and measurements, deliberately not the name list; the contract is `.cursor/rules/activity-marks.mdc` and the geometry is pinned by `tests/unit/activity-mark.test.ts`. Do not report the missing name table as a gap. |

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
4. Run `node scripts/docs-bundle.mjs sources <changed source files>` to map them to concepts; map
   renderer and README changes by judgment (see Source-to-Doc Mapping)
5. If no source files changed (docs-only or config-only commit), report "No source changes detected - skipping doc review" and stop

### Step 2 - Anchor Point Verification

This is the **canonical anchor source list**. `/sync-docs`, `/pull-request`, `/merge-pull-request`, and `/merge-back` all consult this list. When updating, never duplicate - they read it from here.

Each entry has a one-line rationale so future edits know what the entry was protecting. Do not remove an entry without checking that its rationale no longer applies.

**Single-file anchors:**

- `src/shared/types.ts`
  WHY: union types, interfaces, and config defaults (PermissionMode, ActionType, SessionStatus, AppConfig, BoardConfig, EventType, etc.) are enumerated across settings/, database/, architecture/sessions/state-machine.md, architecture/automations/, integrations/agents/adapter-types.md, and architecture/activity/ (see the Type System Anchors table for which concept holds which).

- `src/shared/ipc-channels.ts`
  WHY: every IPC channel string is enumerated by group in architecture/ipc/ (per-group tables, group counts in section headers).

- `src/shared/template-vars.ts`
  WHY: the Shortcut template variable list is mirrored in settings/board-config.md (canonical) and cross-referenced in user-guide/settings.md and integrations/agents/adapter-interface.md.

- `src/shared/task-template-vars.ts`
  WHY: the template-variable catalog every automation field, the per-task auto_command, and the legacy spawn_agent promptTemplate read (26 names: task_xml, workflow_xml, title, description, taskId, taskNumber, projectPath, projectName, worktreePath, branchName, baseBranch, prUrl, prNumber, prState, issueKey, issueUrl, labels, attachments, port, plus the 5 automation-only names column, fromColumn, toColumn, trigger, agentReply, plus the 2 workflow-agent-only names columns and brief_xml) is tabulated in architecture/automations/transition-engine.md "Template Variables" and cross-referenced in architecture/system-overview.md. Each entry's `contexts` decides where it is offered, and `availability` flags the ones that are usually empty; the table's PROSE (the keyword count, which context uses which interpolator) is not mechanically checked and is where this anchor has drifted before. Mechanically enforced by tests/unit/task-template-vars-parity.test.ts; see .cursor/rules/task-template-vars-parity.mdc. Distinct from src/shared/template-vars.ts (the unrelated Shortcut command system). integrations/agents/adapter-interface.md's "Prompt Templates" section also names the full keyword list in prose (linking back to transition-engine.md as canonical) - not mechanically checked, spot-check it by hand on a keyword add/rename.

- `src/shared/automation-manifest.ts`
  WHY: each automation type declares itself once here (label, icon, `status`, `needs`, fields with their per-field `escape`, `timeoutMs`, `retry`), and architecture/automations/transition-engine.md tabulates all of it. Also holds `RETIRED_ACTION_TYPES`, `EXIT_GROUP_BUDGET_MS` and `DEFAULT_SCRIPT_TIMEOUT_MINUTES`, each of which is quoted as a number in the docs. Registry-to-manifest parity is mechanical (`tests/unit/automation-adapter-parity.test.ts`); the docs side is not, so an added type or a changed budget needs a hand pass. See .cursor/rules/automation-adapters.mdc.

- `src/main/agent/agent-adapter.ts`
  WHY: AgentAdapter interface methods (discoverCapabilities, getInjectionSequence, getSubmissionVerifier, summarize, answerFromContext, openAnswerSession, locateSessionHistoryFile, getExitSequence, detectFirstOutput) are tabulated in integrations/agents/adapter-interface.md and integrations/agents/optional-properties.md. Catches drift that types.ts re-exports miss.

- `src/main/agent/agent-registry.ts`
  WHY: canonical list of registered adapters; adding/removing an adapter is a docs-affecting event for integrations/agents/adapter-interface.md's "Supported Agents" table, and for a concept of its own in integrations/agents/ (listed in that folder's index.md).

- `src/main/agent/mcp-http-server.ts`
  WHY: MCP server entry point and tool registration; backs integrations/mcp-server/how-it-works.md's components table.

- `src/main/db/repositories/handoff-repository.ts`
  WHY: handoff DB column list is tabulated in integrations/agents/handoff.md "Database Storage" table.

- `src/main/transition-engine/transition-engine.ts`
  WHY: spawn/transition/handoff state machine is described in architecture/automations/transition-engine.md and architecture/system-overview.md. Action types and transition flow are enumerated here.

- `src/main/transition-engine/injection-plan.ts`
  WHY: command-injection precedence rules (per-task model/effort overrides, swimlane defaults) are described in architecture/automations/command-injection.md and architecture/system-overview.md.

- `src/main/transition-engine/terminal-submit-scheduler.ts`
  WHY: keystroke submission lifecycle wrapper enumerated in architecture/automations/command-injection.md's delivery ladder and its `'paste'` vs `'command-injection'` table.

- `src/main/transition-engine/session-lifecycle.ts`
  WHY: session state transitions enumerated in architecture/sessions/state-machine.md.

- `src/main/pty/session-manager.ts`
  WHY: session lifecycle states, events, and shell adaptations are enumerated in architecture/sessions/, architecture/system-overview.md and platforms/shells-and-paths.md.

- `src/main/pty/spawn/shell-resolver.ts`
  WHY: per-platform shell detection order is enumerated in platforms/shells-and-paths.md.

- `src/main/git/worktree-manager.ts`
  WHY: worktree lifecycle (create, cleanup, slug generation) is described in architecture/worktrees/worktree-lifecycle.md and worktree-creation.md.

- `src/main/config/config-manager.ts`
  WHY: config load/save/merge logic backs settings/cascade.md.

- `src/main/agent/event-bridge.js`
  WHY: hook → JSONL → store pipeline backs architecture/activity/activity-engine.md and event-types.md.

- `src/main/activity-engine/engine/shapes.ts`
  WHY: the TransitionTrigger label vocabulary and ActivityEngineOptions default thresholds are enumerated in architecture/activity/activity-engine.md ("Reading a transition trace", "Configuration").

- `src/main/activity-engine/engine/watchdog.ts`
  WHY: the five watchdog holds (predicates, thresholds, anchors) are enumerated in architecture/activity/watchdog.md.

- `src/renderer/components/settings/settings-tabs.ts`
  WHY: settings tab order, category/tier grouping, separator position, and visibility rules are mirrored in user-guide/settings.md and settings/settings-panel.md. This is the file that DECLARES `SETTINGS_TABS`; `AppSettingsPanel.tsx` only imports it, so anchoring on the panel misses a tab added or reordered here.

- `src/renderer/components/settings/settings-registry.ts`
  WHY: settings registry entries and their defaults are enumerated in settings/app-config.md.

- `src/main/retrieval/retrieval-service.ts`
  WHY: when task summary passes are asked for (project open, board change, the once-a-launch ask of every project, a settings change that resolves a writer, Rebuild), what the Settings Index card counts (every indexed project), and Rebuild's reach are described in architecture/knowledge-graph.md, user-guide/knowledge-graph.md's Index card paragraphs, and architecture/ipc/session-channels.md's `knowledgeGraph:status` and `knowledgeGraph:rebuildIndex` rows. None of those are enumerable, so this is a prose check: the open-project wording survived a change to all projects once before.

- `src/shared/index-summary.ts`
  WHY: one fold and one set of line rules for both Index views, the Settings card and the map's Index panel (`sumIndexCounts` and the panel's `sumIndex`, `summaryStatusOf`, `sourceStatusOf`, and `isIndexedProject`, the set "All projects" means). user-guide/knowledge-graph.md and architecture/knowledge-graph.md say what each view counts and that the two read the same; a change here changes both.

- `electron-builder.yml`
  WHY: native deps allowlist, asarUnpack, signing, and packaging targets are described in platforms/packaging-and-security.md and contributing/developer-guide.md.

- `package.json`
  WHY: version, native deps, build scripts surface in contributing/developer-guide.md.

**Glob anchors** (any file in the directory tree):

- `src/main/db/migrations/**`
  WHY: every CREATE TABLE column, ALTER TABLE, and seed data block is enumerated in the database/ table concepts and database/migrations.md. Glob covers global-schema.ts, project-schema.ts, default-data.ts, spawn-agent-config-migration.ts, and any future migration file. (Note: `src/main/db/migrations.ts` is a 2-line re-export shim - do not rely on it.)

- `src/main/agent/adapters/**`
  WHY: per-adapter capability declarations (claude-adapter.ts, codex-adapter.ts, etc.), command-builders, capability-discovery.ts, detectors, hook-managers, trust-managers, transcript-cleanup.ts all drive the per-adapter concepts in integrations/agents/, integrations/agents/session-history.md, architecture/automations/command-injection-support-matrix.md, and integrations/agents/handoff.md. Glob covers all 15 adapters and all their internal files.

- `src/main/agent/handoff/**`
  WHY: handoff (session-history-reference.ts, transcript-cleanup.ts) backs integrations/agents/handoff.md. Small directory; safe to glob.

- `src/main/agent/shared/**`
  WHY: shared agent helpers (cli-print.ts, cli-answer.ts, auto-name.ts, prompt-xml.ts, agent-detector.ts, bridge-utils.ts, hook-utils.ts, exec-version.ts) back multiple concepts (settings/app-config.md, the integrations/agents/ concepts, platforms/shells-and-paths.md). Small directory; safe to glob.

- `src/main/agent/mcp-http/**`
  WHY: MCP tool registrations (task-tools.ts, session-tools.ts, search-tools.ts, project-tools.ts, diagnostics-tools.ts, browser-tools.ts) are enumerated in the integrations/mcp-server/ concepts. Adding a new tool is a docs-affecting event. The settings panel renders the same tools from `src/shared/mcp-tool-manifest.ts` (`MCP_TOOL_MANIFEST`); `tests/unit/mcp-tool-list-parity.test.ts` asserts every registered tool is in the manifest and has a heading in one of those concepts (see `.cursor/rules/mcp-tool-list-parity.mdc`).

- `src/main/agent/commands/**`
  WHY: MCP command implementations (column-resolver.ts, handoff-commands.ts, task-commands.ts, backlog-commands.ts, search-commands.ts, etc.) are cited in integrations/mcp-server/how-it-works.md's components table and the tool concepts. Adding or renaming a command file is a docs-affecting event. Small directory; safe to glob.

- `src/main/ipc/handlers/**`
  WHY: handler files register IPC channels, emit event payloads, and define handler-level behavior. A new handler that registers a channel without changing ipc-channels.ts (e.g., event-only ipcMain.on) would slip through the channel-constants anchor. The glob avoids list-rot as handlers are added.

- `src/main/retrieval/summary/**`
  WHY: the summary scheduler and pass (one pass at a time, three calls of ten, the gap, the app-wide backoff after a failed agent call, the per-project one after a failed read, the one-task-per-call retry of a reply with no usable label, the reply-gap log line) are described in settings/app-config.md's `knowledgeGraph.taskSummaries` row, architecture/knowledge-graph.md, and user-guide/knowledge-graph.md's Task summaries paragraph, with their numbers. Small directory; safe to glob.

- `src/main/analytics/**`
  WHY: telemetry/usage-analytics.md tabulates every event name, every property, and the closed vocabularies behind them (usage.ts's ANALYTICS_FEATURES and ONBOARDING_MILESTONES, settings-snapshot.ts's SETTINGS_SNAPSHOT_ALLOWLIST, run-uptime.ts's exit kinds and uptime buckets), and telemetry/error-reporting.md the Sentry side. An added event or a renamed property is a docs-affecting event with no other mechanical check. The allowlist in particular is a privacy control the doc enumerates for users, so drift there is worse than stale: user-guide/settings.md's and settings/settings-panel.md's Privacy paragraphs describe the same collection.

If any anchor source files appear in the changed-file list:

1. Spawn a `doc-auditor` agent with the list of changed anchor source files
2. The agent returns a structured gap report listing missing and extra items per anchor
3. Save the gap report for use in Step 4

If no anchor source files changed, skip this step.

### Step 3 - Prose Audit

For each affected concept (from Step 1):

1. Read the concept
2. Read the source files its `sources:` lists
3. Check for prose staleness - details that are no longer accurate:
   - Changed behavior or algorithm descriptions
   - Stale default value explanations
   - Feature interaction descriptions that no longer hold
   - Renamed parameters or function signatures
   - New or removed CLI flags
   - Changed function signatures or behavior

This step focuses on prose accuracy only. Enumerable completeness is handled by the anchor audit in Step 2.

### Step 4 - Update Pass

For each concept with stale content (from Steps 2 and 3):

1. Fix all anchor gaps reported by the doc-auditor:
   - Add missing items to tables/lists
   - Remove extra items no longer in source
   - Update counts in section headers if applicable
2. Fix prose staleness found in Step 3:
   - Update stale facts (numbers, type names, default values, descriptions)
   - Add sections for significant new features not yet documented
   - Remove sections for removed features
3. When a change alters what a concept holds, update its frontmatter `description` and its line in
   the folder's `index.md` to match (the conformance test compares them), and its `sources:`
4. Update cross-references and indexes if concepts were added, split, or removed

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
   - Check whether the `user-guide/` concept for that feature (from `user-guide/index.md`) or `user-guide/overview.md` covers it
4. For each undocumented feature, determine placement:
   - Read the source files touched by the commit to understand the feature scope
   - Run `node scripts/docs-bundle.mjs sources` on them to find the concepts that document that code
   - Identify the specific section within the target concept where the feature belongs (e.g., "user-guide/task-detail.md > Completed task view")
   - Only create a new concept when the feature introduces a new subsystem or integration point (per "When to Create a New Concept" above). Otherwise append to the existing concept.
5. For each undocumented feature, write the documentation into the target concept in the identified section. Use the Edit tool to add content inline, matching the existing style and level of detail.
6. Report what was written in the Step 7 report (feature, target concept, section, what was added).

### Step 6 - Structural Review

Check overall doc health:

1. Run `npx vitest run tests/unit/okf-docs-conformance.test.ts tests/unit/docs-path-citations.test.ts`:
   the first resolves every relative link and `#fragment` in `docs/`, checks every concept's
   frontmatter and `sources:`, and checks each `index.md` against its concepts and subfolders; the
   second checks every docs path the repo cites
2. Check that the `README.md` Documentation section is current
3. Flag any concept over about 40 KB whose headings split into two topics

### Step 7 - Report

Summarize what was done:

- Anchor audit results (if run): anchors checked, gaps found, gaps fixed
- Prose updates: list of concepts updated with brief change descriptions
- Concepts created, split, or deleted (if any)
- Feature documentation: list of features documented, where they were placed, and what was written
- Items that need human review (ambiguous changes, major restructuring)
- "No changes needed" if everything is current
