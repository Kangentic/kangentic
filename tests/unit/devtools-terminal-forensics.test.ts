/**
 * Unit tests for the `/terminal-forensics` route in
 * src/devtools/main/inspection-server.ts.
 *
 * This route is a diagnostic that has to be correct exactly ONCE, under stress,
 * at the moment an intermittent bug reproduces. There is no second chance to
 * re-run it against the same frame, so it is worth exercising for real rather
 * than trusting that it compiles: a route that 500s or returns empty rows at
 * repro time makes the whole capture worthless.
 *
 * Strategy mirrors devtools-inspection-server.test.ts: start a real inspection
 * server on port 0 and drive it with plain Node http.request. Two things are
 * stubbed, and only two - the CDP window (the renderer leg) and the session
 * manager. Everything else is the real code path, including the main-side grid
 * oracle, which is fed a GENUINELY serialized alt-screen frame produced by the
 * real HeadlessFrameBuffer rather than a hand-written escape string. That is
 * the part most likely to be subtly wrong, and the part a hand-written fixture
 * would not catch.
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
import { HeadlessFrameBuffer } from '../../src/main/pty/buffer/headless-frame';
import type { BrowserWindow } from 'electron';

const SESSION_ID = 'session-under-test';
const GRID_COLS = 60;
const GRID_ROWS = 12;

/** Rows the fake renderer reports, with a hole where rows 4-5 should be. */
const RENDERER_ROWS = [
  'top matter',
  '',
  'above the gap',
  '',
  '',
  '',
  'below the gap',
  '',
  '',
  '',
  '',
  'status line',
];

interface Harness {
  port: number;
  /** Value the stubbed Runtime.evaluate returns for the grid-rows read. */
  setRendererDumps: (dumps: unknown) => void;
  setRawScrollback: (raw: string) => void;
  setSerializedFrame: (frame: string) => void;
}

const harness: Harness = {
  port: 0,
  setRendererDumps: () => {},
  setRawScrollback: () => {},
  setSerializedFrame: () => {},
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

/** A real serialized alt-screen frame, produced the way main produces one. */
async function buildRealAltScreenFrame(): Promise<string> {
  const buffer = new HeadlessFrameBuffer(GRID_COLS, GRID_ROWS);
  buffer.write('\x1b[?1049h');
  buffer.write('\x1b[1;1Htop matter');
  buffer.write('\x1b[3;1Habove the gap');
  buffer.write('\x1b[5;1Hinside the gap');
  buffer.write('\x1b[7;1Hbelow the gap');
  buffer.write(`\x1b[${GRID_ROWS};1Hstatus line`);
  const frame = await buffer.serialize();
  buffer.dispose();
  return frame;
}

beforeAll(async () => {
  let rendererDumps: unknown = [
    {
      handle: 'term-1',
      sessionId: SESSION_ID,
      surface: 'board-window',
      cols: GRID_COLS,
      rows: GRID_ROWS,
      altScreen: true,
      scrollRegionTop: 0,
      scrollRegionBottom: GRID_ROWS - 1,
      cursorRow: 11,
      cursorColumn: 0,
      viewportRows: RENDERER_ROWS,
    },
  ];
  let rawScrollback = '';
  let serializedFrame = '';

  harness.setRendererDumps = (dumps) => { rendererDumps = dumps; };
  harness.setRawScrollback = (raw) => { rawScrollback = raw; };
  harness.setSerializedFrame = (frame) => { serializedFrame = frame; };

  const stubDebugger = {
    attach: vi.fn(),
    detach: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    sendCommand: async (method: string) => {
      if (method === 'Runtime.evaluate') {
        return { result: { value: { dumps: rendererDumps } } };
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
    getTerminalDimensions: () => [
      { sessionId: SESSION_ID, taskId: 'task-1', status: 'running', ptyCols: GRID_COLS, ptyRows: GRID_ROWS, inAltScreen: true },
    ],
    getSerializedFrame: async () => serializedFrame,
    getRawScrollback: () => rawScrollback,
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

describe('GET /terminal-forensics', () => {
  it('requires a sessionId', async () => {
    const response = await httpGet(harness.port, '/terminal-forensics');
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ ok: false, error: { kind: 'missing-session-id' } });
  });

  it('re-parses a REAL serialized alt-screen frame back into its rows', async () => {
    // The main-side oracle. If this drifts, the three-way split silently
    // compares the renderer against nothing and every capture reads as "the
    // rows were never in the parsed grid either", which points at upstream
    // whether or not that is true.
    harness.setSerializedFrame(await buildRealAltScreenFrame());
    harness.setRawScrollback('');

    const response = await httpGet(harness.port, `/terminal-forensics?sessionId=${SESSION_ID}`);
    expect(response.status).toBe(200);

    const body = response.body as { mainGrid: { rows: string[]; error?: string; serializedFrameBytes: number } };
    expect(body.mainGrid.error).toBeUndefined();
    expect(body.mainGrid.serializedFrameBytes).toBeGreaterThan(0);
    expect(body.mainGrid.rows).toHaveLength(GRID_ROWS);
    expect(body.mainGrid.rows[0]).toBe('top matter');
    expect(body.mainGrid.rows[2]).toBe('above the gap');
    expect(body.mainGrid.rows[4]).toBe('inside the gap');
    expect(body.mainGrid.rows[6]).toBe('below the gap');
    expect(body.mainGrid.rows[GRID_ROWS - 1]).toBe('status line');
    expect(body.mainGrid.rows[1]).toBe('');
  });

  it('surfaces the three-way disagreement the capture exists to show', async () => {
    // Row 4 is present in main's parsed grid and blank in the renderer's. That
    // is precisely the "lost between main and the renderer" verdict, and it has
    // to be readable by comparing the two arrays at the same index.
    harness.setSerializedFrame(await buildRealAltScreenFrame());

    const response = await httpGet(harness.port, `/terminal-forensics?sessionId=${SESSION_ID}`);
    const body = response.body as {
      mainGrid: { rows: string[] };
      rendererGrids: Array<{ viewportRows: string[]; scrollRegionTop: number }>;
    };

    expect(body.rendererGrids).toHaveLength(1);
    expect(body.rendererGrids[0].viewportRows[4]).toBe('');
    expect(body.mainGrid.rows[4]).toBe('inside the gap');
    // Renderer-side fields survive the CDP round trip intact.
    expect(body.rendererGrids[0].scrollRegionTop).toBe(0);
  });

  it('escapes control bytes in the raw tail so sequences stay readable', async () => {
    harness.setSerializedFrame('');
    harness.setRawScrollback('\x1b[5;20rhello\r\nworld\x07');

    const response = await httpGet(harness.port, `/terminal-forensics?sessionId=${SESSION_ID}`);
    const body = response.body as { raw: { tail: string; totalBytes: number; tailBytes: number } };

    expect(body.raw.tail).toBe('\\x1b[5;20rhello\\r\\nworld\\x07');
    // Searching the tail for a missing row's text is the whole workflow, so the
    // printable characters must survive escaping untouched.
    expect(body.raw.tail).toContain('hello');
    expect(body.raw.totalBytes).toBe('\x1b[5;20rhello\r\nworld\x07'.length);
  });

  it('honors rawTailBytes and reports the slice it took', async () => {
    harness.setSerializedFrame('');
    harness.setRawScrollback('abcdefghij');

    const response = await httpGet(
      harness.port,
      `/terminal-forensics?sessionId=${SESSION_ID}&rawTailBytes=4`,
    );
    const body = response.body as { raw: { tail: string; totalBytes: number; tailBytes: number } };

    expect(body.raw.tail).toBe('ghij');
    expect(body.raw.totalBytes).toBe(10);
    expect(body.raw.tailBytes).toBe(4);
  });

  it('reports the PTY row for the session and degrades rather than failing', async () => {
    harness.setSerializedFrame('');
    harness.setRawScrollback('');
    harness.setRendererDumps([]);

    const response = await httpGet(harness.port, `/terminal-forensics?sessionId=${SESSION_ID}`);
    const body = response.body as {
      sessionId: string;
      pty: { ptyCols: number; inAltScreen: boolean } | null;
      rendererGrids: unknown[];
    };

    expect(response.status).toBe(200);
    expect(body.sessionId).toBe(SESSION_ID);
    expect(body.pty?.ptyCols).toBe(GRID_COLS);
    expect(body.pty?.inAltScreen).toBe(true);
    // No mounted xterm is not an error: main's side of the capture still stands.
    expect(body.rendererGrids).toEqual([]);
  });
});
