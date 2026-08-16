---
description: Cross-platform pitfalls for shell handling, paths, and file operations
---

# Cross-Platform Pitfalls

Contextual knowledge for platform-specific issues across Windows, macOS, and Linux. Reference this skill when working on shell handling, path utilities, terminal rendering, or file operations.

## Shell Resolution

`src/main/pty/spawn/shell-resolver.ts` discovers available shells per platform:

**Windows priority:** PowerShell 7 -> PowerShell 5 -> Git Bash -> cmd.exe, plus WSL distros via `wsl --list --quiet` (5-second timeout, Docker distros filtered out).

**macOS priority:** zsh -> bash -> fish -> nushell -> sh

**Linux priority:** bash -> zsh -> fish -> dash -> nushell -> ksh -> sh

**Default shell fallback:** Windows uses hierarchy search (pwsh -> powershell -> bash -> cmd). Unix uses `$SHELL` env var, then zsh (macOS) or bash (Linux), then `/bin/sh`.

## Per-Shell Adaptations

When spawning a PTY session, the shell type determines command construction:

| Shell | Adaptation | Source |
|-------|-----------|--------|
| PowerShell (pwsh/powershell) | Prefix executable with `& ` call operator | `adaptCommandForShell` (`src/shared/paths.ts`) |
| WSL (`wsl -d <distro>`) | Split into exe (`wsl.exe`) + args (`-d`, distro) only - the `.exe` is appended because node-pty's ConPTY resolver cannot find an extension-less bare name; the agent command is NOT in argv, it is written into the PTY afterwards through `adaptCommandForShell`, which converts the leading exe path to `/mnt/c/...` | `resolveShellArgs` (`src/main/pty/spawn/pty-spawn.ts`), `adaptCommandForShell` (`src/shared/paths.ts`) |
| Fish | Skip `--login` flag | `resolveShellArgs` (`src/main/pty/spawn/pty-spawn.ts`) |
| Nushell | Skip `--login` flag | `resolveShellArgs` (`src/main/pty/spawn/pty-spawn.ts`) |
| Git Bash | Convert the leading Windows exe path to `/c/Users/...` format | `convertWindowsExePath` (`src/shared/paths.ts`) |

## Path Handling

`src/shared/paths.ts` provides platform-safe path utilities:

- **`toForwardSlash(path)`** - Replace backslashes with forward slashes. Required for all paths written to `.claude.json` or config files, as Claude Code uses forward slashes on all platforms.
- **`quoteArg(arg, shell?)`** - Shell-aware quoting, keyed on the TARGET shell, not the host platform: unix-like shells (bash, zsh, WSL) get single quotes with `'\''` escaping; PowerShell/cmd get double quotes with backtick/`$`/`"` escaping. When `shell` is omitted, falls back to platform detection (win32 = double quotes). Simple args (matching `/^[a-zA-Z0-9_.\/:-]+$/`) left unquoted; a backslashed Windows path is never simple, so it is always quoted.
- **`convertWindowsExePath(cmd, isWsl)`** - Converts the leading Windows exe path of a command string to POSIX form (`/c/...` or `/mnt/c/...`), recognizing bare, double-quoted, and single-quoted leading tokens (single quotes are what `quoteArg` emits for unix-like shells; a single-quoted token stays single-quoted so shell-active path characters remain inert). Called via `adaptCommandForShell` at the PTY spawn seam.
- **`toGitBashPath(path)`** - `C:\Users\dev` -> `/c/Users/dev`
- **`toWslPath(path)`** - `C:\Users\dev` -> `/mnt/c/Users/dev`
- **`sanitizeForPty(text)`** - Collapse newlines/tabs/consecutive whitespace to single space. Prevents newlines being interpreted as Enter by terminal emulators.

## PowerShell Prompt Escaping

`src/main/agent/adapters/claude/command-builder.ts` (the prompt block of `buildClaudeCommand`):

PowerShell interprets `\"` differently from bash. The command builder replaces double quotes with single quotes in prompts BEFORE `quoteArg()` wrapping. Without this, prompts containing quotes break PowerShell sessions.

Additionally, `--` (end-of-options) is inserted before the prompt to prevent content like `->` or `--flag` from being parsed as CLI options.

## Windows File Operations

Windows holds file handles longer than Unix after process termination. This affects worktree cleanup:

**Retry pattern** (`src/main/git/worktree-manager.ts`, `removeWorktree`):
```
1. git worktree remove --force (release git's tracking + directory)
2. On failure, fall back to async fs.promises.rm with built-in retries:
     { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }
3. On final failure, best-effort `git worktree prune` so metadata stays
   consistent even if the directory survived.
```

The `maxRetries` / `retryDelay` parameters give the kernel up to 2s total
(10 * 200ms) to release handles on Windows NTFS (EBUSY, ENOTEMPTY, EPERM).
Async `fs.promises.rm` is required (not `fs.rmSync`) so the main process
event loop stays responsive during bulk operations - hundreds of
sequential sync deletes would freeze the UI.

Always use `{ force: true }` on Windows -- never plain recursive removal
which throws EPERM on locked files.

## Em-Dash Encoding

**NEVER use Unicode em-dash (U+2014) anywhere in the codebase.** Always use a single ASCII `-` instead; `--` as punctuation is equally banned (see `.claude/rules/text-formatting.md`).

Windows console code pages (e.g., CP437, CP1252) cannot render em-dashes, producing garbled characters like `\u0096` or mojibake. This applies to:
- Source code and comments
- Test assertions and descriptions
- Documentation and markdown
- CLI output and error messages
- Template strings passed to Claude Code

## Git Commands

**Always use `git -C <path>`** for git commands in other directories. Never use `cd <path> && git ...` -- this triggers an unbypasable Claude Code security prompt.

## xterm.js Terminal Rendering

`src/renderer/hooks/useTerminal.ts`:

### WebGL Context Loss Recovery
```
1. Attempt WebGL renderer (lines 70-79)
2. On context loss -> dispose WebGL addon
3. Fallback to canvas renderer (automatic)
```

No manual recreation needed -- xterm.js falls back to canvas automatically after WebGL disposal.

### Font Preloading
Terminal font must be loaded before xterm initialization. If the font isn't ready, xterm measures characters incorrectly, causing misaligned TUI output.

### Resize Debouncing
PTY resize calls are debounced at 200ms (`useTerminal.ts`, lines 8-11, 90-99). This prevents:
- Scrollback buffer eviction from rapid row-count changes during panel drag
- TUI redraw churn during window resize
- Resize suppression during active scrollback replay (lines 138-143)

### Scrollback Replay
When a terminal reconnects (dialog close -> panel recreate):
1. Load scrollback buffer from session
2. Write to xterm
3. Fit after replay completes
4. Force explicit resize to sync PTY dimensions (initial 120x30 likely differs from container)
5. Drop duplicate `onData` during load via `scrollbackPendingRef`

## Electron E2E Testing

`_electron.launch()` on Windows always opens a real window -- there is no headless mode for Electron E2E tests. Tests that need headless use the UI test tier with `mock-electron-api.js` instead.

## Worktree Path Detection

`src/main/git/worktree-manager.ts` (lines 35-44):

Checks `parent=worktrees` and `grandparent=.kangentic` to verify a path is inside a Kangentic-managed worktree. Normalizes all separators to forward slashes (`replace(/\\/g, '/')`) before splitting, so it works on both Windows and Linux.

**IMPORTANT:** Never use `path.normalize()`, `path.dirname()`, or `path.basename()` on paths that may contain Windows backslashes when the code runs on Linux. Node's `path` module is platform-dependent -- on Linux, `\` is a valid filename character, not a separator. Always normalize slashes manually first.

Sparse-checkout excludes `.claude/commands/` from worktrees (commands walk up the directory tree, so including them would cause duplicate discovery). Skills and agents do NOT walk up, so they must be present in the worktree checkout.

## Key Source Files

- `src/main/pty/spawn/shell-resolver.ts` -- Shell discovery and default selection
- `src/main/agent/adapters/claude/command-builder.ts` -- Claude CLI command assembly, prompt sanitization
- `src/main/git/worktree-manager.ts` -- Worktree CRUD with Windows retry logic
- `src/renderer/hooks/useTerminal.ts` -- xterm setup, WebGL fallback, resize debouncing
- `src/shared/paths.ts` -- Path normalization, shell-aware quoting, PTY sanitization
