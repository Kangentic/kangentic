/**
 * Parity between main's per-renderer focus sets and the pty host's.
 *
 * Two copies of the same fact exist. Main (`SessionManager.focusedByRenderer`)
 * keeps each renderer's visible sessions and their union, which decide what is
 * watched and what a resting grid may do. The pty host (`PtyHostCore.rendererFocus`)
 * keeps its own copy of the per-renderer sets, fed by `setRendererFocus` commands
 * main posts, and routes a session's output to exactly the ports of the renderers
 * that show it. The host's own comment says the two are changed together.
 * Nothing else ties them: a `setFocusedSessions` or `clearFocusedSessionsFor` that
 * updates main's copy and forgets to tell the host leaves a window receiving the
 * output of a terminal it no longer shows (or starves one it does).
 *
 * These tests drive a REAL `SessionManager` over its in-process host and two fake
 * renderer ports (renderer 1 and renderer 2), publish and drop focus in sequences,
 * and after each step feed every session a fresh marker. A marker must reach a
 * renderer's port exactly when main's set for that renderer holds the session,
 * main's sets must be the ones the test published, and `getFocusedSessions()` must
 * be the union of them.
 *
 * Harness follows `session-manager-data-tap.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

vi.mock('../../src/main/pty/spawn/shell-resolver', () => {
  class MockShellResolver {
    async getDefaultShell() { return '/bin/bash'; }
  }
  return { ShellResolver: MockShellResolver };
});

vi.mock('../../src/shared/paths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/shared/paths')>()),
  adaptCommandForShell: (command: string) => command,
  buildSpawnClearPrelude: () => '',
  isUncPath: (pathString: string) => /^[\\/]{2}[^\\/]/.test(pathString),
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
}));

import * as nodePty from 'node-pty';
import { SessionManager } from '../../src/main/pty/session-manager';
import { createFakeRendererPort, receivedOutput } from './helpers/fake-renderer-port';
import type { FakeRendererPort } from './helpers/fake-renderer-port';

function createMockPty() {
  let dataHandler: ((data: string) => void) | null = null;
  let exitHandler: ((event: { exitCode: number }) => void) | null = null;

  const mockPty = {
    pid: 12345,
    cols: 120,
    rows: 30,
    onData: vi.fn((callback: (data: string) => void) => {
      dataHandler = callback;
      return { dispose: () => { dataHandler = null; } };
    }),
    onExit: vi.fn((callback: (event: { exitCode: number }) => void) => {
      exitHandler = callback;
      return { dispose: () => { exitHandler = null; } };
    }),
    write: vi.fn(),
    resize: vi.fn((cols: number, rows: number) => {
      mockPty.cols = cols;
      mockPty.rows = rows;
    }),
    kill: vi.fn(() => {
      if (exitHandler) setTimeout(() => exitHandler?.({ exitCode: 0 }), 0);
    }),
  };

  return {
    mockPty,
    feedData: (data: string) => dataHandler?.(data),
  };
}

const RENDERER_1 = 1;
const RENDERER_2 = 2;
/** A renderer that never published a set and holds no port. */
const SILENT_RENDERER = 3;

type SessionName = 'A' | 'B' | 'C';
const SESSION_NAMES: readonly SessionName[] = ['A', 'B', 'C'];

/** How long a flush may take to land: the 16 ms window plus headroom. */
const FLUSH_SETTLE_MS = 50;
/** Longest a marker that SHOULD arrive is waited for, before the probe reports it missing. */
const ARRIVAL_DEADLINE_MS = 2000;

let tmpDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-focus-union-parity-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe('focus sets: main and the pty host stay in step', () => {
  let manager: SessionManager;
  const sessionIdByName = new Map<SessionName, string>();
  const feedByName = new Map<SessionName, (data: string) => void>();
  const portByRenderer = new Map<number, FakeRendererPort>();
  /** What the test has published to the manager, per renderer: the expected state. */
  let published: Map<number, Set<string>>;
  let probeNumber: number;

  async function spawnNamedSession(name: SessionName): Promise<void> {
    const mock = createMockPty();
    vi.mocked(nodePty.spawn).mockReturnValue(mock.mockPty as unknown as nodePty.IPty);
    // Resumed, so the session starts idle and carries no fresh-spawn timers.
    const session = await manager.spawn({
      taskId: `task-focus-parity-${name}`,
      command: '',
      cwd: tmpDir,
      resuming: true,
    });
    sessionIdByName.set(name, session.id);
    feedByName.set(name, mock.feedData);
  }

  beforeEach(async () => {
    manager = new SessionManager();
    sessionIdByName.clear();
    feedByName.clear();
    portByRenderer.clear();
    published = new Map();
    probeNumber = 0;
    for (const name of SESSION_NAMES) await spawnNamedSession(name);
    // Each renderer holds its port before it publishes focus, as the preload
    // asks for one at load.
    for (const rendererId of [RENDERER_1, RENDERER_2]) {
      const rendererPort = createFakeRendererPort();
      portByRenderer.set(rendererId, rendererPort);
      manager.attachRendererPort(rendererId, rendererPort.port);
    }
  });

  afterEach(async () => {
    manager.killAll();
    await sleep(20);
  });

  function idOf(name: SessionName): string {
    const sessionId = sessionIdByName.get(name);
    if (sessionId === undefined) throw new Error(`session ${name} was not spawned`);
    return sessionId;
  }

  function nameOf(sessionId: string): string {
    for (const [name, candidateId] of sessionIdByName) {
      if (candidateId === sessionId) return name;
    }
    return `unknown(${sessionId})`;
  }

  /** A renderer publishes its whole visible set, as `useFocusedSessionsSync` does. */
  function publish(rendererId: number, names: SessionName[]): void {
    const sessionIds = names.map(idOf);
    manager.setFocusedSessions(sessionIds, rendererId);
    if (sessionIds.length === 0) published.delete(rendererId);
    else published.set(rendererId, new Set(sessionIds));
  }

  /** A renderer's window goes away: main drops every claim it made. */
  function clearRenderer(rendererId: number): void {
    manager.clearFocusedSessionsFor(rendererId);
    published.delete(rendererId);
  }

  /** Main's own per-renderer sets, read from the manager. */
  function mainSets(): Map<number, Set<string>> {
    return (manager as unknown as { focusedByRenderer: Map<number, Set<string>> }).focusedByRenderer;
  }

  /** Per-renderer sets as sorted session names, so a failure diff reads A/B/C. */
  function describeSets(sets: Map<number, Set<string>>): Record<string, string[]> {
    const described: Record<string, string[]> = {};
    for (const [rendererId, sessionIds] of [...sets].sort(([left], [right]) => left - right)) {
      described[`renderer-${rendererId}`] = [...sessionIds].map(nameOf).sort();
    }
    return described;
  }

  function expectedUnion(): string[] {
    const union = new Set<string>();
    for (const sessionIds of published.values()) {
      for (const sessionId of sessionIds) union.add(sessionId);
    }
    return [...union].map(nameOf).sort();
  }

  function markerFor(name: SessionName): string {
    return `<probe-${probeNumber}:${name}>`;
  }

  function markerReached(rendererId: number, name: SessionName): boolean {
    const port = portByRenderer.get(rendererId);
    if (!port) throw new Error(`renderer ${rendererId} has no port`);
    const marker = markerFor(name);
    return receivedOutput(port).some((output) => output.sessionId === idOf(name) && output.data.includes(marker));
  }

  /**
   * Feed every session a fresh marker, let the flush land, and check that main
   * and the host agree on who is showing what.
   */
  async function probe(step: string): Promise<void> {
    probeNumber += 1;
    for (const name of SESSION_NAMES) feedByName.get(name)?.(markerFor(name));

    // A marker that should arrive is waited for, so a slow runner cannot fail
    // the probe on timing. The ones that should NOT arrive can only be given a
    // fixed budget (non-occurrence cannot be polled), so settle for one flush
    // window after the arrivals have landed.
    const expectedArrivals = (): boolean => {
      for (const [rendererId, sessionIds] of published) {
        for (const name of SESSION_NAMES) {
          if (sessionIds.has(idOf(name)) && !markerReached(rendererId, name)) return false;
        }
      }
      return true;
    };
    const deadline = Date.now() + ARRIVAL_DEADLINE_MS;
    while (!expectedArrivals() && Date.now() < deadline) await sleep(10);
    await sleep(FLUSH_SETTLE_MS);

    // Output reaches a renderer's port exactly when MAIN's set for that renderer
    // holds the session.
    const heldByMain = mainSets();
    const mismatches: string[] = [];
    for (const rendererId of portByRenderer.keys()) {
      for (const name of SESSION_NAMES) {
        const mainHolds = heldByMain.get(rendererId)?.has(idOf(name)) ?? false;
        const reached = markerReached(rendererId, name);
        if (reached !== mainHolds) {
          mismatches.push(
            `renderer ${rendererId} ${reached ? 'received' : 'did not receive'} session ${name}'s output, ` +
            `but main's set for it ${mainHolds ? 'holds' : 'does not hold'} ${name}`,
          );
        }
      }
    }
    expect(mismatches, `host routing disagrees with main at step "${step}"`).toEqual([]);

    // Main's sets are what the test published, and its union is their union.
    expect(describeSets(heldByMain), `main's per-renderer sets at step "${step}"`).toEqual(describeSets(published));
    expect(
      [...manager.getFocusedSessions()].map(nameOf).sort(),
      `main's focus union at step "${step}"`,
    ).toEqual(expectedUnion());
  }

  it('routes a session both renderers show to both ports, and holds it once in the union', async () => {
    publish(RENDERER_1, ['A', 'B']);
    publish(RENDERER_2, ['B', 'C']);

    await probe('B shown by both renderers');

    // Sanity: the probe is not vacuous.
    expect(expectedUnion()).toEqual(['A', 'B', 'C']);
    expect(markerReached(RENDERER_1, 'B')).toBe(true);
    expect(markerReached(RENDERER_2, 'B')).toBe(true);
    expect(markerReached(RENDERER_1, 'C')).toBe(false);
    expect(markerReached(RENDERER_2, 'A')).toBe(false);
  });

  it('keeps a shared session flowing to the renderer that still shows it when the other drops it', async () => {
    publish(RENDERER_1, ['A', 'B']);
    publish(RENDERER_2, ['B', 'C']);
    await probe('B shown by both renderers');

    // Renderer 1 stops showing B. The union keeps B (renderer 2 holds it), and
    // the host must stop sending B to renderer 1 only. A host that replaced the
    // per-renderer sets with one shared set (last writer wins) fails here.
    publish(RENDERER_1, ['A']);
    await probe('renderer 1 dropped B');

    expect(expectedUnion()).toEqual(['A', 'B', 'C']);
    expect(markerReached(RENDERER_1, 'B')).toBe(false);
    expect(markerReached(RENDERER_2, 'B')).toBe(true);
    expect(markerReached(RENDERER_1, 'A')).toBe(true);
  });

  it('stops routing to a renderer that is cleared entirely, and keeps the other renderer\'s set', async () => {
    publish(RENDERER_1, ['A', 'B']);
    publish(RENDERER_2, ['B', 'C']);
    await probe('both renderers publishing');

    // Renderer 2's window goes away. Its port is still attached (a closing window
    // is detached separately), so only an empty set sent to the host stops its
    // output: a clear that dropped main's copy and left the host's would keep
    // sending to renderer 2.
    clearRenderer(RENDERER_2);
    await probe('renderer 2 cleared');

    expect(expectedUnion()).toEqual(['A', 'B']);
    for (const name of SESSION_NAMES) expect(markerReached(RENDERER_2, name)).toBe(false);
    expect(markerReached(RENDERER_1, 'A')).toBe(true);
    expect(markerReached(RENDERER_1, 'B')).toBe(true);

    // The last renderer goes too: nothing is shown, nothing flows.
    clearRenderer(RENDERER_1);
    await probe('renderer 1 cleared too');

    expect(manager.getFocusedSessions().size).toBe(0);
    for (const name of SESSION_NAMES) expect(markerReached(RENDERER_1, name)).toBe(false);
  });

  it('treats an empty published set as a drop, and a clear of a renderer that never published as a no-op', async () => {
    publish(RENDERER_1, ['A']);
    publish(RENDERER_2, ['B']);
    await probe('one session each');

    // An empty set is how a renderer with nothing visible publishes.
    publish(RENDERER_2, []);
    await probe('renderer 2 published an empty set');
    expect(markerReached(RENDERER_2, 'B')).toBe(false);
    expect(markerReached(RENDERER_1, 'A')).toBe(true);

    // A window that never published focus closes: nothing of anyone else's changes.
    clearRenderer(SILENT_RENDERER);
    await probe('a renderer that never published was cleared');
    expect(expectedUnion()).toEqual(['A']);
  });

  it('stays in step through a mixed sequence of publishes, drops, re-adds and clears', async () => {
    await probe('nothing published');
    expect(manager.getFocusedSessions().size).toBe(0);

    publish(RENDERER_2, ['C']);
    await probe('renderer 2 shows C');

    publish(RENDERER_1, ['A', 'C']);
    await probe('renderer 1 joins, sharing C');

    publish(RENDERER_2, ['B', 'C']);
    await probe('renderer 2 swaps in B');

    publish(RENDERER_1, ['B']);
    await probe('renderer 1 narrows to B');

    clearRenderer(RENDERER_1);
    await probe('renderer 1 cleared');

    publish(RENDERER_1, ['A']);
    await probe('renderer 1 comes back with A');

    publish(RENDERER_2, []);
    await probe('renderer 2 empties');

    clearRenderer(RENDERER_1);
    await probe('everyone gone');
    expect(manager.getFocusedSessions().size).toBe(0);
  });
});
