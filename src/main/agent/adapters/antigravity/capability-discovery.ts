/**
 * Antigravity CLI capability discovery: model + effort override support and
 * the model list.
 *
 * Verified against agy 1.1.13:
 * - `agy --help` documents `--model` ("Model for the current CLI session")
 *   and `--effort` ("Reasoning effort ... (low|medium|high)") - both parsed
 *   from the live help text so a future CLI that drops a flag degrades
 *   automatically.
 * - `agy models` prints "Fetching available models..." then one
 *   `<slug>\t<Display Name>` line per model (a NETWORK fetch, hence the
 *   longer timeout and the cache) - e.g.
 *   `gemini-3.1-pro-high\tGemini 3.1 Pro (High)`.
 */

import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentCapabilities } from '../../../../shared/types';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const HELP_TIMEOUT_MS = 5000;
const MODELS_TIMEOUT_MS = 10000;

let cache: { cliPath: string; capabilities: AgentCapabilities } | null = null;

/** Test-only: reset the discovery cache between cases. */
export function resetAntigravityCapabilityCacheForTests(): void {
  cache = null;
}

async function runCli(cliPath: string, args: string[], timeoutMs: number): Promise<string> {
  if (process.platform === 'win32') {
    const { stdout } = await execAsync(`"${cliPath}" ${args.join(' ')}`, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  }
  const { stdout } = await execFileAsync(cliPath, args, {
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

/**
 * Parse `agy models` output into slug -> display-name pairs. The banner line
 * and anything else without a tab separator is skipped, so a partial or
 * unauthenticated fetch degrades to "no list" rather than garbage entries.
 */
export function parseModelsOutput(stdout: string): { models: string[]; displayNames: Record<string, string> } {
  const models: string[] = [];
  const displayNames: Record<string, string> = {};
  // Split tolerates CRLF: a trailing \r would make `(.+)$` unmatchable
  // (`.` excludes \r and `$` only anchors at end of input), silently
  // dropping every line of a Windows-emitted models list.
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^(\S+)\t(.+)$/);
    if (!match) continue;
    const slug = match[1].trim();
    const display = match[2].trim();
    if (!slug || models.includes(slug)) continue;
    models.push(slug);
    if (display) displayNames[slug] = display;
  }
  return { models, displayNames };
}

/**
 * Discover Antigravity's capabilities. Best-effort and never throws: a
 * failed help read yields no override support, a failed models fetch yields
 * override support with no list (the renderer falls back to a free-form
 * input). Cached per cliPath because the models list is a network fetch;
 * `forceRefresh` (the settings panel's refresh affordance) bypasses it.
 */
export async function discoverAntigravityCapabilities(
  cliPath: string,
  forceRefresh = false,
): Promise<AgentCapabilities> {
  if (!forceRefresh && cache && cache.cliPath === cliPath) return cache.capabilities;

  let supportsModelOverride = false;
  let effortLevels: string[] = [];
  try {
    const helpText = await runCli(cliPath, ['--help'], HELP_TIMEOUT_MS);
    supportsModelOverride = /--model\s/.test(helpText);
    if (/--effort\s/.test(helpText)) effortLevels = ['low', 'medium', 'high'];
  } catch {
    // Help failure - assume no override support.
  }

  let models: string[] = [];
  let displayNames: Record<string, string> = {};
  if (supportsModelOverride) {
    try {
      const parsed = parseModelsOutput(await runCli(cliPath, ['models'], MODELS_TIMEOUT_MS));
      models = parsed.models;
      displayNames = parsed.displayNames;
    } catch {
      // Network/auth failure - free-form input fallback.
    }
  }

  const capabilities: AgentCapabilities = {
    supportsModelOverride,
    effortLevels,
    models: models.length > 0 ? models : undefined,
    modelDisplayNames: Object.keys(displayNames).length > 0 ? displayNames : undefined,
  };
  cache = { cliPath, capabilities };
  return capabilities;
}
