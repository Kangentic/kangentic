# Analytics

Kangentic collects anonymous usage statistics to understand adoption and improve the product.

## What We Collect

Nine event types are tracked, all on critical-path actions only:

| Event | When | Properties |
|-------|------|------------|
| `app_launch` | App starts (when analytics is enabled) | platform, arch |
| `app_heartbeat` | Every 30 minutes while app is running | activeSessions, suspendedSessions, queuedSessions, totalSessions |
| `app_close` | Graceful quit, Ctrl+C, or SIGTERM | durationSeconds |
| `app_error` | Uncaught exception, unhandled rejection, renderer crash, or React ErrorBoundary | source, message (sanitized), reason (renderer crashes), exitCode (renderer crashes) |
| `project_create` | User creates a project | (none) |
| `task_complete` | Task moves to Done | agent, model |
| `session_spawn` | Agent session reaches running state (board or transient) | agent, isTransient |
| `session_exit` | Agent session finishes | exitCode, durationSeconds, agent, model |
| `transient_session_spawn` | Transient session launched from command bar | agent |

`agent` is the adapter id from a fixed allowlist (`claude`, `codex`, `gemini`, `qwen-code`, `opencode`, `aider`, `cursor`, `warp`, `copilot`, `kimi`, `droid`). `model` is the CLI-level model identifier the agent itself reports through its status output (e.g. `claude-opus-4-7`, `gpt-5-codex`, `gemini-2.5-pro`).

`model` is only present on events fired *after* the agent has emitted at least one status update, which means it is omitted on `session_spawn` and `transient_session_spawn` (model is unknown at spawn time) and may also be omitted on `session_exit` / `task_complete` for very short sessions that exited before the agent reported a model.

The analytics SDK automatically detects: OS name, OS version, locale, app version, anonymous session ID, and country (derived from IP, then discarded).

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

- No cookies or persistent identifiers
- Random anonymous session IDs (not tied to any identity)
- IP addresses are used for geographic lookup only, then discarded
- No personal data is collected or stored
- GDPR-compliant by design

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
