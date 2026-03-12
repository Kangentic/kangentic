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
- `quoteArg(arg, shell?)` -- shell-aware quoting: single quotes for Unix-like shells (bash, zsh, WSL), double quotes for PowerShell/cmd. The shell parameter is explicitly passed in all spawn calls so quoting always matches the target shell. Falls back to platform detection when shell is omitted.
- Git Bash: paths like `C:\Users\...` become `/c/Users/...`
- WSL: paths like `C:\Users\...` become `/mnt/c/Users/...`
- `adaptCommandForShell()` -- adds `& ` prefix for PowerShell commands

## Native Modules

| Module | Build Strategy | Packaging |
|--------|---------------|-----------|
| better-sqlite3 | Rebuilt against Electron headers via `scripts/rebuild-native.js` | Included via `files` in `electron-builder.yml`, C++ source excluded |
| node-pty | Prebuilt NAPI binaries, no rebuild needed | Included via `files`, prebuilds unpacked from asar via `asarUnpack` |
| simple-git | Pure JavaScript, bundled by esbuild | Not in node_modules (bundled into main process) |

The `files` array in `electron-builder.yml` explicitly whitelists `.vite/build/**`, `better-sqlite3`, `node-pty`, `bindings`, and `file-uri-to-path`. Everything else is excluded from the packaged app.

### Bridge Script Unpacking

Bridge scripts (`event-bridge.js`, `status-bridge.js`) are executed by Claude Code hooks in a separate `node` process outside Electron. Plain Node.js cannot read files inside asar archives, so `asar.unpackDir` extracts `.vite/build/` to `app.asar.unpacked/`. The `resolveBridgeScript()` function in `command-builder.ts` rewrites `app.asar` to `app.asar.unpacked` in resolved paths when running in a packaged build.

## Config Directory Locations

| Platform | Default Path |
|----------|-------------|
| Windows | `%APPDATA%/kangentic/` |
| macOS | `~/Library/Application Support/kangentic/` |
| Linux | `$XDG_CONFIG_HOME/kangentic/` (defaults to `~/.config/kangentic/`) |

Overridable via `KANGENTIC_DATA_DIR` environment variable.

## Packaging

electron-builder handles platform-specific packaging via `electron-builder.yml`:

| Platform | Format | Builder |
|----------|--------|---------|
| Windows | Installer | NSIS |
| macOS | Disk image + ZIP | DMG |
| Linux | Package | deb, rpm |

## Windows Taskbar Identity (AUMID)

Windows resolves taskbar icons by matching the running window's AppUserModelID (AUMID) to a `.lnk` shortcut with the same AUMID. The NSIS installer creates shortcuts with the `appId` from `electron-builder.yml`.

`app.setAppUserModelId()` in `src/main/index.ts` must use `com.kangentic.app` in packaged builds to match the `appId` in `electron-builder.yml`. In dev mode, a separate AUMID (`com.kangentic.dev`) prevents the dev exe from poisoning the Windows icon cache with the default Electron icon. Note: `BrowserWindow.setIcon()` does not control the Windows taskbar icon -- only the AUMID match does.

## macOS Title Bar

`BrowserWindow` uses `titleBarStyle: 'hidden'` with `trafficLightPosition: { x: 12, y: 12 }` to position the native traffic lights within the custom TitleBar. The renderer detects macOS via `window.electronAPI.platform === 'darwin'` and applies `pl-20` (80px left padding) to prevent content from rendering under the traffic lights. On Windows/Linux, the custom TitleBar renders its own minimize/maximize/close buttons instead.

## macOS Code Signing

macOS builds use hardened runtime with `build/entitlements.plist` providing JIT, unsigned executable memory, and dyld environment variable entitlements (required by node-pty). Notarization uses `notarytool` via electron-builder, gated on the `APPLE_ID` and `APPLE_APP_SPECIFIC_PASSWORD` environment variables.

## Linux System Dependencies

The deb package declares `depends` on Electron's required system libraries (`libnss3`, `libatk-bridge2.0-0`, `libgtk-3-0`, `libgbm1`, `libasound2`, `libdrm2`, `libxshmfence1`). The rpm package uses equivalent `requires` (`nss`, `atk`, `gtk3`, `mesa-libgbm`, `alsa-lib`, `libdrm`, `libXShmfence`). Without these, the app crashes on launch on fresh Linux installations.

## Auto-Update Platform Guard

Auto-update via `electron-updater` runs on Windows and macOS only. The guard in `src/main/updater.ts` checks `app.isPackaged && process.platform !== 'linux'` -- dev mode and Linux are excluded. Linux users update via the launcher package (`npx kangentic`).

## Security Fuses

Electron fuses enabled for production builds:

- **RunAsNode disabled** -- prevents using the app binary as a Node.js runtime
- **NodeOptions disabled** -- blocks `NODE_OPTIONS` env var injection
- **Inspection disabled** -- no `--inspect` debugging in production
- **Cookie encryption enabled** -- encrypts stored cookies
- **ASAR integrity validation** -- verifies archive hasn't been tampered with
- **OnlyLoadAppFromAsar** -- prevents loading code from extracted directories

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
