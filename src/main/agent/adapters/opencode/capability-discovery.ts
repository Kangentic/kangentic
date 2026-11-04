/**
 * OpenCode capability discovery: the model override flag, read from `--help`,
 * and the models the CLI lists (`opencode models --verbose`, OpenCode 1).
 *
 * No effort levels: OpenCode's reasoning "variants" differ per model and only
 * `run` takes `--variant`; the TUI cycles them with ctrl+t
 * (opencode.ai/docs/models, docs/keybinds), so a flat effort list would offer
 * a TUI column a level it cannot pass.
 */

import { execAsync, execFileAsync } from '../../../utility-process/off-main-exec';
import { execCliForTarget, resolveCliTarget, type CliTarget } from '../../shared/cli-target';
import { quoteCmdExecutable } from '../../../../shared/shell-quote';
import type { AgentCapabilities } from '../../../../shared/types';
import { isOpenCodeV2 } from './version';


const HELP_TIMEOUT_MS = 5000;
/**
 * `opencode models` starts the CLI's provider layer, which loads the models.dev
 * catalog (from its cache, refreshing it in the background) and each connected
 * provider, so it gets more time than `--help`. Bounded, because the agent list
 * (`agent-list.ts`) waits on every adapter's discovery before it answers.
 */
const MODELS_TIMEOUT_MS = 10_000;
const MODELS_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * Run `<cliPath> <args>` and capture stdout.
 * On Windows, use shell invocation; on Unix, use direct execFile. An OpenCode
 * installed in a WSL distro (`target`) runs there, through `wsl.exe`.
 */
async function readCliOutput(cliPath: string, target: CliTarget | null, args: string[], timeout: number, maxBuffer: number): Promise<string> {
  if (target) return (await execCliForTarget(target, args, { timeout, maxBuffer })).stdout;
  if (process.platform === 'win32') {
    const { stdout } = await execAsync(`${quoteCmdExecutable(cliPath)} ${args.join(' ')}`, {
      timeout,
      windowsHide: true,
      maxBuffer,
    });
    return stdout;
  }
  const { stdout } = await execFileAsync(cliPath, args, { timeout, maxBuffer });
  return stdout;
}

function readHelpText(cliPath: string, target: CliTarget | null): Promise<string> {
  return readCliOutput(cliPath, target, ['--help'], HELP_TIMEOUT_MS, 1024 * 1024);
}

/** The models OpenCode lists, with the name the CLI gives each. */
export interface OpenCodeModelInventory {
  /** `provider/model` ids, in the CLI's own order. */
  models: string[];
  /** The CLI's `name` per id, made unique by the provider when two share one. */
  displayNames: Record<string, string>;
}

/** A `provider/model` line: no whitespace, at least one `/`, not JSON. */
const MODEL_ID_LINE = /^[^\s{}"[\]]+\/\S+$/;

/**
 * Parse `opencode models --verbose`. Source: `packages/opencode/src/cli/cmd/models.ts`
 * at v1.18.31 (opencode.ai/docs/cli/#models). The command lists only the
 * providers the user has connected (credentials, config, or a plugin; the
 * `Provider.list()` state in `provider/provider.ts`), one `<providerID>/<modelID>`
 * line per model. `--verbose` follows each line with that model's JSON,
 * pretty-printed with a two-space indent, whose `name` is the label OpenCode's
 * own picker shows. `--refresh` would print a "Models cache refreshed" line
 * first; a line that is neither an id nor JSON is skipped.
 *
 * Checked against a real 1.18.31 run (`tests/fixtures/opencode-models-verbose.txt`):
 * every id line is followed by its block, and every block closes with `}` at
 * column 0, which is the source's `JSON.stringify(model, null, 2)`.
 */
export function parseOpenCodeModels(output: string): OpenCodeModelInventory {
  const lines = output.replace(/\r\n/g, '\n').split('\n');
  const entries: Array<{ id: string; name: string | null }> = [];
  const seenIds = new Set<string>();
  let index = 0;
  while (index < lines.length) {
    const line = lines[index].trim();
    index += 1;
    if (!MODEL_ID_LINE.test(line)) continue;
    let name: string | null = null;
    // A verbose block starts with `{` on the next line and ends with the first
    // `}` back at column 0.
    if (index < lines.length && lines[index].startsWith('{')) {
      const blockStart = index;
      while (index < lines.length && !lines[index].startsWith('}')) index += 1;
      const block = lines.slice(blockStart, index + 1).join('\n');
      index += 1;
      try {
        const parsed = JSON.parse(block) as unknown;
        if (parsed && typeof parsed === 'object' && typeof (parsed as { name?: unknown }).name === 'string') {
          name = ((parsed as { name: string }).name).trim() || null;
        }
      } catch {
        // A block that does not parse leaves the id unnamed.
      }
    }
    if (!seenIds.has(line)) {
      seenIds.add(line);
      entries.push({ id: line, name });
    }
  }

  const nameCounts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.name) nameCounts.set(entry.name, (nameCounts.get(entry.name) ?? 0) + 1);
  }
  const displayNames: Record<string, string> = {};
  for (const entry of entries) {
    if (!entry.name) continue;
    const provider = entry.id.slice(0, entry.id.indexOf('/'));
    displayNames[entry.id] = (nameCounts.get(entry.name) ?? 0) > 1 ? `${entry.name} (${provider})` : entry.name;
  }
  return { models: entries.map((entry) => entry.id), displayNames };
}

/**
 * Ask OpenCode 1 for its models (`opencode models --verbose`). Null when the
 * run fails or lists nothing, which leaves the picker's free-form input. Not
 * asked of OpenCode 2, whose `models` command has not been read.
 */
export async function discoverOpenCodeModels(cliPath: string): Promise<OpenCodeModelInventory | null> {
  try {
    const output = await readCliOutput(cliPath, await resolveCliTarget(cliPath, true), ['models', '--verbose'], MODELS_TIMEOUT_MS, MODELS_MAX_BUFFER);
    const inventory = parseOpenCodeModels(output);
    return inventory.models.length > 0 ? inventory : null;
  } catch {
    return null;
  }
}

/**
 * Discover OpenCode's model override support: OpenCode 1's TUI lists
 * `-m, --model` in its help (1.18.31).
 *
 * OpenCode 2's root help has no `--model` at all: its TUI takes the model
 * from config, and a V2 spawn sets it there (`buildOpenCodeEnv`). So a V2
 * CLI (`cliVersion`) supports the override without reading its help.
 */
export async function discoverOpenCodeCapabilities(cliPath: string, cliVersion?: string | null): Promise<AgentCapabilities> {
  if (isOpenCodeV2(cliVersion)) return { supportsModelOverride: true, effortLevels: [] };
  // Best-effort: try to detect --model flag, but default to false
  let supportsModelOverride = false;
  try {
    const helpText = await readHelpText(cliPath, await resolveCliTarget(cliPath, true));
    supportsModelOverride = /--model\s+<|--model\s+[A-Za-z]|-m\s+<|-m\s+[A-Za-z]/.test(helpText);
  } catch {
    // Help parsing failure - default to false
  }

  return {
    supportsModelOverride,
    // OpenCode has no effort/reasoning levels
    effortLevels: [],
  };
}
