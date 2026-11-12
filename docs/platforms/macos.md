---
type: Reference
title: macOS
description: "macOS-only behavior: the hidden title bar and traffic lights, hardened runtime entitlements and notarization, the custom node-pty spawn-helper that clears mach exception ports so terminal children do not report crashes to Kangentic's Crashpad, and the 1024-byte limit on a line typed into a shell that is still starting."
tags: [macos, code-signing, spawn-helper, crashpad, tty]
sources:
  - resource: build/entitlements.plist
  - resource: build/spawn-helper/spawn-helper.c
  - resource: build/install-spawn-helper.js
  - resource: build/afterSign.js
  - resource: build/verify-signed-team-id.js
  - resource: .github/workflows/macos-spawn-helper.yml
  - resource: src/main/pty/spawn/shell-launch.ts
  - resource: src/main/pty/spawn/typed-launch.ts
---
# macOS

## macOS Title Bar

`BrowserWindow` uses `titleBarStyle: 'hidden'` with `trafficLightPosition: { x: 12, y: 12 }` to position the native traffic lights within the custom TitleBar. The renderer detects macOS via `window.electronAPI.platform === 'darwin'` and applies `pl-20` (80px left padding) to prevent content from rendering under the traffic lights. On Windows/Linux, the custom TitleBar renders its own minimize/maximize/close buttons instead.

## Typed lines and the 1024-byte limit

macOS keeps 1024 bytes of a line in a tty's canonical mode (`MAX_CANON`) and drops the rest, the Enter included. A spawn types its command 100 ms after the shell starts, so a shell still in its startup files (nvm, oh-my-zsh, powerlevel10k) gets the line in that mode. The agent then never starts: the shell shows the command cut off with an open quote, and nothing reports an error. It depends on timing as well as length. On one Mac a 1723-byte launch ran, and a later 1590-byte resume of the same task stopped at exactly 1024 bytes.

`--append-system-prompt` with the browser policy took a Claude launch past that limit, and a long task prompt reaches it too. So a command past 900 bytes goes in a launcher file in the session folder, and the shell is typed a short line that sources it: see [A command too long to type](shells-and-paths.md#a-command-too-long-to-type). `macos-spawn-helper.yml` runs that line through real zsh during a controlled startup delay, and fails if the old whole line stops failing, so the job proves it reached the limit. It also runs one under a pinned powerlevel10k with instant prompt, which draws a prompt before the startup files finish, so a screen that looks ready is not one.

## macOS Code Signing

macOS builds use hardened runtime with `build/entitlements.plist` providing JIT, unsigned executable memory, and dyld environment variable entitlements (required by node-pty). Notarization uses `notarytool` via electron-builder, gated on the `APPLE_ID` and `APPLE_APP_SPECIFIC_PASSWORD` environment variables.

### macOS: mach exception ports

Terminal children reaching Kangentic's Crashpad handler is a leak on Windows too, through a
different mechanism: see [PTY children and Crashpad's handler](windows.md#pty-children-and-crashpads-handler).

node-pty never execs a terminal's program itself on macOS. It posix_spawns `prebuilds/darwin-<arch>/spawn-helper`, which attaches the tty, changes directory, and execs the target. Mach exception ports survive both steps. Crashpad owns Kangentic's task-level crash port, so every process an agent started from a terminal inherited it. Their crashes landed in our crash database: an ffprobe, a headless Chrome, a dotnet, another project's Electron (Sentry DESKTOP-K, -N, -Q, -1D).

`build/spawn-helper/spawn-helper.c` is upstream's helper plus one `task_set_exception_ports(mach_task_self(), EXC_MASK_ALL | EXC_MASK_CRASH, MACH_PORT_NULL, ...)` call before `execvp`, fenced by `kangentic:` markers. `EXC_MASK_ALL` alone is not enough. xnu leaves `EXC_MASK_CRASH` out of it, and Crashpad installs its task port for `EXC_CRASH` and `EXC_RESOURCE`. The probe's `check` mode reads the same widened mask for the same reason. With no task-level port, a crash falls through to the host-level ReportCrash, as it would for a program started from Terminal.app. The return value is ignored, so a refusal leaves the child exactly as before rather than failing the spawn. Kangentic's own renderer, GPU, and utility processes are launched by Chromium, not node-pty, and still report to Crashpad.

`build/install-spawn-helper.js` does the work at package time and fails the build rather than skipping:

- `build/afterPack.js` compiles a universal (arm64 + x86_64) helper for `mac.minimumSystemVersion`, copies it over every `darwin-*/spawn-helper` in the unpacked tree, and gates it. `build/spawn-helper/exception-port-probe.c` gives itself an `EXC_CRASH` port, checks that a control child inherits it, then checks that a child exec'd through the helper has none. A `/bin/pwd -P` run through the helper proves the cwd and exec contract.
- `build/afterSign.js` runs the same gate on the signed helper before notarization, since hardened runtime is the one thing signing adds. electron-builder calls that hook only when it signed, so an unsigned local `npm run package` gets the afterPack gate alone. The hook then checks the signed app's Team ID against `src/shared/apple-team-id.json` (see [macOS signature mismatch](../releases/deployment.md#macos-signature-mismatch)).
- `.github/workflows/macos-spawn-helper.yml` runs `node build/install-spawn-helper.js --self-test` on `macos-latest` when the helper, its gates, the typed launch, or `package-lock.json` change. It runs both gates, the second after ad-hoc signing the helper with hardened runtime (the same kernel flag Developer ID signing sets). It then runs a real node-pty session through the signed helper, checking cwd and the controlling tty. Last, it runs Node under the probe's `with-port` mode, so Node holds a live inherited port the way Kangentic's main process holds Crashpad's, and launches `[helper, '', '/bin/sh', '-c', command]` from `child_process` with stdin a pipe. A control launch must see the port and the shell launched through the helper must not, under the pid `child_process` returned. It is path-filtered and not a required check.
- `tests/unit/spawn-helper-upstream-parity.test.ts` runs on Linux CI. It fails when the installed node-pty's `spawn-helper.cc`, its helper path, or its `[helper, cwd, file, ...args]` layout drifts from what our helper assumes.

The four `child_process` paths that launch a shell able to run anything go through the same helper: the login-shell env probe (`src/main/shell-env.ts`, on every macOS launch), `SHELL_EXEC` shortcuts, run-script automations, and the post-worktree init script. They share one function, `resolveShellLaunch` in `src/main/pty/spawn/shell-launch.ts`, which on macOS turns a launch into `[helper, '', file, ...args]` (a command string becomes `/bin/sh -c`, which is what `shell: true` runs). The helper execs in place, so the pid, a process-group kill, and an `execFile` timeout all still reach the shell. Windows and Linux launch exactly as before. `tests/unit/shell-launch-parity.test.ts` fails on a literal `shell: true` anywhere else in `src/main`, so a new shell launch has to go through it too.

Three gaps remain on purpose:

- `npm start` uses node-pty's stock helper, for PTYs and for the shell launches above. That is harmless by default, because an unpackaged run leaves Sentry off and there is no Crashpad port to inherit. It stops being harmless once a switch turns Sentry on: `KANGENTIC_ERROR_REPORTING=1`, or `KANGENTIC_TELEMETRY=1` with `KANGENTIC_ERROR_REPORTING` left unset (`resolveErrorReportingEnabled` in `src/main/analytics/error-reporting.ts`).
- Headless agent runs launch an agent binary, not a shell, from the pty host (`src/main/pty/host/host-cli-processes.ts`), or from `src/main/agent/shared/cli-print.ts` when no host is registered. The host is a utility process Chromium launched, so it holds the Crashpad port and its children inherit it. The helper exits 1 when its target is missing instead of raising ENOENT, and a missing CLI has to keep surfacing as ENOENT, so they stay direct. The docstring on `resolveShellLaunch` says how to route one without losing that.
- Git runs repository hooks, and git is launched as a plain binary.
