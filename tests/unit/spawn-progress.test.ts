/**
 * Unit tests for the queryable spawn-progress map in
 * src/main/transition-engine/spawn-progress.ts.
 *
 * Contract:
 *  - emit/createProgressCallback set the in-flight map AND push IPC.
 *  - clear deletes from the map AND pushes a null label.
 *  - createProgressCallback resolves known phases to labels and passes
 *    unknown strings (raw git progress) through verbatim.
 *  - getInFlightSpawnProgress() prunes TTL-expired entries on read.
 *  - The map is updated even when the window is destroyed (it is the
 *    authoritative source of truth); only the IPC send is skipped.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import {
  emitSpawnProgress,
  emitSpawnWaiting,
  createProgressCallback,
  clearSpawnProgress,
  getInFlightSpawnProgress,
  onSpawnProgressTransition,
  setSpawnStaleNote,
  beginSpawnStaleProbe,
  touchSpawnStaleProbe,
  __resetSpawnProgressForTest,
} from '../../src/main/transition-engine/spawn-progress';

function makeWindow(isDestroyed = false): { window: BrowserWindow; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn();
  const window = {
    isDestroyed: () => isDestroyed,
    webContents: { send },
  } as unknown as BrowserWindow;
  return { window, send };
}

describe('spawn-progress queryable map', () => {
  beforeEach(() => {
    __resetSpawnProgressForTest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emitSpawnProgress sets the map with the resolved label and pushes IPC', () => {
    const { window, send } = makeWindow();
    emitSpawnProgress(window, 'task-1', 'starting-agent');

    expect(getInFlightSpawnProgress()).toEqual({ 'task-1': 'Starting agent...' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('task:spawnProgress', 'task-1', 'Starting agent...');
  });

  it('createProgressCallback resolves known phases and passes unknown strings verbatim', () => {
    const { window } = makeWindow();
    const onProgress = createProgressCallback(window, 'task-1');

    onProgress('fetching');
    expect(getInFlightSpawnProgress()['task-1']).toBe('Fetching latest...');

    // Raw git progress string (not a known phase) flows through unchanged.
    onProgress('Resolving deltas: 42%');
    expect(getInFlightSpawnProgress()['task-1']).toBe('Resolving deltas: 42%');
  });

  it('createProgressCallback resolves the init-script phase to its user-facing label', () => {
    // Regression guard for the new PHASE_LABELS entry added with the
    // Post-Worktree Script feature. createWorktree calls onProgress('init-script')
    // while runInitScript runs; the renderer displays the resolved label so the
    // card shows "Running setup script..." during a long npm install.
    const { window } = makeWindow();
    const onProgress = createProgressCallback(window, 'task-1');

    onProgress('init-script');
    expect(getInFlightSpawnProgress()['task-1']).toBe('Running setup script...');
  });

  it('emitSpawnWaiting pushes a dynamic "waiting" label with the jobs-ahead count', () => {
    const { window, send } = makeWindow();
    emitSpawnWaiting(window, 'task-1', 2);

    expect(getInFlightSpawnProgress()).toEqual({ 'task-1': 'Waiting (2 ahead)' });
    expect(send).toHaveBeenCalledWith('task:spawnProgress', 'task-1', 'Waiting (2 ahead)');
  });

  it('emitSpawnWaiting omits the count when no jobs are ahead', () => {
    const { window } = makeWindow();
    emitSpawnWaiting(window, 'task-1', 0);

    expect(getInFlightSpawnProgress()['task-1']).toBe('Waiting...');
  });

  it('emitSpawnWaiting leads with the running worktree-removal and its elapsed time', () => {
    const { window } = makeWindow();
    emitSpawnWaiting(window, 'task-1', 1, { label: 'remove-worktree:1a2b3c4d', elapsedMs: 45_000 });

    expect(getInFlightSpawnProgress()['task-1']).toBe('Removing worktree (waiting 45s)');
  });

  it('emitSpawnWaiting names a running worktree creation', () => {
    const { window } = makeWindow();
    emitSpawnWaiting(window, 'task-1', 1, { label: 'create-worktree:1a2b3c4d', elapsedMs: 12_000 });

    expect(getInFlightSpawnProgress()['task-1']).toBe('Creating worktree (waiting 12s)');
  });

  it('emitSpawnWaiting names a running branch rename', () => {
    const { window } = makeWindow();
    emitSpawnWaiting(window, 'task-1', 1, { label: 'rename-branch:1a2b3c4d', elapsedMs: 8_000 });

    expect(getInFlightSpawnProgress()['task-1']).toBe('Renaming branch (waiting 8s)');
  });

  it('emitSpawnWaiting names a running update-from-base job', () => {
    const { window } = makeWindow();
    emitSpawnWaiting(window, 'task-1', 1, { label: 'update-from-base:1a2b3c4d', elapsedMs: 20_000 });

    expect(getInFlightSpawnProgress()['task-1']).toBe('Updating from base (waiting 20s)');
  });

  it('emitSpawnWaiting falls back to a generic phrase for an unknown running label', () => {
    const { window } = makeWindow();
    emitSpawnWaiting(window, 'task-1', 1, { label: 'mystery-op:1a2b3c4d', elapsedMs: 8_000 });

    expect(getInFlightSpawnProgress()['task-1']).toBe('Git operation (waiting 8s)');
  });

  it('emitSpawnWaiting re-emit refreshes the TTL (a long wait never strands)', () => {
    const nowSpy = vi.spyOn(Date, 'now');
    const { window } = makeWindow();

    nowSpy.mockReturnValue(0);
    emitSpawnWaiting(window, 'task-1', 1, { label: 'remove-worktree:1a2b3c4d', elapsedMs: 0 });

    // Re-emit just before the first push's TTL would expire.
    nowSpy.mockReturnValue(119_000);
    emitSpawnWaiting(window, 'task-1', 1, { label: 'remove-worktree:1a2b3c4d', elapsedMs: 119_000 });

    // Past the FIRST push's TTL but within the re-emit's: still alive.
    nowSpy.mockReturnValue(119_000 + 119_000);
    expect(getInFlightSpawnProgress()['task-1']).toBe('Removing worktree (waiting 119s)');
  });

  it('a later phase push overwrites the waiting label (waiting -> fetching transition)', () => {
    const { window } = makeWindow();
    emitSpawnWaiting(window, 'task-1', 1);
    expect(getInFlightSpawnProgress()['task-1']).toBe('Waiting (1 ahead)');

    // When the parked job dequeues and starts, the git layer emits 'fetching'.
    emitSpawnProgress(window, 'task-1', 'fetching');
    expect(getInFlightSpawnProgress()['task-1']).toBe('Fetching latest...');
  });

  it('clearSpawnProgress deletes the entry and pushes a null label', () => {
    const { window, send } = makeWindow();
    emitSpawnProgress(window, 'task-1', 'fetching');
    send.mockClear();

    clearSpawnProgress(window, 'task-1');

    expect(getInFlightSpawnProgress()['task-1']).toBeUndefined();
    expect(getInFlightSpawnProgress()).toEqual({});
    expect(send).toHaveBeenCalledWith('task:spawnProgress', 'task-1', null);
  });

  it('tracks multiple tasks independently', () => {
    const { window } = makeWindow();
    emitSpawnProgress(window, 'task-1', 'fetching');
    emitSpawnProgress(window, 'task-2', 'starting-agent');

    expect(getInFlightSpawnProgress()).toEqual({
      'task-1': 'Fetching latest...',
      'task-2': 'Starting agent...',
    });
  });

  it('prunes TTL-expired entries on read', () => {
    const nowSpy = vi.spyOn(Date, 'now');
    const { window } = makeWindow();

    nowSpy.mockReturnValue(1_000);
    emitSpawnProgress(window, 'task-old', 'starting-agent');

    // Within TTL: still present.
    nowSpy.mockReturnValue(1_000 + 60_000);
    expect(getInFlightSpawnProgress()['task-old']).toBe('Starting agent...');

    // Past the 120s TTL: pruned on read.
    nowSpy.mockReturnValue(1_000 + 120_001);
    expect(getInFlightSpawnProgress()['task-old']).toBeUndefined();
  });

  it('onSpawnProgressTransition fires true on first entry, nothing on a label-only change, false on removal', () => {
    const { window } = makeWindow();
    const events: Array<[string, boolean]> = [];
    const unsubscribe = onSpawnProgressTransition((taskId, active) => events.push([taskId, active]));

    emitSpawnProgress(window, 'task-1', 'fetching'); // first entry: arm
    emitSpawnProgress(window, 'task-1', 'creating-worktree'); // label-only change: no re-arm
    clearSpawnProgress(window, 'task-1'); // removal: disarm

    unsubscribe();
    expect(events).toEqual([
      ['task-1', true],
      ['task-1', false],
    ]);
  });

  it('onSpawnProgressTransition stops firing after unsubscribe', () => {
    const { window } = makeWindow();
    const events: Array<[string, boolean]> = [];
    const unsubscribe = onSpawnProgressTransition((taskId, active) => events.push([taskId, active]));
    unsubscribe();

    emitSpawnProgress(window, 'task-1', 'fetching');
    expect(events).toEqual([]);
  });

  it('updates the map even when the window is destroyed, but skips the IPC send', () => {
    const { window, send } = makeWindow(true);
    emitSpawnProgress(window, 'task-1', 'starting-agent');

    // Map is the source of truth -> still updated.
    expect(getInFlightSpawnProgress()['task-1']).toBe('Starting agent...');
    // Send is guarded.
    expect(send).not.toHaveBeenCalled();
  });

  it('each push resets updatedAt, so a sequence of phases spaced < TTL keeps the entry alive', () => {
    // Regression guard: if pushSpawnProgress set updatedAt only on the FIRST
    // push, a spawn that emits multiple phases (fetching -> creating-worktree
    // -> starting-agent) could be pruned mid-sequence once the wall clock
    // passes the first push's updatedAt + TTL. Each push MUST refresh
    // updatedAt so only the LAST push time is compared to the TTL.
    const nowSpy = vi.spyOn(Date, 'now');
    const { window } = makeWindow();

    // Phase 1 at T+0.
    nowSpy.mockReturnValue(0);
    const onProgress = createProgressCallback(window, 'task-seq');
    onProgress('fetching');
    expect(getInFlightSpawnProgress()['task-seq']).toBe('Fetching latest...');

    // Phase 2 at T+90s (before TTL from phase 1, so still alive without the
    // fix, but this is just the "within TTL" step).
    nowSpy.mockReturnValue(90_000);
    onProgress('creating-worktree');
    expect(getInFlightSpawnProgress()['task-seq']).toBe('Creating worktree...');

    // Phase 3 at T+150s. This is PAST 120s from phase 1's updatedAt (0ms).
    // If updatedAt were NOT refreshed on each push, the entry would be pruned
    // at this read. Since phase 2 was at 90s, the TTL from the last push is
    // 90s+120s=210s -> entry must still be alive at 150s.
    nowSpy.mockReturnValue(150_000);
    onProgress('starting-agent');
    expect(getInFlightSpawnProgress()['task-seq']).toBe('Starting agent...');

    // Verify: only after 120s from the LAST push does the entry expire.
    // The last push was at 150s, so expiry is at 150s + 120s = 270s.
    // At 269_999ms: still alive.
    nowSpy.mockReturnValue(150_000 + 120_000 - 1);
    expect(getInFlightSpawnProgress()['task-seq']).toBe('Starting agent...');

    // At 270_001ms: pruned (past TTL from the last push at 150s).
    nowSpy.mockReturnValue(150_000 + 120_001);
    expect(getInFlightSpawnProgress()['task-seq']).toBeUndefined();
  });
});

describe('spawn-progress stale note', () => {
  beforeEach(() => {
    __resetSpawnProgressForTest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('setting a note re-pushes the current label decorated, immediately', () => {
    const { window, send } = makeWindow();
    emitSpawnProgress(window, 'task-1', 'starting-agent');
    send.mockClear();

    setSpawnStaleNote(window, 'task-1', 'base 3 behind');

    expect(send).toHaveBeenCalledWith('task:spawnProgress', 'task-1', 'Starting agent... (base 3 behind)');
    expect(getInFlightSpawnProgress()['task-1']).toBe('Starting agent... (base 3 behind)');
  });

  it('the note decorates every subsequent phase emit', () => {
    const { window, send } = makeWindow();
    emitSpawnProgress(window, 'task-1', 'fetching');
    setSpawnStaleNote(window, 'task-1', 'base fetch failed');
    send.mockClear();

    emitSpawnProgress(window, 'task-1', 'starting-agent');

    expect(send).toHaveBeenCalledWith('task:spawnProgress', 'task-1', 'Starting agent... (base fetch failed)');
    expect(getInFlightSpawnProgress()['task-1']).toBe('Starting agent... (base fetch failed)');
  });

  it('decorates the queue-wait label too (the stall watcher regex tolerates the suffix)', () => {
    const { window } = makeWindow();
    emitSpawnWaiting(window, 'task-1', 1, { label: 'remove-worktree:1a2b3c4d', elapsedMs: 45_000 });
    setSpawnStaleNote(window, 'task-1', 'base fetch failed');

    expect(getInFlightSpawnProgress()['task-1']).toBe('Removing worktree (waiting 45s) (base fetch failed)');
  });

  it('a TOKENLESS note no-ops when the task has no in-flight entry', () => {
    const { window, send } = makeWindow();

    setSpawnStaleNote(window, 'task-1', 'base 3 behind');
    expect(send).not.toHaveBeenCalled();
    expect(getInFlightSpawnProgress()).toEqual({});

    // A later, unrelated spawn of the same task starts undecorated.
    emitSpawnProgress(window, 'task-1', 'fetching');
    expect(getInFlightSpawnProgress()['task-1']).toBe('Fetching latest...');
  });

  it('a probe-token note with no entry PENDS and decorates the spawn\'s next label push', () => {
    // The reuse-spawn shape: nothing is in flight between the move and Phase
    // 3's 'starting-agent', which is exactly when the drift probe resolves.
    // Dropping the note there meant reuse drift effectively never surfaced.
    const { window } = makeWindow();
    const probeGeneration = beginSpawnStaleProbe('task-1');

    setSpawnStaleNote(window, 'task-1', 'base 1 behind', probeGeneration);
    expect(getInFlightSpawnProgress()).toEqual({});

    emitSpawnProgress(window, 'task-1', 'starting-agent');
    expect(getInFlightSpawnProgress()['task-1']).toBe('Starting agent... (base 1 behind)');
  });

  it('a pended note is voided by a clear - the task\'s NEXT spawn starts undecorated', () => {
    const { window } = makeWindow();
    const probeGeneration = beginSpawnStaleProbe('task-1');
    setSpawnStaleNote(window, 'task-1', 'base 1 behind', probeGeneration);

    // The probed spawn ends without ever pushing a label (the promote/MCP
    // shape); the clear must take the pending note with it.
    clearSpawnProgress(window, 'task-1');

    emitSpawnProgress(window, 'task-1', 'fetching');
    expect(getInFlightSpawnProgress()['task-1']).toBe('Fetching latest...');
  });

  it('a probe token captured before a clear cannot decorate the next spawn, even mid-flight', () => {
    const { window } = makeWindow();
    // Probe starts during spawn A...
    emitSpawnProgress(window, 'task-1', 'starting-agent');
    const staleToken = beginSpawnStaleProbe('task-1');
    // ...spawn A clears, spawn B starts...
    clearSpawnProgress(window, 'task-1');
    emitSpawnProgress(window, 'task-1', 'fetching');

    // ...and spawn A's probe finally resolves. Spawn B's freshly-cut tree is
    // not behind; spawn A's verdict must not stick to it.
    setSpawnStaleNote(window, 'task-1', 'base 5 behind', staleToken);
    expect(getInFlightSpawnProgress()['task-1']).toBe('Fetching latest...');
  });

  it('clearSpawnProgress drops the note - the next spawn of the same task is undecorated', () => {
    const { window } = makeWindow();
    emitSpawnProgress(window, 'task-1', 'fetching');
    setSpawnStaleNote(window, 'task-1', 'base 3 behind');
    clearSpawnProgress(window, 'task-1');

    emitSpawnProgress(window, 'task-1', 'starting-agent');
    expect(getInFlightSpawnProgress()['task-1']).toBe('Starting agent...');
  });

  it('TTL prune removes the note along with the entry', () => {
    const nowSpy = vi.spyOn(Date, 'now');
    const { window } = makeWindow();

    nowSpy.mockReturnValue(0);
    emitSpawnProgress(window, 'task-1', 'starting-agent');
    setSpawnStaleNote(window, 'task-1', 'base 3 behind');

    nowSpy.mockReturnValue(120_001);
    expect(getInFlightSpawnProgress()['task-1']).toBeUndefined();

    // A fresh spawn after the prune starts undecorated.
    emitSpawnProgress(window, 'task-1', 'fetching');
    expect(getInFlightSpawnProgress()['task-1']).toBe('Fetching latest...');
  });

  it('the sweep drops a pending note past the probe horizon, bounding the map', () => {
    const nowSpy = vi.spyOn(Date, 'now');
    const { window } = makeWindow();

    nowSpy.mockReturnValue(0);
    const probeGeneration = beginSpawnStaleProbe('task-1');
    setSpawnStaleNote(window, 'task-1', 'base 1 behind', probeGeneration);

    // Past the 60s horizon, a snapshot read sweeps the orphaned pending entry.
    nowSpy.mockReturnValue(60_001);
    getInFlightSpawnProgress();

    emitSpawnProgress(window, 'task-1', 'starting-agent');
    expect(getInFlightSpawnProgress()['task-1']).toBe('Starting agent...');
  });

  it('the sweep never drops a clear-generation baseline out from under a live probe', () => {
    const nowSpy = vi.spyOn(Date, 'now');
    const { window } = makeWindow();

    // A clear at T0 creates the generation entry...
    nowSpy.mockReturnValue(0);
    emitSpawnProgress(window, 'task-1', 'starting-agent');
    clearSpawnProgress(window, 'task-1');

    // ...a probe starts 50s later (touching the entry)...
    nowSpy.mockReturnValue(50_000);
    const probeGeneration = beginSpawnStaleProbe('task-1');

    // ...a sweep runs 99s after the clear but only 49s after the touch...
    nowSpy.mockReturnValue(99_000);
    getInFlightSpawnProgress();

    // ...and the probe's note still lands on the spawn in flight.
    emitSpawnProgress(window, 'task-1', 'starting-agent');
    setSpawnStaleNote(window, 'task-1', 'base 1 behind', probeGeneration);
    expect(getInFlightSpawnProgress()['task-1']).toBe('Starting agent... (base 1 behind)');
  });

  it('touchSpawnStaleProbe keeps a git-queue-delayed probe\'s baseline alive across a sweep', () => {
    const nowSpy = vi.spyOn(Date, 'now');
    const { window } = makeWindow();

    // A clear at T0 creates the generation entry, and a probe captures it...
    nowSpy.mockReturnValue(0);
    emitSpawnProgress(window, 'task-1', 'starting-agent');
    clearSpawnProgress(window, 'task-1');
    const probeGeneration = beginSpawnStaleProbe('task-1');

    // ...the probe sits in the git queue until T55s, then re-touches when it
    // finally starts running...
    nowSpy.mockReturnValue(55_000);
    touchSpawnStaleProbe('task-1');

    // ...so a sweep at T110s (110s after capture, 55s after the touch) keeps
    // the baseline, and the probe's late note still lands.
    nowSpy.mockReturnValue(110_000);
    getInFlightSpawnProgress();
    emitSpawnProgress(window, 'task-1', 'starting-agent');
    setSpawnStaleNote(window, 'task-1', 'base 1 behind', probeGeneration);
    expect(getInFlightSpawnProgress()['task-1']).toBe('Starting agent... (base 1 behind)');
  });

  it('notes are per-task', () => {
    const { window } = makeWindow();
    emitSpawnProgress(window, 'task-1', 'starting-agent');
    emitSpawnProgress(window, 'task-2', 'starting-agent');
    setSpawnStaleNote(window, 'task-1', 'base 3 behind');

    expect(getInFlightSpawnProgress()).toEqual({
      'task-1': 'Starting agent... (base 3 behind)',
      'task-2': 'Starting agent...',
    });
  });
});
