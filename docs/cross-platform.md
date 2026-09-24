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

Agent spawns (never transient Command Terminals) additionally prefix the typed line with the
shell's own clear via `buildSpawnClearPrelude()` (same module): `Clear-Host; ` for the
PowerShell family, `cls & ` for cmd, and `clear; ` for every other shell (bash, zsh, fish, nu,
dash, ksh, sh, WSL, Git Bash - the default arm, not a closed list). The shell then erases its
startup preamble and command echo the instant the command
executes - a real clear in the real byte stream that every consumer (live terminal, scrollback
ring, headless parser, replays, phone) honors natively. This is the source-level guard against
shell/ConPTY updates reshaping their startup bytes (pwsh 7.6 started emitting `\x1b[?25l` and
`\x1b[2J` inside its escape-only startup preamble, which broke every heuristic that keyed on
those markers); see [session-lifecycle](session-lifecycle.md) for the detection layer it pairs
with.

### npm `.cmd` shims under PowerShell and Git Bash

`quoteArg(..., { multiline: true })` keeps a multi-line prompt on one physical input line. For the
PowerShell family it rewrites each newline as a backtick-n escape inside `"..."`, which PowerShell
expands back into real newlines before the agent sees the argument; for unix-like shells the
newlines stay literal inside `'...'`. Both hold only while the shell launches the agent binary
itself. An npm-installed CLI resolves on PATH to its `.cmd` shim (`which` walks PATHEXT, which
lists neither `.ps1` nor an empty extension), and running a `.cmd` routes through cmd.exe, whose
command line ends at the first newline: the agent received `<task>` and nothing else (#353).
Measured on Windows PowerShell 5.1, pwsh 7.6, and Git Bash; no encoding survives cmd.exe.

Detection reads the same shims. `which` checks that a shim file exists, never that its target
does, and on Windows it searches the working directory before `PATH`, so a `gemini.cmd` left in a
project root by an uninstalled local package used to shadow the real `%APPDATA%\npm\gemini.cmd`
and report the agent missing. `AgentDetector` now enumerates every match and probes them in
order, spending at most four version probes per name. A `.cmd` / `.bat` / `.ps1` shim whose
`node_modules/...` target no longer exists is skipped without a spawn
(`src/main/agent/shared/npm-shim-target.ts`) and costs nothing against that budget, so a run of
dead shims cannot push the real install out of it. npm's third shim file is extensionless and is
what `which` returns on macOS and Linux, so there the skip does not apply and a dead shim costs
one probe before the search moves on.

`resolveShimLaunch` (`src/main/agent/shared/shim-launch.ts`) runs at every spawn chokepoint after
`ensureTrust` and before `buildCommand` (see `.claude/rules/spawn-entry-point-parity.md`). On
Windows with a `.cmd` or `.bat` head it launches the sibling shim native to the host shell
instead, and npm writes both beside every `.cmd`:

| Host shell | Sibling | Gate |
|------------|---------|------|
| PowerShell (pwsh/powershell) | `<name>.ps1` (`& node.exe <bin.js> $args`; a `$args` splat preserves multi-line arguments on 5.1 and 7) | The host's effective execution policy allows scripts: `Get-ExecutionPolicy` is `RemoteSigned`, `Unrestricted`, or `Bypass`, probed once per shell per app run through that same executable with a 5 s timeout; a failed probe counts as blocked. The probe runs without the app's `PSModulePath`: inherited from a pwsh 7 ancestor it makes 5.1 fail to autoload the module that owns `Get-ExecutionPolicy`. Windows PowerShell 5.1 defaults to `Restricted` on client editions, pwsh 7 to `RemoteSigned`, and the two keep separate policies. |
| Git Bash | `<name>` (the extensionless `#!/bin/sh` shim, `exec node <bin.js> "$@"`) | The file exists and starts with `#!`. |
| cmd | none | `quoteArg` already flattens for a cmd host. |
| WSL | none | WSL cannot launch a `.cmd` at all (see [WSL interop](#wsl-runs-the-windows-binary-interop)), and the sh shim would run a Windows bundle under a Linux node. |

With no usable sibling, or under `Restricted` / `AllSigned`, it keeps the `.cmd` head and flattens
the prompt with `sanitizeForPty`, so the whole title and description still arrive on one line
(the reporter's own workaround), and it logs the cause once per shell and path; for the policy
case the fix is `Set-ExecutionPolicy RemoteSigned -Scope CurrentUser` in that host, then an app
restart. Other platforms are untouched, the session row keeps the original prompt, and no adapter
knows any of this: a `.cmd` shim is a Windows packaging fact.

Two consequences. The Windows process tree becomes `pwsh -> node` rather than
`pwsh -> cmd.exe -> node` (the background-shell watcher's immediate-parent rule counts both
shapes). And PowerShell's parameter binder consumes a bare `--` before a `.ps1` sees `$args`, so
`quoteArg('--', shell)` emits `"--"` for PowerShell hosts; the quoted form reaches native
commands and cmd.exe as a plain `--` on every route, which is why the Claude, Grok, Ollama, and
Warp builders route their end-of-options marker through `quoteArg`.

### Spawn-time cwd fixups (Windows)

`resolveSpawnCwd()` (`src/main/pty/spawn/pty-spawn.ts`) passes the working directory to node-pty via its `cwd` option, but two Windows shells mishandle certain valid directories at startup. In those cases it returns a `cwdFixupCommand` that the spawn flow writes into the PTY (raw, before the agent command) so the session lands in the real project directory:

| Shell + cwd | Fixup written first | effectiveCwd |
|-------------|--------------------|--------------|
| cmd.exe + UNC path (`\\server\share\...`) | `pushd "<unc>"` (maps the UNC path to a temporary drive letter; cmd refuses UNC cwds) | Replaced with home |
| PowerShell/pwsh + bracketed path (`D:\[foo]\bar`) | `Set-Location -LiteralPath '<cwd>'` | Left unchanged |

The PowerShell case fixes a Windows PowerShell 5.1 quirk: it treats `[` / `]` in its startup path as wildcard characters, fails to resolve the location, and silently falls back to `$PSHOME` (`C:\Windows\System32\WindowsPowerShell\v1.0`). node-pty's `cwd` is still a valid Win32 directory, so only PowerShell's provider location needs correcting. Applied to the whole PowerShell family (the extra `Set-Location` is harmless in pwsh 7).

## Path Handling

- `toForwardSlash()` - normalizes backslashes to forward slashes for cross-platform CLI commands
- `quoteArg(arg, shell?, { multiline? })` - shell-aware quoting: single quotes for Unix-like shells (bash, zsh, WSL), double quotes for PowerShell and cmd, each escaped by its own rules (see `escapeForDoubleQuotedShell` below). The shell parameter is explicitly passed in all spawn calls so quoting always matches the target shell. Falls back to platform detection when shell is omitted. `{ multiline: true }` keeps newlines in prompt-style content (literal inside `'...'` for unix-like shells, backtick-n escapes for PowerShell, flattened for cmd); a bare `--` is emitted as `"--"` for PowerShell hosts. See [npm `.cmd` shims under PowerShell and Git Bash](#npm-cmd-shims-under-powershell-and-git-bash) for the one place that contract does not reach on its own.
- `escapeForDoubleQuotedShell(text, isCmd)` (`src/shared/shell-quote.ts`) - what `quoteArg` puts inside `"..."`, and the reason cmd and PowerShell are not one branch. They disagree about the backslash. cmd hands the raw command line to the target's C runtime, which reads `\` as an escape in a run immediately before a quote, so that run is doubled or a trailing backslash swallows the closing quote; backtick and `$` are literal there and must NOT be escaped, or the agent receives them doubled. PowerShell is the reverse: backtick is the escape character and `$` starts an expansion, while `\` is not special and escaping it would deliver a doubled path separator. The doc comment carries the measured round-trip table (pwsh 7.6.6, Windows PowerShell 5.1.26100, cmd.exe), including the one case with no answer that is right on both PowerShell hosts.
- `src/shared/shell-quote.ts` also owns the shell predicates and `sanitizeForPty`, which `src/shared/paths.ts` re-exports. The split exists so the renderer can share the real escaping (`quoteForShell` in `src/renderer/utils/terminal-clipboard.ts`, used by drag-drop and image paste): `paths.ts` imports `node:path` and cannot enter that bundle. `quoteForShell` shares the escaping but not `quoteArg` itself, since `sanitizeForPty` would collapse consecutive spaces in a real path.
- `isPowerShellShell(shell)` - the PowerShell-family predicate (`powershell` / `pwsh` substring, the exact negation `isUnixLikeShell` applies) shared by `adaptCommandForShell`, `buildSpawnClearPrelude`, `resolveShellArgs`, `resolveSpawnCwd`, `quoteArg`, and `resolveShimLaunch`.
- Git Bash: paths like `C:\Users\...` become `/c/Users/...`
- WSL: paths like `C:\Users\...` become `/mnt/c/Users/...`
- `adaptCommandForShell()` - adds the `& ` prefix for PowerShell commands, and for unix-like shells (Git Bash, WSL) converts the leading Windows exe path to POSIX form via `convertWindowsExePath()`, which handles bare, double-quoted, and single-quoted leading tokens (a quoted token stays quoted with the same quote character even without spaces, so shell-active path characters like `&` remain inert in the target shell)

## Native Modules

| Module | Build Strategy | Packaging |
|--------|---------------|-----------|
| better-sqlite3 | Rebuilt against Electron headers via `scripts/rebuild-native.js` | Included via `files` in `electron-builder.yml`, C++ source excluded |
| node-pty | Prebuilt NAPI binaries, no rebuild needed, except the macOS `spawn-helper`, which is compiled from `build/spawn-helper/spawn-helper.c` at package time (see macOS Code Signing below) | Included via `files`, prebuilds unpacked from asar via `asarUnpack` |
| sherpa-onnx-node | Prebuilt platform-specific binaries (no rebuild needed) | Included via `files` (`sherpa-onnx-node/**` plus the `sherpa-onnx-*/**` platform packages), unpacked from asar via `asarUnpack: node_modules/sherpa-onnx-*/**` (the voice dictation engine, which runs in its own `kangentic-dictation` utilityProcess - see `.claude/rules/dictation-out-of-process.md` / DESKTOP-X) |
| font-list | Shells out to `fc-list` (Linux) / a PowerShell script (Windows) / a bundled binary (macOS); no rebuild needed | Included via `files` (`font-list/**`), unpacked from asar via `asarUnpack` since the macOS binary is spawned via `child_process` (Terminal Font Family picker) |
| sqlite-vec | Loadable SQLite extension shipped as per-platform binary packages; no rebuild needed | Included via `files` (`sqlite-vec/**` plus the `sqlite-vec-*/**` platform packages), unpacked via `asarUnpack` because SQLite's dlopen cannot read a loadable extension inside an asar archive (conversation-memory retrieval) |
| @huggingface/transformers | Pure JavaScript (transformers.js); no rebuild needed | Included via `files`, unpacked via `asarUnpack` so the embed worker resolves it from the unpacked tree by plain node_modules resolution |
| onnxruntime-node | Prebuilt native binaries (`onnxruntime_binding.node`, plus `onnxruntime.dll` and `DirectML.dll` on Windows) | Included via `files`, unpacked via `asarUnpack` because a native `.node` addon cannot be dlopen'd from inside asar (the embed worker's execution provider) |
| onnxruntime-web | Pure JavaScript; retained only as transformers' optional peer, its wasm path currently unused | Included via `files` and unpacked alongside the others |
| onnxruntime-common | Pure JavaScript; required at module scope by both transformers.js and onnxruntime-node | Included via `files` and unpacked, because the embed worker resolves from the unpacked tree only (see below) |
| sharp, `@img/*`, detect-libc, semver | sharp's prebuilt libvips binding (`@img/sharp-<platform>`) plus its pure-JavaScript runtime deps; transformers.js requires sharp at module scope even though the worker never touches an image | Included via `files` and unpacked, for the same reason |
| simple-git | Pure JavaScript, bundled by esbuild | Not shipped as node_modules; its code is inside `.vite/build/index.js`. A devDependency, like every other bundled package (see `.claude/rules/dependency-block-parity.md`) |

The `files` array in `electron-builder.yml` explicitly whitelists `.vite/build/**`, `package.json`, `better-sqlite3`, `node-pty`, `sherpa-onnx-node`, the `sherpa-onnx-*` platform packages, `font-list`, `bindings`, `file-uri-to-path`, `sqlite-vec`, the `sqlite-vec-*` platform packages, `@huggingface/transformers`, `onnxruntime-node`, `onnxruntime-web`, `onnxruntime-common`, `sharp`, the `@img/*` packages, `detect-libc`, and `semver`. The whitelist governs the app's own files; electron-builder copies every production dependency from `package.json` into the asar on its own, so for a runtime dependency the question is never whether it is in the asar but whether it is unpacked. That also makes the `dependencies` block itself a packaging decision: it used to resolve to 302 packages, most of them already bundled into `.vite/build/**`, and now resolves to 121. `.claude/rules/dependency-block-parity.md` is what keeps it there.

The embed worker's closure is the one that bites: the worker is forked from `app.asar.unpacked`, and Node resolution from a real directory never looks inside the asar, so a package the worker reaches only transitively (transformers.js requires `onnxruntime-common` and `sharp` at module scope) must be unpacked too, or the worker exits 1 at module load on every fork. 0.38.0 and 0.39.0 shipped that way (Sentry DESKTOP-6, DESKTOP-H). `build/afterPack.js` now runs `build/verify-unpacked-worker.js` after packing, once per worker with an unpacked native closure to verify (embed and dictation; line-count's only import, `simple-git`, is bundled by esbuild and has no unpacked closure to check): it loads each worker's external(s) from the unpacked tree in a child `node` whose module resolution is fenced to that tree (an unfenced probe would find the repo's own `node_modules` above `out/` and pass), and fails the package with the child's stderr when anything is missing. The dictation worker (DESKTOP-X) reuses the same gate for `sherpa-onnx-node`. `npm run package` runs it too, so the gate holds locally, not only on the release matrix.

Separately, how the embed, line-count, and dictation workers are forked bites on Windows too.
`UTILITY_PROCESS_STDIO` in `src/main/utility-process/stderr-tail.ts` must never mix `inherit` with
a real handle (`pipe` or `ignore`) across the stdout and stderr slots. Electron gives an `inherit`
slot no Windows branch, so its handle stays null, and it passes both handles to
`ServiceProcessHost` anyway. Electron's patch to `child_process_launcher_helper_win.cc` arms the
child's inherit list when either handle is valid, then fills the null slot from
`GetStdHandle(STD_OUTPUT_HANDLE)`, which is NULL in a packaged GUI build because there is no
console. `SetHandleInformation` on that null handle fails a `PCHECK` in `launch_win.cc` and kills
the main process outright. 0.39.1 shipped `['ignore', 'inherit', 'pipe']` and crashed that way
(Sentry DESKTOP-S); the array is now `['ignore', 'ignore', 'pipe']`. All-`inherit` (what passing no
`stdio` gives you) and all-real are both safe, but omitting `stdio` also drops the piped stderr the
crash reports need, so every worker passes the constant. `npm start` cannot catch this, because a dev
terminal hands the process a valid stdout handle. `tests/unit/stderr-tail.test.ts` guards the
mixing rule and also scans every `utilityProcess.fork` call site for the shared constant.

### Bridge Script Unpacking

Bridge scripts (`event-bridge.js`, `status-bridge.js`) are executed by Claude Code hooks in a separate `node` process outside Electron. Plain Node.js cannot read files inside asar archives, so `asarUnpack` names them individually, alongside `embed-worker.js`, `line-count-worker.js`, `dictation-worker.js`, and `plugins/**` (unpacked for the retrieval, embedding, and dictation subsystems rather than for the hook bridges). Only those six entries under `.vite/build/` are extracted to `app.asar.unpacked/`; the rest of the directory stays inside the archive. The `resolveBridgeScript()` function in `src/main/agent/shared/bridge-utils.ts` rewrites `app.asar` to `app.asar.unpacked` in resolved paths when running in a packaged build.

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

### PTY children and mach exception ports

node-pty never execs a terminal's program itself on macOS. It posix_spawns `prebuilds/darwin-<arch>/spawn-helper`, which attaches the tty, changes directory, and execs the target. Mach exception ports survive both steps. Once `@sentry/electron` starts Electron's `crashReporter`, Crashpad owns Kangentic's task-level crash port, so every process an agent started from a terminal inherited it. Their crashes landed in our crash database: an ffprobe, a headless Chrome, a dotnet, another project's Electron (Sentry DESKTOP-K, -N, -Q, -1D). Linux and Windows are not affected, because Crashpad installs in-process there and exec resets it.

`build/spawn-helper/spawn-helper.c` is upstream's helper plus one `task_set_exception_ports(mach_task_self(), EXC_MASK_ALL | EXC_MASK_CRASH, MACH_PORT_NULL, ...)` call before `execvp`, fenced by `kangentic:` markers. `EXC_MASK_ALL` alone is not enough. xnu leaves `EXC_MASK_CRASH` out of it, and Crashpad installs its task port for `EXC_CRASH` and `EXC_RESOURCE`. The probe's `check` mode reads the same widened mask for the same reason. With no task-level port, a crash falls through to the host-level ReportCrash, as it would for a program started from Terminal.app. The return value is ignored, so a refusal leaves the child exactly as before rather than failing the spawn. Kangentic's own renderer, GPU, and utility processes are launched by Chromium, not node-pty, and still report to Crashpad.

`build/install-spawn-helper.js` does the work at package time and fails the build rather than skipping:

- `build/afterPack.js` compiles a universal (arm64 + x86_64) helper for `mac.minimumSystemVersion`, copies it over every `darwin-*/spawn-helper` in the unpacked tree, and gates it. `build/spawn-helper/exception-port-probe.c` gives itself an `EXC_CRASH` port, checks that a control child inherits it, then checks that a child exec'd through the helper has none. A `/bin/pwd -P` run through the helper proves the cwd and exec contract.
- `build/afterSign.js` runs the same gate on the signed helper before notarization, since hardened runtime is the one thing signing adds. electron-builder calls that hook only when it signed, so an unsigned local `npm run package` gets the afterPack gate alone.
- `.github/workflows/macos-spawn-helper.yml` runs `node build/install-spawn-helper.js --self-test` on `macos-latest` when the helper, its gates, or `package-lock.json` change. It runs both gates, the second after ad-hoc signing the helper with hardened runtime (the same kernel flag Developer ID signing sets). It then runs a real node-pty session through the signed helper, checking cwd and the controlling tty. Last, it runs Node under the probe's `with-port` mode, so Node holds a live inherited port the way Kangentic's main process holds Crashpad's, and launches `[helper, '', '/bin/sh', '-c', command]` from `child_process` with stdin a pipe. A control launch must see the port and the shell launched through the helper must not, under the pid `child_process` returned. It is path-filtered and not a required check.
- `tests/unit/spawn-helper-upstream-parity.test.ts` runs on Linux CI. It fails when the installed node-pty's `spawn-helper.cc`, its helper path, or its `[helper, cwd, file, ...args]` layout drifts from what our helper assumes.

The four `child_process` paths that launch a shell able to run anything go through the same helper: the login-shell env probe (`src/main/shell-env.ts`, on every macOS launch), `SHELL_EXEC` shortcuts, run-script automations, and the post-worktree init script. They share one function, `resolveShellLaunch` in `src/main/pty/spawn/shell-launch.ts`, which on macOS turns a launch into `[helper, '', file, ...args]` (a command string becomes `/bin/sh -c`, which is what `shell: true` runs). The helper execs in place, so the pid, a process-group kill, and an `execFile` timeout all still reach the shell. Windows and Linux launch exactly as before. `tests/unit/shell-launch-parity.test.ts` fails on a literal `shell: true` anywhere else in `src/main`, so a new shell launch has to go through it too.

Three gaps remain on purpose:

- `npm start` uses node-pty's stock helper, for PTYs and for the shell launches above. That is harmless by default, because an unpackaged run leaves Sentry off and there is no Crashpad port to inherit. It stops being harmless once a switch turns Sentry on: `KANGENTIC_ERROR_REPORTING=1`, or `KANGENTIC_TELEMETRY=1` with `KANGENTIC_ERROR_REPORTING` left unset (`resolveErrorReportingEnabled` in `src/main/analytics/error-reporting.ts`).
- Headless agent runs (`src/main/agent/shared/auto-name.ts`) launch an agent binary, not a shell. The helper exits 1 when its target is missing instead of raising ENOENT, and a missing CLI has to keep surfacing as ENOENT, so they stay direct. The docstring on `resolveShellLaunch` says how to route one without losing that.
- Git runs repository hooks, and git is launched as a plain binary.

What still leaks shows up as the Sentry warning "Foreign process crash reached Kangentic's crash database", split by its `module` tag and release (see "Error Reporting" in `docs/analytics.md`).

## Linux System Dependencies

The deb package declares `depends` on Electron's required system libraries (`libnss3`, `libatk-bridge2.0-0`, `libgtk-3-0`, `libgbm1`, `libasound2t64 | libasound2`, `libdrm2`, `libxshmfence1`); the alternation covers Ubuntu 24.04+'s rename of `libasound2` to `libasound2t64`. The rpm package declares `depends` as `.so` soname capabilities (`libnss3.so()(64bit)`, `libatk-1.0.so.0()(64bit)`, `libgtk-3.so.0()(64bit)`, `libgbm.so.1()(64bit)`, `libasound.so.2()(64bit)`, `libdrm.so.2()(64bit)`, `libxshmfence.so.1()(64bit)`) rather than package names, because RPM package names differ per distro (Fedora `libxshmfence` vs. openSUSE `libxshmfence1`) while every distro's rpmbuild auto-generates a `Provides:` for the soname itself. See `.claude/rules/linux-package-dependencies.md`. Without these, the app crashes on launch, or fails to install at all, on fresh Linux installations.

## When the GPU process is unusable

The fatal is not a Linux problem, although one route to it is. DESKTOP-W is a `LOG(FATAL)`
browser-process kill via `OnProcessLaunchFailed`, seen on three Linux installs: Ubuntu 24.04,
NixOS and CachyOS. DESKTOP-15 is a recovered GPU death on the Ubuntu box three days later.
DESKTOP-18 is the identical `LOG(FATAL)` on Windows 10, via `OnProcessCrashed` with
`EXCEPTION_BREAKPOINT`, on an Intel UHD 630. The shipped code has never had a platform gate. The
launch-failure route is Linux's in practice, because of how Linux launches the GPU process (see
"Why a Linux launch failure leaves no trace" below).

DESKTOP-18 is worth reading for its timing rather than its stack. All seven of that install's
runs died between 8.3 and 12.0 seconds after their own `app_start_time`, so Chromium walked its
entire fallback ladder within nine seconds of boot, seven times, and the user never got in. That
rules out anything the app itself was doing: no agent, terminal, or embedding work exists that
early, and the software-GL rung does not touch the display driver at all. It is a host problem,
and the app's job is to survive it rather than diagnose it.

`--disable-gpu` (which `app.disableHardwareAcceleration()` appends, along with disabling the
GpuDataManager, and only before the app is ready) is still not a fix on its own, on either
platform. The reasoning is worth keeping so a future GPU issue does not re-derive it and ship the
flag that does not work.

Chromium's own fallback ladder (`content/browser/gpu/gpu_data_manager_impl_private.cc`,
`GpuDataManagerImplPrivate::InitializeGpuModes`) pushes `DISPLAY_COMPOSITOR` and, if allowed,
`SOFTWARE_GL` onto `fallback_modes_` **before** checking `--disable-gpu`, and
`FallBackToNextGpuMode` pops from the back. So the full pop order is hardware GL ->
`SOFTWARE_GL` -> `DISPLAY_COMPOSITOR` -> empty list -> `LOG(FATAL)`
(`IntentionallyCrashBrowserForUnusableGpuProcess`, whose message - `"GPU process isn't usable.
Goodbye."` - is exactly what DESKTOP-W's minidump carried). A fallback driven by crashes or launch
failures goes through `FallBackToNextGpuModeDueToCrash`, which skips `SOFTWARE_GL` unless a feature
allows it. On Electron 41 that makes the fatal the sixth counted failure: three on hardware, then
three on `DISPLAY_COMPOSITOR` (measured on Linux, below). Either way the last rung is
`DISPLAY_COMPOSITOR`, which already runs without the display driver. `--disable-gpu` starts
Chromium lower in that same list: on `SOFTWARE_GL` where it is allowed, otherwise on
`DISPLAY_COMPOSITOR`. The Linux measurement below reads exactly like `DISPLAY_COMPOSITOR`, while
Windows reads like `SOFTWARE_GL`. Either way, a GPU process that cannot even launch reaches the
identical `LOG(FATAL)`, only faster. A launch failure is not something a rendering-mode flag can
route around. The same holds for DESKTOP-18's crash shape on Windows, because reaching the fatal at
all means the rungs below hardware had already been current and had already failed.

### Why a Linux launch failure leaves no trace

On Linux the GPU process is not launched directly. `GpuSandboxedProcessLauncherDelegate::GetZygote`
forks it from the unsandboxed zygote, so a GPU "launch failure" means
`ZygoteCommunication::ForkRequest` returned no process. When that zygote is gone, two things happen
at once:

- The running GPU process's death reads as a normal exit. `GetTerminationStatus` defaults to
  `TERMINATION_STATUS_NORMAL_TERMINATION` when the zygote cannot answer, and
  `BrowserChildProcessHostImpl::OnChildDisconnected` drops that status with no crash count and no
  observer call, so no `child-process-gone` fires.
- Every relaunch through the dead zygote fails to launch, and Electron forwards no launch failure
  to JS. `electron_api_app.cc` overrides `BrowserChildProcessCrashed` and
  `BrowserChildProcessKilled` but not `BrowserChildProcessLaunchFailed`. Chromium also runs the
  delegate that reaches the fatal before it notifies any observer.

Reproduced in Electron 41.10.7 on Ubuntu 24.04 under WSLg, with `--ignore-gpu-blocklist` so that
compositing starts on the GPU: SIGKILL the `--type=zygote --no-zygote-sandbox` process, then the GPU
process. The browser logged `Failed to send GetTerminationStatus message to zygote`, six
`GPU process launch failed: error_code=1002` inside 2 ms, and the fatal. JS saw no
`child-process-gone` at all. That is DESKTOP-W's stack, and it is why the 0.43.0 crash left
`gpu-health.json` empty. All three DESKTOP-W installs sent Sentry nothing but the fatal, 25 s,
3 min and 4 min into their runs. Why the zygote or its fork failed on those hosts is still unknown.
A dead zygote and a fork refused at the process limit produce the same stack, so each recorded
fallback on Linux now carries the answer (below).

What does reach JS is the fallback itself. Falling back to `DISPLAY_COMPOSITOR` calls
`OnGpuBlocked`, which notifies `gpu-info-update`, and `gpu_compositing` reads `disabled_software`
from then on. The notify is posted a full GPU launch round trip before the fatal, so the listener
runs first by queue order, not by a margin of time. In the reproduction, a synchronous write from
that listener was on disk before the process died, in the same millisecond as the fatal. Killing
the GPU process alone, with the zygote alive, walks the same ladder by crashes
instead: six SIGKILLs produced five `child-process-gone` events, the fallback's `gpu-info-update`
arrived 1 ms after the third, and the sixth kill, the fatal one, was never announced.

### The recovery

The switch that does work is `--in-process-gpu`: it removes the GPU child process entirely, so
`IntentionallyCrashBrowserForUnusableGpuProcess` is unreachable. It was deferred when DESKTOP-W
was the only evidence, on the grounds that it trades a GPU hang for an app hang. DESKTOP-18's seven
dead launches settled that trade: an app that hangs occasionally beats an app that cannot start.

Measured on Electron 41, booting a real window with both switches applied:

| | Platform | `app.getAppMetrics()` process types | `gpu_compositing` | `webgl` |
|---|---|---|---|---|
| Control | Windows | `Browser`, `GPU`, `Tab`, `Utility` | `enabled` | `enabled` |
| `--disable-gpu --in-process-gpu` | Windows | `Browser`, `Tab`, `Utility` | `disabled_software` | `unavailable_software` |
| Control, `--ignore-gpu-blocklist` | Linux (WSLg) | `Browser`, `GPU`, `Utility`, `Tab` | `enabled` | `enabled` |
| `--disable-gpu --in-process-gpu` | Linux (WSLg) | `Browser`, `Utility`, `Tab` | `disabled_software` | `disabled_off` |

No GPU process is spawned at all, which is the property the whole recovery path rests on. On Linux
the window still painted: a page capture found all 10,000 pixels of a 100 px animated box. The
Linux rows come from Ubuntu 24.04 under WSLg, whose GL is Mesa's d3d12 driver rather than a native
one, and which Chromium blocklists, so the control needed `--ignore-gpu-blocklist` to start on the
GPU. macOS has not been measured. `app.getGPUInfo('complete')` still settles under the switches
(1 ms on Windows), and still names the adapter, so the report loses nothing by running in this
mode. `webgl: unavailable_software` is why `terminal-webgl.ts` skips its attach entirely rather
than retrying on its usual schedule: in this mode the context is not blocked, it cannot exist.

What ships now, on every platform:

- `src/main/diagnostics/gpu-health.ts` records EVERY GPU `child-process-gone` death, not just a
  threshold breach, along with the Chromium GPU mode each one left behind. That is read after
  Chromium handled the death, so the death that triggers a fallback already reads the lower rung:
  three kills record `enabled`, `enabled`, `disabled_software` on both Windows and Linux. The threshold moved
  to report time. The reason is ordering: Chromium calls `GpuProcessHost::RecordProcessCrash` (and
  the `LOG(FATAL)` below it) from the delegate, BEFORE the observer notification Electron emits
  `child-process-gone` from, so the death that kills the app is one JS is never told about.
  Whatever is going to be on disk has to already be there.
- The same file records the fallback, from `gpu-info-update`: the moment `gpu_compositing` leaves
  the GPU after this run was seen compositing on it, and each later status change. A launch-failure
  ladder leaves nothing else (see above), so the record's `lastAt` covers a fallback as well as a
  death, and the next launch's near-end check counts it as the death that ended the run. A machine
  that never had GPU compositing normally writes nothing: our own software mode reads exactly like
  `DISPLAY_COMPOSITOR` from its first update, and a blocklisted driver churns its status at every
  boot.
- On Linux, `src/main/diagnostics/linux-gpu-zygote.ts` finds the unsandboxed zygote on the first
  `gpu-info-update`, while the GPU is healthy, and each recorded fallback carries a `linux` reading:
  whether that zygote is `alive`, `dead` (gone, a zombie, or its pid reused), or `unknown`, plus the
  system-wide thread count from `/proc/loadavg` and the soft `Max processes` limit. A dead zygote is
  never a normal state, so it also lifts the hardware-first rule above: a blocklisted Linux box whose
  zygote dies is recorded too. Verified with the real modules bundled into the WSLg reproduction: on
  both a GPU-composited start and a blocklisted one, killing the zygote and then the GPU process
  wrote a `hardware-fallback` record with `zygote: dead` before the fatal, while killing the GPU
  process alone recorded `zygote: alive`. Three shapes stay uncovered: a machine that already sits
  on the last rung, since its fatal comes with no further `gpu-info-update`; a Linux machine that
  never composited on the GPU and whose zygote is alive but cannot fork, at the process limit for
  example; and a Windows or macOS machine that never composited on the GPU, where there is no
  zygote to check. On a kernel without the per-thread `children` files, finding the zygote falls
  back to one scan of every `/proc` entry, once per run.
- `src/main/index.ts` decides at MODULE SCOPE, before `app.whenReady()`, whether to start in
  software rendering, because `app.disableHardwareAcceleration()` THROWS once the app is ready
  rather than quietly doing nothing. It engages both that call and `--in-process-gpu`:
  `--in-process-gpu` removes the GPU child, and the `--disable-gpu` the API appends keeps the
  display driver out of the browser process that child's absence would otherwise pull it into.
  `--in-process-gpu` is set on every platform, unguarded, and has been verified on Windows and on
  Linux (under WSLg), not on macOS. That is deliberate rather than an oversight: the issues this
  path exists for came from Windows and Linux installs, and a platform gate would only weaken the
  recovery somewhere it has not been measured.
- The downgrade is a real user-visible setting (`graphicsAccelerationEnabled`, Settings > Performance),
  set to `off` once and never back on by us. A one-line callout says Kangentic did it. Nothing
  watches the driver version: we never established what killed the GPU process, so the app claims
  no cause and suggests no cure.

See "Error Reporting" in [analytics.md](analytics.md) for the reporting half.

## Auto-Update Platform Guard

Auto-update via `electron-updater` runs on **all three platforms**. The guard in `src/main/updater.ts` checks `app.isPackaged` only, so the sole exclusion is dev mode.

Linux is included because `electron-updater` ships `DebUpdater` / `RpmUpdater` and selects one via the `package-type` marker `electron-builder` writes into `resourcesPath` for every fpm target in its `supportsAutoUpdate` list. `initUpdater` carries two `process.platform` branches. On Linux it forces `autoInstallOnAppQuit` to `false`, because the package manager always elevates and an auth prompt on the quit path is both confusing and race-prone. On macOS it sets `disableDifferentialDownload`, because the cached `update.zip` the differential path reads gets evicted under disk pressure and the resulting `ENOENT` was once our dominant updater failure. See [Linux auto-update](deployment.md#linux-auto-update).

Two platform-specific FAILURES have no branch in that guard, because each is recognized by the error it produces rather than by `process.platform`. On Linux a denied elevation prompt is counted and never filed. On macOS an app running from a read-only volume cannot be written over, so it never updates; that one is also the single updater failure the app tells the user about. See [macOS read-only volumes](deployment.md#macos-read-only-volumes) and the "counted, not reported" entries in [analytics.md](analytics.md).

Release notes are not gated by that guard either. The post-update "What's New" dialog reads notes inlined into the renderer bundle at build time, so it works for every install route: an `npx kangentic` upgrade and a manual installer run both surface it on the next launch. See [Auto-Update Behavior](deployment.md#auto-update-behavior).

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

Two keys are keeplisted, both renderer tuning flags rather than identity markers, so neither can
re-parent a session. An explicit value already present in the environment always wins for both,
including a user's opt-out, and non-Claude agents ignore them.

- `CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT`: defaulted to `1` on **win32 only**, matching what Claude
  Code's own agent views do on Windows, because the fullscreen TUI otherwise intermittently drops
  history entries from its incremental scrolled-view updates.
- `CLAUDE_CODE_SCROLL_SPEED`: keeplisted only, **no default**. A default of `3` was shipped and
  reverted the same day: the fullscreen TUI's differential renderer intermittently mis-assembles
  frames on large scrolled jumps, pipe reads coalesce rapid wheel reports into one jump, and the
  3x multiplier tripled every such jump past that corruption threshold. The CLI default of `1`
  matches the native terminals verified clean; the keeplist exists so a user's exported tuning
  still survives the identity-marker strip.

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

`COLORTERM` and `TERM_PROGRAM` are deliberately not defaulted, even though VS Code's integrated
terminal exports both unconditionally. Claude Code already selects truecolor from
`TERM=xterm-256color` alone (measured 2026-08-28 at claude 2.1.250: 222 truecolor SGR sequences,
zero indexed, with COLORTERM absent), so a `COLORTERM` default would change nothing. `TERM_PROGRAM`
is host identity that the CLI's DECSTBM capability gate enumerates among its inputs, so a fake
host name could reopen the gate that `scrollRegionSuffix()` in `headless-frame.ts` guards against.

## See Also

- [Shell Resolution](architecture.md#shell-resolution) -- overview in architecture doc
- [Developer Guide](developer-guide.md#packaging) -- build and package commands
