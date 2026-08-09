import type { SessionEngineState } from './shapes';

/**
 * Construct a fresh per-session state for the activity engine. All
 * counters start at zero, activity starts as `'idle'`, and the
 * pending-tool stack is empty.
 */
export function createSessionEngineState(): SessionEngineState {
  return {
    activity: 'idle',
    turnActive: false,
    pendingToolCount: 0,
    subagentDepth: 0,
    activeBackgroundShellIds: new Set<string>(),
    anonymousBackgroundShellCount: 0,
    exemptBackgroundShellIds: new Set<string>(),
    pendingExemptShellToolIds: new Set<string>(),
    permissionPending: false,
    permissionAwaitedToolId: null,
    lastSignalAt: null,
    lastPtyOutputAt: null,
    currentTool: null,
    pendingToolStack: [],
    idleTimestamp: null,
    needsUserSince: null,
    idleAuthoritative: false,
    turnForcedByHeartbeat: false,
    pendingIdleAt: null,
    bgShellHoldSince: null,
    idleHintPending: false,
    retryFailurePending: false,
    recentTransitions: [],
    compensationCounters: {
      staleThinking: 0,
      bgShellHatch: 0,
      stuckPendingTools: 0,
      forceThinking: 0,
      forceIdle: 0,
      unmatchedBgShellEnd: 0,
      ignoredInnerSubagentStop: 0,
      stuckSubagent: 0,
    },
    recentPtyChunks: [],
  };
}
