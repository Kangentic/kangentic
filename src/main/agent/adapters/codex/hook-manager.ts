import path from 'node:path';
import { EventType } from '../../../../shared/types';
import { isKangenticHookCommand, safelyUpdateSettingsFile, EVENTS_PATH_FROM_ENVIRONMENT } from '../../shared/hook-utils';
import { extractTool, extractToolId, extractDetail, setDetail } from '../../shared/directive-builders';

/**
 * The workspace copy of the event bridge Codex's hooks run, relative to the
 * session's working directory, which is the hook's (measured on 0.163.0). A
 * relative path is the one that is a bare token on every platform, so the hook
 * command needs no quotes. It has to: the command sits inside a TOML literal
 * string, which cannot hold `'`, and the whole value reaches Codex through the
 * user's shell, where `quoteArg` turns a content `"` into `'` on Windows.
 */
export const CODEX_EVENT_BRIDGE_COPY_NAME = 'codex-event-bridge.cjs';
const CODEX_EVENT_BRIDGE_RELATIVE = `.kangentic/${CODEX_EVENT_BRIDGE_COPY_NAME}`;

/** Seconds each hook may run. Written out because Codex hashes a hook with its timeout, and fills 600 when absent. */
const CODEX_HOOK_TIMEOUT_SECONDS = 10;

/** Characters a token of a Codex hook command may hold: a bare word on sh, PowerShell and cmd, and no TOML quote. */
const CODEX_HOOK_TOKEN = /^[A-Za-z0-9_./:+=-]+$/;

function codexHookCommand(eventType: string, ...directives: string[]): string {
  const tokens = ['node', CODEX_EVENT_BRIDGE_RELATIVE, EVENTS_PATH_FROM_ENVIRONMENT, eventType, ...directives];
  for (const token of tokens) {
    if (!CODEX_HOOK_TOKEN.test(token)) throw new Error(`A Codex hook command cannot carry this token: ${token}`);
  }
  return tokens.join(' ');
}

/**
 * Codex hook events Kangentic wires (task #859), measured on 0.163.0 in the
 * TUI and in `exec`. Each payload is snake_case. A yielded `exec_command` fires
 * PreToolUse and no PostToolUse; `write_stdin` fires none; an Esc interrupt
 * and a failed model request fire no Stop (the rollout reports both, see
 * session-history-parser.ts). PermissionRequest carries no `tool_use_id`, and
 * the engine awaits the pending tool PreToolUse opened. SessionEnd is left out:
 * Codex clamps its timeout to 3 s before hashing it.
 */
function codexHookCommands(): ReadonlyArray<readonly [event: string, command: string]> {
  return [
    ['SessionStart', codexHookCommand(EventType.SessionStart)],
    ['UserPromptSubmit', codexHookCommand(EventType.Prompt)],
    ['PreToolUse', codexHookCommand(EventType.ToolStart,
      extractTool('tool_name'),
      extractToolId(['tool_use_id']),
      extractDetail(['command'], { nested: 'tool_input' }))],
    ['PostToolUse', codexHookCommand(EventType.ToolEnd,
      extractTool('tool_name'),
      extractToolId(['tool_use_id']))],
    ['PermissionRequest', codexHookCommand(EventType.Idle,
      setDetail('permission'),
      extractTool('tool_name'))],
    ['Stop', codexHookCommand(EventType.Idle)],
    ['PreCompact', codexHookCommand(EventType.Compact)],
  ];
}

/** One Kangentic hook: what Codex should list for it, and the `-c` value that registers it. */
export interface CodexHookDefinition {
  command: string;
  timeoutSeconds: number;
  override: string;
}

/**
 * Kangentic's hooks for one Codex process, in Codex's session-flags layer:
 * nothing is written to `~/.codex` or the repo, and the user's own hooks in
 * their config load beside these. Identical for every session (the events path
 * comes from `KANGENTIC_EVENTS_PATH`), which is what lets one trust check per
 * Codex binary cover every spawn.
 */
export function codexHookDefinitions(): CodexHookDefinition[] {
  return codexHookCommands().map(([event, command]) => ({
    command,
    timeoutSeconds: CODEX_HOOK_TIMEOUT_SECONDS,
    override: `hooks.${event}=[{hooks=[{type='command',command='${command}',timeout=${CODEX_HOOK_TIMEOUT_SECONDS}}]}]`,
  }));
}

/** The `-c` values that register Kangentic's hooks (`codexHookDefinitions`). */
export function buildCodexHookOverrides(): string[] {
  return codexHookDefinitions().map((definition) => definition.override);
}

/** One hook's trust entry, as Codex's `hooks/list` reported it. */
export interface CodexHookTrustEntry {
  key: string;
  hash: string;
}

/**
 * A key Codex reported (`C:\<session-flags>\config.toml:stop:0:0` on Windows)
 * that the quoting contract can carry: no TOML quote, and none of the
 * characters a shell reads inside the value's quotes (`"`, `%`, `` ` ``, `$`).
 */
const TRUST_KEY = /^[^'"%`$\r\n]+$/;
const TRUST_HASH = /^sha256:[0-9a-f]{64}$/;

/**
 * The `-c hooks.state=...` value that marks these hooks trusted for this
 * process only, so the TUI runs them without its "Hooks need review" dialog.
 * Codex merges it with the user's own `[hooks.state]` (measured: their trusted
 * hooks stay trusted). Returns null for an entry that cannot be written safely.
 */
export function codexHookStateOverride(entries: readonly CodexHookTrustEntry[]): string | null {
  if (entries.length === 0) return null;
  for (const entry of entries) {
    if (!TRUST_KEY.test(entry.key) || !TRUST_HASH.test(entry.hash)) return null;
  }
  return `hooks.state={${entries.map((entry) => `'${entry.key}'={trusted_hash='${entry.hash}'}`).join(',')}}`;
}

/**
 * Shape of an entry in the legacy project-local `.codex/hooks.json` array.
 * Retained only for cleanup of files written by older Kangentic builds.
 */
interface CodexLegacyHookEntry {
  event: string;
  command: string;
  timeout_secs?: number;
}

/** Path to .codex/hooks.json for a given project directory. */
function codexHooksPath(directory: string): string {
  return path.join(directory, '.codex', 'hooks.json');
}

/**
 * Codex 0.128 redesigned the hook system. User hooks now live in
 * `~/.codex/config.toml` under `[[hooks]]` tables (TOML, snake_case event
 * names like `pre_tool_use`, camelCase fields `eventName`/`timeoutSec`), or
 * inside a Codex plugin folder referenced from a `plugin.json` manifest.
 *
 * The legacy project-local `.codex/hooks.json` (top-level JSON array) is no
 * longer recognized. Codex 0.128 surfaces a yellow `failed to parse hooks
 * config ... trailing characters` warning at startup whenever it finds one.
 *
 * Older Kangentic builds wrote that file as forward-compat for a hook pipeline
 * that 0.118 also ignored in practice, so removing the writer reverts to
 * the same effective behavior we already had on 0.118 with no functional loss.
 *
 * `buildHooks` is invoked from the spawn path; we use it to clean up any stale
 * Kangentic-owned entries left over from a pre-upgrade Kangentic install. We
 * never write the file ourselves any more. The live hooks are `-c` overrides
 * (`codexHookDefinitions`, `buildCodexHookOverrides`), wired once Codex
 * confirmed their trust (`hook-trust.ts`).
 */
export function buildHooks(projectRoot: string): void {
  cleanupLegacyHooks(projectRoot);
}

/**
 * Strip ALL Kangentic hook entries from a legacy `.codex/hooks.json` at the
 * given directory. Preserves any user-defined hooks; deletes the file if
 * only Kangentic-owned entries remained.
 */
export function removeHooks(directory: string): void {
  cleanupLegacyHooks(directory);
}

function cleanupLegacyHooks(directory: string): void {
  safelyUpdateSettingsFile(codexHooksPath(directory), (parsed) => {
    if (!Array.isArray(parsed)) return null;
    const hooks = parsed as CodexLegacyHookEntry[];
    const filtered = hooks.filter(entry => !isKangenticHookCommand(entry.command));
    return filtered.length === hooks.length ? null : filtered;
  }, 'cleanupLegacyHooks');
}
