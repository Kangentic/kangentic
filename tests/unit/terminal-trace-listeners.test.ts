/**
 * The terminal trace ring's listener fan-out (src/main/pty/terminal-trace.ts).
 *
 * `recordTerminalTrace` keeps an entry on a 300-entry ring and then hands that
 * entry to every listener `addTerminalTraceListener` registered. The devtools
 * install persists those entries to disk and samples the composed width off
 * them, so the contract that matters is what a listener is guaranteed:
 *  - it sees every kept entry, stamped `process: 'main'` unless the recorder
 *    says it relayed the entry for the pty host;
 *  - a throwing listener cannot break the resize or replay that traced, nor
 *    starve a listener registered after it;
 *  - the unsubscribe returned by `addTerminalTraceListener` really stops delivery;
 *  - an entry recorded once the ring is full (the old one evicted) still
 *    reaches listeners, and the ring stays at its bound.
 *
 * The module is a no-op unless `__KANGENTIC_DEV__` is true, and vitest.config.mts
 * pins that constant to `false` by replacing the identifier in the source text
 * at transform time, so `vi.stubGlobal` cannot reach it. These tests therefore
 * bundle the real source with esbuild, defining the constant as `true`, and
 * load that bundle from a temp directory. The same esbuild-in-a-unit-test move
 * is made by pty-host-boundary.test.ts. The ring and the listener set are
 * module state, so every test loads its own copy of the bundle.
 *
 * Tier: Unit. No Electron, no PTY.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as esbuild from 'esbuild';
import type { TerminalTraceEvent } from '../../src/main/pty/terminal-trace';

type TerminalTraceModule = typeof import('../../src/main/pty/terminal-trace');

const REPO_ROOT = path.resolve(__dirname, '../..');
const TERMINAL_TRACE_ENTRY = path.join(REPO_ROOT, 'src/main/pty/terminal-trace.ts');

// `RING_SIZE` in terminal-trace.ts, which is not exported. Pinned here as the
// contract: the ring never holds more than this many entries.
const RING_SIZE = 300;

const nodeRequire = createRequire(import.meta.url);

let bundleDirectory: string;
let bundledSource: string;
let loadCount = 0;

/** A copy of terminal-trace.ts with its own ring and listener set, built with
 *  the dev constant on. A fresh file per call, so `require`'s cache cannot hand
 *  back the previous test's state. */
function loadFreshTerminalTrace(): TerminalTraceModule {
  loadCount += 1;
  const modulePath = path.join(bundleDirectory, `terminal-trace-${loadCount}.cjs`);
  fs.writeFileSync(modulePath, bundledSource);
  return nodeRequire(modulePath) as TerminalTraceModule;
}

/** A listener that keeps what it was given, for assertions. */
function collectingListener(): { received: TerminalTraceEvent[]; listener: (entry: TerminalTraceEvent) => void } {
  const received: TerminalTraceEvent[] = [];
  return { received, listener: (entry) => { received.push(entry); } };
}

beforeAll(async () => {
  bundleDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-terminal-trace-listeners-'));
  const result = await esbuild.build({
    entryPoints: [TERMINAL_TRACE_ENTRY],
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    define: { __KANGENTIC_DEV__: 'true' },
    write: false,
    logLevel: 'silent',
  });
  bundledSource = result.outputFiles[0].text;
});

afterAll(() => {
  fs.rmSync(bundleDirectory, { recursive: true, force: true });
});

describe('terminal trace: the bundled module is live (not the vitest no-op)', () => {
  // Control for every test below: with the dev constant on, a record is kept.
  // If the define ever stopped reaching the bundle, every assertion here would
  // pass or fail for the wrong reason, so this one names the cause.
  it('keeps a recorded entry, which the vitest-transformed module would drop', () => {
    const trace = loadFreshTerminalTrace();

    trace.recordTerminalTrace('session-live', 'resize', undefined, 100);

    expect(trace.readTerminalTrace()).toHaveLength(1);
  });
});

describe('terminal trace: listeners see every kept entry', () => {
  // Red-green: delete the listener loop and nothing is received; flip the
  // `recordedBy` default to 'pty-host' and the default case fails; stop passing
  // `recordedBy` through to the entry and the 'pty-host' case reads 'main'.
  it("delivers the entry stamped process 'main' when the recorder is not named", () => {
    const trace = loadFreshTerminalTrace();
    const { received, listener } = collectingListener();
    trace.addTerminalTraceListener(listener);

    trace.recordTerminalTrace('session-main', 'settle', { reason: 'marker' }, 1_700_000_000_001);

    expect(received).toEqual([
      {
        ts: 1_700_000_000_001,
        source: 'main',
        process: 'main',
        sessionId: 'session-main',
        event: 'settle',
        detail: { reason: 'marker' },
      },
    ]);
  });

  it("delivers the entry stamped process 'pty-host' when the recorder says it relayed for the host", () => {
    const trace = loadFreshTerminalTrace();
    const { received, listener } = collectingListener();
    trace.addTerminalTraceListener(listener);

    trace.recordTerminalTrace('session-host', 'resize-applied', { cols: 120 }, 1_700_000_000_002, 'pty-host');

    expect(received).toEqual([
      {
        ts: 1_700_000_000_002,
        // The ring a relayed entry lives in is still main's; `process` names the recorder.
        source: 'main',
        process: 'pty-host',
        sessionId: 'session-host',
        event: 'resize-applied',
        detail: { cols: 120 },
      },
    ]);
  });

  it('delivers each entry, in order, to every registered listener, and the ring keeps the same entries', () => {
    const trace = loadFreshTerminalTrace();
    const first = collectingListener();
    const second = collectingListener();
    trace.addTerminalTraceListener(first.listener);
    trace.addTerminalTraceListener(second.listener);

    trace.recordTerminalTrace('session-a', 'one', undefined, 1);
    trace.recordTerminalTrace('session-b', 'two', undefined, 2);
    trace.recordTerminalTrace('session-a', 'three', undefined, 3, 'pty-host');

    const expectedEvents = ['one', 'two', 'three'];
    expect(first.received.map((entry) => entry.event)).toEqual(expectedEvents);
    expect(second.received.map((entry) => entry.event)).toEqual(expectedEvents);
    expect(first.received.map((entry) => entry.process)).toEqual(['main', 'main', 'pty-host']);
    // A listener is handed the kept entry itself, not a copy that could drift from the ring.
    const kept = trace.readTerminalTrace();
    expect(kept).toHaveLength(3);
    kept.forEach((entry, index) => {
      expect(first.received[index]).toBe(entry);
      expect(second.received[index]).toBe(entry);
    });
  });
});

describe('terminal trace: a throwing listener is contained', () => {
  // Red-green: delete the try/catch around `listener(entry)` and the first
  // case throws out of `recordTerminalTrace` (which is the resize or replay
  // that traced) and the second listener never runs.
  it('neither throws out of recordTerminalTrace nor stops a later listener from receiving the entry', () => {
    const trace = loadFreshTerminalTrace();
    let throwingCalls = 0;
    trace.addTerminalTraceListener(() => {
      throwingCalls += 1;
      throw new Error('listener failure');
    });
    const later = collectingListener();
    trace.addTerminalTraceListener(later.listener);

    expect(() => trace.recordTerminalTrace('session-throw', 'first', undefined, 10)).not.toThrow();

    expect(throwingCalls).toBe(1);
    expect(later.received.map((entry) => entry.event)).toEqual(['first']);
    // The entry was kept before any listener ran, so the failure cost nothing.
    expect(trace.readTerminalTrace().map((entry) => entry.event)).toEqual(['first']);

    // Control: the throwing listener stays registered and a later entry still
    // reaches the healthy one, so the containment is per call, not a one-time pass.
    expect(() => trace.recordTerminalTrace('session-throw', 'second', undefined, 11)).not.toThrow();
    expect(throwingCalls).toBe(2);
    expect(later.received.map((entry) => entry.event)).toEqual(['first', 'second']);
  });
});

describe('terminal trace: the unsubscribe stops delivery', () => {
  // Red-green: make the returned function a no-op (or drop the
  // `listeners.delete`) and the unsubscribed listener keeps receiving.
  it('stops delivering to the listener it was returned for, and only that one', () => {
    const trace = loadFreshTerminalTrace();
    const unsubscribed = collectingListener();
    const retained = collectingListener();
    const unsubscribe = trace.addTerminalTraceListener(unsubscribed.listener);
    trace.addTerminalTraceListener(retained.listener);

    trace.recordTerminalTrace('session-unsub', 'before', undefined, 20);
    unsubscribe();
    trace.recordTerminalTrace('session-unsub', 'after', undefined, 21);

    expect(unsubscribed.received.map((entry) => entry.event)).toEqual(['before']);
    // Control: the entry after the unsubscribe was recorded and delivered to the
    // listener that stayed, so the silence above is the unsubscribe and not a
    // record that never fired.
    expect(retained.received.map((entry) => entry.event)).toEqual(['before', 'after']);
    expect(trace.readTerminalTrace().map((entry) => entry.event)).toEqual(['before', 'after']);
  });
});

describe('terminal trace: a full ring still feeds listeners', () => {
  // Red-green: return early (or skip the listener loop) once the ring is at its
  // bound and the listener stops receiving at the 301st entry; let the ring
  // grow instead of evicting and `readTerminalTrace()` passes the bound.
  it('delivers entries recorded after the 300-entry bound, and keeps the ring at the bound', () => {
    const trace = loadFreshTerminalTrace();
    const { received, listener } = collectingListener();
    trace.addTerminalTraceListener(listener);
    const totalRecorded = RING_SIZE + 5;

    for (let index = 0; index < totalRecorded; index += 1) {
      trace.recordTerminalTrace('session-ring', `event-${index}`, undefined, 1_000 + index);
    }

    // Every entry reached the listener, the five past the bound included.
    expect(received).toHaveLength(totalRecorded);
    expect(received.map((entry) => entry.event)).toEqual(
      Array.from({ length: totalRecorded }, (_, index) => `event-${index}`),
    );

    const kept = trace.readTerminalTrace();
    expect(kept).toHaveLength(RING_SIZE);
    // The oldest five were evicted; the newest is the last one delivered.
    expect(kept[0].event).toBe('event-5');
    expect(kept[RING_SIZE - 1].event).toBe(`event-${totalRecorded - 1}`);
    expect(received[totalRecorded - 1]).toBe(kept[RING_SIZE - 1]);
  });
});
