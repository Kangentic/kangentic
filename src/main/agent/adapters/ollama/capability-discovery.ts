/**
 * Ollama capability discovery: enumerate locally installed models via
 * `ollama list` so the renderer can populate the model-picker dropdown.
 *
 * `ollama run` always accepts a positional model argument, so model override
 * is always supported. The discovered list is the set of already-pulled
 * models; the user can still type any model name (Ollama auto-pulls on run),
 * which is why the renderer falls back to a free-form text input when the
 * list is empty.
 */
import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentCapabilities } from '../../../../shared/types';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const LIST_TIMEOUT_MS = 5000;

/**
 * Run `<cliPath> list` and capture stdout.
 * On Windows, use a shell invocation (handles `.cmd` / `.exe` shims); on
 * Unix, use direct execFile.
 */
async function readModelListOutput(cliPath: string): Promise<string> {
  if (process.platform === 'win32') {
    const { stdout } = await execAsync(`"${cliPath}" list`, {
      timeout: LIST_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  }
  const { stdout } = await execFileAsync(cliPath, ['list'], {
    timeout: LIST_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
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

/**
 * Discover Ollama capabilities: model override is always supported, and the
 * model list comes from `ollama list`.
 *
 * Best-effort: never throws. On any failure (daemon down, CLI missing,
 * unparseable output) it returns `{ supportsModelOverride: true }` with no
 * model list, so the renderer falls back to a free-form model text input.
 */
export async function discoverOllamaCapabilities(cliPath: string): Promise<AgentCapabilities> {
  let models: string[] = [];
  try {
    models = parseOllamaModelList(await readModelListOutput(cliPath));
  } catch {
    // `ollama list` failed - fall back to free-form model input.
  }
  return {
    supportsModelOverride: true,
    models: models.length > 0 ? models : undefined,
    // Ollama has no effort / reasoning levels.
    effortLevels: [],
  };
}
