/**
 * Tells a paired phone's board subscription when a task's spawn-progress
 * label changes, so the phone's card can draw the desktop's preparing footer
 * ("Creating worktree...", "Waiting (2 ahead)", "Switching model...") from
 * `BoardTaskWire.spawn_progress` and re-read it on each change.
 *
 * Bridge-owned, and deliberately NOT fed into `context.boardEvents`. A label
 * change is not a board mutation, and that bus wakes the retrieval worker's
 * task-record sweep and the Agent Monitor push on every event, so a git-queue
 * wait's 5s label refresh would re-sweep task records for nothing. read-board
 * subscribes here alongside the bus instead.
 *
 * Throttled per task here rather than per read-board subscription: a phone
 * re-requests read-board after a board event (a board subscription
 * re-snapshots on every change, see read-board.ts), which replaces the
 * subscription, so a throttle held by the subscription would reset on every
 * emit. A spawn can pass through fetching, creating the worktree, the setup
 * script and starting the agent inside one second, and each emit costs a
 * paired phone a full board snapshot, so an unthrottled feed would send one
 * per phase.
 *
 * Per task: the first change emits at once, later changes inside the window
 * coalesce into one trailing emit, an unchanged label (emitSpawnWaiting
 * re-pushes "Waiting (2 ahead)" every 5s) emits nothing, and the clear always
 * emits.
 */
import { onSpawnProgressChange, SPAWN_PROGRESS_TTL_MS } from '../transition-engine/spawn-progress';

/** Window after an emit during which further changes coalesce into one trailing emit. */
const THROTTLE_MS = 1000;

/**
 * A TTL expiry in getInFlightSpawnProgress() drops a label without a push, so
 * the clear this feed waits for never comes. An entry untouched this long is
 * dropped on the next change, on the same horizon as that TTL.
 */
const STALE_ENTRY_MS = SPAWN_PROGRESS_TTL_MS;

interface TaskThrottleState {
  /** The label the last emit announced. */
  deliveredLabel: string | null;
  /** The newest label pushed. */
  latestLabel: string | null;
  /** Set while a window is open; its expiry delivers whatever arrived inside it. */
  windowTimer: ReturnType<typeof setTimeout> | null;
  touchedAt: number;
  /**
   * The owning project, resolved on the first emit that has a listener and
   * kept until the label clears and this entry goes. A task never changes
   * project under one id (`move_task_to_project` re-creates it under a new
   * one), so the answer cannot go stale, and the project scan runs once per
   * label rather than once per emit.
   */
  projectId: string | null;
}

export type SpawnProgressChangedListener = (projectId: string, taskId: string) => void;

export interface SpawnProgressFeedOptions {
  /** Which project owns a task, or null when none does (deleted, or a project whose database will not open). */
  resolveProjectIdForTask: (taskId: string) => string | null;
}

export class SpawnProgressFeed {
  private readonly resolveProjectIdForTask: (taskId: string) => string | null;
  private readonly states = new Map<string, TaskThrottleState>();
  private readonly listeners = new Set<SpawnProgressChangedListener>();
  private unsubscribe: (() => void) | null = null;
  private disposed = false;

  constructor(options: SpawnProgressFeedOptions) {
    this.resolveProjectIdForTask = options.resolveProjectIdForTask;
  }

  start(): void {
    if (this.unsubscribe || this.disposed) return;
    this.unsubscribe = onSpawnProgressChange((taskId, label) => this.onChange(taskId, label));
  }

  /** Subscribe to throttled label changes. Returns an unsubscribe function. */
  onTaskSpawnProgressChanged(listener: SpawnProgressChangedListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private onChange(taskId: string, label: string | null): void {
    if (this.disposed) return;
    const now = Date.now();
    this.pruneStale(now);
    let state = this.states.get(taskId);
    if (!state) {
      // A clear for a task with no label on record has nothing to retract:
      // abort paths clear unconditionally, label or not.
      if (label === null) return;
      state = { deliveredLabel: null, latestLabel: label, windowTimer: null, touchedAt: now, projectId: null };
      this.states.set(taskId, state);
    }
    state.latestLabel = label;
    state.touchedAt = now;
    if (state.windowTimer) return; // the window's trailing edge delivers it
    this.deliver(taskId, state);
  }

  private deliver(taskId: string, state: TaskThrottleState): void {
    if (state.latestLabel === state.deliveredLabel) return;
    state.deliveredLabel = state.latestLabel;
    this.emit(taskId, state);
    if (state.latestLabel === null) {
      this.states.delete(taskId);
      return;
    }
    const windowTimer = setTimeout(() => {
      state.windowTimer = null;
      if (this.disposed) return;
      this.deliver(taskId, state);
    }, THROTTLE_MS);
    windowTimer.unref?.();
    state.windowTimer = windowTimer;
  }

  private emit(taskId: string, state: TaskThrottleState): void {
    // No phone is watching a board: skip the project scan entirely.
    if (this.listeners.size === 0) return;
    let projectId = state.projectId;
    if (projectId === null) {
      // This runs inside spawn-progress's push, on the spawn path itself, so
      // nothing here may throw back into it.
      try {
        projectId = this.resolveProjectIdForTask(taskId);
      } catch (error) {
        console.warn('[mobile-bridge] could not resolve the project for a spawn-progress change:', error);
        return;
      }
      // A miss is not kept: the next emit asks again.
      if (!projectId) return;
      state.projectId = projectId;
    }
    for (const listener of this.listeners) {
      try {
        listener(projectId, taskId);
      } catch (error) {
        console.warn('[mobile-bridge] spawn-progress listener failed:', error);
      }
    }
  }

  private pruneStale(now: number): void {
    for (const [taskId, state] of this.states) {
      if (!state.windowTimer && now - state.touchedAt > STALE_ENTRY_MS) this.states.delete(taskId);
    }
  }

  /** Synchronous, per synchronous-shutdown.md: detaches from spawn-progress and clears every pending window. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const state of this.states.values()) {
      if (state.windowTimer) clearTimeout(state.windowTimer);
    }
    this.states.clear();
    this.listeners.clear();
  }
}
