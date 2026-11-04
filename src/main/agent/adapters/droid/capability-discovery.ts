/**
 * Droid capability discovery: the models the CLI itself lists.
 *
 * `droid exec --help` (0.218.0, read 2026-11-03) ends with an "Available
 * Models:" block and a "Custom Models:" block (the user's BYOK
 * `customModels[]`), one `<id>  <Display Name>` row each, with `(default)`
 * after the CLI's default. Factory's CLI reference points `-m, --model <id>`
 * at the same ids (https://docs.factory.com/droid-cli/cli-reference.md).
 * Asking the CLI keeps the list current with no table in Kangentic
 * (`cli-features-over-custom-layers.md`).
 *
 * The list is for the headless runs that take `--model` (`droid exec`:
 * summarize and the Knowledge Graph answer). `supportsModelOverride` stays
 * false, which keeps the column and Command Terminal model pickers hidden:
 * interactive `droid` 0.218.0 lists no `--model` flag, and the TUI's `/model`
 * picker is how a session's model is chosen.
 *
 * Effort is per model: the help's "Model details:" block gives each model's
 * levels (`- <Display Name>: supports reasoning: Yes; supported: [off, low,
 * ...]; default: high`), which `droid exec -r, --reasoning-effort <level>`
 * takes ("defaults per model"). They are reported as `effortLevelsByModel`,
 * keyed by id through the display name, and `effortLevels` stays empty so no
 * agent-wide list offers a level some model refuses.
 */

import { execAsync, execFileAsync } from '../../../utility-process/off-main-exec';
import { quoteCmdExecutable } from '../../../../shared/shell-quote';
import { execCliForTarget, resolveCliTarget, type CliTarget } from '../../shared/cli-target';
import type { AgentCapabilities } from '../../../../shared/types';

const HELP_TIMEOUT_MS = 5000;
const HELP_MAX_BUFFER = 1024 * 1024;

/** The headers of the two model blocks, as `droid exec --help` prints them. */
const MODEL_BLOCK_HEADERS = ['Available Models:', 'Custom Models:'];

/** The header of the per-model details block. */
const MODEL_DETAILS_HEADER = 'Model details:';

/** One model row: an indented id with no spaces, two or more spaces, then its display name. */
const MODEL_ROW = /^\s+(\S+)\s{2,}(\S.*?)\s*$/;

/** The CLI's marker after its default model's name. */
const DEFAULT_MARKER = /\s*\(default\)\s*$/i;

/** One "Model details:" row: `- <Display Name>: supports reasoning: ...; supported: [<levels>]; ...`. */
const MODEL_DETAIL_ROW = /^\s*-\s+(.+?):\s+supports reasoning:\s*(Yes|No)\b.*?supported:\s*\[([^\]]*)\]/i;

export interface DroidModelList {
  models: string[];
  modelDisplayNames: Record<string, string>;
  /** Each model's reasoning levels, by id, for the models that list any. */
  effortLevelsByModel: Record<string, string[]>;
}

/**
 * Read the model blocks out of `droid exec --help`. A block runs from its
 * header to the first line that is not a model row (a blank line or the next
 * header). Empty when neither block is present.
 */
export function parseDroidExecHelpModels(helpText: string): DroidModelList {
  const models: string[] = [];
  const modelDisplayNames: Record<string, string> = {};
  const levelsByDisplayName = new Map<string, string[]>();
  let block: 'models' | 'details' | null = null;
  for (const line of helpText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (MODEL_BLOCK_HEADERS.includes(trimmed)) {
      block = 'models';
      continue;
    }
    if (trimmed === MODEL_DETAILS_HEADER) {
      block = 'details';
      continue;
    }
    if (block === 'details') {
      const detail = MODEL_DETAIL_ROW.exec(line);
      if (!detail) {
        block = null;
        continue;
      }
      const [, displayName, supportsReasoning, levelList] = detail;
      // A model with no reasoning lists `[none]`; it takes no level at all. A
      // reasoning model's `none` is one of its levels, passed as written.
      const levels = levelList.split(',').map((level) => level.trim()).filter((level) => level.length > 0);
      if (supportsReasoning.toLowerCase() === 'yes' && levels.length > 0) levelsByDisplayName.set(displayName.trim(), levels);
      continue;
    }
    if (block !== 'models') continue;
    const row = MODEL_ROW.exec(line);
    if (!row) {
      block = null;
      continue;
    }
    const [, id, displayName] = row;
    if (modelDisplayNames[id] !== undefined) continue;
    models.push(id);
    modelDisplayNames[id] = displayName.replace(DEFAULT_MARKER, '');
  }
  // The details name a model by its display name, the list by its id. A name
  // two listed models share (a BYOK entry named like a built-in) cannot say
  // whose levels a row holds, so neither takes them and no level is passed.
  const idCountByDisplayName = new Map<string, number>();
  for (const id of models) {
    idCountByDisplayName.set(modelDisplayNames[id], (idCountByDisplayName.get(modelDisplayNames[id]) ?? 0) + 1);
  }
  const effortLevelsByModel: Record<string, string[]> = {};
  for (const id of models) {
    const displayName = modelDisplayNames[id];
    const levels = levelsByDisplayName.get(displayName);
    if (levels && idCountByDisplayName.get(displayName) === 1) effortLevelsByModel[id] = levels;
  }
  return { models, modelDisplayNames, effortLevelsByModel };
}

/**
 * Run `<cliPath> exec --help` and capture stdout. On Windows, through the
 * shell; on Unix, directly. A Droid installed in a WSL distro runs there,
 * through `wsl.exe`.
 */
async function readExecHelpText(cliPath: string, target: CliTarget | null): Promise<string> {
  if (target) {
    const { stdout } = await execCliForTarget(target, ['exec', '--help'], { timeout: HELP_TIMEOUT_MS, maxBuffer: HELP_MAX_BUFFER });
    return stdout;
  }
  if (process.platform === 'win32') {
    const { stdout } = await execAsync(`${quoteCmdExecutable(cliPath)} exec --help`, {
      timeout: HELP_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: HELP_MAX_BUFFER,
    });
    return stdout;
  }
  const { stdout } = await execFileAsync(cliPath, ['exec', '--help'], { timeout: HELP_TIMEOUT_MS, maxBuffer: HELP_MAX_BUFFER });
  return stdout;
}

/** How the help text is read; a test passes its own. */
export type DroidHelpReader = (cliPath: string) => Promise<string>;

const defaultHelpReader: DroidHelpReader = async (cliPath) => readExecHelpText(cliPath, await resolveCliTarget(cliPath, true));

/**
 * One result per CLI path. The model list can change with a Droid update or
 * a new BYOK entry, so `forceRefresh` (a model dropdown opening) reads again.
 */
const capabilityCache = new Map<string, AgentCapabilities>();

/**
 * The read still running per CLI path, so callers that arrive together (an
 * automation check and a summary after startup) share one `droid exec --help`.
 * A forced refresh never joins one: it must read after the request was made.
 */
const pendingReads = new Map<string, Promise<AgentCapabilities>>();

/**
 * Discover Droid's capabilities. Never throws: a help run that fails reports
 * no model list, and the answer pickers fall back to a free-form model input.
 * A failed run is not cached, so the next discovery tries again. Help text
 * with no model blocks is the CLI's own answer, so it is cached like any other
 * until a forced refresh.
 */
export async function discoverDroidCapabilities(
  cliPath: string,
  forceRefresh = false,
  readHelp: DroidHelpReader = defaultHelpReader,
): Promise<AgentCapabilities> {
  if (forceRefresh) return readCapabilities(cliPath, readHelp);
  const cached = capabilityCache.get(cliPath);
  if (cached) return cached;
  const pending = pendingReads.get(cliPath);
  if (pending) return pending;
  const read = readCapabilities(cliPath, readHelp).finally(() => pendingReads.delete(cliPath));
  pendingReads.set(cliPath, read);
  return read;
}

async function readCapabilities(cliPath: string, readHelp: DroidHelpReader): Promise<AgentCapabilities> {
  const capabilities: AgentCapabilities = { supportsModelOverride: false, effortLevels: [] };
  let helpText: string;
  try {
    helpText = await readHelp(cliPath);
  } catch {
    return capabilities;
  }
  const { models, modelDisplayNames, effortLevelsByModel } = parseDroidExecHelpModels(helpText);
  if (models.length > 0) {
    capabilities.models = models;
    capabilities.modelDisplayNames = modelDisplayNames;
  }
  if (Object.keys(effortLevelsByModel).length > 0) capabilities.effortLevelsByModel = effortLevelsByModel;
  capabilityCache.set(cliPath, capabilities);
  return capabilities;
}

/** Forget every cached result (tests). */
export function clearDroidCapabilityCache(): void {
  capabilityCache.clear();
  pendingReads.clear();
}
