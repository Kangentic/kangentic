import fs from 'node:fs';
import path from 'node:path';
import { escapePercentForCmd, isBareShellToken, POWERSHELL_CURLY_DOUBLE_QUOTE_CHARACTERS } from '../../../shared/shell-quote';

/**
 * Identify a hook command string as Kangentic-injected.
 *
 * Matches the current bridges (`event-bridge`, `plan-approval-bridge`) and the
 * legacy `activity-bridge` (removed 2026-03-01) AND requires `.kangentic` in the
 * path, so user-defined hooks that happen to mention our script names without
 * pointing at our worktree are not swept up.
 */
export function isKangenticHookCommand(command: string | undefined): boolean {
  if (typeof command !== 'string') return false;
  const hasBridge = command.includes('activity-bridge')
    || command.includes('event-bridge')
    || command.includes('plan-approval-bridge');
  const hasKangenticPath = command.includes('.kangentic') || command.includes('/kangentic/');
  return hasBridge && hasKangenticPath;
}

/**
 * Filter out Kangentic-injected entries from a hook array, keeping only
 * user-defined hooks. Works with any hook entry shape - the caller
 * provides a `getCommands` function that extracts command strings from
 * each entry.
 *
 * Used by each adapter's `buildHooks` (strip stale before inject) and
 * `removeHooks` (clean up on exit).
 */
export function filterKangenticHooks<T>(
  entries: T[] | undefined,
  getCommands: (entry: T) => string[],
): T[] {
  return (entries || []).filter((entry) => {
    return !getCommands(entry).some((command) => isKangenticHookCommand(command));
  });
}

/**
 * How an agent CLI hands a bridge command (a hook or a status line) to a shell
 * on Windows. Each adapter declares one for each command it builds. On macOS
 * and Linux every CLI runs the command with `sh -c` or `bash -c`, so there it
 * is always `sh-or-powershell`. What each CLI was measured to do is in
 * docs/agent-integration.md, "Paths in hook commands".
 */
export type HookShell =
  /** The command is one `-c` argument to sh, bash or Git Bash, or one `-Command` argument to PowerShell. */
  | 'sh-or-powershell'
  /** `cmd /d /s /c "<command>"`, passed verbatim, as Node's `shell: true` does. */
  | 'cmd'
  /**
   * cmd given an escaped command line, which turns each `"` into `\"`, so no
   * quoted path reaches the program intact. Every token must be bare.
   */
  | 'bare-tokens';

/**
 * The variable every session spawn sets to its events file
 * (`session-spawn-flow.ts`). A hook inherits it from the CLI.
 */
export const EVENTS_PATH_ENVIRONMENT_VARIABLE = 'KANGENTIC_EVENTS_PATH';

/** The events-path argument event-bridge.js reads from the hook's own environment. */
export const EVENTS_PATH_FROM_ENVIRONMENT = `env:${EVENTS_PATH_ENVIRONMENT_VARIABLE}`;

/**
 * Characters that go in single quotes. `$`, a backtick and `"` stay special
 * inside double quotes in sh, bash and PowerShell, `\` in sh and bash, and
 * PowerShell reads a curly double quote as `"`. A `$` also never sits next to
 * a name: Gemini, Qwen and Grok replace `$NAME` and `${NAME}` in a hook command
 * themselves, before any shell sees it.
 */
const SINGLE_QUOTED_CHARACTERS = ['$', '`', '\\', '"', ...POWERSHELL_CURLY_DOUBLE_QUOTE_CHARACTERS];
const SINGLE_QUOTED_CLASS = `[${SINGLE_QUOTED_CHARACTERS.map((character) => (/[\\\]^-]/.test(character) ? `\\${character}` : character)).join('')}]`;
/** Splits a path into runs of those characters and runs of everything else. */
const SINGLE_QUOTED_RUN_SPLIT = new RegExp(`(${SINGLE_QUOTED_CLASS}+)`);
const SINGLE_QUOTED_RUN = new RegExp(`^${SINGLE_QUOTED_CLASS}+$`);

/**
 * Quote for sh, bash, Git Bash and both PowerShells at once: double-quoted
 * runs, with each run of the characters above in single quotes between them
 * (`C:"/work/"'$'"client/x.js"`). Two in a row share one pair (`'$$'`), because
 * PowerShell reads `''` inside single quotes as a quote, so `'$''$'` would hand
 * the bridge `$'$`. A path with none of them stays `"path"`.
 *
 * `escapeForDoubleQuotedShell` (`src/shared/shell-quote.ts`) quotes a line
 * typed at a prompt. This quotes one argument a CLI hands to `-c` or
 * `-Command`, where single quotes keep every character above literal.
 */
function quoteForShOrPowerShell(filePath: string, platform: NodeJS.Platform): string {
  if (!SINGLE_QUOTED_RUN_SPLIT.test(filePath)) return `"${filePath}"`;
  const prefix = platform === 'win32' ? windowsUnquotedPrefix(filePath) : '';
  const quotedRuns = filePath.slice(prefix.length)
    .split(SINGLE_QUOTED_RUN_SPLIT)
    .filter((run) => run !== '')
    .map((run) => (SINGLE_QUOTED_RUN.test(run) ? `'${run}'` : `"${run}"`));
  return prefix + quotedRuns.join('');
}

/**
 * The drive, or a UNC path's `//`, that stays bare in front of a quoted Windows
 * path: PowerShell ends an argument that opens with a quote at its closing quote.
 */
function windowsUnquotedPrefix(filePath: string): string {
  const match = /^(?:[A-Za-z]:|\/\/)/.exec(filePath);
  if (!match) {
    throw new Error(`Cannot quote a Windows bridge path with no drive for PowerShell: ${filePath}`);
  }
  return match[0];
}

/**
 * Quote for `cmd /d /s /c "<command>"`. A `%` is escaped by `escapePercentForCmd`
 * (`src/shared/shell-quote.ts`), as `quoteCmdExecutable` escapes it. A `$` steps
 * outside the quotes, where cmd leaves it alone, so a CLI that expands `$NAME`
 * in the command first never finds a name after it.
 */
function quoteForVerbatimCmd(filePath: string): string {
  const escaped = escapePercentForCmd(filePath)
    .replace(/(\\*)\$/g, (_match, backslashes: string) => `${backslashes}${backslashes}"$"`);
  return `"${escaped}"`;
}

/**
 * Quote a path for a bridge command an agent CLI runs, so the bridge receives
 * the path as written. `windowsShell` is the adapter's declared `HookShell` for
 * this command; off Windows the path is always quoted for sh or bash.
 *
 * Without it a project under a folder named `$client` lost that segment: the
 * plan approval bridge found no decision file and Automatic did nothing, and
 * every activity event went to the wrong path.
 */
export function quoteBridgePath(
  filePath: string,
  windowsShell: HookShell,
  platform: NodeJS.Platform = process.platform,
): string {
  const shell = platform === 'win32' ? windowsShell : 'sh-or-powershell';
  if (shell === 'cmd') return quoteForVerbatimCmd(filePath);
  if (shell === 'bare-tokens') {
    if (!isBareShellToken(filePath)) {
      throw new Error(`A bare-tokens bridge command cannot carry this path: ${filePath}`);
    }
    return filePath;
  }
  return quoteForShOrPowerShell(filePath, platform);
}

/**
 * Build a `node <bridge> <events> <eventType> [directives...]` command string.
 * Used by all hook-managers when wiring bridge entries.
 */
export function buildBridgeCommand(
  windowsShell: HookShell,
  eventBridge: string,
  eventsPath: string,
  eventType: string,
  ...directives: string[]
): string {
  const parts = [`node ${quoteBridgePath(eventBridge, windowsShell)} ${quoteBridgePath(eventsPath, windowsShell)} ${eventType}`];
  parts.push(...directives);
  return parts.join(' ');
}

/**
 * Transactionally update a JSON settings file with backup-on-write and
 * restore-on-error. Guarantees the file is never left in a corrupt state.
 *
 * Behavior:
 * - If the file doesn't exist, this is a no-op.
 * - Reads + parses the file, calls `transform(parsed)` to produce the new value.
 * - If `transform` returns `null`, signals "no change" and the file is not touched.
 * - Otherwise writes a .kangentic-bak copy, validates the new content round-trips
 *   through JSON, then atomically replaces the file. On any error restores
 *   from backup. The backup is removed on success.
 * - If `transform` returns `{}` (empty object), the file is deleted entirely,
 *   and the containing directory is removed if it's now empty.
 */
export function safelyUpdateSettingsFile(
  filePath: string,
  transform: (parsed: unknown) => unknown | null,
  label: string,
): void {
  if (!fs.existsSync(filePath)) return;

  const backupPath = filePath + '.kangentic-bak';
  let backedUp = false;

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    const next = transform(parsed);
    if (next === null) return; // no change requested

    fs.copyFileSync(filePath, backupPath);
    backedUp = true;

    const isEmpty = typeof next === 'object' && next !== null
      && !Array.isArray(next) && Object.keys(next as object).length === 0;

    if (isEmpty || (Array.isArray(next) && next.length === 0)) {
      fs.unlinkSync(filePath);
      try { fs.rmdirSync(path.dirname(filePath)); } catch { /* not empty or already gone */ }
    } else {
      const output = JSON.stringify(next, null, 2);
      JSON.parse(output); // round-trip validation
      fs.writeFileSync(filePath, output);
    }

    try { fs.unlinkSync(backupPath); } catch { /* best effort */ }
  } catch (error) {
    if (backedUp) {
      try { fs.copyFileSync(backupPath, filePath); } catch { /* can't recover */ }
      try { fs.unlinkSync(backupPath); } catch { /* best effort */ }
    }
    console.error(`[${label}] Failed to update ${filePath}:`, error);
  }
}
