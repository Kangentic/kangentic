import type { HostMemorySample } from '../../shared/types';
import { memoryHeadroom } from '../diagnostics/host-memory';
import { createMemoryReliefState, evaluateMemoryRelief } from '../diagnostics/idle-agent-pause';

/**
 * One queue for the load a running workflow starts by itself: a recovery
 * nudge (which usually reruns a gate) and a memory resume (an agent's 1.15 GB
 * coming back). Each waits its turn here, so they come one at a time, and none
 * goes while memory reads low.
 *
 * Measured overnight: Claude Code's memory reaper stopped gates around 02:20 and
 * told the agents not to start them again on their own; the step check's
 * nudge then told them to run the gate without asking, and one reran at 3.7 GB
 * free and was killed again. Three nudges at 04:37, sent within four seconds
 * while memory still read fine, started three gates at once, and all three
 * failed on load. So the pacing holds always, not only while memory reads low
 * (owner's decision, 2026-10-31):
 *
 * - **Nothing while memory reads low.** The latch is the low-memory pause's
 *   own (`evaluateMemoryRelief`): on below the threshold, off once headroom
 *   clears the recovery line. A reading older than `SAMPLE_STALE_MS`, or none,
 *   is not low: a sampler that stopped never holds the workflow.
 * - **One at a time.** An item released holds the queue until its turn is
 *   under way (its session went thinking, `noteThinking`), it typed nothing
 *   (`release`), or `TURN_WAIT_MS` passed.
 * - **Paced.** At most one release every `PACE_MS`, about one sampler tick, so
 *   the next one reads memory with the last one's load on it.
 * - **In order.** First asked, first released. A key nobody has asked for again
 *   within `ABANDONED_AFTER_MS` is dropped, so a holder that went away never
 *   blocks the queue.
 *
 * The gate never acts on its own: a holder asks (`tryAcquire`) when it is
 * ready, and asks again on its own timer when told to wait.
 */

/** At most one release this often: about one memory sampler tick. */
export const PACE_MS = 60_000;
/** How long a released item may hold the queue before its turn is under way. */
export const TURN_WAIT_MS = 3 * 60_000;
/** A memory reading older than this is not trusted to hold anything. */
const SAMPLE_STALE_MS = 3 * 60_000;
/** A waiting key not asked for again within this long is dropped. */
const ABANDONED_AFTER_MS = 3 * 60_000;

export type GateDecision =
  | { go: true }
  | { go: false; why: 'memory-low' | 'queued' };

/** What the gate reads of memory now. `freeBytes` is null where the platform reports a level, not bytes (macOS). */
export interface GateMemoryReading {
  low: boolean;
  freeBytes: number | null;
}

export class WorkflowMemoryGate {
  private readonly relief = createMemoryReliefState();
  private lastSampleAt: number | null = null;
  private lastFreeBytes: number | null = null;
  private readonly waiting: Array<{ key: string; lastAskedAt: number }> = [];
  private inFlight: { key: string; sessionId: string | null; since: number } | null = null;
  private lastReleaseAt: number | null = null;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** The memory sampler's per-tick hook. */
  onSample(sample: HostMemorySample): void {
    const headroom = memoryHeadroom(sample);
    if (headroom === null) return;
    evaluateMemoryRelief(headroom, this.relief);
    this.lastSampleAt = this.now();
    this.lastFreeBytes = headroom.kind === 'bytes' ? headroom.remainingBytes : null;
  }

  reading(): GateMemoryReading {
    const fresh = this.lastSampleAt !== null && this.now() - this.lastSampleAt <= SAMPLE_STALE_MS;
    return { low: fresh && this.relief.active, freeBytes: fresh ? this.lastFreeBytes : null };
  }

  /**
   * Ask to go now. `go` when memory is fine, nothing released is still
   * settling, the pace allows it, and this key is first in line: the caller
   * must then act, and `begin` (or `release`) what it did. Otherwise it is in
   * line, and asks again later.
   */
  tryAcquire(key: string): GateDecision {
    const now = this.now();
    this.dropAbandoned(now);
    const queued = this.waiting.find((entry) => entry.key === key);
    if (queued) queued.lastAskedAt = now;
    else this.waiting.push({ key, lastAskedAt: now });

    if (this.reading().low) return { go: false, why: 'memory-low' };
    // The key in flight asking again continues its own load (a task's nudge
    // after its memory resume): past the turn wait and the line, never the pace.
    const continuing = this.inFlight?.key === key;
    if (this.inFlight && now - this.inFlight.since < TURN_WAIT_MS && !continuing) return { go: false, why: 'queued' };
    if (this.lastReleaseAt !== null && now - this.lastReleaseAt < PACE_MS) return { go: false, why: 'queued' };
    if (!continuing && this.waiting[0]?.key !== key) return { go: false, why: 'queued' };

    this.forget(key);
    this.inFlight = { key, sessionId: null, since: now };
    this.lastReleaseAt = now;
    return { go: true };
  }

  /** The released item started its turn in this session; the queue moves on once that session works. */
  begin(key: string, sessionId: string): void {
    if (this.inFlight?.key === key) this.inFlight.sessionId = sessionId;
  }

  /** A session went thinking: an item waiting on that turn has it under way. */
  noteThinking(sessionId: string): void {
    if (this.inFlight?.sessionId === sessionId) this.inFlight = null;
  }

  /**
   * The released item started nothing (it was held, refused, judged done, or
   * failed), or its holder went away: the queue moves on at once, and the pace
   * resets, since no load was added.
   */
  release(key: string): void {
    if (this.inFlight?.key === key) {
      this.inFlight = null;
      this.lastReleaseAt = null;
    }
    this.forget(key);
  }

  /**
   * The holder is gone (its task moved, its recovery stopped): out of line,
   * and out of flight. The pace stays: whatever it started may still be
   * loading the machine.
   */
  drop(key: string): void {
    if (this.inFlight?.key === key) this.inFlight = null;
    this.forget(key);
  }

  /**
   * The holder no longer asks for this place (what it waited to do went away):
   * out of line only. An item already in flight stays, since another holder of
   * the same key may have started it.
   */
  withdraw(key: string): void {
    this.forget(key);
  }

  /** Test-only: an empty gate with no reading. */
  resetForTests(): void {
    this.waiting.length = 0;
    this.inFlight = null;
    this.lastReleaseAt = null;
    this.lastSampleAt = null;
    this.lastFreeBytes = null;
    this.relief.active = false;
  }

  private forget(key: string): void {
    const index = this.waiting.findIndex((entry) => entry.key === key);
    if (index >= 0) this.waiting.splice(index, 1);
  }

  private dropAbandoned(now: number): void {
    for (let index = this.waiting.length - 1; index >= 0; index -= 1) {
      if (now - this.waiting[index].lastAskedAt > ABANDONED_AFTER_MS) this.waiting.splice(index, 1);
    }
    if (this.inFlight && now - this.inFlight.since >= TURN_WAIT_MS) this.inFlight = null;
  }
}

/** The app's one gate, fed by the memory sampler (`src/main/index.ts`). */
export const workflowMemoryGate = new WorkflowMemoryGate();
