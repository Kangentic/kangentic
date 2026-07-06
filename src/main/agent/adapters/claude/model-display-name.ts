/**
 * Derive a human-friendly Claude model name from a spawned command's `--model`
 * flag, so a board card can show the model IMMEDIATELY (before status.json
 * reports the agent's own). This is a placeholder that the agent's live
 * telemetry overrides, so a later in-session `/model` change stays accurate.
 *
 * Claude-command-syntax parsing lives here (and is surfaced via the adapter's
 * `configuredModelFromCommand`), keeping it out of the shared spawn/renderer
 * code. Model-name humanizing delegates to the shared `humanizeModelId`.
 */

import { humanizeModelId } from '../../../../shared/model-id';

/**
 * Extract the raw `--model` value from a built Claude command string. `quoteArg`
 * leaves shell-safe ids (letters/digits/`._:-`) unquoted, but a bracketed
 * variant like `claude-opus-4-8[1m]` gets quoted, so accept both forms.
 *
 * Only the flag region is searched, never the prompt: the command builder always
 * emits an end-of-options `--` marker before the quoted prompt, so a literal
 * `--model` inside the task text (e.g. a task titled "fix the --model parser")
 * cannot be mistaken for a real flag when no `--model` was actually passed.
 */
export function parseModelFromClaudeCommand(command: string): string | null {
  const endOfOptions = command.search(/\s--\s/);
  const flagRegion = endOfOptions === -1 ? command : command.slice(0, endOfOptions);
  const match = flagRegion.match(/--model\s+(?:"([^"]+)"|'([^']+)'|(\S+))/);
  if (!match) return null;
  const value = (match[1] ?? match[2] ?? match[3] ?? '').trim();
  return value.length > 0 ? value : null;
}

/**
 * Humanize a Claude model id (best-effort; the exact name comes from the agent's
 * own status.json later). Delegates to the shared `humanizeModelId` so model-name
 * display formatting has a single source (also used by the conversation viewer).
 */
export function humanizeClaudeModelId(modelId: string): string | null {
  return humanizeModelId(modelId);
}

/**
 * Parse a built Claude command and humanize its `--model` value into an
 * `{ id, displayName }` pair for eager card display, or null when the command
 * encodes no explicit model (the agent then uses its own default).
 */
export function configuredModelFromClaudeCommand(
  command: string,
): { id: string; displayName: string } | null {
  const id = parseModelFromClaudeCommand(command);
  if (!id) return null;
  const displayName = humanizeClaudeModelId(id);
  return displayName ? { id, displayName } : null;
}

/**
 * Build the `AgentCapabilities.modelDisplayNames` map for a discovered model
 * list: humanize each id, dropping any id that produces no meaningful label
 * (the renderer falls back to the raw id for those).
 */
export function buildModelDisplayNames(models: string[]): Record<string, string> {
  const displayNames: Record<string, string> = {};
  for (const id of models) {
    const displayName = humanizeClaudeModelId(id);
    if (displayName) displayNames[id] = displayName;
  }
  return displayNames;
}
