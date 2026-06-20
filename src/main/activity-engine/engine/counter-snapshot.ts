import type { CountersSnapshot, SessionEngineState } from './shapes';

/**
 * Capture the predicate-relevant counters / flags from `state` so the
 * audit log can describe what actually changed across a mutation.
 */
export function snapshotCounters(state: SessionEngineState): CountersSnapshot {
  return {
    pendingToolCount: state.pendingToolCount,
    subagentDepth: state.subagentDepth,
    bgShells: state.activeBackgroundShellIds.size + state.anonymousBackgroundShellCount,
    turnActive: state.turnActive,
    permissionPending: state.permissionPending,
  };
}

/**
 * Render a plain-text summary of which counters/flags changed between
 * two snapshots. Returns undefined when nothing observable shifted.
 * Format: "tools +1", "bg -1, turn no", "perm yes". Booleans render
 * as the new value (yes/no); numeric counters render as signed delta.
 */
export function formatCounterDelta(before: CountersSnapshot, after: CountersSnapshot): string | undefined {
  const parts: string[] = [];
  if (after.pendingToolCount !== before.pendingToolCount) {
    const delta = after.pendingToolCount - before.pendingToolCount;
    parts.push(`tools ${delta > 0 ? '+' : ''}${delta}`);
  }
  if (after.subagentDepth !== before.subagentDepth) {
    const delta = after.subagentDepth - before.subagentDepth;
    parts.push(`subagent ${delta > 0 ? '+' : ''}${delta}`);
  }
  if (after.bgShells !== before.bgShells) {
    const delta = after.bgShells - before.bgShells;
    parts.push(`bg ${delta > 0 ? '+' : ''}${delta}`);
  }
  if (after.turnActive !== before.turnActive) {
    parts.push(`turn ${after.turnActive ? 'yes' : 'no'}`);
  }
  if (after.permissionPending !== before.permissionPending) {
    parts.push(`perm ${after.permissionPending ? 'yes' : 'no'}`);
  }
  return parts.length === 0 ? undefined : parts.join(', ');
}
