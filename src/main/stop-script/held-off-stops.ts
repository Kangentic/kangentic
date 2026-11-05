/**
 * Stops a connected client held off, tried again later.
 *
 * In memory, and empty is the normal state: then a tick returns on its first line
 * and nothing polls. Only a task that has something running and a client on it is
 * ever in here, and each check drops a task the moment it stops, resumes, moves
 * or has nothing left. The tick is the host memory sampler's existing 60 s one,
 * so this adds no timer, and a recheck costs one scan (about 45 ms) and one
 * connection read (about 3 ms) per held-off task every five minutes.
 *
 * A restart forgets the set. That is a miss and no harm: the task's terminal reap
 * still comes.
 */

import type { ParkedStopResult, ParkedStopTarget } from './parked-stop';

/** Sampler ticks between checks: about five minutes. */
export const HELD_OFF_RECHECK_TICKS = 5;

/** The results that leave a task waiting: still connected, or the host could not tell. */
function staysHeldOff(result: ParkedStopResult): boolean {
  return result === 'held-off' || result === 'unknown' || result === 'already-running';
}

export class HeldOffStops {
  private readonly targets = new Map<string, ParkedStopTarget>();
  private ticks = 0;
  private checking = false;

  get size(): number {
    return this.targets.size;
  }

  add(target: ParkedStopTarget): void {
    this.targets.set(target.taskId, target);
  }

  clear(): void {
    this.targets.clear();
    this.ticks = 0;
  }

  /** One sampler tick. `attempt` is one try at one task; it must not throw. */
  onTick(attempt: (target: ParkedStopTarget) => Promise<ParkedStopResult>): void {
    if (this.targets.size === 0) {
      this.ticks = 0;
      return;
    }
    this.ticks += 1;
    if (this.ticks < HELD_OFF_RECHECK_TICKS || this.checking) return;
    this.ticks = 0;
    this.checking = true;
    void this.checkAll(attempt).finally(() => {
      this.checking = false;
    });
  }

  private async checkAll(attempt: (target: ParkedStopTarget) => Promise<ParkedStopResult>): Promise<void> {
    for (const [taskId, target] of [...this.targets]) {
      const result = await attempt(target).catch((error: unknown): ParkedStopResult => {
        console.warn(`[STOP-SCRIPT] recheck failed for task ${taskId.slice(0, 8)} (non-fatal):`, error);
        return 'unknown';
      });
      if (!staysHeldOff(result)) this.targets.delete(taskId);
    }
  }
}
