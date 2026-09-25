/**
 * The web demo's replay emulator (demo/replay-emulator.ts) is expensive to keep around: each
 * instance holds a recording's worth of xterm scrollback, and a visitor may open every card on
 * the board. `buildDemoPreConfig`'s generated script (tests/captures/helpers/demo-dataset.ts)
 * wraps `window.electronAPI.sessions.setMounted` (the renderer's whole-set-replace of which
 * sessions a terminal currently shows) to dispose an emulator once its session has gone unshown
 * for EMULATOR_UNMOUNTED_MS, and `startEmulator` restarts a fresh one when the session is shown
 * again.
 *
 * This is the one piece of that machinery no test exercised: every existing demo-emulator-*.test.ts
 * drives `emulatorPaint` or the raw `createReplayEmulator` module, never the disposal wrapper,
 * `startEmulator`'s own restart, or `frameScrollback` (the real entry point a reopened window's
 * `getScrollback` call reaches). The behavior was verified by hand instead: a window closed past
 * EMULATOR_UNMOUNTED_MS and reopened restarts the emulator on the SESSION'S clock (elapsed =
 * Date.now() - entry.startedAt, where entry.startedAt is set once, the first time frameScrollback
 * sees it null, and never reset by a later close/reopen), not rewound to the start of the
 * recording. Lifted here with fake timers so that claim is pinned by a test rather than left to
 * hand verification, driven through frameScrollback itself for the reopen case so the pin also
 * covers frameScrollback's own contribution (the `=== null` guard), not just startEmulator's
 * elapsed arithmetic.
 *
 * Lifted out of the GENERATED seed, not the TypeScript source, the way demo-emulator-paint.test.ts
 * and demo-frame-fit.test.ts lift their functions: the seed is a template literal, so its numeric
 * constants and its `window.electronAPI.sessions.setMounted` assignment only take their real shape
 * once the template has been evaluated by buildDemoPreConfig.
 *
 * `repaintSoon` (the per-write repaint pacer) is stubbed to a no-op here: its own behavior is
 * `demo-emulator-paint.test.ts`'s job, and pulling in the real one would drag the whole frame
 * applier (fitFrameParts, ALT_PREFIX, the glyph tables) into a file that is only about disposal
 * and restart timing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildDemoPreConfig } from '../captures/helpers/demo-dataset';
import { buildCellWidthTable, loadDemoScrollback } from '../captures/helpers/demo-scrollback';

interface Grid { cols: number; rows: number }
interface StreamChunk { t: number; data: string }
interface Recording extends Grid { stream: StreamChunk[] }
interface Entry { startedAt: number | null; tail: number; file: string; projectId: string }

interface FakeEmulator {
  writes: string[];
  write: (data: string) => Promise<void>;
  dispose: ReturnType<typeof vi.fn>;
}

interface EmulatorState { emulator: FakeEmulator }

interface Lifted {
  setMounted: (sessionIds: string[]) => unknown;
  stopEmulator: (sessionId: string) => void;
  startEmulator: (sessionId: string, entry: Entry, recording: Recording, grid: Grid) => Promise<EmulatorState | null>;
  frameScrollback: (sessionId: string, entry: Entry, recording: Recording, grid: Grid) => Promise<string>;
  emulators: Record<string, EmulatorState>;
}

/** One function's source out of the generated script, by brace matching from its declaration. */
function extractFunction(script: string, name: string): string {
  const start = script.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found in the generated seed`);
  const open = script.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < script.length; index += 1) {
    if (script[index] === '{') depth += 1;
    if (script[index] === '}') {
      depth -= 1;
      if (depth === 0) return script.slice(start, index + 1);
    }
  }
  throw new Error(`unbalanced function ${name} in the generated seed`);
}

function extractNumericConstant(script: string, name: string): number {
  const match = script.match(new RegExp(`var ${name} = ([0-9.]+);`));
  if (!match) throw new Error(`var ${name} not found in the generated seed`);
  return Number(match[1]);
}

/**
 * `var originalSetMounted = window.electronAPI.sessions.setMounted;` through the closing `};` of
 * the function expression assigned to `window.electronAPI.sessions.setMounted`. Not a
 * `function NAME(` declaration, so extractFunction's marker does not match it.
 */
function extractSetMountedAssignment(script: string): string {
  const originalDeclaration = 'var originalSetMounted = window.electronAPI.sessions.setMounted;';
  const start = script.indexOf(originalDeclaration);
  if (start === -1) throw new Error('the setMounted original-implementation declaration was not found in the generated seed');
  const functionMarker = 'window.electronAPI.sessions.setMounted = function (';
  const functionStart = script.indexOf(functionMarker, start);
  if (functionStart === -1) throw new Error('the setMounted assignment was not found in the generated seed');
  const open = script.indexOf('{', functionStart);
  let depth = 0;
  for (let index = open; index < script.length; index += 1) {
    if (script[index] === '{') depth += 1;
    if (script[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        const semicolon = script.indexOf(';', index);
        if (semicolon === -1) throw new Error('the setMounted assignment has no terminating semicolon in the generated seed');
        return script.slice(start, semicolon + 1);
      }
    }
  }
  throw new Error('unbalanced setMounted assignment in the generated seed');
}

const script = buildDemoPreConfig({ scrollback: loadDemoScrollback(), cellWidths: buildCellWidthTable() });
const EMULATOR_UNMOUNTED_MS = extractNumericConstant(script, 'EMULATOR_UNMOUNTED_MS');
const SET_MOUNTED_SOURCE = extractSetMountedAssignment(script);
const STOP_EMULATOR_SOURCE = extractFunction(script, 'stopEmulator');
const LOAD_EMULATOR_MODULE_SOURCE = extractFunction(script, 'loadEmulatorModule');
const START_EMULATOR_SOURCE = extractFunction(script, 'startEmulator');
// frameScrollback is the REAL entry point a reopened window calls (getScrollback -> frameScrollback
// -> startEmulator), so driving the "not rewound" case through it (rather than calling
// startEmulator directly) also pins frameScrollback's own contribution to that claim: it sets
// entry.startedAt ONLY when it is null, so a close/reopen never resets the session's clock.
const FRAME_SCROLLBACK_SOURCE = extractFunction(script, 'frameScrollback');
const RECORDING_END_MS_SOURCE = extractFunction(script, 'recordingEndMs');

interface EmulatorFactory {
  instances: FakeEmulator[];
  createReplayEmulator: (cols: number, rows: number) => FakeEmulator;
}

/** A lightweight double for demo/replay-emulator.ts's createReplayEmulator: it records what it was
 *  written and nothing else. The real emulator's own write/frame contract is
 *  tests/unit/demo-replay-emulator.test.ts's job; this file is about which INSTANCE runs and when
 *  it is created and disposed. */
function createEmulatorFactory(): EmulatorFactory {
  const instances: FakeEmulator[] = [];
  return {
    instances,
    createReplayEmulator: () => {
      const writes: string[] = [];
      const instance: FakeEmulator = {
        writes,
        write: (data: string) => { writes.push(data); return Promise.resolve(); },
        dispose: vi.fn(),
      };
      instances.push(instance);
      return instance;
    },
  };
}

/** Builds the disposal wrapper, stopEmulator, startEmulator, and frameScrollback over injected
 *  `emulators` / `emulatorGenerations` / `replayTimers` state and a stub `window`, the way the
 *  real functions close over the module's own variables and `window.electronAPI` /
 *  `window.__demoLoadReplayEmulator`. frameScrollback's own dependencies beyond those (the session
 *  clock scheduler, the still-frame fallback, the real frame applier) are stubbed: this file is
 *  about which emulator instance runs and when it restarts, not the bytes a paint produces (that
 *  is demo-emulator-paint.test.ts's job) or the session clock (untouched here). The `emulatorPaint`
 *  stub echoes what was written so a test can read it straight off frameScrollback's return value. */
function lift(factory: EmulatorFactory, originalSetMounted: ReturnType<typeof vi.fn> = vi.fn()): Lifted {
  const windowStub = {
    electronAPI: { sessions: { setMounted: originalSetMounted } },
    __demoLoadReplayEmulator: () => Promise.resolve({ createReplayEmulator: factory.createReplayEmulator }),
  };
  const source = [
    `var EMULATOR_UNMOUNTED_MS = ${EMULATOR_UNMOUNTED_MS};`,
    'var emulators = {};',
    'var emulatorGenerations = {};',
    'var replayTimers = {};',
    'var mountedSessions = null;',
    // Real repaint pacing is demo-emulator-paint.test.ts's job; here it is only ever a target of
    // a call this file's tests never let fire (it is scheduled inside a FUTURE chunk's timer,
    // which none of these tests advance far enough to trigger).
    'function repaintSoon() {}',
    SET_MOUNTED_SOURCE,
    STOP_EMULATOR_SOURCE,
    'var emulatorModule = null;',
    LOAD_EMULATOR_MODULE_SOURCE,
    START_EMULATOR_SOURCE,
    // frameScrollback's own remaining dependencies. None of these tests' scenarios reach the
    // "recording already ended" or "emulator failed to load" branches (the recording's last chunk
    // is always ahead of the elapsed time these tests use), so REPAINT/fitFrameToGrid/openFrames
    // are stubs that fail loudly if a test's assumption about that is ever wrong.
    'var replayModes = {};',
    'var openFrames = {};',
    'var REPAINT = "";',
    'function sessionDurationMs() { return 0; }',
    'function clearReplayTimers() {}',
    'function scheduleSessionClock() {}',
    'function endedOnItsOwn() { return false; }',
    'function notePainted(sessionId, grid, frame) { return frame; }',
    'function emulatorPaint(state) { return "PAINTED:" + state.emulator.writes.join(""); }',
    'function fitFrameToGrid() { throw new Error("fitFrameToGrid should not be reached: the recording has not ended yet"); }',
    RECORDING_END_MS_SOURCE,
    FRAME_SCROLLBACK_SOURCE,
    'return { setMounted: window.electronAPI.sessions.setMounted, stopEmulator: stopEmulator, startEmulator: startEmulator, frameScrollback: frameScrollback, emulators: emulators };',
  ].join('\n');
  return new Function('window', source)(windowStub) as Lifted;
}

const RECORDING: Recording = {
  cols: 80,
  rows: 24,
  stream: [
    { t: 0, data: 'chunk0' },
    { t: 5_000, data: 'chunk1' },
    { t: 20_000, data: 'chunk2' },
  ],
};
const GRID: Grid = { cols: 80, rows: 24 };

describe('the replay emulator disposal wrapper (window.electronAPI.sessions.setMounted / stopEmulator / startEmulator)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('disposes an emulator whose session has gone unmounted for EMULATOR_UNMOUNTED_MS, and still forwards the mount list to the original implementation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const factory = createEmulatorFactory();
    const originalSetMounted = vi.fn();
    const lifted = lift(factory, originalSetMounted);
    const entry: Entry = { startedAt: 0, tail: 0, file: 'rec.json', projectId: 'proj-1' };

    await lifted.startEmulator('sess-1', entry, RECORDING, GRID);
    expect(factory.instances).toHaveLength(1);

    // The window is open, then closed: the session drops out of the mounted set.
    lifted.setMounted(['sess-1']);
    lifted.setMounted([]);
    expect(originalSetMounted).toHaveBeenLastCalledWith([]);

    // One millisecond short of the window: still alive.
    await vi.advanceTimersByTimeAsync(EMULATOR_UNMOUNTED_MS - 1);
    expect(factory.instances[0].dispose).not.toHaveBeenCalled();
    expect(lifted.emulators['sess-1']).toBeDefined();

    // The window elapses with no remount: disposed.
    await vi.advanceTimersByTimeAsync(1);
    expect(factory.instances[0].dispose).toHaveBeenCalledTimes(1);
    expect(lifted.emulators['sess-1']).toBeUndefined();
  });

  it('a session mounted again before EMULATOR_UNMOUNTED_MS elapses keeps its emulator running', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const factory = createEmulatorFactory();
    const lifted = lift(factory);
    const entry: Entry = { startedAt: 0, tail: 0, file: 'rec.json', projectId: 'proj-1' };

    await lifted.startEmulator('sess-2', entry, RECORDING, GRID);
    lifted.setMounted(['sess-2']);
    lifted.setMounted([]); // the window closes, arming the disposal timer

    await vi.advanceTimersByTimeAsync(EMULATOR_UNMOUNTED_MS / 2);
    lifted.setMounted(['sess-2']); // the window reopens before the timer runs out

    // The ORIGINAL timer's full delay passes; the remount must have cancelled its effect even
    // though the setTimeout itself was never cleared (the wrapper checks mountedSessions at fire
    // time, not at arm time).
    await vi.advanceTimersByTimeAsync(EMULATOR_UNMOUNTED_MS);
    expect(factory.instances[0].dispose).not.toHaveBeenCalled();
    expect(lifted.emulators['sess-2']?.emulator).toBe(factory.instances[0]);
  });

  it('a window reopened after disposal restarts frameScrollback on a NEW emulator fed from the session clock, not rewound to the start', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const factory = createEmulatorFactory();
    const lifted = lift(factory);
    // startedAt is null, as it is for a real entry before its first mount: frameScrollback sets it
    // itself, and MUST NOT reset it on a later reopen (that is the guard this test pins).
    const entry: Entry = { startedAt: null, tail: 0, file: 'rec.json', projectId: 'proj-1' };

    // First open, at the very start of the session's clock (sessionDurationMs stubbed to 0, tail
    // 0, so frameScrollback sets entry.startedAt to Date.now() = 0): only chunk0 (t=0) is behind
    // "now", so only it is written immediately.
    const firstPaint = await lifted.frameScrollback('sess-3', entry, RECORDING, GRID);
    expect(firstPaint).toBe('PAINTED:chunk0');
    expect(entry.startedAt).toBe(0);

    // The window closes and stays closed past the disposal window.
    lifted.setMounted(['sess-3']);
    lifted.setMounted([]);
    await vi.advanceTimersByTimeAsync(EMULATOR_UNMOUNTED_MS);
    expect(factory.instances[0].dispose).toHaveBeenCalledTimes(1);

    // Reopened (a second frameScrollback call, exactly what a real getScrollback would issue) at
    // t=EMULATOR_UNMOUNTED_MS. entry.startedAt must still be 0 (frameScrollback's `=== null` guard
    // skips re-assignment), so chunk1 (t=5000) is now also behind "now" and must arrive in the
    // same immediate write as chunk0. A rewind bug (entry.startedAt reset to "now", or the guard
    // dropped) would restart at elapsed=0 and leave chunk1 scheduled 5 seconds in the future
    // instead, which is exactly the behavior this test was written to catch by hand.
    const secondPaint = await lifted.frameScrollback('sess-3', entry, RECORDING, GRID);
    expect(entry.startedAt).toBe(0);
    expect(factory.instances).toHaveLength(2);
    expect(factory.instances[1]).not.toBe(factory.instances[0]);
    expect(secondPaint).toBe('PAINTED:chunk0chunk1');
  });
});
