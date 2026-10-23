---
type: Reference
title: Droid
description: Factory's Droid, a bare droid --cwd command since autonomy is set in its TUI, session ids polled from ~/.factory/sessions cwd-slug files, a project .factory/mcp.json holding only an environment reference for the token, and why live telemetry is unsupported.
tags: [agents, adapter, droid]
sources:
  - resource: src/main/agent/adapters/droid/droid-adapter.ts
  - resource: src/main/agent/adapters/droid/detector.ts
  - resource: src/main/agent/adapters/droid/command-builder.ts
  - resource: src/main/agent/adapters/droid/session-id-capture.ts
---
# Droid

## CLI Detection

`src/main/agent/adapters/droid/detector.ts`

Droid is Factory's coding agent CLI (the `droid` binary). Detection follows the standard `AgentDetector` flow with a `droid --version` probe. Output is either `droid <semver>` or bare `<semver>`; `parseVersion` strips the optional `droid` product prefix and returns the trimmed version string. Standard Unix fallback paths are wired via `standardUnixFallbackPaths('droid')` for cases where the binary is not on `PATH`. Refer to Factory's documentation for the current install command.

## Command Building

`src/main/agent/adapters/droid/command-builder.ts`

```
droid --cwd <cwd> [--resume <uuid>] "<prompt>"
```

Empirically validated against Droid 0.109.1 (see `scripts/probe-droid.js`). The adapter is intentionally minimal - the bare command with cwd + optional resume + prompt is the production path. Other CLI behavior (model picker, autonomy mode, BYOK) is configured in Droid's TUI and persisted in `~/.factory/settings.json`. Trying to shadow these with Kangentic-managed `--settings` overrides was rejected by user feedback as unnecessary custom layering.

## Session ID Capture

`src/main/agent/adapters/droid/session-id-capture.ts`

`captureSessionIdFromFilesystem` polls `~/.factory/sessions/<cwd-slug>/` (up to 20 attempts at 500ms) for `<uuid>.jsonl` files whose mtime is at or above `spawnedAt - 30s`, and returns the UUID with the newest qualifying mtime. The cwd slug normalizes path separators and the drive-letter colon to `-` (e.g. `C:\Users\dev\project` -> `-C-Users-dev-project`). Concurrent Droid spawns in the same cwd within the 30s floor can collide; per-task worktrees are the recommended mitigation.

## Permission Modes

Droid does not accept a CLI flag for autonomy mode. The adapter surfaces a single `default` mode and the user cycles autonomy in the TUI directly (shift+tab toggles low/medium/high). Kangentic does not translate `permissionMode` into a flag override.

## MCP Setup

Droid CLI has no per-spawn `--mcp-config` flag, but it does expand `${NAME}` references against the process environment inside `headers` values at connect time, and never rewrites the file with the expanded value. Kangentic uses that: on spawn it writes a project-scoped `<cwd>/.factory/mcp.json` holding only the environment variable NAME, and supplies the value through the adapter's `buildEnv`. `~/.factory/mcp.json` is never touched, and the token never reaches disk even though the file lives inside the user's repo.

```json
{
  "mcpServers": {
    "kangentic": {
      "type": "http",
      "url": "<kangenticMcpUrl>",
      "headers": { "X-Kangentic-Token": "${KANGENTIC_MCP_TOKEN}" }
    }
  }
}
```

User-defined servers in that file are preserved, and `removeHooks` strips only the `kangentic` entry once the folder's last session ends (deleting the file when nothing else remains). Verified against droid 0.189.0: `droid mcp list` reports `kangentic  http  connected  [project]`.

Cleanup runs from the PTY exit and suspend paths, so a hard kill (Task Manager, crash, OS reboot) leaves the entry behind pointing at a dead loopback port until the next spawn rewrites it. It holds no secret, but it is a file Kangentic wrote inside the user's tree, so when Kangentic creates it the builder seeds `.factory/mcp.json` and `.kangentic/` into `.git/info/exclude` via the shared `git-exclude.ts` mechanism (see [Antigravity](antigravity.md)) - the file never shows as untracked and cannot ride a `git add -A`. A pre-existing user `mcp.json` keeps its normal git visibility (the created-by-us carve-out). A Droid session on a project with worktrees disabled writes it into the project root rather than a worktree, which is what makes that entry matter.

## Limitations

### No live telemetry (model, cost, tokens, context window)

Droid 0.109.x has no per-session telemetry channel that Kangentic can subscribe to. The three documented surfaces all sit outside the live-streaming contract that `ContextBar` requires:

- **`/cost` and `/context` slash commands** - post-hoc and user-initiated inside the TUI, not a stream Kangentic can read.
- **`OTEL_TELEMETRY_ENDPOINT`** - out-of-band OpenTelemetry export to a collector. Not a per-session signal we can subscribe to from the main process.
- **`~/.factory/sessions/<cwd-slug>/<uuid>.settings.json`** - written post-hoc, schema undocumented and unstable. Empirical parsing was evaluated and rejected (see "Out of scope" below).

As a result, `SessionUsage` is never populated for Droid sessions. The Droid adapter declares `liveTelemetryUnsupported` (carrying a label and tooltip) on `AgentAdapter`, the field flows to the renderer through `AgentDetectionInfo`, and `ContextBar` reads the generic capability and renders a "Telemetry: TUI only" pill (with the adapter-supplied tooltip) in place of the loading spinner. The board card and the Agent Monitor card show the same label in their footer, in place of "Starting agent..." (`TelemetryUnavailableFooter`, `task-card-view.tsx`). The renderer never branches on agent name. Users get live telemetry by running `/cost` or `/context` directly inside the Droid TUI.

Tracked upstream at [Factory-AI/factory#TBD](https://github.com/Factory-AI/factory/issues) - once a per-session streaming channel ships (status file, named pipe, or `stream-json` on interactive `droid`), wire a `runtime.sessionHistory` (or `runtime.statusFile` / `runtime.streamOutput`) parser in `src/main/agent/adapters/droid/` and remove `liveTelemetryUnsupported` from the Droid adapter. The renderer falls back to the standard model / cost / token pills automatically.

### Other gaps

- No status events or activity log integration; the terminal panel is the only signal of agent state.
- No trust dialog (`ensureTrust` is a no-op; Droid does not prompt for directory approval).
- No cross-agent handoff source: `locateSessionHistoryFile` returns null because Droid's JSONL transcript format has not yet been wired into the handoff pipeline.

### Out of scope: post-hoc JSONL replay

Reading `<uuid>.settings.json` after session exit was considered as a "good enough" fallback for cost/token totals. Rejected because (a) the file schema is undocumented and observed to differ across Droid 0.10x point releases, (b) post-hoc data does not solve the live-spinner UX, only the final-row UX, and (c) Factory has signaled willingness to add a streaming channel - see upstream FR.
