/**
 * Derive a human-friendly Claude model name from a spawned command's `--model`
 * flag, so a board card can show the model IMMEDIATELY (before status.json
 * reports the agent's own). This is a placeholder that the agent's live
 * telemetry overrides, so a later in-session `/model` change stays accurate.
 *
 * All Claude-command-syntax and model-naming knowledge lives here (and is
 * surfaced via the adapter's `configuredModelFromCommand`), keeping it out of
 * the shared spawn/renderer code.
 */

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
 * Humanize a Claude model id, matching Anthropic's scheme
 * (`claude-<name>-<major>-<minor>` <-> "<Name> <major>.<minor>").
 * e.g. `claude-opus-4-8` -> "Opus 4.8", `claude-fable-5` -> "Fable 5",
 * `opus` -> "Opus". Best-effort: the exact name comes from the agent's own
 * status.json later. Returns null when nothing meaningful can be derived.
 */
export function humanizeClaudeModelId(modelId: string): string | null {
  const trimmed = modelId.trim();
  if (!trimmed) return null;

  // A bracketed suffix (e.g. `[1m]`) marks a context-window variant.
  const bracketMatch = trimmed.match(/\[([^\]]+)\]/);
  const base = trimmed.replace(/\[[^\]]*\]/, '');
  const segments = base.replace(/^claude-/i, '').split('-').filter(Boolean);
  if (segments.length === 0) return null;

  const nameParts: string[] = [];
  const versionParts: string[] = [];
  for (const segment of segments) {
    if (/^\d+$/.test(segment)) {
      // Numeric segment: a version component, unless it is a date stamp
      // (>= 6 digits, e.g. 20251001), which we drop.
      if (segment.length < 6) versionParts.push(segment);
    } else {
      nameParts.push(segment.charAt(0).toUpperCase() + segment.slice(1));
    }
  }

  const label = [nameParts.join(' '), versionParts.join('.')].filter(Boolean).join(' ');
  if (!label) return null;
  return bracketMatch ? `${label} (${bracketMatch[1].toUpperCase()})` : label;
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
