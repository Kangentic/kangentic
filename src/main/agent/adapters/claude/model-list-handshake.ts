import { StringDecoder } from 'node:string_decoder';
import { spawnCli, stopCli } from '../../shared/cli-print';
import type { CliTarget } from '../../shared/cli-target';
import type { CliChildProcess } from '../../../utility-process/off-main-cli';
import type { ModelAliasOption } from '../../../../shared/types';
import { CLAUDE_ALIAS_ID_PATTERN, CLAUDE_MODEL_ID_PATTERN, claudeCoreOf } from './model-display-name';

/**
 * Claude Code's own model list, read from the `initialize` control request of
 * its stream-json mode. This is what the Agent SDK's `supportedModels()` reads
 * (https://code.claude.com/docs/en/agent-sdk/typescript). There is still no
 * `claude model list` (anthropics/claude-code#12612).
 *
 * `initialize` is the first line on stdin and no user message follows, so no
 * turn runs and nothing is billed. `--print` skips the workspace trust dialog,
 * so no trust entry is needed and a Mac's symlinked temp folder cannot stop it.
 * Measured on 2.1.318: an answer in 388 to 1291 ms, signed out included, with no
 * network dependency. A signed-out empty config still lists the four aliases.
 * `--safe-mode` keeps `availableModels` and custom models. `--bare` must stay out:
 * it reads no OAuth or keychain, so a signed-in account gets 5 rows instead of 13.
 *
 * The SDK's `ModelInfo` is public, the wire format under it is not, so every row
 * is validated as untrusted and any failure falls back to the `/model` PTY probe
 * (`model-picker-probe.ts`). The payload also holds `account`: nothing here logs
 * or keeps anything but the fields it maps.
 */

const HANDSHAKE_ARGS = [
  '-p',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose',
  '--no-session-persistence',
  '--safe-mode',
];

const INITIALIZE_REQUEST_ID = 'kangentic-model-list';

/** The row `--model` needs no value for: Kangentic's empty value already means it. */
const DEFAULT_ROW_VALUE = 'default';

const MAX_DISPLAY_NAME_CHARS = 80;

/** What the CLI listed, in its own order. Every field is what `ModelPickerScan` holds. */
export interface ClaudeModelList {
  models: string[];
  aliases: ModelAliasOption[];
  /** The CLI's name for an id with no `claude-` core, the only ids it cannot be derived from. */
  displayNames?: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A row's id, or null. One id that fails only loses that row. */
function modelValueOf(value: unknown): string | null {
  return typeof value === 'string' && CLAUDE_MODEL_ID_PATTERN.test(value) ? value : null;
}

/**
 * Whether a row is a floating alias. Its family word must appear in the id it
 * resolves to, which holds for every provider's shape
 * (`us.anthropic.claude-haiku-4-5-20251001-v1:0`, `claude-haiku-4-5@20251001`)
 * and rejects `opusplan` and a gateway's own model with no list of names. A bare
 * word with no `resolvedModel` (a CLI before 2.1.197, or a row an allowlist
 * synthesized) has nothing to check against, and counts.
 */
function isAliasRow(value: string, resolvedModel: string | null): boolean {
  const word = CLAUDE_ALIAS_ID_PATTERN.exec(value)?.[1];
  if (word === undefined) return false;
  return resolvedModel === null || resolvedModel.includes(`claude-${word}-`);
}

/**
 * Turn the `models` of an `initialize` answer into a list, or null when it holds
 * no usable row. A row that fails validation is skipped. Exported for tests.
 *
 * The CLI's `displayName` never names an alias (signed in, `opus` is "Opus 5.5",
 * which would read as a pinned version) or an id with a `claude-` core (on
 * Bedrock `...claude-opus-5-5` is just "Opus", which would read as the alias).
 */
export function mapSupportedModels(rows: unknown): ClaudeModelList | null {
  if (!Array.isArray(rows)) return null;
  const models = new Set<string>();
  const aliases = new Map<string, ModelAliasOption>();
  const displayNames = new Map<string, string>();
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const value = modelValueOf(row.value);
    if (value === null || value === DEFAULT_ROW_VALUE) continue;
    const resolvedModel = modelValueOf(row.resolvedModel);
    if (isAliasRow(value, resolvedModel)) {
      aliases.set(value, resolvedModel === null ? { id: value } : { id: value, resolvesTo: resolvedModel });
      // There is no standalone row for the version an alias runs today, so the
      // specific versions would otherwise lose the current ones.
      if (resolvedModel !== null) models.add(resolvedModel);
      continue;
    }
    models.add(value);
    const displayName = typeof row.displayName === 'string' ? row.displayName.trim() : '';
    if (claudeCoreOf(value) === null && displayName.length > 0 && displayName.length <= MAX_DISPLAY_NAME_CHARS) {
      displayNames.set(value, displayName);
    }
  }
  if (models.size === 0 && aliases.size === 0) return null;
  return {
    models: [...models],
    aliases: [...aliases.values()],
    // Entries, not assignment: an id is the CLI's text, and `__proto__` must stay a key.
    ...(displayNames.size > 0 ? { displayNames: Object.fromEntries(displayNames) } : {}),
  };
}

/** The `models` of an answer line, or null for a line that is not this request's answer. */
function answerIn(line: string): { rows: unknown; success: boolean } | null {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(record) || record.type !== 'control_response' || !isRecord(record.response)) return null;
  const { request_id: requestId, subtype, response } = record.response;
  if (requestId !== undefined && requestId !== INITIALIZE_REQUEST_ID) return null;
  return { rows: isRecord(response) ? response.models : undefined, success: subtype === 'success' };
}

/** Send `initialize` and resolve the first answer. Rejects on an exit first, a spawn error, or the bound. */
function converse(child: CliChildProcess, timeoutMs: number): Promise<ClaudeModelList> {
  return new Promise((resolve, reject) => {
    // A pipe can split a multi-byte character across two chunks.
    const decoder = new StringDecoder('utf8');
    let buffered = '';
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle();
    };
    const timer = setTimeout(() => finish(() => reject(new Error('timed out'))), timeoutMs);
    timer.unref?.();
    // A CLI that exits before reading (one with no stream-json mode) fails the
    // write with EPIPE; its exit rejects the read.
    child.stdin.on('error', () => undefined);
    child.once('error', (error: Error) => finish(() => reject(error)));
    child.once('exit', () => finish(() => reject(new Error('exited before answering'))));
    child.stderr.resume();
    // Left listening after the answer: a process with a full pipe cannot exit.
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      buffered += decoder.write(chunk);
      let newline = buffered.indexOf('\n');
      while (newline >= 0 && !settled) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf('\n');
        const answer = line.length > 0 ? answerIn(line) : null;
        if (answer === null) continue;
        const list = answer.success ? mapSupportedModels(answer.rows) : null;
        finish(() => (list ? resolve(list) : reject(new Error(answer.success ? 'answer held no models' : 'initialize failed'))));
      }
    });
    child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: INITIALIZE_REQUEST_ID, request: { subtype: 'initialize' } })}\n`);
  });
}

/**
 * End stdin and let the CLI leave on its own, stopping it only if it has not
 * after `exitGraceMs`. Detached from the read: the list is already in hand, and
 * the dropdown rescan waiting on it must not pay for the exit. Signed in, the
 * exit took about 2 s from stdin's end on 2.1.318, against 46 to 342 ms on an
 * empty config.
 */
function leaveOnItsOwn(child: CliChildProcess, exitGraceMs: number): void {
  const timer = setTimeout(() => stopCli(child), exitGraceMs);
  timer.unref?.();
  child.once('exit', () => clearTimeout(timer));
  child.stdin.end();
}

/**
 * Ask the CLI at `cliPath` for its models. Rejects with a path-free error on
 * anything but a success holding usable rows, stopping the run; the caller falls
 * back to the PTY probe.
 */
export async function readClaudeModelList(
  cliPath: string,
  target: CliTarget | null,
  cwd: string,
  timeoutMs: number,
  exitGraceMs: number,
  spawn: typeof spawnCli = spawnCli,
): Promise<ClaudeModelList> {
  const child = spawn(cliPath, HANDSHAKE_ARGS, cwd, undefined, target);
  try {
    const list = await converse(child, timeoutMs);
    leaveOnItsOwn(child, exitGraceMs);
    return list;
  } catch (error) {
    stopCli(child);
    throw error;
  }
}
