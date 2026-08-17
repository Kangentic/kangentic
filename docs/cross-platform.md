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
| WSL (wsl -d ...) | Split into exe + args | Leading exe path converted to `/mnt/c/...` (runs the Windows binary via WSL interop) |
| bash/zsh | `--login` | Standard execution |
| fish | (none) | No login flag |
| nushell (nu) | (none) | No login flag |
| cmd | (none) | Standard execution |
| Git Bash | `--login` | Leading exe path converted to `/c/...` |

The leading-token conversion (`convertWindowsExePath` in `src/shared/paths.ts`) recognizes all
three quote forms a command builder can emit: a bare path, a double-quoted path, and the
single-quoted path `quoteArg` produces for unix-like shells. UNC exe paths (`\\server\share\...`)
are normalized the same way.

### Spawn-time cwd fixups (Windows)

`resolveSpawnCwd()` (`src/main/pty/spawn/pty-spawn.ts`) passes the working directory to node-pty via its `cwd` option, but two Windows shells mishandle certain valid directories at startup. In those cases it returns a `cwdFixupCommand` that the spawn flow writes into the PTY (raw, before the agent command) so the session lands in the real project directory:

| Shell + cwd | Fixup written first | effectiveCwd |
|-------------|--------------------|--------------|
| cmd.exe + UNC path (`\\server\share\...`) | `pushd "<unc>"` (maps the UNC path to a temporary drive letter; cmd refuses UNC cwds) | Replaced with home |
| PowerShell/pwsh + bracketed path (`D:\[foo]\bar`) | `Set-Location -LiteralPath '<cwd>'` | Left unchanged |

The PowerShell case fixes a Windows PowerShell 5.1 quirk: it treats `[` / `]` in its startup path as wildcard characters, fails to resolve the location, and silently falls back to `$PSHOME` (`C:\Windows\System32\WindowsPowerShell\v1.0`). node-pty's `cwd` is still a valid Win32 directory, so only PowerShell's provider location needs correcting. Applied to the whole PowerShell family (the extra `Set-Location` is harmless in pwsh 7).

## Path Handling

- `toForwardSlash()` - normalizes backslashes to forward slashes for cross-platform CLI commands
- `quoteArg(arg, shell?)` - shell-aware quoting: single quotes for Unix-like shells (bash, zsh, WSL), double quotes for PowerShell/cmd. The shell parameter is explicitly passed in all spawn calls so quoting always matches the target shell. Falls back to platform detection when shell is omitted.
- Git Bash: paths like `C:\Users\...` become `/c/Users/...`
- WSL: paths like `C:\Users\...` become `/mnt/c/Users/...`
- `adaptCommandForShell()` - adds the `& ` prefix for PowerShell commands, and for unix-like shells (Git Bash, WSL) converts the leading Windows exe path to POSIX form via `convertWindowsExePath()`, which handles bare, double-quoted, and single-quoted leading tokens (a quoted token stays quoted with the same quote character even without spaces, so shell-active path characters like `&` remain inert in the target shell)

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

Release notes are not gated by that guard. The pre-restart modal is, since it needs a downloaded update, but the post-update "What's New" dialog reads notes inlined into the renderer bundle at build time, so it works on every platform and for every install route: a Linux `npx kangentic` upgrade and a manual installer run both surface it on the next launch. See [Auto-Update Behavior](deployment.md#auto-update-behavior).

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

## Windows MAX_PATH is mostly not the wall people expect

It is tempting to treat 260 as a hard ceiling for everything inside a worktree. Measurement says
otherwise. Taken on 2026-07-30 inside a 98-character Kangentic worktree of a React Native / Expo
project, with `node_modules` a real directory rather than a junction:

| | |
|---|---|
| Files | 75,133 |
| Longest absolute path | **337** |
| Files already over MAX_PATH (260) | **1,958** |
| `npm install`, `expo prebuild`, Gradle | all completed |
| `LongPathsEnabled` | `0` |

Node, the JVM and Git route around MAX_PATH with the `\\?\` prefix, so they are unaffected by the
registry setting and unaffected by depth at these scales. **A length-based warning would have fired
on that healthy tree and told the user nothing true.**

### The limit that does bind is still MAX_PATH, applied to a string you never see

The one thing that failed in that worktree was the native compile. It is tempting to blame CMake's
`CMAKE_OBJECT_PATH_MAX` (250 on Windows), because that warning floods the log. Measurement says
otherwise: raising it to 1000 took the warnings from **402 to zero and the build failed
identically**, so it is a policy warning the build routinely survives, not the cause.

The real mechanism is MAX_PATH applied to a composed path that never appears in any log:

```
ninja explain: output ../prefab/arm64-v8a/prefab/lib/aarch64-linux-android/cmake/
               ReactAndroid/ReactAndroidConfig.cmake of phony edge with no inputs doesn't exist
```

That file exists. Its normalized absolute path is 254 characters. But ninja stats it **relative to
the build directory**, and Windows measures the composed string *before* collapsing the `..`:

| | |
|---|---|
| build directory | 170 |
| relative path | 96 |
| **what Windows actually resolves** | **267** |
| normalized path that exists on disk | 254 |

The stat fails, ninja concludes a required output is missing, re-runs the generator, and loops until
`ninja: error: manifest 'build.ninja' still dirty after 100 tries` - a message that names no path, no
limit, and no file.

A second, independent case appears once the first is cleared: CMake hashes leading components of an
object name to fit its own limit, but when even the hashed floor exceeds that limit it gives up and
emits the **full** unshortened name (395 characters, where the floor would have been 254), and ninja
reports `Filename longer than 260 characters`.

Both are MAX_PATH, and both scale with the checkout root, which is why a short root works:

| Checkout | Root | Native build |
|---|---|---|
| `C:\kw` | 5 | builds |
| The project at its normal location | 48 | builds |
| Kangentic worktree, numeric scheme | 73 | fails |
| Kangentic worktree, pre-numeric scheme | 98 | fails |

The practical limit for a given project can only be found by building it, and it moves with the
toolchain: the binding module here was whichever one had the deepest build directory combined with
the longest prefab dependency name.

### What Kangentic does about it

It keeps its own overhead small and bounded, and otherwise stays out of the way. The numeric worktree
folder took Kangentic's contribution from about 49 characters to about 24 (`\.kangentic\worktrees\`
plus a short number); see
[Worktree Directory Naming](worktree-strategy.md#worktree-directory-naming).

There is deliberately **no path-length threshold, no proactive warning, and no configurable worktree
root**. A length check fires on length rather than on the presence of a native toolchain, so it warns
the majority about a failure they will never see, and it cannot observe the case that actually breaks
(the overflow surfaces inside Gradle, in the agent's terminal).

A short worktree root **does** help, as the table above shows, but it can never be a guarantee:
Kangentic controls neither where the user's project lives nor how deep a toolchain builds beneath it.
Bounding its own contribution is the honest limit of what it can promise.

`src/shared/windows-path-budget.ts` therefore holds no reserves. It recognizes a path-length failure
**after** one has happened, from the error text (`ENAMETOOLONG`, "filename or extension is too long",
"Filename too long", "Filename longer than", "manifest 'build.ninja' still dirty after"), matching
through a wrapped `cause` chain, and `describeWorktreePathLengthCause` appends an explanation so the
user is not left reading raw git output. It is a no-op off Windows.

The CMake `CMAKE_OBJECT_PATH_MAX` strings are deliberately **not** in that list. They are a policy
warning builds routinely survive: measured, they fired 402 times on a build that failed for the ninja
reason above, and zero times on a build that still failed after the limit was raised.

A project whose native toolchain genuinely cannot fit has two options, and the second is usually
better. It can live at a shorter path, which is a property of the project's location rather than of
Kangentic. Or it can point the toolchain's build output somewhere short: Android's
`externalNativeBuild.cmake.buildStagingDirectory`, for instance, moves `.cxx` out of the source tree
and takes checkout depth out of the calculation entirely, which fixes the case at **any** depth
rather than buying a fixed number of characters.

Note that Node resolves through the worktree's `node_modules` junction using the pre-resolution
path, so a tool inside a worktree sees the worktree path even though the junction target lives at
the project root. A junction is not a way around any of this.

## WSL Support

- Detection: `wsl --list --quiet` with 5s timeout
- Docker filtering: distros starting with `docker-` are excluded
- Shell spec: stored as `wsl -d Ubuntu` etc., split into exe (`wsl.exe`) + args (`-d Ubuntu`) at spawn time. The `.exe` extension is appended deliberately: node-pty's ConPTY executable search cannot resolve the extension-less bare name (the session exits -1 with no output)
- Path conversion: the leading exe path of the agent command is converted to `/mnt/c/...`; the agent command itself is written into the PTY after the shell starts, never passed in argv

### WSL runs the Windows binary (interop)

Converting the CLI path to `/mnt/c/...` launches the **Windows** agent binary through WSL's
binfmt interop, which can only execute PE `.exe` files. Two consequences, both accepted as
documented limitations:

- npm-installed `.cmd` / `.bat` shims cannot be launched from inside WSL (Git Bash can run
  them; WSL interop cannot). Users on WSL need the agent's native `.exe` install.
- A CLI installed *inside* the distro (e.g. `claude` under Linux) is not discovered: CLI
  detection resolves on the Windows host only, identically for every shell. Preferring a
  distro-native binary in WSL mode would also require converting every path *argument*
  (`--settings`, `--mcp-config` are Windows paths, correct for a Windows binary, wrong for a
  Linux one); it is a possible follow-up feature, not current behavior.

## Environment Stripping and Defaults

When spawning PTY sessions, `buildSpawnEnv` (`src/main/pty/spawn/pty-spawn.ts`) strips `CLAUDECODE`
and every `CLAUDE_CODE_*` identity marker from the merged environment. Kangentic is often launched
from inside a Claude Code session, and those markers would otherwise re-parent the spawned agent to
the launching session, so a later `--resume` finds nothing. A Kangentic-spawned agent must always be
a clean top-level session. `ANTHROPIC_*` keys (BYOK / API auth) are deliberately left untouched.

One key is keeplisted: `CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT`. It is a renderer tuning flag, not an
identity marker, so it cannot re-parent a session. Kangentic defaults it to `1` on **win32 only**,
matching what Claude Code's own agent views do on Windows, because the fullscreen TUI otherwise
intermittently drops history entries from its incremental scrolled-view updates. An explicit value
already present in the environment always wins, including a user's opt-out. Non-Claude agents ignore
the variable.

`NO_COLOR` is stripped too, but only when the merged environment also carries `CLAUDECODE`. Claude
Code exports `NO_COLOR=1` into its tool shells alongside `CLAUDECODE`, so a dev/preview Kangentic
launched from inside a Claude Code session would otherwise force-dim every color-capable CLI in
every agent PTY. A `NO_COLOR` present without `CLAUDECODE` is a deliberate user preference and
passes through untouched, as does an explicit per-spawn `NO_COLOR` supplied by a caller.

`buildSpawnEnv` also defaults `TERM=xterm-256color` when the merged environment has no TERM (an
empty TERM counts as absent). node-pty turns the `name` spawn option into the child's TERM only on
POSIX; its Windows path never writes TERM, so a child of a PowerShell-launched Kangentic would see
no TERM at all and capability-detecting TUIs (Antigravity's agy) render monochrome. The default
gives Windows children the same environment POSIX children already get; an explicit TERM in the
environment always wins.

## See Also

- [Shell Resolution](architecture.md#shell-resolution) -- overview in architecture doc
- [Developer Guide](developer-guide.md#packaging) -- build and package commands
