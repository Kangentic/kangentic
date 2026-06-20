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
  readTailBytes,
  parseJsonlRecords,
  SESSION_SCAN_HEAD_BYTES,
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
async function detectStaticCapabilities(cliPath: string): Promise<AgentCapabilities> {
  let helpText: string;
  try {
    helpText = await readHelpText(cliPath);
  } catch {
    // Help parsing failure - return conservative defaults
    return { supportsModelOverride: false, effortLevels: [] };
  }

  let supportsModelOverride = false;
  const effortLevels: string[] = [];

  // Check for --model flag
  if (/--model\s+<[^>]+>/.test(helpText)) {
    supportsModelOverride = true;
  }

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

  return { supportsModelOverride, effortLevels };
}

/**
 * Scan Copilot's per-session events.jsonl for observed models. Sessions
 * are stored under `~/.copilot/session-state/<sessionId>/events.jsonl`
 * (verified empirically against copilot 1.0.39). The model surfaces in:
 *   - `session.shutdown` events: `data.currentModel`, `data.modelMetrics`
 *     (object keyed by model name)
 *   - Per-turn events with `data.model` or similar
 *
 * Bounded to the most-recent 10 sessions x 256KB head per file so the
 * scan runs quickly even on heavy users.
 */
async function scanCopilotSessionHistory(): Promise<string[]> {
  const modelSet = new Set<string>();
  const sessionsRoot = path.join(os.homedir(), '.copilot', 'session-state');
  const sessionDirs = await listMostRecentDirs(sessionsRoot, 10);

  for (const sessionDir of sessionDirs) {
    const eventsPath = path.join(sessionDir.fullPath, 'events.jsonl');
    // Read from the END of the file rather than the start: Copilot's
    // session.shutdown event (which carries currentModel and modelMetrics)
    // lands at the tail, while the head holds setup chatter that does not name
    // a model. readTailBytes drops the truncated first line for us.
    const text = await readTailBytes(eventsPath, SESSION_SCAN_HEAD_BYTES);
    if (text.length === 0) continue;
    for (const record of parseJsonlRecords(text, false)) {
      const data = record.data;
      if (!data || typeof data !== 'object') continue;
      const dataRecord = data as Record<string, unknown>;
      if (typeof dataRecord.currentModel === 'string' && dataRecord.currentModel.length > 0) {
        modelSet.add(dataRecord.currentModel);
      }
      if (typeof dataRecord.model === 'string' && dataRecord.model.length > 0) {
        modelSet.add(dataRecord.model);
      }
      // `modelMetrics` is an object keyed by model name; harvest its keys.
      if (dataRecord.modelMetrics && typeof dataRecord.modelMetrics === 'object') {
        for (const key of Object.keys(dataRecord.modelMetrics)) {
          if (key.length > 0) modelSet.add(key);
        }
      }
    }
  }

  return Array.from(modelSet).sort();
}

/**
 * Discover Copilot's capabilities: model override support, effort levels, and available models.
 * Returns:
 * - supportsModelOverride: true if --model flag is supported
 * - effortLevels: array of effort level strings (or empty if not supported)
 * - models: list of models seen in `~/.copilot/session-state/*` (best-effort)
 *
 * Best-effort: always returns a capabilities object even if detection partially fails.
 */
export async function discoverCopilotCapabilities(cliPath: string): Promise<AgentCapabilities> {
  const staticCapabilities = await detectStaticCapabilities(cliPath);
  if (!staticCapabilities.supportsModelOverride) {
    return staticCapabilities;
  }
  let models: string[] = [];
  try {
    models = await scanCopilotSessionHistory();
  } catch {
    // Best-effort - leave models empty on any failure.
  }
  return {
    ...staticCapabilities,
    models: models.length > 0 ? models : undefined,
  };
}
