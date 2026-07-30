# Cross-Platform Support

Kangentic runs on Windows, macOS, and Linux. This document covers platform-specific behavior including shell detection, path handling, native modules, and packaging.

## Shell Resolution

Platform-specific detection order in `src/main/pty/spawn/shell-resolver.ts`:

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

Adaptations applied during the spawn flow (`src/main/pty/lifecycle/session-spawn-flow.ts`) via `adaptCommandForShell()` (exported from `src/shared/paths.ts`):

| Shell | Args | Command Adaptation |
|-------|------|-------------------|
| PowerShell (pwsh/powershell) | `-NoLogo` | `& ` prefix for command execution |
| WSL (wsl -d ...) | Split into exe + args | Paths converted to `/mnt/c/...` |
| bash/zsh | `--login` | Standard execution |
| fish | (none) | No login flag |
| nushell (nu) | (none) | No login flag |
| cmd | (none) | Standard execution |
| Git Bash | `--login` | Paths may use `/c/...` format |

### Spawn-time cwd fixups (Windows)

`resolveSpawnCwd()` (`src/main/pty/spawn/pty-spawn.ts`) passes the working directory to node-pty via its `cwd` option, but two Windows shells mishandle certain valid directories at startup. In those cases it returns a `cwdFixupCommand` that the spawn flow writes into the PTY (raw, before the agent command) so the session lands in the real project directory:

| Shell + cwd | Fixup written first | effectiveCwd |
|-------------|--------------------|--------------|
| cmd.exe + UNC path (`\\server\share\...`) | `pushd "<unc>"` (maps the UNC path to a temporary drive letter; cmd refuses UNC cwds) | Replaced with home |
| PowerShell/pwsh + bracketed path (`D:\[foo]\bar`) | `Set-Location -LiteralPath '<cwd>'` | Left unchanged |

The PowerShell case fixes a Windows PowerShell 5.1 quirk: it treats `[` / `]` in its startup path as wildcard characters, fails to resolve the location, and silently falls back to `$PSHOME` (`C:\Windows\System32\WindowsPowerShell\v1.0`). node-pty's `cwd` is still a valid Win32 directory, so only PowerShell's provider location needs correcting. Applied to the whole PowerShell family (the extra `Set-Location` is harmless in pwsh 7).

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
| sherpa-onnx-node | Prebuilt platform-specific binaries (no rebuild needed) | Included via `files` (`sherpa-onnx-node/**` plus the `sherpa-onnx-*/**` platform packages), unpacked from asar via `asarUnpack: node_modules/sherpa-onnx-*/**` (voice dictation engine) |
| font-list | Shells out to `fc-list` (Linux) / a PowerShell script (Windows) / a bundled binary (macOS); no rebuild needed | Included via `files` (`font-list/**`), unpacked from asar via `asarUnpack` since the macOS binary is spawned via `child_process` (Terminal Font Family picker) |
| simple-git | Pure JavaScript, bundled by esbuild | Not in node_modules (bundled into main process) |

The `files` array in `electron-builder.yml` explicitly whitelists `.vite/build/**`, `better-sqlite3`, `node-pty`, `sherpa-onnx-node`, the `sherpa-onnx-*` platform packages, `font-list`, `bindings`, and `file-uri-to-path`. Everything else is excluded from the packaged app.

### Bridge Script Unpacking

Bridge scripts (`event-bridge.js`, `status-bridge.js`) are executed by Claude Code hooks in a separate `node` process outside Electron. Plain Node.js cannot read files inside asar archives, so `asar.unpackDir` extracts `.vite/build/` to `app.asar.unpacked/`. The `resolveBridgeScript()` function in `src/main/agent/shared/bridge-utils.ts` rewrites `app.asar` to `app.asar.unpacked` in resolved paths when running in a packaged build.

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

The deb package declares `depends` on Electron's required system libraries (`libnss3`, `libatk-bridge2.0-0`, `libgtk-3-0`, `libgbm1`, `libasound2t64 | libasound2`, `libdrm2`, `libxshmfence1`); the alternation covers Ubuntu 24.04+'s rename of `libasound2` to `libasound2t64`. The rpm package declares `depends` as `.so` soname capabilities (`libnss3.so()(64bit)`, `libatk-1.0.so.0()(64bit)`, `libgtk-3.so.0()(64bit)`, `libgbm.so.1()(64bit)`, `libasound.so.2()(64bit)`, `libdrm.so.2()(64bit)`, `libxshmfence.so.1()(64bit)`) rather than package names, because RPM package names differ per distro (Fedora `libxshmfence` vs. openSUSE `libxshmfence1`) while every distro's rpmbuild auto-generates a `Provides:` for the soname itself. See `.claude/rules/linux-package-dependencies.md`. Without these, the app crashes on launch, or fails to install at all, on fresh Linux installations.

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

## Windows Long Paths

Git worktrees live under `.kangentic/worktrees/<n>/`, which can push deeply nested file paths past Windows' default 260-character limit. Kangentic enables `core.longpaths=true` on Windows during worktree creation (both as a per-command flag for `git worktree add` and as a persistent config in the worktree's local git config). This activates the `\\?\` extended-length path prefix, allowing paths up to 32,767 characters. macOS and Linux are unaffected (1024-4096 byte `PATH_MAX`). See [Worktree Strategy](worktree-strategy.md#windows-long-paths) for details.

## Windows MAX_PATH and build toolchains

`core.longpaths` only covers git. The toolchains that run *inside* a worktree - npm, node-gyp, CMake,
the Android NDK, Rust - are not long-path aware, so what matters is how many of the 260 characters
the worktree path leaves for them.

`src/shared/windows-path-budget.ts` holds the measured reserves. They are measurements, not
estimates:

| Tier | Deepest path relative to the checkout root | Measured against |
|---|---|---|
| Source tree | 91 | this repository |
| `node_modules` | 142 | this repository, 39,571 files |
| React Native Android (CMake/NDK) | 242 | a completed release build |

The React Native figure is the floor **after** CMake's own MD5 path shortening, not a starting
point, and CMake compares the full object path against a 250-character `CMAKE_OBJECT_PATH_MAX`. So
such a build needs the worktree path itself to be about 7 characters, which no worktree naming
scheme can deliver. A project with a native toolchain that deep has to live at a short path; that is
what short-path checkouts like `C:\kw` exist for.

What Kangentic controls is its own overhead, and the numeric worktree folder reduces it from 49
characters to about 4. That is enough for node-gyp, Rust, and less extreme CMake projects.

There is deliberately **no proactive warning and no configurable worktree root**. A path-length check
fires on path length rather than on the presence of a native toolchain, so it would warn most users
about a failure that will never reach them, and it cannot observe the worst case anyway (a CMake
object-path overflow surfaces inside Gradle, in the agent's terminal). Instead,
`describeWorktreePathLengthCause` appends an explanation to a worktree failure that has *already*
happened, when headroom is genuinely short. `worktreePathHeadroom` accounts for the separator; both
are no-ops off Windows.

Note that Node resolves through the worktree's `node_modules` junction using the pre-resolution
path, so the 142-character reserve applies to the worktree path even though the junction target
lives at the project root.

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
