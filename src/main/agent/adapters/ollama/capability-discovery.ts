/**
 * Ollama capability discovery: enumerate locally installed models via
 * `ollama list` so the renderer can populate the model-picker dropdown, and
 * read the thinking levels `ollama run --think` accepts from its own help.
 *
 * `ollama run` always accepts a positional model argument, so model override
 * is always supported. The discovered list is the set of already-pulled
 * models; the user can still type any model name (Ollama auto-pulls on run),
 * which is why the renderer falls back to a free-form text input when the
 * list is empty.
 */
import { execAsync, execFileAsync } from '../../../utility-process/off-main-exec';
import { quoteCmdExecutable } from '../../../../shared/shell-quote';
import { execCliForTarget, resolveCliTarget } from '../../shared/cli-target';
import type { AgentCapabilities } from '../../../../shared/types';


const LIST_TIMEOUT_MS = 5000;
const HELP_TIMEOUT_MS = 5000;

/**
 * Run `<cliPath> <args>` and capture stdout.
 * On Windows, use a shell invocation (handles `.cmd` / `.exe` shims); on
 * Unix, use direct execFile. An Ollama installed in a WSL distro is asked
 * there, so it reports the distro's own install and daemon. The Windows
 * branch joins `args` into a cmd line unquoted, so every arg must be a fixed
 * literal token with no space or shell character (`list`, `run`, `--help`).
 */
async function readCliOutput(cliPath: string, args: string[], timeoutMs: number): Promise<string> {
  const target = await resolveCliTarget(cliPath, true);
  if (target) {
    const { stdout } = await execCliForTarget(target, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 });
    return stdout;
  }
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
 * Parse the thinking levels out of `ollama run --help`.
 *
 * Ollama 0.40.14 registers the flag as
 *   --think string   Enable thinking mode: true/false or high/medium/low for supported models
 * (https://github.com/ollama/ollama/blob/v0.40.14/cmd/cmd.go). The levels are
 * every slash-separated word list on that line except the `true`/`false`
 * switch, in the CLI's own order. A CLI without the flag (before 0.9.0, when
 * thinking shipped) or help that reads differently yields no levels, so the
 * Effort row stays hidden rather than offering a guess. Pure, for unit tests.
 */
export function parseOllamaThinkLevels(helpText: string): string[] {
  // `(?![\w-])` ends the name, so a `--think-...` or `--thinking` flag is not this line.
  const thinkLine = helpText.split('\n').find((line) => /^\s*--think(?![\w-])/.test(line));
  if (!thinkLine) return [];
  const levels: string[] = [];
  for (const group of thinkLine.match(/[a-z]+(?:\/[a-z]+)+/gi) ?? []) {
    for (const word of group.split('/')) {
      const level = word.toLowerCase();
      if (level === 'true' || level === 'false' || levels.includes(level)) continue;
      levels.push(level);
    }
  }
  return levels;
}

/**
 * Parse `ollama list` table output into a sorted list of model names.
 *
 * Output format:
 *   NAME               ID              SIZE      MODIFIED
 *   llama3.2:latest    a80c4f17acd5    2.0 GB    2 days ago
 *   qwen2.5-coder:7b   2b0496514337    4.7 GB    1 week ago
 *
 * Takes the first whitespace-delimited column of each row, skipping the
 * header. Pure and side-effect-free so it can be unit-tested directly.
 */
export function parseOllamaModelList(stdout: string): string[] {
  const models = new Set<string>();
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const firstColumn = trimmed.split(/\s+/)[0];
    // Skip the header row (always emitted as uppercase "NAME") and any stray
    // separator lines. Exact-match so a model literally named "name" is kept.
    if (!firstColumn || firstColumn === 'NAME') continue;
    models.add(firstColumn);
  }
  // Ascending alphabetical, matching the other adapters' model ordering.
  return Array.from(models).sort();
}

export interface OllamaDiscovery {
  capabilities: AgentCapabilities;
  /**
   * The `--think` levels `ollama run --help` named, or null when that read
   * failed. An empty list is an answer (this CLI has no `--think` flag); null
   * is not, so the adapter keeps whatever an earlier read reported.
   */
  thinkLevels: string[] | null;
}

/**
 * Discover Ollama capabilities: model override is always supported, the
 * model list comes from `ollama list`, and the effort levels are the
 * `--think` levels `ollama run --help` names.
 *
 * Best-effort: never throws. A failed `ollama list` (daemon down, CLI
 * missing, unparseable output) leaves no model list, so the renderer falls
 * back to a free-form model text input. A failed `run --help` reports
 * `thinkLevels: null` with empty `effortLevels`, and the adapter offers the
 * levels an earlier read of that CLI reported in their place.
 */
export async function discoverOllama(cliPath: string): Promise<OllamaDiscovery> {
  const [models, thinkLevels] = await Promise.all([
    readCliOutput(cliPath, ['list'], LIST_TIMEOUT_MS).then(parseOllamaModelList, () => [] as string[]),
    // `run --help` is answered by the CLI itself, so it works with the daemon down.
    readCliOutput(cliPath, ['run', '--help'], HELP_TIMEOUT_MS).then(parseOllamaThinkLevels, () => null),
  ]);
  return {
    capabilities: {
      supportsModelOverride: true,
      models: models.length > 0 ? models : undefined,
      effortLevels: thinkLevels ?? [],
    },
    thinkLevels,
  };
}
