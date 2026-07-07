# Analytics

Kangentic collects anonymous usage statistics to understand adoption and improve the product.

## What We Collect

Nine event types are tracked, all on critical-path actions only:

| Event | When | Properties |
|-------|------|------------|
| `app_launch` | App starts (when analytics is enabled) | platform, arch, clientId |
| `app_heartbeat` | Every 30 minutes while at least one agent session is active; skipped when idle. Also fires once right before system sleep if a session is active | activeSessions, suspendedSessions, queuedSessions, totalSessions |
| `app_close` | Graceful quit, Ctrl+C, SIGTERM, or OS shutdown/reboot/log-off | durationSeconds |
| `app_error` | Uncaught exception, unhandled rejection, renderer crash, or React ErrorBoundary | source, message (sanitized), reason (renderer crashes), exitCode (renderer crashes) |
| `project_create` | User creates a project | (none) |
| `task_complete` | Task moves to Done | agent, model, durationSeconds, costUsd, inputTokens, outputTokens, toolCalls |
| `session_spawn` | Agent session reaches running state (board or transient) | agent, isTransient |
| `session_exit` | Agent session finishes | exitCode, durationSeconds, agent, model, costUsd, toolCalls |
| `transient_session_spawn` | Transient session launched from command bar | agent |

`agent` is the adapter id from a fixed allowlist (`claude`, `codex`, `gemini`, `qwen-code`, `opencode`, `aider`, `cursor`, `warp`, `copilot`, `kimi`, `droid`). `model` is the CLI-level model identifier the agent itself reports through its status output (e.g. `claude-opus-4-7`, `gpt-5-codex`, `gemini-2.5-pro`).

`model` is only present on events fired *after* the agent has emitted at least one status update, which means it is omitted on `session_spawn` and `transient_session_spawn` (model is unknown at spawn time) and may also be omitted on `session_exit` / `task_complete` for very short sessions that exited before the agent reported a model.

For Claude sessions, `model` is normalized to its base id via `parseModelId` (`src/shared/model-id.ts`) before being attached, so the 1M-context opt-in suffix and a dated pin no longer fragment the model breakdown: `claude-opus-4-8[1m]` -> `claude-opus-4-8`, `claude-haiku-4-5-20251001` -> `claude-haiku-4-5`. This is a display-layer grouping only - the exact spawnable id is unaffected.

`costUsd`, `inputTokens`, `outputTokens`, and `toolCalls` are cumulative session metrics, omitted when not yet available (e.g. a session that exited before any usage was recorded). `session_exit` carries `costUsd`/`toolCalls` only, since its token counts would otherwise be a point-in-time context-window snapshot rather than a cumulative total; `task_complete` is the source for cumulative token counts.

The `app_launch` event also carries `clientId`, an anonymous id Kangentic generates and attaches (see "Unique Installs" below). It is attached only to `app_launch` (the one authoritative per-launch install signal), not to every event, to avoid inflating high-cardinality string-prop volume on events like `app_heartbeat` where it adds no install-counting value.

The analytics SDK automatically detects: OS name, OS version, locale, app version, anonymous session ID, and country (derived from IP, then discarded).

### Unique Installs

Aptabase's own identity model rotates daily (see "How It Works" below), so it cannot report unique users or installs. To make that possible ourselves, Kangentic generates its own anonymous `clientId` and attaches it to the `app_launch` event, the one authoritative per-launch install signal, so unique installs can be rolled up as `COUNT(DISTINCT clientId)` over that event.

- **Derivation:** `clientId` is an HMAC-SHA256 digest of the OS machine id (already SHA-256-hashed by the `node-machine-id` library) and a hash of the OS home directory, keyed with a fixed Kangentic salt. It is a one-way, non-reversible digest containing no raw machine identifiers, paths, or usernames.
- **Stability:** stable across app updates and a clean uninstall/reinstall, because it is derived from the OS install itself rather than data Kangentic's own uninstaller would remove. It is unique per OS user, so two accounts on a shared machine get distinct ids.
- **Fallback:** if the OS machine-id source is unavailable (e.g. a hardened or containerized environment), Kangentic falls back to a random id persisted locally; that id does not survive a reinstall.
- **Control:** `clientId` is on by default and shares the same `KANGENTIC_TELEMETRY` control as every other event below - there is no separate opt-out.

## What We Don't Collect

- Task titles, descriptions, or any user-generated content
- File paths, project names, or code
- Usernames, emails, or any personally identifiable information
- Task creation, task start, or mid-board task moves (only done-entry is tracked)

## Why

- Understand how many people use Kangentic and on which platforms
- Measure product effectiveness (task completion rates, agent success rates)
- Prioritize development based on actual usage patterns

## How It Works

Kangentic uses [Aptabase](https://aptabase.com), a privacy-first, open-source analytics platform designed for desktop apps:

- No cookies
- Aptabase's own session IDs are random and rotate daily, not tied to any identity
- IP addresses are used for geographic lookup only, then discarded
- No personal data is collected or stored
- GDPR-compliant by design

Kangentic separately attaches its own anonymous, non-reversible `clientId` to the `app_launch` event so we can count unique installs ourselves - see "Unique Installs" above. It contains no personal data and is not an Aptabase feature.

All analytics run in the main process only -- the renderer never sends analytics events.

## KANGENTIC_TELEMETRY Environment Variable

The `KANGENTIC_TELEMETRY` environment variable controls analytics:

| Value | Behavior |
|-------|----------|
| `0` or `false` | Analytics disabled (opt-out) |
| `1` or `true` | Analytics enabled, even in dev builds (for local debugging) |
| *(unset)* | Analytics enabled in production only (default) |

### Opt-out examples

**Windows (PowerShell):**
```
$env:KANGENTIC_TELEMETRY = "0"
```

**Windows (System):**
Add `KANGENTIC_TELEMETRY` with value `0` in System Properties > Environment Variables.

**macOS / Linux:**
```
export KANGENTIC_TELEMETRY=0
```

Add the export to your shell profile (`~/.bashrc`, `~/.zshrc`, etc.) to make it permanent.

## Data Retention

Data retention follows [Aptabase's privacy policy](https://aptabase.com/legal/privacy).
