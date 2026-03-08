# Analytics

Kangentic collects anonymous usage statistics to understand adoption and improve the product.

## What We Collect

Seven event types are tracked, all on critical-path actions only:

| Event | When | Properties |
|-------|------|------------|
| `app_launch` | App starts (when analytics is enabled) | platform, arch |
| `project_create` | User creates a project | (none) |
| `task_create` | User creates a task | (none) |
| `task_start` | Task moves out of Backlog | (none) |
| `task_complete` | Task moves to Done | (none) |
| `session_spawn` | Agent session starts | agent type |
| `session_exit` | Agent session finishes | exit code, duration (seconds) |

The analytics SDK automatically detects: OS name, OS version, locale, app version, anonymous session ID, and country (derived from IP, then discarded).

## What We Don't Collect

- Task titles, descriptions, or any user-generated content
- File paths, project names, or code
- Usernames, emails, or any personally identifiable information
- Mid-board task moves (only backlog-exit and done-entry)

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
| *(unset)* | Analytics enabled in all builds (default) |

Dev-mode events are tagged with `isDebug=true` in Aptabase, so they are filterable and won't pollute production metrics.

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
