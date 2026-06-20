/**
 * Cursor CLI capability discovery: detect available models and model override support.
 *
 * Cursor supports:
 * - `--model <model>` flag for model selection
 * - `/model` slash command for live session model switching
 * - No effort/reasoning flags (reasoning is encoded in model names, e.g., "sonnet-4-thinking")
 *
 * Models are discovered from:
 * 1. `agent about --format json` output (current model)
 * 2. Session history in .cursor/sessions directory (NDJSON init events)
 * 3. Hardcoded fallback list of common Cursor models
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

/**
 * Read `<cliPath> --help`. On Windows, npm/installer shims (.cmd / .CMD)
 * cannot be invoked via `execFile` directly because Node's CVE-2024-27980
 * mitigation refuses to execute .cmd/.bat without a shell. We fall back
 * to `exec` with a quoted command string on Windows (same pattern as
 * codex/claude/gemini adapters); other platforms keep `execFile` which
 * is safer and faster for native binaries.
 */
async function readHelpText(cliPath: string): Promise<string> {
  if (process.platform === 'win32') {
    const { stdout } = await execAsync(`"${cliPath}" --help`, {
      timeout: 5000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  }
  const { stdout, stderr } = await execFileAsync(cliPath, ['--help'], {
    timeout: 5000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return stdout + stderr;
}

/**
 * Parse `agent --help` to detect if --model flag is supported.
 * Returns true if the help text mentions a --model flag.
 */
async function detectModelFlagSupport(cliPath: string): Promise<boolean> {
  try {
    const helpText = await readHelpText(cliPath);
    // Look for exact flag pattern: --model followed by whitespace and arg description
    return /--model\s+<|--model\s+[A-Za-z]/.test(helpText);
  } catch {
    // If help fails, assume no model support
    return false;
  }
}

/**
 * Scan Cursor's NDJSON session history for observed models.
 * Sessions are stored in .cursor/sessions with dated subdirectories and chat JSONL files.
 *
 * Each line is a JSON event. The init event contains:
 * {"type":"system","subtype":"init","session_id":"uuid","model":"display name",...}
 */
async function scanCursorSessionHistory(): Promise<string[]> {
  const modelSet = new Set<string>();
  const sessionsDir = path.join(os.homedir(), '.cursor', 'sessions');

  // Read up to 10 most recent session directories (by mtime).
  const dirs = await listMostRecentDirs(sessionsDir, 10);
  for (const dir of dirs) {
    // Read up to 3 most recent JSONL files per directory.
    const files = await listMostRecentFiles(dir.fullPath, (name) => name.endsWith('.jsonl'), 3);
    for (const { fullPath } of files) {
      const text = await readHeadBytes(fullPath, SESSION_SCAN_HEAD_BYTES);
      for (const record of parseJsonlRecords(text, false)) {
        // Extract model from the init event.
        if (
          record.type === 'system' &&
          record.subtype === 'init' &&
          typeof record.model === 'string' &&
          record.model.length > 0
        ) {
          modelSet.add(record.model);
        }
      }
    }
  }

  // Ascending alphabetical: groups by family naturally (shared prefix
  // clusters together) and keeps the order consistent across all agents.
  return Array.from(modelSet).sort();
}

/**
 * Hardcoded list of Cursor CLI models that are commonly available.
 * Used as fallback when session history is empty or unavailable.
 */
const CURSOR_COMMON_MODELS = [
  'Claude 4.1 Sonnet',
  'Claude 3.5 Sonnet',
  'GPT-4.5',
  'GPT-4o Max',
  'GPT-4o',
  'Claude 3 Opus',
  'Claude 3 Sonnet',
  'GPT-4 Turbo',
];

/**
 * Discover Cursor's capabilities: model override support and available models.
 * Returns:
 * - supportsModelOverride: true if --model flag is supported
 * - models: list of discovered models (from history + fallback)
 * - effortLevels: empty array (Cursor doesn't have separate effort flags)
 *
 * Best-effort: always returns a capabilities object even if detection partially fails.
 */
export async function discoverCursorCapabilities(cliPath: string): Promise<AgentCapabilities> {
  let supportsModelOverride = false;
  try {
    supportsModelOverride = await detectModelFlagSupport(cliPath);
  } catch {
    // Flag detection failure - continue with assumed no support
  }

  // Discover models from session history (best-effort)
  let discoveredModels: string[] = [];
  try {
    discoveredModels = await scanCursorSessionHistory();
  } catch {
    // Session history scan failure - continue with empty list
  }

  // Combine with fallback list, preserving discovered models first, then adding fallbacks
  const modelSet = new Set<string>(discoveredModels);
  for (const model of CURSOR_COMMON_MODELS) {
    modelSet.add(model);
  }

  const models = Array.from(modelSet);

  return {
    supportsModelOverride,
    models: models.length > 0 ? models : undefined,
    // Effort levels are not a separate concept in Cursor - reasoning is encoded
    // in model names (e.g., "Claude 4.1 Sonnet" vs "Claude 4.1 Sonnet Thinking")
    effortLevels: [],
  };
}
