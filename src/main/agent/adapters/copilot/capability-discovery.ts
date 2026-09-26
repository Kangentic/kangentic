/**
 * GitHub Copilot CLI capability discovery: detect available models, effort levels, and overrides.
 *
 * Copilot supports:
 * - `--model <model>` flag for model selection
 * - `/model` slash command for live session model switching
 * - `--reasoning-effort <level>` flag for effort selection (similar to Claude)
 * - `/reasoning-effort` slash command for live effort switching
 */

import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import {
  listMostRecentDirs,
  readHeadBytes,
  parseJsonlRecords,
} from '../../shared/history-scan';
import type { AgentCapabilities } from '../../../../shared/types';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const HELP_TIMEOUT_MS = 5000;

/**
 * Run `<cliPath> --help` and capture stdout.
 * On Windows, use shell invocation; on Unix, use direct execFile.
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

/**
 * Parse help output for `--model` and `--reasoning-effort` flags.
 * Returns capabilities object with booleans indicating support.
 * Always returns a complete object with all required fields.
 */
async function detectStaticCapabilities(
  cliPath: string,
): Promise<AgentCapabilities & { offersAutoModel: boolean }> {
  let helpText: string;
  try {
    helpText = await readHelpText(cliPath);
  } catch {
    // Help parsing failure - return conservative defaults
    return { supportsModelOverride: false, effortLevels: [], offersAutoModel: false };
  }

  let supportsModelOverride = false;
  const effortLevels: string[] = [];

  // Check for --model flag
  if (/--model\s+<[^>]+>/.test(helpText)) {
    supportsModelOverride = true;
  }
  // The help names one model value itself: "use 'auto' to let Copilot pick".
  const offersAutoModel = supportsModelOverride && /use\s+['"]auto['"]/i.test(helpText);

  // Check for --reasoning-effort or --effort flag. Copilot's help uses
  // commander.js's `(choices: "low", "medium", "high", "xhigh")` format
  // (note the "choices:" prefix and quoted entries), while Claude uses a
  // bare `(low, medium, high, xhigh, max)` parenthesized list. Match the
  // wider pattern, then strip the optional "choices:" prefix and any
  // surrounding quotes from each entry so both formats produce clean
  // bare-name levels.
  const effortMatch = helpText.match(/--(?:reasoning-)?effort[^\n]*?\(([^)]+)\)/);
  if (effortMatch) {
    const raw = effortMatch[1].replace(/^\s*choices:\s*/i, '');
    const levels = raw
      .split(',')
      .map((entry) => entry.trim().replace(/^["']|["']$/g, ''))
      .filter((entry) => entry.length > 0 && /^[a-zA-Z][a-zA-Z0-9-]*$/.test(entry));
    if (levels.length > 0) {
      effortLevels.push(...levels);
    }
  }

  return { supportsModelOverride, effortLevels, offersAutoModel };
}

/** `session.start` is the first line of a session's log, so this is plenty. */
const SESSION_START_HEAD_BYTES = 64 * 1024;

/**
 * Scan Copilot's per-session events.jsonl for the models the user CHOSE.
 * Sessions are stored under `~/.copilot/session-state/<sessionId>/events.jsonl`.
 *
 * Only `session.start`'s `selectedModel`, which is what `--model` was given.
 * The models a session RAN on are a different list and must not be offered:
 * `auto` routes to models the account cannot select by name, and background
 * work (titles, compaction) runs on helper models, so `currentModel`,
 * `modelMetrics` and per-turn `model` all name models that `--model` then
 * refuses. Measured on one account: every session selected `auto`, and the
 * logs named six models, none of which that account could pick.
 *
 * Bounded to the most-recent 10 sessions, head only.
 */
async function scanCopilotSessionHistory(): Promise<string[]> {
  const modelSet = new Set<string>();
  const sessionsRoot = path.join(os.homedir(), '.copilot', 'session-state');
  const sessionDirs = await listMostRecentDirs(sessionsRoot, 10);

  for (const sessionDir of sessionDirs) {
    const eventsPath = path.join(sessionDir.fullPath, 'events.jsonl');
    const text = await readHeadBytes(eventsPath, SESSION_START_HEAD_BYTES);
    if (text.length === 0) continue;
    for (const record of parseJsonlRecords(text, true)) {
      if (record.type !== 'session.start') continue;
      const data = record.data;
      if (!data || typeof data !== 'object') continue;
      const selected = (data as Record<string, unknown>).selectedModel;
      if (typeof selected === 'string' && selected.length > 0) modelSet.add(selected);
      break;
    }
  }

  return Array.from(modelSet).sort();
}

/**
 * Discover Copilot's capabilities: model override support, effort levels, and available models.
 * Returns:
 * - supportsModelOverride: true if --model flag is supported
 * - effortLevels: array of effort level strings (or empty if not supported)
 * - models: `auto` when the help names it, then the models the user has
 *   selected in `~/.copilot/session-state/*` (best-effort)
 *
 * Best-effort: always returns a capabilities object even if detection partially fails.
 */
export async function discoverCopilotCapabilities(cliPath: string): Promise<AgentCapabilities> {
  const { offersAutoModel, ...staticCapabilities } = await detectStaticCapabilities(cliPath);
  if (!staticCapabilities.supportsModelOverride) {
    return staticCapabilities;
  }
  let selected: string[] = [];
  try {
    selected = await scanCopilotSessionHistory();
  } catch {
    // Best-effort - leave models empty on any failure.
  }
  const models = offersAutoModel ? ['auto', ...selected.filter((model) => model !== 'auto')] : selected;
  return {
    ...staticCapabilities,
    models: models.length > 0 ? models : undefined,
  };
}
