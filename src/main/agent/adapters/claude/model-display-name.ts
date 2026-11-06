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

import { humanizeModelId, resolveModelSelector, resolveSpacedModelName } from '../../../../shared/model-id';
import type { AgentCapabilities, ModelAliasOption } from '../../../../shared/types';

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

/** A model id: what `--model` takes. A provider's use `[`, `@`, `/` and uppercase. */
export const CLAUDE_MODEL_ID_PATTERN = /^\S{1,256}$/u;
/** A floating alias: a bare lowercase word, with or without `[1m]`. The group is the word. */
export const CLAUDE_ALIAS_ID_PATTERN = /^([a-z]+)(?:\[1m\])?$/u;

/** A `claude-...` core: at the id's start, or after the `.`, `/` or `:` a provider wraps it with. */
const CLAUDE_CORE_PATTERN = /(?:^|[./:])(claude-.*)$/u;
/** A provider's revision tail on a Claude id (`-v1`, `-v1:0`), before any `[1m]`. */
const PROVIDER_REVISION_TAIL_PATTERN = /-v\d+(?::\d+)?(?=\[|$)/u;
/** Vertex's date tail on a Claude id (`@20251001`), before any `[1m]`. */
const PROVIDER_DATE_TAIL_PATTERN = /@\d{8}(?=\[|$)/u;

/**
 * The `claude-...` an id wraps, or null for an id with no such core. A gateway's
 * own model can hold the word mid-name (`team-claude-proxy-v2`), which is no core.
 */
export function claudeCoreOf(modelId: string): string | null {
  return CLAUDE_CORE_PATTERN.exec(modelId)?.[1] ?? null;
}

/**
 * Humanize a Claude model id (best-effort; the exact name comes from the agent's
 * own status.json later). Delegates to the shared `humanizeModelId` so model-name
 * display formatting has a single source (also used by the conversation viewer).
 *
 * A provider wraps the id (`us.anthropic.claude-opus-4-1-20250805-v1:0`,
 * `claude-haiku-4-5@20251001`), so only its `claude-...` core is humanized,
 * which also labels ids learned from such a provider's transcripts.
 */
export function humanizeClaudeModelId(modelId: string): string | null {
  const core = claudeCoreOf(modelId);
  if (core === null) return humanizeModelId(modelId);
  return humanizeModelId(core.replace(PROVIDER_REVISION_TAIL_PATTERN, '').replace(PROVIDER_DATE_TAIL_PATTERN, ''));
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
 * (the renderer falls back to the raw id for those). `cliNames` holds the CLI's
 * own name for an id with no `claude-` core (a custom option, an ARN), which
 * humanizing cannot derive.
 */
export function buildModelDisplayNames(models: string[], cliNames: Record<string, string> = {}): Record<string, string> {
  const displayNames: Record<string, string> = {};
  for (const id of models) {
    const displayName = Object.hasOwn(cliNames, id) ? cliNames[id] : humanizeClaudeModelId(id);
    if (displayName) displayNames[id] = displayName;
  }
  return displayNames;
}

/**
 * The value to hand Claude for a stored model. Stored values keep what was
 * written, so a model the app displays ("Opus 5.5", "Sonnet (1M)") is
 * converted to Claude's spelling here. A name with a space can never be a raw
 * id, so it always converts. A single capitalized word ("Opus") converts only
 * when its lowercase form is an alias Claude's own model list reported
 * (`knownAliasIds`); anything else ("Workhorse", a gateway's own model name)
 * passes through exactly as written, never guessed at.
 */
export function toClaudeModelArgument(model: string, knownAliasIds: ReadonlySet<string>): string {
  const written = model.trim();
  if (/\s/.test(written)) return resolveSpacedModelName(written);
  const converted = resolveModelSelector(written);
  return knownAliasIds.has(converted) ? converted : written;
}

/**
 * The model-related `AgentCapabilities` fields for one discovery pass: the ids,
 * display names covering both the ids and the alias ids (an alias shows as its
 * bare family name, `opus` -> "Opus"), and the aliases themselves when there
 * are any. Shared by the adapter's cached path and `discoverClaudeCapabilities`.
 */
export function buildModelCapabilityFields(
  models: string[],
  aliases: ModelAliasOption[],
  cliNames?: Record<string, string>,
): Pick<AgentCapabilities, 'models' | 'modelDisplayNames' | 'modelAliases'> {
  const aliasIds = aliases.map((alias) => alias.id);
  return {
    models,
    modelDisplayNames: buildModelDisplayNames([...models, ...aliasIds], cliNames),
    ...(aliases.length > 0 ? { modelAliases: aliases } : {}),
  };
}
