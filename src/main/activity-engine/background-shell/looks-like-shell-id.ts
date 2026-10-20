import { SHELL_ID_PATTERN_SOURCE } from '../../../shared/background-command-spec';

const SHELL_ID_PATTERN = new RegExp(SHELL_ID_PATTERN_SOURCE);

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
  return typeof value === 'string' && SHELL_ID_PATTERN.test(value);
}
