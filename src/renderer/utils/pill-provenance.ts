/**
 * Where a context-bar model/effort value came from.
 *
 * The ContextBar resolves each pill through a fallback chain (live telemetry ->
 * task override -> column override -> project default) so the pill stays
 * populated even when the agent reports nothing. That chain is correct and must
 * stay. What was missing is any notion of LIVENESS: it could not distinguish
 * "the agent reports high" from "the agent reports nothing, so here is what you
 * configured", and rendered both identically.
 *
 * That is not a hypothetical. Claude Code builds its status payload's effort
 * field as `supportsEffort(model) ? { level } : undefined`, and support is per
 * MODEL rather than per family (`claude-haiku-4-5` and `claude-sonnet-4-5` have
 * no effort; `claude-opus-4-8` does), so on Haiku the key is absent from every
 * status write. Switching a task to Haiku left the pill showing a stale
 * configured `high` with full confidence.
 *
 * A model with no effort levels now hides its pill outright, so these resolvers
 * carry the remaining case: the window before the first snapshot, where the
 * configured value is the best answer available but is not yet confirmed.
 *
 * These resolvers return the value AND its provenance so the render site can
 * show the difference. Extracted from the component so the derivation is
 * unit-testable without a browser.
 */

export interface PillProvenance {
  /** Value to display, or null when there is nothing to show at all. */
  value: string | null;
  /** True only when `value` came from the agent's own live telemetry. */
  isLive: boolean;
}

/**
 * Effort provenance.
 *
 * A non-null `liveEffort` is definitive: Claude's status parser is the only
 * producer of `SessionUsage.model.effort`, and Claude Code documents the field
 * as the level in force "after any silent downgrade for the selected model", so
 * it is what the session is actually running at, not what was requested.
 */
export function resolveEffortDisplay(input: {
  liveEffort: string | null;
  taskEffortOverride: string | null;
  swimlaneEffortOverride: string | null;
  projectDefaultEffort: string | null;
}): PillProvenance {
  if (input.liveEffort != null) return { value: input.liveEffort, isLive: true };
  return {
    value: input.taskEffortOverride ?? input.swimlaneEffortOverride ?? input.projectDefaultEffort,
    isLive: false,
  };
}

/**
 * Model provenance.
 *
 * `liveModelName` being non-null is NOT sufficient here, which is why this takes
 * `telemetryLanded` and effort does not. A spawn seeds the model display name
 * from the `--model` flag so a never-yet-reported session still shows its model
 * instead of a spinner (`session-spawn-flow.ts`). That seeded name is the best
 * label available and stays the displayed value, but it is a configured value,
 * not a confirmed one, until a status snapshot arrives.
 *
 * When no live name exists the caller gets a raw override id back and should
 * humanize it (`modelRowLabel`); a live name is already human-readable. Note
 * that `isLive` is NOT the discriminator for that decision: a spawn-seeded name
 * is `isLive: false` yet already humanized, so humanizing on `!isLive` would
 * re-format an agent-shaped label. The discriminator is whether `liveModelName`
 * was non-null, i.e. which branch below produced the value.
 */
export function resolveModelDisplay(input: {
  liveModelName: string | null;
  telemetryLanded: boolean;
  taskModelOverride: string | null;
  swimlaneModelOverride: string | null;
  projectDefaultModel: string | null;
}): PillProvenance {
  if (input.liveModelName != null) {
    return { value: input.liveModelName, isLive: input.telemetryLanded };
  }
  return {
    value: input.taskModelOverride || input.swimlaneModelOverride || input.projectDefaultModel,
    isLive: false,
  };
}
