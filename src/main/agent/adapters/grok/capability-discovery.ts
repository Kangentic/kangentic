import fs from 'node:fs';
import path from 'node:path';
import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { grokHomeDir } from './session-paths';
import type { AgentCapabilities } from '../../../../shared/types';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const HELP_TIMEOUT_MS = 5000;

/**
 * Grok Build capability discovery.
 *
 * Primary source: `~/.grok/models_cache.json`, the CLI's own cache of its
 * `/v1/models` endpoint (written and refreshed by grok itself - the same
 * source its in-TUI `/model` picker uses). Verified shape (grok 1.0.0):
 *
 *   { "models": { "<id>": { "info": {
 *       "id", "name",                       // id + friendly display name
 *       "context_window",                    // e.g. 500000
 *       "supports_reasoning_effort",
 *       "reasoning_efforts": [{"id": "xhigh"|"high"|"medium"|"low", ...}],
 *       "hidden": bool } } } }
 *
 * Fallback when the cache is absent (fresh install, never launched):
 * `grok --help` documents `-m/--model` and `--reasoning-effort`, so model
 * override is reported as supported with a free-form input and the
 * documented effort ladder is confirmed from the help text.
 *
 * Best-effort throughout: never throws, returns an empty object on total
 * failure. `forceRefresh` bypasses the in-module memo (the underlying
 * cache file is grok's own; Kangentic never refetches the model list
 * itself - cli-features-over-custom-layers).
 */
// Keyed by cliPath (mirroring antigravity/capability-discovery.ts): a
// Settings save that repoints agent.cliPaths.grok rebuilds the agent list
// WITHOUT forceRefresh, and an unkeyed memo would keep reporting the old
// binary's capabilities.
let discoveryMemo: { cliPath: string; capabilities: AgentCapabilities } | null = null;

export async function discoverGrokCapabilities(
  cliPath: string,
  forceRefresh?: boolean,
): Promise<AgentCapabilities> {
  if (discoveryMemo && discoveryMemo.cliPath === cliPath && !forceRefresh) {
    return discoveryMemo.capabilities;
  }

  const fromCache = readModelsCache();
  if (fromCache) {
    discoveryMemo = { cliPath, capabilities: fromCache };
    return fromCache;
  }

  const fromHelp = await readHelpCapabilities(cliPath);
  discoveryMemo = { cliPath, capabilities: fromHelp };
  return fromHelp;
}

/** Test hook: reset the discovery memo. */
export function clearGrokCapabilityMemo(): void {
  discoveryMemo = null;
}

function readModelsCache(): AgentCapabilities | null {
  const cachePath = path.join(grokHomeDir(), 'models_cache.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.models)) return null;

  const models: string[] = [];
  const modelDisplayNames: Record<string, string> = {};
  const effortSet = new Set<string>();

  for (const [modelId, entry] of Object.entries(parsed.models)) {
    if (!isRecord(entry) || !isRecord(entry.info)) continue;
    const info = entry.info;
    if (info.hidden === true) continue;
    models.push(modelId);
    if (typeof info.name === 'string' && info.name.length > 0) {
      modelDisplayNames[modelId] = info.name;
    }
    if (Array.isArray(info.reasoning_efforts)) {
      for (const effort of info.reasoning_efforts) {
        if (isRecord(effort) && typeof effort.id === 'string' && effort.id.length > 0) {
          effortSet.add(effort.id);
        }
      }
    }
  }

  if (models.length === 0) return null;
  models.sort();

  return {
    supportsModelOverride: true,
    models,
    modelDisplayNames: Object.keys(modelDisplayNames).length > 0 ? modelDisplayNames : undefined,
    effortLevels: orderEffortLevels(effortSet),
  };
}

async function readHelpCapabilities(cliPath: string): Promise<AgentCapabilities> {
  let helpText = '';
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execAsync(`"${cliPath}" --help`, {
        timeout: HELP_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
      helpText = stdout;
    } else {
      const { stdout } = await execFileAsync(cliPath, ['--help'], {
        timeout: HELP_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });
      helpText = stdout;
    }
  } catch {
    return {};
  }

  const supportsModelOverride = /--model\s+<|-m,\s*--model/.test(helpText);
  const supportsEffort = /--reasoning-effort\s+<|--effort/.test(helpText);
  return {
    supportsModelOverride,
    // The documented ladder (17-sessions.md / `/effort`): low..xhigh. Only
    // reported when the flag is present in this build's help.
    effortLevels: supportsEffort ? ['low', 'medium', 'high', 'xhigh'] : [],
  };
}

/** Stable low-to-high ordering for the effort dropdown. */
function orderEffortLevels(effortSet: Set<string>): string[] {
  const canonical = ['low', 'medium', 'high', 'xhigh'];
  const ordered = canonical.filter((level) => effortSet.has(level));
  for (const level of effortSet) {
    if (!ordered.includes(level)) ordered.push(level);
  }
  return ordered;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
