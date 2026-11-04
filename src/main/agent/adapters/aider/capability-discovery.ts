/**
 * Aider capability discovery: whether the CLI takes a model override.
 *
 * From Aider's options reference (https://aider.chat/docs/config/options.html,
 * Aider v0.86.1):
 * - `--model MODEL` "Specify the model to use for the main chat". Read from
 *   the live `aider --help`, so a CLI that drops the flag degrades to no
 *   override.
 * - No model list. `--list-models MODEL` lists "known models which match the
 *   (partial) MODEL name": it needs a search term, and what it searches is
 *   LiteLLM's whole catalog, not the models this user can run. Aider writes no
 *   per-model record outside a project's chat history either. The renderer
 *   falls back to its free-form model input.
 * - No effort levels. `--reasoning-effort VALUE` exists, but its values are "a
 *   number or low/medium/high depending on model" (the `/reasoning-effort` row
 *   of https://aider.chat/docs/usage/commands.html), so a fixed list would offer
 *   levels a model refuses. A column's effort override still reaches the CLI
 *   through `buildCommand`.
 *
 * The `--help` parse is checked against a real Aider 0.86.2 capture
 * (`tests/fixtures/aider-help-0.86.2.txt`). No Aider session has been run.
 */

import { execAsync, execFileAsync } from '../../../utility-process/off-main-exec';
import { quoteCmdExecutable } from '../../../../shared/shell-quote';
import { execCliForTarget, resolveCliTarget, type CliTarget } from '../../shared/cli-target';
import type { AgentCapabilities } from '../../../../shared/types';

/** Aider is a Python program that imports LiteLLM at start, so its help is slow. */
const HELP_TIMEOUT_MS = 15000;

let cache: { cliPath: string; capabilities: AgentCapabilities } | null = null;

/**
 * Probes still running, by cliPath, so callers that arrive together share one
 * slow `aider --help` instead of each starting their own.
 */
const probesInFlight = new Map<string, Promise<AgentCapabilities>>();

/** Test-only: reset the discovery cache between cases. */
export function resetAiderCapabilityCacheForTests(): void {
  cache = null;
  probesInFlight.clear();
}

async function readHelp(cliPath: string, target: CliTarget | null): Promise<string> {
  const options = { timeout: HELP_TIMEOUT_MS, maxBuffer: 1024 * 1024 };
  if (target) return (await execCliForTarget(target, ['--help'], options)).stdout;
  if (process.platform === 'win32') {
    return (await execAsync(`${quoteCmdExecutable(cliPath)} --help`, { ...options, windowsHide: true })).stdout;
  }
  return (await execFileAsync(cliPath, ['--help'], options)).stdout;
}

/**
 * Whether `aider --help` text defines `--model`: a help line that opens with
 * the flag (`  --model MODEL   Specify the model ...`). Other flags' help
 * mentions it too ("default depends on --model", "deprecated, use --model"),
 * and those mentions must not count, or a CLI that dropped the flag would
 * still report an override.
 */
export function helpListsModelFlag(helpText: string): boolean {
  return /^[ \t]*--model(?=[\s,=]|$)/m.test(helpText);
}

/**
 * Discover Aider's capabilities. Never throws: a failed help read reports no
 * override support. Cached per cliPath; `forceRefresh` reads the help again.
 * A caller that arrives while a probe for the same cliPath is running shares it.
 */
export async function discoverAiderCapabilities(cliPath: string, forceRefresh = false): Promise<AgentCapabilities> {
  if (!forceRefresh && cache && cache.cliPath === cliPath) return cache.capabilities;

  const running = probesInFlight.get(cliPath);
  if (running) return running;
  const probe = probeCapabilities(cliPath).finally(() => {
    if (probesInFlight.get(cliPath) === probe) probesInFlight.delete(cliPath);
  });
  probesInFlight.set(cliPath, probe);
  return probe;
}

async function probeCapabilities(cliPath: string): Promise<AgentCapabilities> {
  // A distro whose facts cannot be read cannot be asked either.
  const target = await resolveCliTarget(cliPath, true).catch(() => undefined);
  if (target === undefined) return { supportsModelOverride: false, effortLevels: [] };

  let supportsModelOverride: boolean;
  try {
    supportsModelOverride = helpListsModelFlag(await readHelp(cliPath, target));
  } catch {
    // Help failure: assume no override support, and do not cache it.
    return { supportsModelOverride: false, effortLevels: [] };
  }

  const capabilities: AgentCapabilities = { supportsModelOverride, effortLevels: [] };
  cache = { cliPath, capabilities };
  return capabilities;
}
