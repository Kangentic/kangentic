/**
 * The workflow's memory gate (src/main/workflows/workflow-memory-gate.ts): one
 * queue for the load a running workflow starts by itself, nudges and memory
 * resumes. None while memory reads low, one at a time otherwise, paced, in
 * order. Overnight, three nudges sent within four seconds started three gates at
 * once, and all three failed on load.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { PACE_MS, TURN_WAIT_MS, WorkflowMemoryGate } from '../../src/main/workflows/workflow-memory-gate';
import { GIBIBYTE, windowsSample } from './helpers/host-memory-sample';

describe('WorkflowMemoryGate', () => {
  let now: number;
  let gate: WorkflowMemoryGate;

  beforeEach(() => {
    now = 1_000_000;
    gate = new WorkflowMemoryGate(() => now);
  });

  it('lets one item go, then holds the next until the first one\'s turn is under way and the pace allows', () => {
    expect(gate.tryAcquire('nudge:a')).toEqual({ go: true });
    gate.begin('nudge:a', 'session-a');
    expect(gate.tryAcquire('nudge:b')).toEqual({ go: false, why: 'queued' });

    // The first agent works: the queue moves on, but only once the pace allows.
    gate.noteThinking('session-a');
    expect(gate.tryAcquire('nudge:b')).toEqual({ go: false, why: 'queued' });
    now += PACE_MS;
    expect(gate.tryAcquire('nudge:b')).toEqual({ go: true });
  });

  it('releases in the order asked, first asked first', () => {
    gate.tryAcquire('nudge:a');
    gate.release('nudge:a');
    // b asks before c; once the pace has passed, c asking first still waits for b.
    expect(gate.tryAcquire('nudge:b')).toEqual({ go: true });
    gate.release('nudge:b');
    expect(gate.tryAcquire('nudge:c')).toEqual({ go: true });
    gate.begin('nudge:c', 'session-c');
    gate.tryAcquire('nudge:d');
    gate.tryAcquire('nudge:e');
    gate.noteThinking('session-c');
    now += PACE_MS;
    expect(gate.tryAcquire('nudge:e')).toEqual({ go: false, why: 'queued' });
    expect(gate.tryAcquire('nudge:d')).toEqual({ go: true });
  });

  it('frees the queue at once for an item that started nothing, with no pace to wait out', () => {
    expect(gate.tryAcquire('nudge:a')).toEqual({ go: true });
    gate.release('nudge:a');
    expect(gate.tryAcquire('nudge:b')).toEqual({ go: true });
  });

  it('holds nothing longer than the turn wait when the turn never shows', () => {
    gate.tryAcquire('resume:a');
    gate.begin('resume:a', 'session-a');
    now += TURN_WAIT_MS;
    expect(gate.tryAcquire('nudge:b')).toEqual({ go: true });
  });

  // Red before (seen live): a task's nudge waited the full turn wait behind
  // its own memory resume, which starts no turn to end that wait.
  it('lets the key in flight continue its own load after the pace, ahead of the line and the turn wait', () => {
    expect(gate.tryAcquire('task:a')).toEqual({ go: true });
    gate.begin('task:a', 'session-a');
    gate.tryAcquire('task:b');
    // The pace still holds: the next one reads memory with this load on it.
    expect(gate.tryAcquire('task:a')).toEqual({ go: false, why: 'queued' });
    now += PACE_MS;
    expect(gate.tryAcquire('task:a')).toEqual({ go: true });
    // Another key still waits for the turn that continuation starts.
    gate.begin('task:a', 'session-a');
    now += PACE_MS;
    expect(gate.tryAcquire('task:b')).toEqual({ go: false, why: 'queued' });
    gate.noteThinking('session-a');
    expect(gate.tryAcquire('task:b')).toEqual({ go: true });
  });

  it('releases nothing while memory reads low, and resumes once it clears the recovery line', () => {
    gate.onSample(windowsSample(1 * GIBIBYTE));
    expect(gate.reading()).toEqual({ low: true, freeBytes: 1 * GIBIBYTE });
    expect(gate.tryAcquire('nudge:a')).toEqual({ go: false, why: 'memory-low' });

    // Between the threshold and the recovery line: still low (the latch's hysteresis).
    gate.onSample(windowsSample(3 * GIBIBYTE));
    expect(gate.tryAcquire('nudge:a')).toEqual({ go: false, why: 'memory-low' });

    gate.onSample(windowsSample(8 * GIBIBYTE));
    expect(gate.tryAcquire('nudge:a')).toEqual({ go: true });
  });

  it('never holds on a reading that went stale: a stopped sampler never holds the workflow', () => {
    gate.onSample(windowsSample(1 * GIBIBYTE));
    now += 4 * 60_000;
    expect(gate.reading().low).toBe(false);
    expect(gate.tryAcquire('nudge:a')).toEqual({ go: true });
  });

  it('reports no free-memory figure where the platform reports a level', () => {
    gate.onSample({ ...windowsSample(0), platform: 'darwin', memoryPressureLevel: 1 });
    expect(gate.reading()).toEqual({ low: false, freeBytes: null });
  });

  it('drops a waiting key nobody asks for again, so a holder that went away blocks nothing', () => {
    gate.tryAcquire('nudge:a');
    gate.begin('nudge:a', 'session-a');
    gate.tryAcquire('nudge:gone');
    gate.noteThinking('session-a');
    now += 4 * 60_000;
    expect(gate.tryAcquire('nudge:b')).toEqual({ go: true });
  });

  it('lets a dropped holder out of line and out of flight, keeping the pace', () => {
    gate.tryAcquire('nudge:a');
    gate.drop('nudge:a');
    expect(gate.tryAcquire('nudge:b')).toEqual({ go: false, why: 'queued' });
    now += PACE_MS;
    expect(gate.tryAcquire('nudge:b')).toEqual({ go: true });
  });

  describe('withdraw', () => {
    it('takes a waiting key out of line, so the next key goes first', () => {
      gate.tryAcquire('task:a');
      gate.begin('task:a', 'session-a');
      expect(gate.tryAcquire('task:b')).toEqual({ go: false, why: 'queued' });
      expect(gate.tryAcquire('task:c')).toEqual({ go: false, why: 'queued' });

      gate.noteThinking('session-a');
      now += PACE_MS;
      // b asked first and is still in line, so c waits for it.
      expect(gate.tryAcquire('task:c')).toEqual({ go: false, why: 'queued' });

      gate.withdraw('task:b');
      expect(gate.tryAcquire('task:c')).toEqual({ go: true });
    });

    it('leaves an item of the same key in flight: only the place in line goes', () => {
      expect(gate.tryAcquire('task:a')).toEqual({ go: true });
      gate.begin('task:a', 'session-a');
      // The same key asks again while its first is in flight, and is told to wait.
      expect(gate.tryAcquire('task:a')).toEqual({ go: false, why: 'queued' });
      expect(gate.tryAcquire('task:b')).toEqual({ go: false, why: 'queued' });

      gate.withdraw('task:a');

      // The pace is over, but the first item has not started its turn: still in flight.
      now += PACE_MS;
      expect(gate.tryAcquire('task:b')).toEqual({ go: false, why: 'queued' });
      // And its turn is still tracked by its session.
      gate.noteThinking('session-a');
      expect(gate.tryAcquire('task:b')).toEqual({ go: true });
    });
  });
});
