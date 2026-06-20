/**
 * Returns true if `value` plausibly identifies one specific bg shell.
 * Constraints: non-empty string, ≤64 chars, only word chars / hyphens.
 *
 * Used to decide whether `background_shell_start` should track this
 * shell by identity (named set) or anonymously (count). Without this
 * gate, the Claude PreToolUse directive's `command` fallback for
 * `tool_input.shell_id` would feed command strings into the named
 * set - distinct commands accumulating forever, identical commands
 * colliding onto the same key. Anonymous tracking is correct in both
 * cases until empirical capture confirms what real shell_id values
 * look like.
 */
export function looksLikeShellId(value: string | undefined): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > 64) return false;
  return /^[\w-]+$/.test(value);
}
