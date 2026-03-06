# Cross-Platform Support

Kangentic runs on Windows, macOS, and Linux. This document covers platform-specific behavior including shell detection, path handling, native modules, and packaging.

## Shell Resolution

Platform-specific detection order in `src/main/pty/shell-resolver.ts`:

### Windows

Detection order: pwsh (PowerShell 7) → powershell (PowerShell 5) → bash (Git Bash) → cmd → WSL distros

WSL detection: runs `wsl --list --quiet`, filters out Docker-internal distros. Each distro appears as "WSL: Ubuntu" etc.

### macOS

Detection order: zsh → bash → fish → nushell (nu) → sh

Default: `$SHELL` env var, or zsh as fallback.

### Linux

Detection order: bash → zsh → fish → dash → nushell (nu) → ksh → sh

Default: `$SHELL` env var, or bash as fallback. Final fallback: `/bin/sh`.

## Shell-Specific Adaptations

Adaptations applied in `SessionManager.doSpawn()` and `adaptCommandForShell()`:

| Shell | Args | Command Adaptation |
|-------|------|-------------------|
| PowerShell (pwsh/powershell) | `-NoLogo` | `& ` prefix for command execution |
| WSL (wsl -d ...) | Split into exe + args | Paths converted to `/mnt/c/...` |
| bash/zsh | `--login` | Standard execution |
| fish | (none) | No login flag |
| nushell (nu) | (none) | No login flag |
| cmd | (none) | Standard execution |
| Git Bash | `--login` | Paths may use `/c/...` format |

## Path Handling

- `toForwardSlash()` -- normalizes backslashes to forward slashes for cross-platform CLI commands
- `quoteArg()` -- wraps arguments in double quotes on Windows, handles escaping
- Git Bash: paths like `C:\Users\...` become `/c/Users/...`
- WSL: paths like `C:\Users\...` become `/mnt/c/Users/...`
- `adaptCommandForShell()` -- adds `& ` prefix for PowerShell commands

## Native Modules

| Module | Build Strategy |
|--------|---------------|
| better-sqlite3 | Rebuilt per platform during packaging (Visual Studio Build Tools on Windows, Xcode on macOS, build-essential on Linux) |
| node-pty | Prebuilt NAPI binaries, no rebuild needed |
| simple-git | Pure JavaScript, no native code |

## Config Directory Locations

| Platform | Default Path |
|----------|-------------|
| Windows | `%APPDATA%/kangentic/` |
| macOS | `~/Library/Application Support/kangentic/` |
| Linux | `$XDG_CONFIG_HOME/kangentic/` (defaults to `~/.config/kangentic/`) |

Overridable via `KANGENTIC_DATA_DIR` environment variable.

## Packaging

Electron Forge handles platform-specific packaging via `forge.config.ts`:

| Platform | Format | Maker |
|----------|--------|-------|
| Windows | Installer | Squirrel |
| macOS | Disk image | DMG |
| Linux | Package | deb, rpm |
| All | Archive | ZIP (fallback) |

## Security Fuses

Electron fuses enabled for production builds:

- **RunAsNode disabled** -- prevents using the app binary as a Node.js runtime
- **NodeOptions disabled** -- blocks `NODE_OPTIONS` env var injection
- **Inspection disabled** -- no `--inspect` debugging in production
- **Cookie encryption enabled** -- encrypts stored cookies
- **ASAR integrity validation** -- verifies archive hasn't been tampered with

## WSL Support

- Detection: `wsl --list --quiet` with 5s timeout
- Docker filtering: distros starting with `docker-` are excluded
- Shell spec: stored as `wsl -d Ubuntu` etc., split into exe (`wsl`) + args (`-d Ubuntu`) at spawn time
- Path conversion: Windows paths converted to `/mnt/c/...` for WSL environments

## Environment Stripping

When spawning PTY sessions, Kangentic strips the `CLAUDECODE` environment variable from `process.env`. This prevents spawned Claude CLI sessions from refusing to start when Kangentic itself was launched from inside a Claude Code session.

## See Also

- [Shell Resolution](architecture.md#shell-resolution) -- overview in architecture doc
- [Developer Guide](developer-guide.md#packaging) -- build and package commands
