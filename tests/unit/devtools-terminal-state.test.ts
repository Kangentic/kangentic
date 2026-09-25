/**
 * Unit tests for the `/terminal-state` route in
 * src/devtools/main/inspection-server.ts - the first coverage this route has.
 *
 * Strategy mirrors devtools-terminal-forensics.test.ts: start a real
 * inspection server on port 0 and drive it with plain Node http. Only the CDP
 * window (the renderer leg) and the session manager are stubbed; the join and
 * every derived invariant run the real code path.
 *
 * Beyond the pre-existing invariants (ptyMatchesGrid / colsDrift), this pins
 * the composed-width fields (task 573): `composedMatchesPty: false` while
 * `ptyMatchesGrid: true` is the spawn-race verdict the pty-vs-grid comparisons
 * structurally cannot reach, because Kangentic sets both of their sides itself.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';

// Must precede any devtools import: inspection-server.ts calls app.getVersion().
vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '0.0.0') },
}));

import {
  startInspectionServer,
  stopInspectionServer,
} from '../../src/devtools/main/inspection-server';
import { attachDebugger } from '../../src/devtools/main/cdp';
import { TUI_SETUP, DEFECTIVE_JUMP_FRAME } from '../fixtures/claude-code-frames';
import type { BrowserWindow } from 'electron';

interface DimensionRowInput {
  sessionId: string;
  ptyCols: number | null;
  ptyRows: number | null;
  inAltScreen: boolean;
}

interface Harness {
  port: number;
  setRendererGrids: (grids: unknown) => void;
  setDimensionRows: (rows: DimensionRowInput[]) => void;
  setRawScrollback: (sessionId: string, raw: string) => void;
}

const harness: Harness = {
  port: 0,
  setRendererGrids: () => {},
  setDimensionRows: () => {},
  setRawScrollback: () => {},
};

function httpGet(port: number, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path, method: 'GET' }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = raw;
        }
        resolve({ status: response.statusCode ?? 0, body: parsed });
      });
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end();
  });
}

/** The glued-rows raw stream: a child composing 120 columns. */
const GLUED_120_STREAM =
  '\x1b[?1049h' +
  ('\x1b[H' + '─'.repeat(120) + '\r\n' + ' '.repeat(120) + '\r\n' + 'text\x1b[K\r\n').repeat(3);

interface TerminalRow {
  sessionId: string;
  ptyMatchesGrid: boolean | null;
  colsDrift: number | null;
  composedCols: number | null;
  composedColsSampleCount: number;
  composedMatchesPty: boolean | null;
}

interface TerminalStateBody {
  terminals: TerminalRow[];
  unmountedSessions: Array<TerminalRow & { ptyCols: number | null }>;
}

beforeAll(async () => {
  let rendererGrids: unknown = [];
  let dimensionRows: DimensionRowInput[] = [];
  const rawBySession = new Map<string, string>();

  harness.setRendererGrids = (grids) => { rendererGrids = grids; };
  harness.setDimensionRows = (rows) => { dimensionRows = rows; };
  harness.setRawScrollback = (sessionId, raw) => { rawBySession.set(sessionId, raw); };

  const stubDebugger = {
    attach: vi.fn(),
    detach: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    sendCommand: async (method: string) => {
      if (method === 'Runtime.evaluate') {
        return { result: { value: { grids: rendererGrids, trace: [] } } };
      }
      return {};
    },
  };
  const fakeWindow = {
    webContents: { debugger: stubDebugger },
    isDestroyed: vi.fn(() => false),
  } as unknown as BrowserWindow;
  attachDebugger(fakeWindow);

  const sessionManager = {
    getTerminalDimensions: () =>
      dimensionRows.map((row) => ({ taskId: 'task-1', status: 'running', ...row })),
    getPipelineStats: () => [],
    getRawScrollback: (sessionId: string) => rawBySession.get(sessionId) ?? '',
  };

  const port = await startInspectionServer({
    getMainWindow: () => fakeWindow,
    getEvalEnabled: () => true,
    getSessionManager: () => sessionManager as never,
    getProjectRoot: () => null,
    getIpcContext: () => null,
    getProjectId: () => null,
  });
  expect(port).not.toBeNull();
  harness.port = port!;
});

afterAll(() => {
  stopInspectionServer();
});

describe('GET /terminal-state', () => {
  it('joins renderer grids to PTY rows and derives the pty-vs-grid invariants', async () => {
    harness.setDimensionRows([
      { sessionId: 'healthy', ptyCols: 306, ptyRows: 15, inAltScreen: false },
      { sessionId: 'drifted', ptyCols: 120, ptyRows: 30, inAltScreen: false },
    ]);
    harness.setRendererGrids([
      { handle: 'term-1', sessionId: 'healthy', cols: 306, rows: 15 },
      { handle: 'term-2', sessionId: 'drifted', cols: 306, rows: 15 },
    ]);

    const response = await httpGet(harness.port, '/terminal-state');
    expect(response.status).toBe(200);
    const body = response.body as TerminalStateBody;

    const healthy = body.terminals.find((terminal) => terminal.sessionId === 'healthy');
    expect(healthy?.ptyMatchesGrid).toBe(true);
    expect(healthy?.colsDrift).toBe(0);

    const drifted = body.terminals.find((terminal) => terminal.sessionId === 'drifted');
    expect(drifted?.ptyMatchesGrid).toBe(false);
    expect(drifted?.colsDrift).toBe(-186);
  });

  it('reports the spawn-race verdict: composed width disagrees while pty and grid agree', async () => {
    // The live capture's exact shape: ptyCols 306, xterm 306 (both healthy by
    // construction), but the raw bytes are composed at 120.
    harness.setDimensionRows([
      { sessionId: 'stuck', ptyCols: 306, ptyRows: 15, inAltScreen: true },
    ]);
    harness.setRendererGrids([{ handle: 'term-1', sessionId: 'stuck', cols: 306, rows: 15 }]);
    harness.setRawScrollback('stuck', GLUED_120_STREAM);

    const response = await httpGet(harness.port, '/terminal-state');
    const body = response.body as TerminalStateBody;
    const stuck = body.terminals.find((terminal) => terminal.sessionId === 'stuck');

    expect(stuck?.ptyMatchesGrid).toBe(true);
    expect(stuck?.colsDrift).toBe(0);
    expect(stuck?.composedCols).toBe(120);
    expect(stuck?.composedColsSampleCount).toBeGreaterThanOrEqual(2);
    expect(stuck?.composedMatchesPty).toBe(false);
  });

  it('reports a matching composed width for a healthy alt-screen session', async () => {
    harness.setDimensionRows([
      { sessionId: 'healthy-210', ptyCols: 210, ptyRows: 48, inAltScreen: true },
    ]);
    harness.setRendererGrids([
      { handle: 'term-1', sessionId: 'healthy-210', cols: 210, rows: 48 },
    ]);
    harness.setRawScrollback('healthy-210', TUI_SETUP + DEFECTIVE_JUMP_FRAME);

    const response = await httpGet(harness.port, '/terminal-state');
    const body = response.body as TerminalStateBody;
    const healthy = body.terminals.find((terminal) => terminal.sessionId === 'healthy-210');

    expect(healthy?.composedCols).toBe(210);
    expect(healthy?.composedMatchesPty).toBe(true);
  });

  it('folds autowrap-concatenated rows against the live grid (live 2026-08-29 false red)', async () => {
    // The exact shape the first live capture mis-read: a healthy alt-screen
    // session whose rows arrive glued by autowrap (612-length runs at a
    // 306-column grid) must read as matching, not as a 612-column child.
    harness.setDimensionRows([
      { sessionId: 'wrapped', ptyCols: 306, ptyRows: 10, inAltScreen: true },
    ]);
    harness.setRendererGrids([{ handle: 'term-1', sessionId: 'wrapped', cols: 306, rows: 10 }]);
    harness.setRawScrollback('wrapped', '\x1b[?1049h' + ('─'.repeat(612) + '\r\n').repeat(3));

    const response = await httpGet(harness.port, '/terminal-state');
    const body = response.body as TerminalStateBody;
    const wrapped = body.terminals.find((terminal) => terminal.sessionId === 'wrapped');

    expect(wrapped?.composedCols).toBe(306);
    expect(wrapped?.composedMatchesPty).toBe(true);
  });

  it('reports null composed fields outside alt-screen instead of measuring pass-through content', async () => {
    harness.setDimensionRows([
      { sessionId: 'shell', ptyCols: 306, ptyRows: 15, inAltScreen: false },
    ]);
    harness.setRendererGrids([{ handle: 'term-1', sessionId: 'shell', cols: 306, rows: 15 }]);
    // Would read as a 500-column composition if the gate were missing.
    harness.setRawScrollback('shell', '='.repeat(500));

    const response = await httpGet(harness.port, '/terminal-state');
    const body = response.body as TerminalStateBody;
    const shell = body.terminals.find((terminal) => terminal.sessionId === 'shell');

    expect(shell?.composedCols).toBeNull();
    expect(shell?.composedColsSampleCount).toBe(0);
    expect(shell?.composedMatchesPty).toBeNull();
  });

  it('carries the composed fields on unmounted sessions so a background stuck session is diagnosable', async () => {
    harness.setDimensionRows([
      { sessionId: 'background', ptyCols: 306, ptyRows: 15, inAltScreen: true },
    ]);
    harness.setRendererGrids([]);
    harness.setRawScrollback('background', GLUED_120_STREAM);

    const response = await httpGet(harness.port, '/terminal-state');
    const body = response.body as TerminalStateBody;

    expect(body.terminals).toEqual([]);
    expect(body.unmountedSessions).toHaveLength(1);
    expect(body.unmountedSessions[0].sessionId).toBe('background');
    expect(body.unmountedSessions[0].ptyCols).toBe(306);
    expect(body.unmountedSessions[0].composedCols).toBe(120);
    expect(body.unmountedSessions[0].composedMatchesPty).toBe(false);
  });

  it('composedMatchesPty is true at the exact tolerance boundary (off by COMPOSED_MATCH_TOLERANCE_COLUMNS)', async () => {
    // 304-column rules against a 306 grid: off by exactly the tolerance (2).
    // The constant does double duty - it gates the fold's reference-consistency
    // pre-filter AND the match verdict - so retuning it moves both at once.
    harness.setDimensionRows([
      { sessionId: 'boundary-in', ptyCols: 306, ptyRows: 15, inAltScreen: true },
    ]);
    harness.setRendererGrids([{ handle: 'term-1', sessionId: 'boundary-in', cols: 306, rows: 15 }]);
    harness.setRawScrollback('boundary-in', '\x1b[?1049h' + ('─'.repeat(304) + '\r\n').repeat(3));

    const response = await httpGet(harness.port, '/terminal-state');
    const body = response.body as TerminalStateBody;
    const boundaryIn = body.terminals.find((terminal) => terminal.sessionId === 'boundary-in');

    expect(boundaryIn?.composedCols).toBe(304);
    expect(boundaryIn?.composedMatchesPty).toBe(true);
  });

  it('composedMatchesPty is false one column past the tolerance', async () => {
    // 303-column rules: off by 3, one past COMPOSED_MATCH_TOLERANCE_COLUMNS.
    // 303 also falls out of the reference-consistent set, so the fold names
    // the divergent width on its own evidence rather than snapping to 306.
    harness.setDimensionRows([
      { sessionId: 'boundary-out', ptyCols: 306, ptyRows: 15, inAltScreen: true },
    ]);
    harness.setRendererGrids([
      { handle: 'term-1', sessionId: 'boundary-out', cols: 306, rows: 15 },
    ]);
    harness.setRawScrollback('boundary-out', '\x1b[?1049h' + ('─'.repeat(303) + '\r\n').repeat(3));

    const response = await httpGet(harness.port, '/terminal-state');
    const body = response.body as TerminalStateBody;
    const boundaryOut = body.terminals.find((terminal) => terminal.sessionId === 'boundary-out');

    expect(boundaryOut?.composedCols).toBe(303);
    expect(boundaryOut?.composedMatchesPty).toBe(false);
  });

  it('measures composed width for a suspended alt-screen session (ptyCols null) without a match verdict', async () => {
    // A suspended session tears down its pty (ptyCols null) while the buffer
    // manager's alt-screen state persists. The reference-less fold must still
    // name the composed width; the match verdict has nothing to compare
    // against and stays null.
    harness.setDimensionRows([
      { sessionId: 'suspended', ptyCols: null, ptyRows: null, inAltScreen: true },
    ]);
    harness.setRendererGrids([]);
    harness.setRawScrollback('suspended', GLUED_120_STREAM);

    const response = await httpGet(harness.port, '/terminal-state');
    const body = response.body as TerminalStateBody;

    expect(body.unmountedSessions).toHaveLength(1);
    expect(body.unmountedSessions[0].sessionId).toBe('suspended');
    expect(body.unmountedSessions[0].composedCols).toBe(120);
    expect(body.unmountedSessions[0].composedMatchesPty).toBeNull();
  });
});
