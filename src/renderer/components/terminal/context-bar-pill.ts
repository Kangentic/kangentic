/**
 * Shared pill styling for the context bar and its pre-spawn sibling.
 *
 * Two variants, because the bar shows two different KINDS of value and used to
 * render them identically:
 *
 * - `pill` - a value confirmed by the agent's own live telemetry.
 * - `provisionalPill` - a value we configured but the agent has not confirmed.
 *
 * The distinction is not cosmetic. Claude Code omits `effort` from its status
 * payload for models that have no effort levels, so the ContextBar's fallback
 * chain would render a stored override with exactly the same weight as live
 * telemetry: a confident, wrong value with no way to tell the difference.
 *
 * Both variants carry a border at all times, transparent on the confirmed one.
 * A pill flipping provisional -> confirmed when a status update lands therefore
 * only repaints; its box never changes size and no neighbouring pill shifts.
 * Keep that property if you touch these strings.
 */

/** A value confirmed by agent telemetry. */
export const pill = 'px-2 py-0.5 rounded border border-transparent bg-surface-raised whitespace-nowrap select-none';

/** A configured value the agent has not confirmed. Reached via `pillForProvenance`. */
const provisionalPill = 'px-2 py-0.5 rounded border border-dashed border-edge bg-transparent whitespace-nowrap select-none';

/** Pick the variant for a pill whose value may or may not be agent-confirmed. */
export function pillForProvenance(isLive: boolean): string {
  return isLive ? pill : provisionalPill;
}
