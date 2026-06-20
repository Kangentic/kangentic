import os from 'node:os';
import path from 'node:path';
import { execFile, exec } from 'node:child_process';
import { promisify } from 'node:util';
import { getCachedModelPickerModels } from './model-picker-probe';
import {
  listMostRecentDirs,
  listMostRecentFiles,
  readHeadBytes,
  parseJsonlRecords,
  SESSION_SCAN_HEAD_BYTES,
} from '../../shared/history-scan';
import type { AgentCapabilities } from '../../../../shared/types';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

const HELP_TIMEOUT_MS = 5000;

/**
 * Run `<cliPath> --help` and capture stdout. Mirrors `execVersion`'s Windows
 * vs Unix split: Windows .cmd shims need a shell, Unix can call the binary
 * directly.
 */
async function readHelpText(cliPath: string): Promise<string> {
  if (process.platform === 'win32') {
    const { stdout } = await execAsync(`"${cliPath}" --help`, {
      timeout: HELP_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  }
  const { stdout } = await execFileAsync(cliPath, ['--help'], {
    timeout: HELP_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

// Caps for the historical-session scan. The walk runs at agents.list() time
// (cached afterwards) so it must complete quickly even on a heavily-used
// install. These limits trade exhaustive coverage for predictable latency:
// the most-recent N projects/sessions are nearly always representative of
// the models a user picks from.
const MAX_PROJECT_DIRS_TO_SCAN = 30;
const MAX_SESSIONS_PER_PROJECT = 3;

/**
 * Read up to `lookupBytes` from the head of a JSONL file and collect every
 * distinct `message.model` value found on assistant records, decoding lazily
 * so we never load multi-MB transcripts. Claude's native session JSONLs lead
 * with summary and user records, so we cannot stop at the first line - we
 * iterate until we either run out of head bytes or find at least one
 * assistant turn with a model. Returns an empty set on any read failure.
 */
async function readModelsFromHead(filePath: string, lookupBytes: number): Promise<Set<string>> {
  const found = new Set<string>();
  const text = await readHeadBytes(filePath, lookupBytes);
  if (text.length === 0) return found;
  // parseJsonlRecords drops the truncated final line for us; a half-line would
  // never parse anyway, and well-formed JSONL ends with a newline.
  for (const record of parseJsonlRecords(text, true)) {
    if (record.type !== 'assistant') continue;
    const message = record.message as Record<string, unknown> | undefined;
    if (!message || typeof message.model !== 'string' || message.model.length === 0) continue;
    // Claude Code uses angle-bracket sentinels (e.g. `<synthetic>`) on
    // assistant records that did not come from a real API call - tool
    // result framing, replays, error placeholders. They are not valid
    // values for `--model`, so drop anything wrapped in `<...>`.
    if (message.model.startsWith('<') && message.model.endsWith('>')) continue;
    // Preserve the exact form Claude wrote into the transcript. Empirical
    // probe (scripts/probe-claude-model-forms.js) showed that
    // `claude-haiku-4-5` and `claude-haiku-4-5-20251001` are NOT aliased on
    // the API side - Claude echoes back whatever you pass. Stripping the
    // dated suffix would silently turn a pinned build into "latest", which
    // loses reproducibility for users who want to port back to a specific
    // version.
    found.add(message.model);
  }
  return found;
}

/**
 * Walk Claude Code's native session JSONL store at `~/.claude/projects/` and
 * collect distinct model identifiers from the assistant messages. This gives
 * the user a dropdown populated with models they have actually used, with no
 * configuration needed - a fresh install with zero sessions returns undefined
 * and the renderer falls back to a free-form text input.
 *
 * Bounded: walks the most-recent project dirs and the most-recent session
 * files per dir, reads only a small head of each file, and stops as soon as
 * it finds a model. Returns undefined on any directory listing failure or
 * when no models could be extracted.
 */
async function discoverHistoricalModels(): Promise<string[] | undefined> {
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
  // Sort projects by directory mtime (proxy for "recently active") so we scan
  // the freshest data first when capped by MAX_PROJECT_DIRS_TO_SCAN.
  const projectDirs = await listMostRecentDirs(projectsRoot, MAX_PROJECT_DIRS_TO_SCAN);
  if (projectDirs.length === 0) return undefined;

  const models = new Set<string>();
  for (const projectDir of projectDirs) {
    const sessionFiles = await listMostRecentFiles(
      projectDir.fullPath,
      (name) => name.endsWith('.jsonl'),
      MAX_SESSIONS_PER_PROJECT,
    );
    for (const sessionFile of sessionFiles) {
      // Native Claude session JSONL stores the model on assistant messages
      // under `message.model` (see transcript-parser.ts:92 for the canonical
      // shape). Sessions lead with summary/user records, so we have to scan
      // past those to reach the first assistant turn.
      const fileModels = await readModelsFromHead(sessionFile.fullPath, SESSION_SCAN_HEAD_BYTES);
      for (const modelId of fileModels) models.add(modelId);
    }
  }

  if (models.size === 0) return undefined;
  // Ascending alphabetical: the family prefix is shared across versions
  // (e.g. all `claude-opus-*` IDs cluster together) so a simple a-z sort
  // groups by family for free, and versions within a family land in
  // increasing order. The "Default" entry is prepended by the renderer.
  return Array.from(models).sort((a, b) => a.localeCompare(b));
}

/**
 * Parse the `--help` output of the live CLI for the static capability bits:
 * effort levels (enumerated in the help text) and `--model` flag presence.
 * These do not change between dialog opens for a given binary, so callers
 * cache the result keyed by `cliPath`. Returns an empty object on any read
 * or parse failure so the rest of detection can still succeed.
 */
export async function discoverClaudeStaticCapabilities(cliPath: string): Promise<AgentCapabilities> {
  let helpText: string;
  try {
    helpText = await readHelpText(cliPath);
  } catch {
    return {};
  }

  const capabilities: AgentCapabilities = {};

  // The `--effort` line in Claude Code's help output looks like:
  //   --effort <level>     Effort level for the current session (low, medium, high, xhigh, max)
  // At real terminal widths the description is long enough that the
  // parenthesized choice list wraps onto an indented continuation line:
  //   --effort <level>     Effort level for the current session
  //                        (low, medium, high, xhigh, max)
  // The parenthesized choice list is the source of truth - parse it directly
  // so any future addition (e.g. a new "ultra" level) shows up automatically.
  // The gap class is `[^(]` (newlines allowed) rather than `[^(\n]` so the
  // match spans that wrap; it still stops at the first `(` after `<level>`,
  // which is the choice list.
  const effortMatch = helpText.match(/--effort\s+<[^>]+>\s+[^(]*\(([^)]+)\)/);
  if (effortMatch) {
    const levels = effortMatch[1]
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (levels.length > 0) capabilities.effortLevels = levels;
  }

  // The `--model` flag is documented in --help but its valid values are
  // open-ended (aliases plus full model IDs). We only record presence here;
  // the enumerable model list is discovered separately from session history
  // so the dropdown picks up newly-used models without restarting Kangentic.
  if (/--model\s+<[^>]+>/.test(helpText)) {
    capabilities.supportsModelOverride = true;
  }

  return capabilities;
}

/**
 * Discover the models the user can pass to `--model`, from two sources:
 *
 * 1. A live scan of `~/.claude/projects/` session JSONLs. Always runs fresh
 *    (no cache) so the dropdown picks up models the user just used in another
 *    window since the last time the dialog opened. This is the base source -
 *    it covers `[1m]` variants and gateway/Bedrock id forms that only appear
 *    in transcripts.
 * 2. The CLI's own `/model` picker, driven through a hidden short-lived PTY
 *    (see model-picker-probe.ts) - the only surface that enumerates a newly
 *    shipped model before the user has used it, and it works with every auth
 *    method. Read from a background-warmed cache so discovery never blocks on
 *    the PTY round trip; fails silently to source 1.
 *
 * Returns undefined when neither source yields a model, in which case the
 * renderer falls back to a free-form text input.
 */
export async function rescanClaudeModels(cliPath: string): Promise<string[] | undefined> {
  const transcriptModels = await discoverHistoricalModels();
  const pickerModels = getCachedModelPickerModels(cliPath);

  if (!transcriptModels && !pickerModels) return undefined;
  const union = new Set<string>([...(transcriptModels ?? []), ...(pickerModels ?? [])]);
  return Array.from(union).sort((modelIdA, modelIdB) => modelIdA.localeCompare(modelIdB));
}

/**
 * Discover Claude Code's full runtime capabilities by combining the cached
 * static bits with a fresh model rescan. Used by the IPC layer when no
 * caller-managed cache exists - tests and ad-hoc callers.
 */
export async function discoverClaudeCapabilities(cliPath: string): Promise<AgentCapabilities> {
  const capabilities = await discoverClaudeStaticCapabilities(cliPath);
  if (capabilities.supportsModelOverride) {
    const models = await rescanClaudeModels(cliPath);
    if (models) capabilities.models = models;
  }
  return capabilities;
}
