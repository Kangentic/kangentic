/**
 * Main-process mirror of the renderer's spawn-stall toast timer
 * (src/renderer/App.tsx's `spawnStallTimers`): a task sitting in a
 * "preparing" spawn-progress state (worktree creation / git fetch / queue
 * wait) past the threshold triggers a callback, here wired to the
 * spawn-stalled push category. Unlike the toast, this must survive with
 * no renderer/window present, so it watches spawn-progress.ts's
 * module-level map directly via onSpawnProgressTransition rather than
 * useSessionStore.
 *
 * Arms an 8s timer when a task newly enters the in-flight map. Does NOT
 * re-arm on a label change (waiting -> fetching, etc.) - the threshold
 * measures total continuous preparing time, not time-in-current-phase,
 * matching the renderer's own rule. Disarms when the task leaves the map
 * (spawn finished, aborted, or moved).
 */
import { onSpawnProgressTransition } from '../../transition-engine/spawn-progress';

const STALL_THRESHOLD_MS = 8000;

export interface SpawnStallWatcherOptions {
  onStall: (taskId: string) => void;
}

export class SpawnStallWatcher {
  private readonly options: SpawnStallWatcherOptions;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private unsubscribe: (() => void) | null = null;
  private disposed = false;

  constructor(options: SpawnStallWatcherOptions) {
    this.options = options;
  }

  start(): void {
    if (this.unsubscribe || this.disposed) return;
    this.unsubscribe = onSpawnProgressTransition((taskId, active) => {
      if (active) {
        if (this.timers.has(taskId)) return;
        const timer = setTimeout(() => {
          this.timers.delete(taskId);
          this.options.onStall(taskId);
        }, STALL_THRESHOLD_MS);
        timer.unref?.();
        this.timers.set(taskId, timer);
      } else {
        const timer = this.timers.get(taskId);
        if (!timer) return;
        clearTimeout(timer);
        this.timers.delete(taskId);
      }
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
