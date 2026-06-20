/**
 * Codex CLI capability discovery: detect available models and model override support.
 *
 * Codex supports:
 * - `--model <model>` or `-m <model>` flag for model selection
 * - `model_reasoning_effort` config in config.toml (config-file only, not CLI)
 * - No documented live `/model` slash command
 *
 * Models are discovered from:
 * 1. `codex --help` output (static support detection)
 * 2. Session history in ~/.codex/sessions directory (JSONL init events + turn_context)
 */

import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import {
  listMostRecentDirs,
  listMostRecentFiles,
  readHeadBytes,
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
 * Parse `codex --help` to detect if --model flag is supported.
 * Returns true if the help text mentions a --model flag.
 */
async function detectModelFlagSupport(cliPath: string): Promise<boolean> {
  try {
    const helpText = await readHelpText(cliPath);
    // Look for --model or -m flag pattern
    return /--model\s+<|--model\s+[A-Za-z]|-m\s+<|-m\s+[A-Za-z]/.test(helpText);
  } catch {
    // If help fails, assume no model support
    return false;
  }
}

/**
 * Scan Codex's JSONL session history for observed models.
 * Sessions are stored in `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl`
 * (verified against codex 0.128.0 - three levels of date directories).
 *
 * The model field lives on `turn_context` events at `payload.model`.
 * `session_meta` does NOT carry the model in current Codex - if it did
 * historically, the broader `payload.model` check below still picks it
 * up so the parser is forward-compatible.
 */
async function scanCodexSessionHistory(): Promise<string[]> {
  const modelSet = new Set<string>();
  const sessionsDir = path.join(os.homedir(), '.codex', 'sessions');

  // Walk YYYY/MM/DD/. Cap each level so a long-running install doesn't pay an
  // unbounded scan cost. listMostRecentDirs returns [] for a missing dir, so
  // an absent `.codex/sessions` simply yields no models.
  const yearDirs = await listMostRecentDirs(sessionsDir, 2);
  for (const year of yearDirs) {
    const monthDirs = await listMostRecentDirs(year.fullPath, 3);
    for (const month of monthDirs) {
      const dayDirs = await listMostRecentDirs(month.fullPath, 5);
      for (const day of dayDirs) {
        const files = await listMostRecentFiles(day.fullPath, (name) => name.endsWith('.jsonl'), 3);
        for (const { fullPath } of files) {
          const text = await readHeadBytes(fullPath, SESSION_SCAN_HEAD_BYTES);
          for (const record of parseJsonlRecords(text, false)) {
            // Codex 0.128.0+: `turn_context` events carry `payload.model`.
            // Older builds may have placed it on `session_meta`; checking any
            // event with `payload.model` covers both shapes without us having
            // to enumerate event types.
            const payload = record.payload;
            if (payload && typeof payload === 'object') {
              const model = (payload as { model?: unknown }).model;
              if (typeof model === 'string' && model.length > 0) {
                modelSet.add(model);
              }
            }
          }
        }
      }
    }
  }

  // Ascending alphabetical: groups by family naturally (shared prefix
  // clusters together) and keeps the order consistent across all agents.
  return Array.from(modelSet).sort();
}

/**
 * Discover Codex's capabilities: model override support and available models.
 * Returns:
 * - supportsModelOverride: true if --model flag is supported
 * - models: list of discovered models (from history)
 * - effortLevels: empty array (Codex effort is config-file only, not CLI)
 *
 * Best-effort: always returns a capabilities object even if detection partially fails.
 */
export async function discoverCodexCapabilities(cliPath: string): Promise<AgentCapabilities> {
  let supportsModelOverride = false;
  try {
    supportsModelOverride = await detectModelFlagSupport(cliPath);
  } catch {
    // Flag detection failure - continue with assumed no support
  }

  // Discover models from session history (best-effort)
  let discoveredModels: string[] = [];
  if (supportsModelOverride) {
    try {
      discoveredModels = await scanCodexSessionHistory();
    } catch {
      // Session history scan failure - continue with empty list
    }
  }

  return {
    supportsModelOverride,
    models: discoveredModels.length > 0 ? discoveredModels : undefined,
    // Codex effort/reasoning is config-file only (config.toml: model_reasoning_effort)
    // No CLI flag, so effortLevels is always empty
    effortLevels: [],
  };
}
