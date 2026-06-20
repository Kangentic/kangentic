/**
 * Google Gemini CLI capability discovery: detect available models and model override support.
 *
 * Gemini supports:
 * - `--model <model>` or `-m <model>` flag for model selection
 * - `/model` slash command for live session model switching
 * - No effort/reasoning levels (not a separate concept)
 *
 * Models are discovered from:
 * 1. `gemini --help` output (static support detection)
 * 2. Session history in ~/.gemini/tmp directory (JSON files with chat content)
 */

import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import {
  listMostRecentDirs,
  listMostRecentFiles,
  readHeadBytes,
  readWholeFile,
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
 * Parse `gemini --help` to detect if --model flag is supported.
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
 * Scan Gemini's session history for observed models.
 * Sessions are stored in ~/.gemini/tmp/<basename(cwd)>/chats/ with session-*.json files.
 *
 * Each JSON file contains chat history and metadata including model selection.
 */
/** Collect `model` from a record's top level and from each entry of its
 *  `messages[]` array (the two places Gemini writes it). */
function harvestGeminiModels(record: unknown, modelSet: Set<string>): void {
  if (!record || typeof record !== 'object') return;
  const typed = record as { model?: unknown; messages?: unknown };
  if (typeof typed.model === 'string' && typed.model.length > 0) {
    modelSet.add(typed.model);
  }
  if (Array.isArray(typed.messages)) {
    for (const message of typed.messages) {
      if (message && typeof message === 'object') {
        const model = (message as { model?: unknown }).model;
        if (typeof model === 'string' && model.length > 0) {
          modelSet.add(model);
        }
      }
    }
  }
}

async function scanGeminiSessionHistory(): Promise<string[]> {
  const modelSet = new Set<string>();
  const tmpDir = path.join(os.homedir(), '.gemini', 'tmp');

  // Walk the project directories, ranking by the `chats/` subdirectory's mtime
  // rather than the project root. This keeps test-artifact dirs (which never
  // get a `chats/` written to them) from monopolizing the top-N slots and
  // pushing real sessions out of scan range. Cap at 50 to keep total stat cost
  // bounded on installs with thousands of project dirs.
  const projectDirs = await listMostRecentDirs(tmpDir, 50, {
    mtimeSubpath: 'chats',
    requireMtimeSubpath: true,
  });

  // Scan each project directory for chat session files. Gemini ships both
  // `.json` (single-document) and `.jsonl` (newline-delimited) for its session
  // history; the schema for both has model on each gemini-typed message under
  // `.model`. We accept both so the scan does not regress when Gemini changes
  // its on-disk format.
  for (const projectDir of projectDirs) {
    const chatsDir = path.join(projectDir.fullPath, 'chats');
    const sessionFiles = await listMostRecentFiles(
      chatsDir,
      (name) => name.startsWith('session-') && (name.endsWith('.json') || name.endsWith('.jsonl')),
      3,
    );
    for (const { fullPath } of sessionFiles) {
      if (fullPath.endsWith('.jsonl')) {
        // Newline-delimited: each line is a record. The model id sits on early
        // records, so a bounded head read is enough.
        const text = await readHeadBytes(fullPath, SESSION_SCAN_HEAD_BYTES);
        for (const record of parseJsonlRecords(text, false)) {
          harvestGeminiModels(record, modelSet);
        }
      } else {
        // Single-document JSON: the whole file is one record, so it must be
        // read in full to parse (a truncated head would not parse).
        const text = await readWholeFile(fullPath);
        if (text.length === 0) continue;
        try {
          harvestGeminiModels(JSON.parse(text), modelSet);
        } catch {
          // Ignore unparseable files.
        }
      }
    }
  }

  // Ascending alphabetical: groups by family naturally (shared prefix
  // clusters together) and keeps the order consistent across all agents.
  return Array.from(modelSet).sort();
}

/**
 * Discover Gemini's capabilities: model override support and available models.
 * Returns:
 * - supportsModelOverride: true if --model flag is supported
 * - models: list of discovered models (from history)
 * - effortLevels: empty array (Gemini doesn't have effort levels)
 *
 * Best-effort: always returns a capabilities object even if detection partially fails.
 */
export async function discoverGeminiCapabilities(cliPath: string): Promise<AgentCapabilities> {
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
      discoveredModels = await scanGeminiSessionHistory();
    } catch {
      // Session history scan failure - continue with empty list
    }
  }

  return {
    supportsModelOverride,
    models: discoveredModels.length > 0 ? discoveredModels : undefined,
    // Gemini does not have separate effort levels
    effortLevels: [],
  };
}
