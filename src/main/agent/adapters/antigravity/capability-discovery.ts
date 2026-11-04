/**
 * Antigravity CLI capability discovery: model + effort override support, the
 * model list, and the flags the command builder only passes where the CLI
 * lists them.
 *
 * - `agy --help` documents `--model` ("Model for the current CLI session")
 *   and `--effort` ("Reasoning effort ... (low|medium|high)" on 1.1.13,
 *   `(low|medium|high|xhigh|max)` on 1.4.12) - both parsed from the live help
 *   text so a future CLI that drops a flag or adds a level follows on its own.
 * - The same help on 1.4.12 lists `--settings` ("Settings for this session
 *   only, never saved") and `--mode` with `(accept-edits, auto, plan)`. An
 *   older CLI lacks one or both, and passing an unknown flag or value could
 *   stop its launch, so the builder reads `antigravityHelpFeatures` first.
 * - `agy models` prints "Fetching available models..." then one
 *   `<slug>\t<Display Name>` line per model (a NETWORK fetch, hence the
 *   longer timeout and the cache) - e.g.
 *   `gemini-3.1-pro-high\tGemini 3.1 Pro (High)`.
 */

import { execAsync, execFileAsync } from '../../../utility-process/off-main-exec';
import { quoteCmdExecutable } from '../../../../shared/shell-quote';
import { execCliForTarget, resolveCliTarget, type CliTarget } from '../../shared/cli-target';
import type { AgentCapabilities } from '../../../../shared/types';


const HELP_TIMEOUT_MS = 5000;
const MODELS_TIMEOUT_MS = 10000;

let cache: { cliPath: string; capabilities: AgentCapabilities } | null = null;

/** Flags whose presence the command builder checks before passing them. */
export interface AntigravityHelpFeatures {
  /** `--settings` (per-session settings, never saved): carries the status line. */
  sessionSettings: boolean;
  /** The values `--mode` lists (`accept-edits`, `auto`, `plan` on 1.4.12). */
  modes: readonly string[];
}

/**
 * Help-derived features per CLI path. Filled by discovery, read synchronously
 * by the command builder. A path discovery has not read yet answers null,
 * which the builder treats as an older CLI (no `--settings`, no `auto`).
 */
const helpFeaturesByCliPath = new Map<string, AntigravityHelpFeatures>();

/** What `agy --help` said about the flags the builder gates on, or null before discovery ran for `cliPath`. */
export function antigravityHelpFeatures(cliPath: string): AntigravityHelpFeatures | null {
  return helpFeaturesByCliPath.get(cliPath) ?? null;
}

/** Test-only: reset the discovery caches between cases. */
export function resetAntigravityCapabilityCacheForTests(): void {
  cache = null;
  helpFeaturesByCliPath.clear();
}

/** Test-only: seed what discovery would have read from `--help`. */
export function setAntigravityHelpFeaturesForTests(cliPath: string, features: AntigravityHelpFeatures): void {
  helpFeaturesByCliPath.set(cliPath, features);
}

/** The documented effort levels (headless flag table), for a help line that lists none. */
const DOCUMENTED_EFFORT_LEVELS = ['low', 'medium', 'high'];

/**
 * The description on the help line of `flag` (Go's flag usage:
 * `  --flag   Description`), empty when the line has none, or null when the
 * help does not list the flag. The match stays on one line, so a flag with no
 * description never reads the next flag's text, and a CRLF help reads the same.
 * `flag` is a plain `--name`, which needs no regex escaping.
 */
function helpLineOf(helpText: string, flag: string): string | null {
  const match = helpText.match(new RegExp(`^[ \\t]*${flag}(?:[ \\t]+(.*?))?\\r?$`, 'm'));
  return match ? (match[1] ?? '') : null;
}

/**
 * The effort levels `--effort` lists in its parenthesized `a|b|c` set, or the
 * documented three when the line has none. Null when the flag is absent.
 */
export function parseEffortLevels(helpText: string): string[] | null {
  const line = helpLineOf(helpText, '--effort');
  if (line === null) return null;
  const listed = line.match(/\(([a-z]+(?:\|[a-z]+)+)\)/);
  return listed ? listed[1].split('|') : [...DOCUMENTED_EFFORT_LEVELS];
}

/** `--settings` presence and the `--mode` values, read off the help text. */
export function parseHelpFeatures(helpText: string): AntigravityHelpFeatures {
  const modeLine = helpLineOf(helpText, '--mode');
  const modeList = modeLine?.match(/\(([a-z-]+(?:,\s*[a-z-]+)+)\)/);
  return {
    sessionSettings: helpLineOf(helpText, '--settings') !== null,
    modes: modeList ? modeList[1].split(/,\s*/) : [],
  };
}

/** Run agy and return stdout. An agy installed in a WSL distro (`target`) runs there, through `wsl.exe`. */
async function runCli(cliPath: string, args: string[], timeoutMs: number, target: CliTarget | null): Promise<string> {
  if (target) return (await execCliForTarget(target, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 })).stdout;
  if (process.platform === 'win32') {
    const { stdout } = await execAsync(`${quoteCmdExecutable(cliPath)} ${args.join(' ')}`, {
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

  // A distro whose facts cannot be read cannot be asked either.
  const target = await resolveCliTarget(cliPath, true).catch(() => undefined);
  if (target === undefined) return { supportsModelOverride: false, effortLevels: [] };

  let supportsModelOverride = false;
  let effortLevels: string[] = [];
  try {
    const helpText = await runCli(cliPath, ['--help'], HELP_TIMEOUT_MS, target);
    supportsModelOverride = /--model\s/.test(helpText);
    effortLevels = parseEffortLevels(helpText) ?? [];
    helpFeaturesByCliPath.set(cliPath, parseHelpFeatures(helpText));
  } catch {
    // Help failure - assume no override support.
  }

  let models: string[] = [];
  let displayNames: Record<string, string> = {};
  if (supportsModelOverride) {
    try {
      const parsed = parseModelsOutput(await runCli(cliPath, ['models'], MODELS_TIMEOUT_MS, target));
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
