---
type: Reference
title: Windows
description: "Windows-only behavior: the AUMID that ties the taskbar icon to the installer shortcut, core.longpaths for worktrees, why MAX_PATH rarely binds and where it does (ninja, CMake), and how CHROME_CRASHPAD_PIPE_NAME is kept from terminal children."
tags: [windows, aumid, long-paths, crashpad]
sources:
  - resource: src/shared/windows-path-budget.ts
  - resource: src/main/shared/child-env.ts
---
# Windows

## Windows Taskbar Identity (AUMID)

Windows resolves taskbar icons by matching the running window's AppUserModelID (AUMID) to a `.lnk` shortcut with the same AUMID. The NSIS installer creates shortcuts with the `appId` from `electron-builder.yml`.

`app.setAppUserModelId()` in `src/main/index.ts` must use `com.kangentic.app` in packaged builds to match the `appId` in `electron-builder.yml`. In dev mode, a separate AUMID (`com.kangentic.dev`) prevents the dev exe from poisoning the Windows icon cache with the default Electron icon. Note: `BrowserWindow.setIcon()` does not control the Windows taskbar icon -- only the AUMID match does.

## PTY children and Crashpad's handler

Once `@sentry/electron` starts Electron's `crashReporter`, Crashpad runs a crash handler for Kangentic, and Chromium tells Kangentic's own child processes how to reach it. On macOS and Windows that hand-off also reached every process an agent or a user started from a terminal, so their crashes landed in our crash database and reached Sentry as the foreign-crash warning (see [Error reporting](../telemetry/error-reporting.md)). The two platforms leak through different mechanisms, fixed in different places: the Windows one is below, and the macOS one is [mach exception ports](macos.md#macos-mach-exception-ports). Linux is not affected: Crashpad installs in-process there, and exec resets it.

### Windows: the handler's pipe name

Chromium's `components/crash/core/app/crashpad_win.cc` has the browser process put its handler's pipe in its own environment, as `CHROME_CRASHPAD_PIPE_NAME`, so the processes Chromium starts can connect to it. A non-initial Crashpad client that finds the variable registers with that handler. Every child that copied main's `process.env` passed the variable on, and an Electron program started from a terminal registered with our handler. VS Code's `code` CLI is Code.exe in Electron's node mode, and its crash reached Sentry DESKTOP-1S as `module: Code.exe` on 0.45.0. On a packaged build, main exports exactly this one Crashpad variable, and a task terminal inherited the same pipe name.

The variable stays in main's `process.env`. Kangentic's renderer, GPU and utility processes (the pty host, retrieval, embed, dictation, line count) find the handler through it, so deleting it there would silently lose their crash dumps. Instead, `src/main/shared/child-env.ts` builds every child env: `childProcessEnv(overrides)` copies main's environment without the variable, and `withoutCrashpadPipeName(env)` drops it from an env a caller built. The strip runs on every platform and changes no value off Windows. It sits at these chokepoints:

- `buildSpawnEnv` (`src/main/pty/spawn/pty-spawn.ts`): every session and Command Terminal PTY.
- `spawnOffMainCli` and `execAsync` / `execFileAsync` (`src/main/utility-process/`): everything main ships to the pty host, which is every exec, every headless agent run, and git on a task's lifecycle.
- `spawnOffMainPty` (the model-picker probe, the Antigravity print runner) and `spawnWithAbort` (the post-worktree init script, and git with or without a host) strip before they choose a route, and `off-main-exec.ts` strips on its local fallback as well.
- The direct launches: `spawnCli`, `run_script` automations, `SHELL_EXEC` shortcuts, the non-interactive fetch env, the WSL reap, and the macOS process-tag reader's tool launches.
- The git calls outside a lifecycle that run repository hooks, filters or merge drivers: Update from base's `merge --ff-only`, the carry of uncommitted changes into a new worktree (`apply --3way` and the reads before it), and the Command Terminal's cold-start checkout and `merge --ff-only`. They go through `gitAt` (`src/main/git/git-client.ts`, which runs on `execFileAsync`) instead of simple-git. simple-git can only set a child's env through `.env()`, and it refuses an env that carries `EDITOR`, `VISUAL`, `PAGER` or any `GIT_*` key, which many users export.

`tests/unit/child-env-parity.test.ts` fails on a `...process.env` spread or an `env: process.env` anywhere else in `src/main` (a deliberate exception carries `// crashpad-env-ok: <reason>`), and on a `delete process.env` of the variable.

What still inherits it, by decision:

- The utility processes Kangentic forks. They need it to report their own crashes.
- Fixed system tools main spawns directly, which start nothing: taskkill and the zombie reaper's PowerShell queries. The pty host's own launches (taskkill, its process listing) inherit the host's env too.
- Git plumbing that runs no hooks: `git cat-file`, the `ls-files` in the workspace file index (`project-entry-search.ts`), and simple-git's reads (status, diff, blame, log), plus a task's branch-switch config write. These reads can still run a repository's clean or textconv filters, and that exposure is accepted: moving every read to `gitAt` would not change which program a filter starts. simple-git 4 does drop some of main's env from these calls: every `GIT_*` variable, plus `EDITOR`, `VISUAL`, `PAGER`, `PREFIX` and `SSH_ASKPASS`. So a `GIT_DIR`, `GIT_CONFIG_GLOBAL` or `GIT_CONFIG_PARAMETERS` inherited from whatever launched Kangentic reaches `gitAt`'s commands but not these reads. None of them touches a remote, so credential helpers and ssh are not in play. One key is kept on purpose: `GIT_CEILING_DIRECTORIES`, which a dev preview sets so git in a preview project cannot find the worktree above it. Every client opens through `openSimpleGit` (`src/main/git/simple-git-client.ts`), which allows it, and `tests/unit/simple-git-client.test.ts` fails on a client opened around it.
- `shell.openPath`, `openExternal` and `showItemInFolder`, `app.relaunch`, and the updater. Electron gives them no env option. `openPath` can open a file in an Electron app that is its default, so this is the one real gap, and its only fix is the global delete ruled out above.

What still leaks shows up as the Sentry warning "Foreign process crash reached Kangentic's crash database", split by its `module` tag and release (see [Error reporting](../telemetry/error-reporting.md)).

## Windows Long Paths

Git worktrees live under `.kangentic/worktrees/<n>/`, which can push deeply nested file paths past Windows' default 260-character limit. Kangentic enables `core.longpaths=true` on Windows during worktree creation (both as a per-command flag for `git worktree add` and as a persistent config in the worktree's local git config). This activates the `\\?\` extended-length path prefix, allowing paths up to 32,767 characters. macOS and Linux are unaffected (1024-4096 byte `PATH_MAX`). See [Worktree creation](../architecture/worktrees/worktree-creation.md#windows-long-paths) for details.

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
[Worktree Directory Naming](../architecture/worktrees/worktree-lifecycle.md#worktree-directory-naming).

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
