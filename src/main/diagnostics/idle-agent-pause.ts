/**
 * Pause idle agents while memory runs low.
 *
 * Task #873 measured about 1.15 GB of Windows commit per running agent, and an
 * agent waiting on the user holds all of it. While the host is low on memory
 * (`memoryHeadroom`), each sampler tick pauses the one agent that has waited
 * on the user longest, through the Pause button's own path, recorded as
 * Kangentic's low-memory pause (`'low_memory'`). Outside a workflow it stays
 * paused until the user resumes it: a restart does not bring it back, and
 * neither does memory recovering. A running workflow's task is the exception
 * (owner's decision, 2026-10-31, revising #873 for workflows only): it comes
 * back by itself once memory recovers, one at a time
 * (`workflow-memory-resume.ts`), since nobody is there overnight to resume it.
 *
 * The decision is pure (`evaluateMemoryRelief`, `isPauseEligible`,
 * `pickAgentToPause`); `createIdleAgentPauser` adds the one-at-a-time flag
 * around the pause itself.
 *
 * The loop starts when headroom drops below the threshold and stops once it
 * climbs past the recovery line (the warning's hysteresis line), one pause per
 * tick, re-reading memory before the next. On macOS it starts at a warn or
 * critical pressure level and stops when the level returns to normal. Nothing
 * stops the session queue or a workflow from filling the slot a pause frees:
 * #873 decided against a memory gate on spawning.
 */

import type { ActivityState, HostMemorySample, SessionStatus } from '../../shared/types';
import { requiresUserInteraction } from '../../shared/activity-state';
import { memoryHeadroom, pressureThreshold, recoveryLine, type MemoryHeadroom } from './host-memory';

/** An agent must have waited on the user this long before low memory pauses it. */
export const MIN_WAIT_BEFORE_PAUSE_MS = 5 * 60_000;

export interface MemoryReliefState {
  /** True from the drop below the threshold until headroom clears the recovery line. */
  active: boolean;
}

export function createMemoryReliefState(): MemoryReliefState {
  return { active: false };
}

/**
 * Whether this tick should pause an agent. Mutates `state`: the latch turns
 * on below the threshold and off past the recovery line, so a reading in
 * between keeps whatever it was. A missing reading changes nothing and pauses
 * nothing.
 */
export function evaluateMemoryRelief(headroom: MemoryHeadroom | null, state: MemoryReliefState): boolean {
  if (headroom === null) return false;
  if (headroom.kind === 'level') {
    state.active = headroom.low;
    return state.active;
  }
  if (headroom.remainingBytes < pressureThreshold(headroom.limitBytes)) {
    state.active = true;
  } else if (headroom.remainingBytes >= recoveryLine(headroom.limitBytes)) {
    state.active = false;
  }
  return state.active;
}

/** What the pause needs to know about one live session. */
export interface IdleAgentFacts {
  sessionId: string;
  taskId: string;
  projectId: string;
  status: SessionStatus;
  /** A Command Terminal: a suspend ends it, so it is never paused. */
  transient: boolean;
  /** A workflow's own agent: its pane has its own pause. */
  workflowId: string | null;
  activity: ActivityState | undefined;
  /** When the agent started waiting on the user (epoch ms), from its activity reason. */
  waitingSince: number | null;
  /** The user has text typed into the agent's prompt. */
  hasDraft: boolean;
  /** The agent's terminal is on screen. */
  focused: boolean;
  /** Keystrokes are queued for the agent (a column command on its way). */
  hasPendingSubmit: boolean;
  /** A column message is waiting to be pasted into the agent. */
  hasPendingDelivery: boolean;
  /**
   * The agent is waiting on work of its own: a background shell it holds, or
   * a subagent still running past its turn end, by the hook events
   * (`SessionManager.getOpenWork`), never by the card's state.
   */
  hasOpenBackgroundWork: boolean;
  /**
   * A workflow step check ruled the agent's work still running, and that wait
   * is still fresh (`isInWorkingWait`, `workflow-recovery-state.ts`).
   */
  inWorkingWait: boolean;
}

/**
 * Whether low memory may pause this agent. Only a task's own agent, live and
 * waiting on the user (idle or at a permission prompt; the pending tool call
 * is not run) for at least `MIN_WAIT_BEFORE_PAUSE_MS`, with nothing typed,
 * nothing on its way to it, and not on screen. Never an agent that is working,
 * and never one that waits on its own work.
 *
 * The last part is the overnight lesson: five of seven pauses hit agents
 * waiting on their own background gate. The card read idle once the engine's
 * display hold let the shell go, the pause killed the CLI and left the gate's
 * process tree running, so it freed little, and the gate's results sat unread
 * for 45 to 110 minutes. One of those agents had been ruled "still working"
 * by its step check eight minutes before.
 */
export function isPauseEligible(facts: IdleAgentFacts, now: number): boolean {
  if (facts.status !== 'running') return false;
  if (facts.transient || facts.workflowId !== null) return false;
  if (!facts.taskId || !facts.projectId) return false;
  if (!requiresUserInteraction(facts.activity)) return false;
  if (facts.waitingSince === null || now - facts.waitingSince < MIN_WAIT_BEFORE_PAUSE_MS) return false;
  if (facts.hasDraft || facts.focused) return false;
  if (facts.hasPendingSubmit || facts.hasPendingDelivery) return false;
  if (facts.hasOpenBackgroundWork || facts.inWorkingWait) return false;
  return true;
}

/** The eligible agent that has waited on the user longest, or null. */
export function pickAgentToPause(candidates: readonly IdleAgentFacts[], now: number): IdleAgentFacts | null {
  let chosen: IdleAgentFacts | null = null;
  for (const candidate of candidates) {
    if (!isPauseEligible(candidate, now)) continue;
    if (chosen === null || (candidate.waitingSince ?? now) < (chosen.waitingSince ?? now)) chosen = candidate;
  }
  return chosen;
}

/** One pause the loop made, for the toast and the Review list. */
export interface IdleAgentPaused {
  facts: IdleAgentFacts;
  pausedAt: number;
  /** How long it had waited on the user when it was paused. */
  waitedMs: number;
}

export interface IdleAgentPauserDeps {
  /** The setting (`agent.pauseIdleAgentsOnLowMemory`), read on every tick. */
  isEnabled: () => boolean;
  /** Every live session's facts, read fresh on every tick that acts. */
  listCandidates: () => IdleAgentFacts[];
  /**
   * Pause the agent, re-checking it under the task lock. Resolves true when it
   * paused, false when the agent no longer qualified or was gone.
   */
  pause: (facts: IdleAgentFacts) => Promise<boolean>;
  onPaused: (paused: IdleAgentPaused) => void;
  now?: () => number;
}

export interface IdleAgentPauser {
  /** The sampler's per-tick hook. */
  onSample: (sample: HostMemorySample) => void;
}

/**
 * The loop around the pure decision. At most one pause runs at a time: a
 * tick that lands while one is still in flight (the PTY shutdown takes about
 * 3 s and can pass 10 s) skips, and the next tick re-reads memory first.
 */
export function createIdleAgentPauser(deps: IdleAgentPauserDeps): IdleAgentPauser {
  const state = createMemoryReliefState();
  const now = deps.now ?? Date.now;
  let pauseInFlight = false;
  return {
    onSample(sample) {
      // The latch follows memory whether or not the setting is on, so turning
      // it on during a low spell acts on the next tick.
      const shouldRelieve = evaluateMemoryRelief(memoryHeadroom(sample), state);
      if (!shouldRelieve || pauseInFlight || !deps.isEnabled()) return;
      const startedAt = now();
      const target = pickAgentToPause(deps.listCandidates(), startedAt);
      if (!target) return;
      pauseInFlight = true;
      deps.pause(target)
        .then((paused) => {
          if (!paused) return;
          const pausedAt = now();
          deps.onPaused({ facts: target, pausedAt, waitedMs: pausedAt - (target.waitingSince ?? pausedAt) });
        })
        .catch((error: unknown) => {
          console.error('[idle-agent-pause] Pause failed:', error);
        })
        .finally(() => {
          pauseInFlight = false;
        });
    },
  };
}
