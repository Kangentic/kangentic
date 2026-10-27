/**
 * Qwen Code capability discovery: detect available models and model override support.
 *
 * Qwen Code supports:
 * - `--model <model>` or `-m <model>` flag for model selection
 * - `/model` slash command for live session model switching (interactive picker)
 * - No effort/reasoning levels
 *
 * Models are discovered from:
 * 1. `qwen --help` output (static support detection)
 * 2. Session history in ~/.qwen/projects directory (JSONL files)
 */

import { execAsync, execFileAsync } from '../../../utility-process/off-main-exec';
import { quoteCmdExecutable } from '../../../../shared/shell-quote';
import path from 'node:path';
import { qwenHomeDir } from './qwen-home';
import { execCliForTarget, resolveCliTarget, type CliPlace, type CliTarget } from '../../shared/cli-target';
import {
  listMostRecentDirs,
  listMostRecentFiles,
  readHeadBytes,
  parseJsonlRecords,
  SESSION_SCAN_HEAD_BYTES,
} from '../../shared/history-scan';
import type { AgentCapabilities } from '../../../../shared/types';


const HELP_TIMEOUT_MS = 5000;

/**
 * Run `<cliPath> --help` and capture stdout.
 * On Windows, use shell invocation; on Unix, use direct execFile. A Qwen
 * installed in a WSL distro (`target`) runs there, through `wsl.exe`.
 */
async function readHelpText(cliPath: string, target: CliTarget | null): Promise<string> {
  if (target) {
    const { stdout } = await execCliForTarget(target, ['--help'], { timeout: HELP_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
    return stdout;
  }
  if (process.platform === 'win32') {
    const { stdout } = await execAsync(`${quoteCmdExecutable(cliPath)} --help`, {
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
 * Parse `qwen --help` to detect if --model flag is supported.
 * Returns true if the help text mentions a --model flag.
 */
async function detectModelFlagSupport(cliPath: string, target: CliTarget | null): Promise<boolean> {
  try {
    const helpText = await readHelpText(cliPath, target);
    // Look for --model or -m flag pattern
    return /--model\s+<|--model\s+[A-Za-z]|-m\s+<|-m\s+[A-Za-z]/.test(helpText);
  } catch {
    // If help fails, assume no model support
    return false;
  }
}

/**
 * Scan Qwen's JSONL session history for observed models.
 * Sessions are stored in `~/.qwen/projects/<project-hash>/chats/<sessionId>.jsonl`
 * (verified empirically against qwen 0.15.3 - flat `chats/` subdirectory,
 * one JSONL file per session, NOT a per-session subdirectory).
 *
 * Models surface on `assistant`-type events at top-level `obj.model`, and
 * on `ui_telemetry` events under `systemPayload.uiEvent.model` (qwen-code's
 * observability stream). We probe both to be schema-drift resilient.
 *
 * A Qwen in a WSL distro (`place`) keeps them in the distro's Qwen directory.
 */
async function scanQwenSessionHistory(place: CliPlace | null): Promise<string[]> {
  const modelSet = new Set<string>();
  const projectsDir = path.join(qwenHomeDir(place), 'projects');

  // Rank project directories by their `chats/` subdirectory's mtime so
  // test-artifact dirs (which never write to chats/) are skipped first. Cap at
  // 50 to bound stat cost on heavy installs.
  const dirs = await listMostRecentDirs(projectsDir, 50, {
    mtimeSubpath: 'chats',
    requireMtimeSubpath: true,
  });

  for (const projectDir of dirs) {
    const chatsDir = path.join(projectDir.fullPath, 'chats');
    const files = await listMostRecentFiles(chatsDir, (name) => name.endsWith('.jsonl'), 3);
    for (const { fullPath } of files) {
      const text = await readHeadBytes(fullPath, SESSION_SCAN_HEAD_BYTES);
      for (const record of parseJsonlRecords(text, false)) {
        // Top-level: assistant messages carry `model`.
        const topModel = record.model;
        if (typeof topModel === 'string' && topModel.length > 0) {
          modelSet.add(topModel);
        }
        // ui_telemetry events nest model under systemPayload.uiEvent.
        const systemPayload = record.systemPayload;
        if (systemPayload && typeof systemPayload === 'object') {
          const uiEvent = (systemPayload as { uiEvent?: unknown }).uiEvent;
          if (uiEvent && typeof uiEvent === 'object') {
            const model = (uiEvent as { model?: unknown }).model;
            if (typeof model === 'string' && model.length > 0) {
              modelSet.add(model);
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
 * Discover Qwen Code's capabilities: model override support and available models.
 * Returns:
 * - supportsModelOverride: true if --model flag is supported
 * - models: list of discovered models (from history)
 * - effortLevels: empty array (Qwen has no effort levels)
 *
 * Best-effort: always returns a capabilities object even if detection partially fails.
 */
export async function discoverQwenCapabilities(cliPath: string): Promise<AgentCapabilities> {
  // A Qwen installed in a WSL distro: its --help runs there, and its history is
  // in the distro. A distro whose facts cannot be read cannot be asked either.
  const target = await resolveCliTarget(cliPath, true).catch(() => undefined);
  let supportsModelOverride = false;
  try {
    supportsModelOverride = target === undefined ? false : await detectModelFlagSupport(cliPath, target);
  } catch {
    // Flag detection failure - continue with assumed no support
  }

  // Discover models from session history (best-effort)
  let discoveredModels: string[] = [];
  if (supportsModelOverride && target !== undefined) {
    try {
      discoveredModels = await scanQwenSessionHistory(target);
    } catch {
      // Session history scan failure - continue with empty list
    }
  }

  return {
    supportsModelOverride,
    models: discoveredModels.length > 0 ? discoveredModels : undefined,
    // Qwen has no effort levels
    effortLevels: [],
  };
}
