import type { WorkflowStepVerdict } from './workflow-step';
import type { WorkflowBlocker } from './workflow-step-condition';

/**
 * The workflow tasks under recovery right now (`workflow-recovery.ts`), kept
 * apart from the recovery itself so the move path, the idle sweep and a
 * workflow's Pause can ask and cancel it without importing the turn-end runner,
 * the step check or the move path. No imports but a type.
 *
 * The run log is the record (attempt counts, the stall notice): an entry only
 * caches it, with the one timer and the newest verdict, and goes when recovery
 * stops. A restart loses the entries and rebuilds them from the run log.
 */

/**
 * How long a turn that left its own work running is left alone: nearly twice
 * the longest such wait seen ending by itself (37 minutes). Here, not in the
 * recovery, so the low-memory pause can read a wait's age without importing it.
 */
export const WORKING_WAIT_MS = 60 * 60_000;

/** The newest verdict a recovery acted on, and the turn it judged. */
export interface RecoveryVerdict {
  workSerial: number;
  verdict: WorkflowStepVerdict;
  reason: string | null;
  /** What the reply says the agent is stuck on, for the nudge to aim at. */
  blockers: WorkflowBlocker[];
}

export interface RecoveryEntry {
  projectId: string;
  taskId: string;
  workflowId: string;
  columnId: string;
  sessionId: string;
  /** The next attempt's place on the schedule. Past its end, the hourly cadence. */
  attemptIndex: number;
  /** Nudges whose turn ran, this recovery: at most `MAX_COUNTED_NUDGES`. */
  countedNudges: number;
  /** Of those, the ones since the stall notice: a notice goes out again only after one ran. */
  countedSinceNotice: number;
  /** The stall notice has gone out (its run-log row is the latch). */
  noticeSent: boolean;
  /** When this recovery began (epoch ms), for its 24-hour bound. */
  startedAt: number;
  /** A `'working'` verdict's one long wait is what is armed, not the schedule. */
  workingWait: boolean;
  /** When that wait was armed (epoch ms), or null. */
  workingWaitSince: number | null;
  /** When a held attempt is spent, if one is held off. */
  holdUntil: number | null;
  verdict: RecoveryVerdict | null;
  /** A nudge whose turn has not ended yet, and its run-log row. */
  pendingNudge: { rowId: string } | null;
  /** The session's latest turn end was the turn a nudge started. */
  lastTurnFromNudge: boolean;
  /**
   * When Kangentic last started this agent again itself after a quit, a crash
   * or a pty host loss (epoch ms), until a nudge has said so: its background
   * commands died with the old process.
   */
  restartedAt: number | null;
  /** A nudge held for low memory has said so in the run log this low spell. */
  memoryHoldNoted: boolean;
  /** Siblings whose PR landed before this time (epoch ms) were already named in a nudge. */
  siblingsToldThrough: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** An attempt is running now. */
  inFlight: boolean;
}

const entries = new Map<string, RecoveryEntry>();

/** Told when a task's recovery stops, so the gate it waits in lets it go. */
let forgetListener: ((taskId: string) => void) | null = null;

/** Set by the recovery: drop a stopped recovery's place in the memory gate. */
export function setRecoveryForgetListener(listener: ((taskId: string) => void) | null): void {
  forgetListener = listener;
}

export function getRecoveryEntry(taskId: string): RecoveryEntry | undefined {
  return entries.get(taskId);
}

export function setRecoveryEntry(entry: RecoveryEntry): void {
  entries.set(entry.taskId, entry);
}

export function recoveryEntryForSession(sessionId: string): RecoveryEntry | undefined {
  for (const entry of entries.values()) {
    if (entry.sessionId === sessionId) return entry;
  }
  return undefined;
}

/**
 * Is this task's agent waiting on a recovery timer, or in an attempt? The idle
 * sweep leaves such an agent alone: it waits on a timer, not on the user.
 */
export function isUnderWorkflowRecovery(taskId: string): boolean {
  const entry = entries.get(taskId);
  return entry !== undefined && (entry.timer !== null || entry.inFlight);
}

/**
 * Is this task's agent in a fresh "still working" wait: the step check found
 * work of its own still running (`'working'`), and that wait has not run out?
 * The low-memory pause leaves such an agent alone (`isPauseEligible`).
 */
export function isInWorkingWait(taskId: string, now: number = Date.now()): boolean {
  const entry = entries.get(taskId);
  if (!entry || !entry.workingWait || entry.workingWaitSince === null) return false;
  return now - entry.workingWaitSince < WORKING_WAIT_MS;
}

/** Stop a task's recovery: it moved, its workflow paused or ended, or recovery is done. */
export function forgetWorkflowRecovery(taskId: string): void {
  const entry = entries.get(taskId);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = null;
  entries.delete(taskId);
  forgetListener?.(taskId);
}

/** Stop every recovery of a workflow: it was paused or deleted. */
export function cancelWorkflowRecovery(workflowId: string): void {
  for (const entry of [...entries.values()]) {
    if (entry.workflowId === workflowId) forgetWorkflowRecovery(entry.taskId);
  }
}

/** Test-only: forget every recovery. */
export function resetWorkflowRecoveryForTests(): void {
  for (const entry of entries.values()) {
    if (entry.timer) clearTimeout(entry.timer);
  }
  entries.clear();
}
