# Claude Code Integration

Kangentic orchestrates Claude Code CLI sessions through a layered integration: CLI detection, command building, settings merge with hook injection, trust management, and bridge scripts for real-time feedback.

## CLI Detection

`src/main/agent/adapters/claude/detector.ts`

On first use, `ClaudeDetector` locates the Claude CLI:

1. If `config.agent.cliPaths.claude` is set, use that path directly
2. Otherwise, search `PATH` using the `which` package
3. Run `claude --version` (5s timeout) to capture the version string
4. Cache the result for the app lifetime (`invalidateCache()` resets)

Returns `{ found: boolean, path: string | null, version: string | null }`.

## Command Building

`src/main/agent/adapters/claude/command-builder.ts`

### New Session

```
claude --settings <mergedSettingsPath> --session-id <uuid> -- "prompt text"
```

- `--session-id <uuid>` creates a new conversation with a known ID (enables resume later)
- `--` separates options from the prompt (prevents prompt content like `--flag` from being parsed as CLI options)
- Prompt has double quotes replaced with single quotes to avoid PowerShell quoting issues

### Resumed Session

```
claude --settings <mergedSettingsPath> --resume <uuid>
```

- `--resume <uuid>` continues an existing conversation
- No prompt is injected -- Claude resumes from its saved context

### Permission Mode Flags

| Mode | CLI Flag |
|------|----------|
| `default` | `--settings <path>` (uses project-settings) |
| `plan` | `--permission-mode plan` |
| `acceptEdits` | `--permission-mode acceptEdits` |
| `dontAsk` | `--permission-mode dontAsk` |
| `auto` | `--permission-mode auto` |
| `bypassPermissions` | `--dangerously-skip-permissions` |

### Permission Mode Resolution (Priority Order)

1. Swimlane's `permission_mode` (if set)
2. Global `config.agent.permissionMode`

### Non-Interactive Mode

When `nonInteractive` is set, `--print` is added. The agent runs, prints output, and exits without waiting for user input.

## Prompt Templates

Actions of type `spawn_agent` can define a `promptTemplate` with placeholders:

| Variable | Value |
|----------|-------|
| `{{title}}` | Task title (PTY-sanitized) |
| `{{description}}` | Task description with `: ` prefix when non-empty, empty string otherwise |
| `{{taskId}}` | Task UUID |
| `{{worktreePath}}` | Worktree directory path (empty if no worktree) |
| `{{branchName}}` | Git branch name (empty if no worktree) |
| `{{prUrl}}` | Pull request URL (empty if none) |
| `{{prNumber}}` | Pull request number as string (empty if none) |
| `{{attachments}}` | Bare file paths (one per line) when attachments exist, empty otherwise |

Default template: `{{title}}{{description}}{{attachments}}`

This produces prompts like:
- `Fix auth bug: Users can't login after password reset` followed by `/path/to/screenshot.png` on the next line
- `Add dark mode` (no description, no attachments)

Shortcut commands use a separate set of template variables. See [Configuration](configuration.md#shortcuts) for the full list.

## Settings Merge

For every session, a merged settings file is built at `.kangentic/sessions/<claudeSessionId>/settings.json` and passed via `--settings`:

1. Read `.claude/settings.json` from project root (committed, shared)
2. Deep-merge `.claude/settings.local.json` from project root (gitignored, personal)
   - Hooks: concatenated per event type (local hooks appended after project hooks)
   - Permissions: deduplicated union of allow/deny arrays
3. For worktrees: merge permissions from the worktree's `.claude/settings.local.json`
   - Only permissions are merged (captures "always allow" grants from user)
   - Hooks from the worktree are skipped (may be stale leftovers)
4. Inject `statusLine` config pointing to the status bridge script
5. Inject event-bridge hooks into all registered hook points
6. Write merged file to session directory
7. Pass `--settings <mergedSettingsPath>` to the CLI

All Kangentic artifacts stay in `.kangentic/` -- nothing is written to `.claude/settings.local.json`.

## Hook Injection

Kangentic subscribes to 17 Claude Code hook points via the event bridge:

| Hook Event | Event Type | Purpose |
|------------|-----------|---------|
| `PreToolUse` (blank) | `tool_start` | Agent began using a tool |
| `PostToolUse` (blank) | `tool_end` | Tool execution completed |
| `PostToolUseFailure` (blank) | `tool_failure` | Tool execution failed |
| `UserPromptSubmit` | `prompt` | User submitted a prompt |
| `Stop` | `idle` | Agent stopped naturally |
| `PermissionRequest` | `idle` | Agent hit a permission wall |
| `SessionStart` | `session_start` | Session began |
| `SessionEnd` | `session_end` | Session ended |
| `SubagentStart` | `subagent_start` | Main agent launched a subagent |
| `SubagentStop` | `subagent_stop` | Subagent finished |
| `Notification` | `notification` | Informational notification |
| `PreCompact` | `compact` | Context compaction starting |
| `TeammateIdle` | `teammate_idle` | Teammate agent went idle |
| `TaskCompleted` | `task_completed` | Task marked complete |
| `ConfigChange` | `config_change` | Configuration changed |
| `WorktreeCreate` | `worktree_create` | Worktree created |
| `WorktreeRemove` | `worktree_remove` | Worktree removed |

All hooks use blank matchers (fire for every invocation regardless of tool name). See [Activity Detection](activity-detection.md) for the full event-to-state mapping and state derivation logic.

### Hook Identification

Kangentic hooks are identified by two markers in the command string:
- Contains `.kangentic` (path component)
- Contains a known bridge name (`activity-bridge` or `event-bridge`)

Both must match. This two-marker pattern prevents false positives on user-defined hooks with similar names. The `activity-bridge` check is for backwards compatibility with older session directories -- the current bridge script is `event-bridge`.

### Hook Cleanup

`stripKangenticHooks()` in `hook-manager.ts` removes all Kangentic hooks from `.claude/settings.local.json` on project close or delete. This is a backward-compatibility function -- the unified `--settings` approach means Kangentic no longer writes hooks to `settings.local.json`, but older worktrees may still have them.

Safety guarantees:
- Backs up the original file before modification
- Validates JSON integrity before writing
- Restores from backup on any error
- Deletes empty settings files and `.claude/` directories

## Trust Management

`src/main/agent/adapters/claude/trust-manager.ts`

When spawning an agent in a worktree (CWD differs from project root), `ensureWorktreeTrust()` pre-populates `~/.claude.json` so Claude Code doesn't prompt for trust:

1. Read `~/.claude.json` (or start from empty object if missing/malformed)
2. Find the parent project's trust entry in `projects`
3. Create a new entry for the worktree path with `hasTrustDialogAccepted: true`
4. Copy `enabledMcpjsonServers` from the parent entry (MCP server inheritance)
5. Write back to `~/.claude.json`

Idempotent -- skips write if the worktree is already trusted.

## Bridge Scripts

Two standalone Node.js scripts in `src/main/agent/`:

### `status-bridge.js`

- **Hook point:** `statusLine` (not a hook -- uses Claude Code's status line feature)
- **Output:** `status.json` (overwritten on each invocation)
- **Data:** Token usage, cost, model, context window percentage
- **Watched by:** SessionManager with 100ms debounce

### `event-bridge.js`

- **Hook point:** All registered hooks (17 event types)
- **Output:** `events.jsonl` (append-only, one JSON line per event)
- **Data:** Timestamps, event types, tool names, file paths
- **Watched by:** SessionManager with 50ms debounce, incremental byte-offset reads

Both scripts are stateless (no persistent process), read JSON from stdin, write to their output file, and exit. All writes are try/catch wrapped for non-fatal failures.

## CWD Strategy

Claude CLI is invoked with `cwd` set to:
- **Worktree path** if the task has a worktree
- **Project directory** otherwise

This ensures Claude Code loads the project's `.claude/` directory (commands, skills, settings) from the correct location.

## See Also

- [Activity Detection](activity-detection.md) -- event processing, state derivation, subagent-aware transitions
- [Session Lifecycle](session-lifecycle.md) -- spawn flow, resume, crash recovery
- [Worktree Strategy](worktree-strategy.md) -- worktree creation, sparse-checkout, hook delivery
- [Configuration](configuration.md) -- permission modes
