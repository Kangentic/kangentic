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
| `architecture.md` | `src/shared/ipc-channels.ts`, `src/preload/preload.ts`, `src/renderer/stores/`, `src/main/pty/session-manager.ts` |
| `session-lifecycle.md` | `src/main/pty/session-manager.ts`, `src/main/pty/session-queue.ts`, `src/main/engine/session-recovery.ts` |
| `configuration.md` | `src/shared/types.ts` (AppConfig, DEFAULT_CONFIG, GLOBAL_ONLY_PATHS), `src/main/config/config-manager.ts` |
| `claude-integration.md` | `src/main/agent/command-builder.ts`, `src/main/agent/hook-manager.ts`, `src/main/agent/trust-manager.ts`, `src/main/agent/claude-detector.ts` |
| `transition-engine.md` | `src/main/engine/transition-engine.ts`, `src/shared/types.ts` (ActionType, ActionConfig) |
| `database.md` | `src/main/db/migrations.ts`, `src/main/db/database.ts`, `src/main/db/repositories/*.ts` |
| `cross-platform.md` | `src/main/pty/shell-resolver.ts`, `electron-builder.yml`, `scripts/build.js` |
| `worktree-strategy.md` | `src/main/git/worktree-manager.ts`, `src/main/agent/hook-manager.ts`, `src/main/agent/trust-manager.ts` |
| `activity-detection.md` | `src/main/agent/event-bridge.js`, `src/shared/types.ts` (EventType, EventTypeActivity, HookEvent) |
| `mcp-server.md` | `src/main/ipc/handlers/mcp-handlers.ts`, `src/main/mcp/`, `src/shared/types.ts` (MCP types) |
| `overview.md` | `README.md`, high-level features |
| `user-guide.md` | `src/renderer/components/`, `src/renderer/stores/`, `src/shared/types.ts` |
| `developer-guide.md` | `scripts/`, `tests/`, `electron-builder.yml`, `package.json` |
| `docs/README.md` | All other docs (index) |

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
| `HookEvent` | Object keys | claude-integration.md |
| `EventTypeActivity` | Mapping entries | activity-detection.md |
| `AppConfig` / `DEFAULT_CONFIG` | Flattened dot-paths + defaults | configuration.md |
| `BoardConfig` | Interface fields | configuration.md |
| `BoardColumnConfig` | Interface fields | configuration.md |

### IPC Anchors (src/shared/ipc-channels.ts)

| Anchor | What to extract | Target doc |
|--------|----------------|------------|
| IPC channels | All string values from `IPC` object | architecture.md (per-group tables) |
| IPC group counts | Count per section header | architecture.md (section headers) |

### Database Anchors (src/main/db/migrations.ts)

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

### Template Anchors

| Anchor | Source file | Target doc |
|--------|-----------|------------|
| Template variables | `src/shared/template-vars.ts` | configuration.md (canonical), transition-engine.md and claude-integration.md (cross-reference only) |

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

Check if any changed source files are anchor sources (see Anchor Points section above):
- `src/shared/types.ts`
- `src/shared/ipc-channels.ts`
- `src/main/db/migrations.ts`
- `src/renderer/components/settings/AppSettingsPanel.tsx`
- `src/renderer/components/settings/settings-registry.ts`
- `src/shared/template-vars.ts`

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
