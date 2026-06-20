/**
 * Kimi Code capability discovery: detect available models and model override support.
 *
 * Kimi is a Chinese-focused AI coding agent. Based on the adapter structure
 * (wire-parser, similar to Codex), it likely supports:
 * - `--model <model>` flag for model selection
 * - Possible live `/model` slash command (similar to Gemini/Qwen)
 * - No effort/reasoning levels
 *
 * Session history location: ~/.kimi/sessions (JSONL files via wire-parser)
 *
 * Note: Research on Kimi's CLI was quota-limited. This is best-effort.
 */

import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import {
  listMostRecentDirs,
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
 * Parse `kimi --help` to detect if --model flag is supported.
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
 * Scan Kimi's JSONL session history for observed models.
 * Sessions are stored as `~/.kimi/sessions/<workdir-hash>/<session-uuid>/wire.jsonl`
 * (verified empirically against kimi 1.37.0 - two levels of nesting:
 * the outer dir is a hash of the session's working directory, the inner
 * dir is the session UUID, and `wire.jsonl` is the only file inside).
 *
 * The wire format (protocol_version 1.9+) does NOT carry a top-level
 * `model` field on most events. Models tend to appear inside payload
 * objects on `StatusUpdate`, `TurnEnd`, or `ConfigSet` events. We probe
 * any event with a `payload.model` and any nested string `model` field
 * to stay forward-compatible.
 */
async function scanKimiSessionHistory(): Promise<string[]> {
  const modelSet = new Set<string>();
  const sessionsDir = path.join(os.homedir(), '.kimi', 'sessions');

  // Walk the workdir-hash directories (top level), then the session UUID dirs
  // inside each. Cap each level so we never scan more than ~30 files end-to-end.
  const workdirDirs = await listMostRecentDirs(sessionsDir, 10);
  for (const workdirDir of workdirDirs) {
    const sessionDirs = await listMostRecentDirs(workdirDir.fullPath, 3);
    for (const sessionDir of sessionDirs) {
      const wirePath = path.join(sessionDir.fullPath, 'wire.jsonl');
      const text = await readHeadBytes(wirePath, SESSION_SCAN_HEAD_BYTES);
      if (text.length === 0) continue;
      for (const record of parseJsonlRecords(text, false)) {
        // Top-level model.
        const topModel = record.model;
        if (typeof topModel === 'string' && topModel.length > 0) {
          modelSet.add(topModel);
        }
        // message.payload.model (TurnEnd, StatusUpdate, etc.)
        const message = record.message;
        if (message && typeof message === 'object') {
          const payload = (message as { payload?: unknown }).payload;
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

  return Array.from(modelSet).sort();
}

/**
 * Discover Kimi's capabilities: model override support and available models.
 * Returns:
 * - supportsModelOverride: true if --model flag is supported
 * - models: list of discovered models (from history)
 * - effortLevels: empty array (Kimi has no effort levels)
 *
 * Best-effort: always returns a capabilities object even if detection partially fails.
 * Note: Research on Kimi was quota-limited; this is best-effort.
 */
export async function discoverKimiCapabilities(cliPath: string): Promise<AgentCapabilities> {
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
      discoveredModels = await scanKimiSessionHistory();
    } catch {
      // Session history scan failure - continue with empty list
    }
  }

  return {
    supportsModelOverride,
    models: discoveredModels.length > 0 ? discoveredModels : undefined,
    // Kimi has no effort levels
    effortLevels: [],
  };
}
