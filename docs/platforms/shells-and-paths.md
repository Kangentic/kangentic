---
type: Reference
title: Shells and paths
description: Shell detection order per OS, how adaptCommandForShell and quoteArg quote for PowerShell, cmd, bash, fish, nushell and WSL, npm .cmd shim launching, Windows cwd fixups, WSL interop limits, PTY environment stripping (CLAUDE_CODE_*, NO_COLOR, TERM), and config directory locations.
tags: [shells, paths, quoting, wsl, environment]
sources:
  - resource: src/main/pty/spawn/shell-resolver.ts
  - resource: src/shared/paths.ts
  - resource: src/shared/shell-quote.ts
  - resource: src/main/pty/spawn/pty-spawn.ts
  - resource: src/main/agent/shared/shim-launch.ts
  - resource: src/main/agent/shared/npm-shim-target.ts
  - resource: src/main/config/paths.ts
  - resource: src/main/agent/shared/exec-version.ts
  - resource: src/main/pty/lifecycle/session-spawn-flow.ts
    title: the adaptCommandForShell call site
---
# Shells and paths

Kangentic runs on Windows, macOS, and Linux. How it picks and adapts each shell, builds paths, finds its config directory, runs under WSL, and strips its own environment from what a terminal inherits differs per platform; native modules and packaging are in [Packaging and security](packaging-and-security.md).

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
| PowerShell (pwsh/powershell) | `-NoLogo` | `& ` prefix for command execution, on every platform (pwsh can be the macOS or Linux login shell) |
| WSL (wsl -d ...) | Split into exe + args | Leading exe path converted to `/mnt/c/...` (runs the Windows binary via WSL interop) |
| bash/zsh | `--login` | Standard execution |
| fish | (none) | No login flag |
| nushell (nu) | (none) | No login flag; a quoted command head gets a `^` prefix |
| cmd | (none) | Standard execution |
| Git Bash | `--login` | Leading exe path converted to `/c/...` |

The leading-token conversion (`convertWindowsExePath` in `src/shared/paths.ts`) recognizes all
three quote forms a command builder can emit: a bare path, a double-quoted path, and the
single-quoted path `quoteArg` produces for unix-like shells. UNC exe paths (`\\server\share\...`)
are normalized the same way.

Bridge paths in hook and status-line commands follow a separate rule: see
[Paths in hook commands](../integrations/agents/claude-code.md#paths-in-hook-commands).

Every spawn that types a command (a task's agent, a Command Terminal, a workflow's agent) additionally prefixes the typed line with the
shell's own clear via `buildSpawnClearPrelude()` (same module): `Clear-Host; ` for the
PowerShell family, `cls & ` for cmd, and `clear; ` for every other shell (bash, zsh, fish, nu,
dash, ksh, sh, WSL, Git Bash - the default arm, not a closed list). The shell then erases its
startup preamble and command echo the instant the command
executes - a real clear in the real byte stream that every consumer (live terminal, scrollback
ring, headless parser, replays, phone) honors natively. This is the source-level guard against
shell/ConPTY updates reshaping their startup bytes (pwsh 7.6 started emitting `\x1b[?25l` and
`\x1b[2J` inside its escape-only startup preamble, which broke every heuristic that keyed on
those markers); see [session-lifecycle](../architecture/sessions/index.md) for the detection layer it pairs
with.

### npm `.cmd` shims under PowerShell and Git Bash

`quoteArg(..., { multiline: true })` keeps a multi-line prompt on one physical input line. For the
PowerShell family it rewrites each newline as a backtick-n escape inside `"..."`, which PowerShell
expands back into real newlines before the agent sees the argument; for POSIX shells and fish the
newlines stay literal inside `'...'`, and nushell gets `\n` escapes inside `"..."`. These hold
only while the shell launches the agent binary itself. An npm-installed CLI resolves on PATH to its `.cmd` shim (`which` walks PATHEXT, which
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
| cmd.exe + UNC path (`\\server\share\...`) | `pushd "<unc>"` (maps the UNC path to a temporary drive letter; cmd refuses UNC cwds), with each `%` escaped by `escapePercentForCmd` | Replaced with home |
| PowerShell/pwsh + bracketed path (`D:\[foo]\bar`) | `Set-Location -LiteralPath '<cwd>'`, escaped by `escapeForPowerShellSingleQuoted` | Left unchanged |

The PowerShell case fixes a Windows PowerShell 5.1 quirk: it treats `[` / `]` in its startup path as wildcard characters, fails to resolve the location, and silently falls back to `$PSHOME` (`C:\Windows\System32\WindowsPowerShell\v1.0`). node-pty's `cwd` is still a valid Win32 directory, so only PowerShell's provider location needs correcting. Applied to the whole PowerShell family (the extra `Set-Location` is harmless in pwsh 7).

## Path Handling

- `toForwardSlash()` - normalizes backslashes to forward slashes for cross-platform CLI commands
- `quoteArg(arg, shell?, { multiline? })` - shell-aware quoting: single quotes for POSIX shells (bash, zsh, sh, WSL), double quotes for PowerShell and cmd, each escaped by its own rules (see `escapeForDoubleQuotedShell` below), and a form of their own for fish and nushell (see `quoteForFish` and `quoteForNushell` below). The shell parameter is explicitly passed in all spawn calls so quoting always matches the target shell. Falls back to platform detection when shell is omitted. `{ multiline: true }` keeps newlines in prompt-style content (literal inside `'...'` for POSIX shells and fish, `\n` escapes for nushell, backtick-n escapes for PowerShell, flattened for cmd); a bare `--` is emitted as `"--"` for PowerShell hosts. See [npm `.cmd` shims under PowerShell and Git Bash](#npm-cmd-shims-under-powershell-and-git-bash) for the one place that contract does not reach on its own.
- `escapeForDoubleQuotedShell(text, isCmd)` (`src/shared/shell-quote.ts`) - what `quoteArg` puts inside `"..."`, and the reason cmd and PowerShell are not one branch. They disagree about the backslash. cmd hands the raw command line to the target's C runtime, which reads `\` as an escape in a run immediately before a quote, so that run is doubled or a trailing backslash swallows the closing quote; backtick and `$` are literal there and must NOT be escaped, or the agent receives them doubled. PowerShell is the reverse: backtick is the escape character and `$` starts an expansion, while `\` is not special and escaping it would deliver a doubled path separator. PowerShell also ends a double-quoted string at the curly double quotes (U+201C, U+201D, U+201E), so each is doubled. Left bare at a pwsh 7.6 prompt, a task description holding one reached the agent split in two, and a `;` after it ran as a second PowerShell command. A backtick escape was rejected: Windows PowerShell 5.1 at a ConPTY prompt drops these characters from typed input, which left the backtick to turn the next `t` or `n` into a tab or newline. Both branches write an ASCII `"` in the content as `'`, because no escaped quote is safe on all three shells. A model or effort override is free text that a committed `kangentic.json`, a board profile or an MCP call can set, and a `\"` in one lets a `;` or `&` run a second command. So a literal `"` never reaches an agent through a Windows double-quoted argument, the same trade the prompt builders make. The doc comment carries the measured round-trip tables (pwsh 7.6.6, Windows PowerShell 5.1.26100, cmd.exe), including each rejected quote escape and the trailing-backslash case with no answer that is right on both PowerShell hosts.
- `quoteForNushell(text)` and `quoteForFish(text)` (`src/shared/shell-quote.ts`) - the two unix-like shells that do not quote like POSIX sh, picked by `isNushellShell` and `isFishShell`, which match the program's basename (a substring match on `nu` also caught a bash under `/opt/menu/`, which then lost `--login`). nushell's single-quoted strings have no escapes, so the POSIX `'\''` for an apostrophe was a parse error ("Unclosed delimiter", measured on nushell 0.116.0) and every prompt holding one failed to start. `quoteForNushell` writes a double-quoted string instead, escaping only `\` and `"` (a plain `"..."` does not interpolate, and nushell rejects an unknown escape), with newlines and tabs as `\n` and `\t`. nushell also runs a quoted command head only behind `^`, so `adaptCommandForShell` adds one there. fish reads `\\` and `\'` inside single quotes, so the POSIX form lost one of two backslashes and left the quote open after a trailing one; `quoteForFish` backslash-escapes every `\` and `'`. The renderer's `quoteForShell` uses both for a dropped path.
- `escapeForPowerShellSingleQuoted(text)` (`src/shared/shell-quote.ts`) - doubles `'` and the four curly single quotes (U+2018 to U+201B, which PowerShell also ends a single-quoted string at). The `Set-Location` cwd fixup uses it. Doubling only `'` left a path holding a curly apostrophe as a parse error on both hosts.
- `escapePercentForCmd(text)` (`src/shared/shell-quote.ts`) - the cmd-only step `quoteArg` runs after `escapeForDoubleQuotedShell`, and that `quoteForCmdShell` (`src/main/agent/shared/cli-print.ts`) runs for a headless `.cmd` shim launched through `shell: true`. cmd expands `%NAME%` even inside double quotes. Doubling to `%%` does not help, because that escape belongs to batch files, and both routes type a command line instead (the interactive prompt, and `cmd /d /s /c`). There `%%PATH%%` arrives as `%<value>%`. Each `%` is written as `"^%"` instead, and the backslash run before it is doubled so the inserted quote is not read as an escaped one. Any `%name%` pair cmd then forms names a variable that starts with a quote, which none does, and cmd strips the caret because it sits outside the quotes. The renderer's `quoteForShell` does not use it, because a dropped or pasted path usually lands in an agent's input box, where `"^%"` would be literal text. The doc comment carries the measured table (piped stdin, a ConPTY prompt, `shell: true`, and an npm-style `.cmd` shim, which parses the arguments a second time).
- `quoteCmdExecutable(path)` (`src/shared/shell-quote.ts`) - quotes an executable as the head of a command line cmd.exe parses, with the `%` escape. `spawnCli` and every Windows `exec` of a detected agent CLI (`execVersion` and the adapters' capability probes) use it, because cmd expands a `%NAME%` in the head too and then cannot find the path. `tests/unit/shell-quote.test.ts` scans `src/main` and fails on an `execAsync` command head that is quoted by hand instead.
- `isBareShellToken(text)` (`src/shared/shell-quote.ts`) - true when every supported shell reads the text as one literal word without quotes (letters, digits and `._/:-`). `quoteArg` and the renderer's `quoteForShell` leave such text unquoted. The Aider adapter uses it for the paths inside its `--notifications-command`, which Aider runs through its own shell (cmd.exe on Windows, `/bin/sh` elsewhere). A bare path needs no inner quote. Any other path gets `"` under a unix-like shell and `'` under pwsh off Windows. On Windows, under PowerShell or cmd, a path that is not bare drops the `--notifications` and `--notifications-command` pair, since the `"` cmd needs cannot cross a Windows double-quoted argument. So does a path holding `"`, `$` or a backtick under a unix-like shell. Aider still starts, and its prompt regex stays the idle signal.
- The live round trips behind these escapes run in `tests/unit/command-builder.test.ts` (`quoteArg` typed at a cmd prompt and at each PowerShell host), `tests/unit/aider-adapter.test.ts` (the Aider notifications command at each host) and `tests/unit/auto-name-clean.test.ts` (`spawnCli` and `quoteForCmdShell` through a `.cmd` shim), on the rig in `tests/unit/helpers/shell-argv-probe.ts`. They need a real cmd.exe and PowerShell, so the Linux unit tier skips them and `.github/workflows/shell-quoting-windows.yml` runs them on Windows when the escapes, `cli-print.ts`, the Claude, Aider or Qwen command builder, or their tests change. The same workflow runs the hook and status-line round trips, which hand each CLI's bridge commands to the shell that CLI runs them in, whenever `hook-utils.ts`, `workspace-bridge-copy.ts`, a bridge, a hook manager or their tests change (see [Paths in hook commands](../integrations/agents/claude-code.md#paths-in-hook-commands)). The nushell and fish round trip in `tests/unit/command-builder.test.ts` types the Claude builder's output, with the agent at a quoted path, into each shell (`typeAtPosixShell`); `.github/workflows/shell-quoting-posix.yml` installs fish and a pinned nushell on Linux and requires both. nushell's parser is the same on Windows, so a Windows machine with `nu` on PATH runs the nushell half too, with node and the argv printer as the quoted head; fish has no native Windows build. The cwd fixups above have string pins only, in `tests/unit/pty-spawn.test.ts`. Their round trips were measured by hand, and `pushd` is a cmd builtin with no C runtime parse, so it lands in the folder only because Windows collapses the doubled backslash the `%` escape writes before a `%`.
- `src/shared/shell-quote.ts` also owns the shell predicates and `sanitizeForPty`, which `src/shared/paths.ts` re-exports. The split exists so the renderer can share the real escaping (`quoteForShell` in `src/renderer/utils/terminal-clipboard.ts`, used by drag-drop and image paste): `paths.ts` imports `node:path` and cannot enter that bundle. `quoteForShell` shares the escaping but not `quoteArg` itself, since `sanitizeForPty` would collapse consecutive spaces in a real path.
- `isPowerShellShell(shell)` - the PowerShell-family predicate (`powershell` / `pwsh` substring after nushell and fish are ruled out by program name, so a `nu` under a `pwsh-tools` directory is not PowerShell; the negation `isUnixLikeShell` applies) shared by `adaptCommandForShell`, `buildSpawnClearPrelude`, `resolveShellArgs`, `resolveSpawnCwd`, `quoteArg`, and `resolveShimLaunch`.
- Git Bash: paths like `C:\Users\...` become `/c/Users/...`
- WSL: paths like `C:\Users\...` become `/mnt/c/Users/...`
- `adaptCommandForShell()` - adds the `& ` prefix for PowerShell commands on every platform (without it pwsh reads a quoted head followed by flags as a parse error), the `^` prefix for a quoted head under nushell, and on Windows for unix-like shells (Git Bash, WSL) converts the leading Windows exe path to POSIX form via `convertWindowsExePath()`, which handles bare, double-quoted, and single-quoted leading tokens (a quoted token stays quoted with the same quote character even without spaces, so shell-active path characters like `&` remain inert in the target shell)

## Config Directory Locations

| Platform | Default Path |
|----------|-------------|
| Windows | `%APPDATA%/kangentic/` |
| macOS | `~/Library/Application Support/kangentic/` |
| Linux | `$XDG_CONFIG_HOME/kangentic/` (defaults to `~/.config/kangentic/`) |

Overridable via `KANGENTIC_DATA_DIR` environment variable.

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

Four keys are keeplisted, all renderer flags rather than identity markers, so none can re-parent a
session. `CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT` and `CLAUDE_CODE_SCROLL_SPEED` are always kept.
`CLAUDE_CODE_NO_FLICKER` and `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN` are kept only for a spawn that
passes one (the renderer variables from `rendererEnvironment`, a user's own opt-out included), and a
WSL shell lists them in `WSLENV`. An explicit value already present in the environment always wins
for each, and non-Claude agents ignore them.

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

The Claude `/model` picker probe (`model-picker-probe.ts`) does not use `buildSpawnEnv` and sets
`TERM=xterm-256color` unconditionally instead of defaulting it. Its PTY's terminal is Kangentic's
own `VirtualScreen` grid, so a user's TERM describes a terminal it is not. TERM matters to it for
the glyph, not for color: Claude Code draws its prompt and select-row markers with the `figures`
pointer, `❯` only when its Unicode check passes, and on Windows that check reads only the
environment (`WT_SESSION`, `TERM_PROGRAM=vscode`, `TERM=xterm-256color`, and a few others). A
packaged app started from the Start menu has none of them, so the CLI drew `>`, the probe's wait
for `❯` timed out, and the pickers lost their Latest group. `npm start` from Windows Terminal
inherited `WT_SESSION`, which is why the dev build never showed it.

`COLORTERM` and `TERM_PROGRAM` are deliberately not defaulted, even though VS Code's integrated
terminal exports both unconditionally. Claude Code already selects truecolor from
`TERM=xterm-256color` alone (measured 2026-08-28 at claude 2.1.250: 222 truecolor SGR sequences,
zero indexed, with COLORTERM absent), so a `COLORTERM` default would change nothing. `TERM_PROGRAM`
is host identity that the CLI's DECSTBM capability gate enumerates among its inputs, so a fake
host name could reopen the gate that `scrollRegionSuffix()` in `headless-frame.ts` guards against.

## See Also

- [Shell Resolution](../architecture/system-overview.md#shell-resolution) -- overview in architecture doc
- [Developer Guide](../contributing/developer-guide.md#packaging) -- build and package commands
