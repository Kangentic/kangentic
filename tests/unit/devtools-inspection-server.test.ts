/**
 * Unit tests for handler-level behavior in
 * src/devtools/main/inspection-server.ts.
 *
 * Strategy: spin up a real inspection server bound on port 0 via
 * `startInspectionServer`, then drive it with plain Node `http.request`
 * calls. For endpoints that require a live CDP window we build a fake
 * `BrowserWindow` whose `webContents.debugger` is a controlled stub, then
 * call the exported `attachDebugger` to register it in cdp.ts's WeakMap so
 * `isDebuggerAttached` returns true.
 *
 * This file does NOT touch real Electron windows, PTYs, or the filesystem
 * (other than OS-assigned port binding) - everything is stub-driven pure
 * Node. All tests run in the same process as the server so the
 * module-level `activeOptions` binding in inspection-server.ts is shared.
 * Tests run serially in the single worker Vitest uses for this suite.
 *
 * Covered:
 *   1. runScriptStep `eval` case - eval-disabled guard, missing-expression
 *      guard, runtimeEvaluate error path, happy-path value propagation,
 *      and non-eval steps do not carry `value`.
 *   2. respondQueryAll / respondBoundingBoxAll - missing-selector 400 guard
 *      (the `evaluate-failed` and `query-failed` paths need a live CDP
 *      round-trip so they are noted as intentionally excluded with rationale).
 *   3. respondStoreState - missing-store 400 guard, mirror-not-installed 503
 *      (reader returns null), store-read-failed 500 (__error branch).
 *   4. POST /cookie-jar-list dispatch wiring - the eval-disabled 403 guard, and
 *      that the route is reachable with NO main window at all (it is dispatched
 *      before the CDP-attached gate, deliberately, per the comment in
 *      handleRequest - reading a jar's cookies needs no CDP round trip, so
 *      gating it behind the debugger would break the rig whenever DevTools is
 *      open). The route's own request-shape validation and 200 envelope are
 *      covered separately in cookie-jar-routes.test.ts; these two tests pin
 *      only the dispatcher-level wiring around it.
 *
 * Mocks `electron` because inspection-server.ts imports `app.getVersion()`.
 * The `attachDebugger` function in cdp.ts also calls `debugger.attach()`,
 * `debugger.on()`, and fires `Console.enable` / `DOM.enable` etc. via
 * `sendCommand` - all silenced by the stub.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import * as http from 'node:http';

// electron mock must come before any devtools imports that transitively
// pull in electron (app.getVersion(), type BrowserWindow, etc.)
vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '0.0.0') },
}));

import {
  startInspectionServer,
  stopInspectionServer,
} from '../../src/devtools/main/inspection-server';
import { attachDebugger } from '../../src/devtools/main/cdp';
import type { BrowserWindow } from 'electron';

// ---------------------------------------------------------------------------
// Helpers: fake debugger + fake BrowserWindow
// ---------------------------------------------------------------------------

type DebuggerEventListener = (event: unknown, method: string, params: unknown) => void;
type DebuggerDetachListener = (event: unknown, reason: string) => void;

interface StubDebugger {
  /** Controls the next sendCommand return value for a given method. */
  responses: Map<string, unknown>;
  /** Records all sendCommand calls. */
  calls: Array<{ method: string; params: unknown }>;
  attach: ReturnType<typeof vi.fn>;
  detach: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
  sendCommand: (method: string, params?: unknown) => Promise<unknown>;
}

function buildStubDebugger(): StubDebugger {
  const responses = new Map<string, unknown>();
  const calls: Array<{ method: string; params: unknown }> = [];
  const listeners: Map<string, Set<DebuggerEventListener | DebuggerDetachListener>> = new Map();

  const sendCommand = async (method: string, params?: unknown): Promise<unknown> => {
    calls.push({ method, params: params ?? null });
    if (responses.has(method)) {
      const value = responses.get(method);
      if (value instanceof Error) throw value;
      return value;
    }
    // Default no-op returns for domain-enable commands that fire on attach.
    if (
      method === 'Console.enable' ||
      method === 'DOM.enable' ||
      method === 'Runtime.enable' ||
      method === 'CSS.enable'
    ) {
      return {};
    }
    return {};
  };

  const onFn = vi.fn((event: string, listener: unknown) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event)!.add(listener as DebuggerEventListener);
  });

  const removeListenerFn = vi.fn((event: string, listener: unknown) => {
    listeners.get(event)?.delete(listener as DebuggerEventListener);
  });

  return {
    responses,
    calls,
    attach: vi.fn(),
    detach: vi.fn(),
    on: onFn,
    removeListener: removeListenerFn,
    sendCommand,
  };
}

function buildFakeBrowserWindow(stubDebugger: StubDebugger): BrowserWindow {
  const fakeWebContents = {
    debugger: stubDebugger,
  };
  return {
    webContents: fakeWebContents,
    isDestroyed: vi.fn(() => false),
  } as unknown as BrowserWindow;
}

// ---------------------------------------------------------------------------
// HTTP helper: fire one request against the test server
// ---------------------------------------------------------------------------

interface RequestOptions {
  method?: string;
  path: string;
  body?: unknown;
}

interface JsonResponse {
  status: number;
  body: unknown;
}

function httpRequest(port: number, options: RequestOptions): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const rawBody = options.body !== undefined ? JSON.stringify(options.body) : undefined;
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: options.path,
        method: options.method ?? 'GET',
        headers: rawBody
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(rawBody) }
          : undefined,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let parsedBody: unknown;
          try {
            parsedBody = JSON.parse(raw);
          } catch {
            parsedBody = raw;
          }
          resolve({ status: response.statusCode ?? 0, body: parsedBody });
        });
        response.on('error', reject);
      },
    );
    request.on('error', reject);
    if (rawBody) request.write(rawBody);
    request.end();
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('inspection-server handler behaviors', () => {
  let serverPort = 0;
  let fakeWindow: BrowserWindow;
  let stubDebugger: StubDebugger;

  beforeAll(async () => {
    stubDebugger = buildStubDebugger();
    fakeWindow = buildFakeBrowserWindow(stubDebugger);
    // Registers fakeWindow in cdp.ts's WeakMap so isDebuggerAttached returns true.
    attachDebugger(fakeWindow);

    const port = await startInspectionServer({
      getMainWindow: () => fakeWindow,
      getEvalEnabled: () => true, // individual tests override via the script body
      getSessionManager: () => null,
      getProjectRoot: () => null,
      getIpcContext: () => null,
      getProjectId: () => null,
    });
    expect(port).not.toBeNull();
    serverPort = port!;
  });

  afterAll(() => {
    stopInspectionServer();
  });

  afterEach(() => {
    // Clear per-test debugger responses and call history between tests.
    stubDebugger.responses.clear();
    stubDebugger.calls.length = 0;
  });

  // -------------------------------------------------------------------------
  // 1. runScriptStep `eval` case
  // -------------------------------------------------------------------------

  describe('POST /script - eval step', () => {
    it('eval step when eval is disabled throws and trace entry is ok:false', async () => {
      // To test the eval-disabled path without restarting the server, we POST
      // with an eval step and observe that the server's getEvalEnabled logic
      // is the guard. However our shared server has getEvalEnabled: () => true.
      //
      // We instead test via the POST /eval route (which shares the same guard)
      // to confirm the guard path, and separately test the eval step's error
      // propagation below. The eval-disabled path in runScriptStep is exactly
      // `if (!options.getEvalEnabled()) throw new Error('eval step requires ...')`.
      //
      // To cover this branch we start a second server instance with eval off,
      // test it, then stop it immediately (servers bind on port 0 so no conflict).
      stopInspectionServer();
      const disabledPort = await startInspectionServer({
        getMainWindow: () => fakeWindow,
        getEvalEnabled: () => false,
        getSessionManager: () => null,
        getProjectRoot: () => null,
        getIpcContext: () => null,
        getProjectId: () => null,
      });
      expect(disabledPort).not.toBeNull();

      const response = await httpRequest(disabledPort!, {
        method: 'POST',
        path: '/script',
        body: {
          steps: [{ type: 'eval', expression: '1 + 1' }],
        },
      });

      // The script endpoint always returns 200 with a trace.
      expect(response.status).toBe(200);
      const responseBody = response.body as { trace: Array<{ ok: boolean; error?: string; type: string }> };
      expect(responseBody.trace).toHaveLength(1);
      expect(responseBody.trace[0].ok).toBe(false);
      expect(responseBody.trace[0].error).toContain('previewEvalEnabled');
      expect(responseBody.trace[0].type).toBe('eval');

      // Restore the shared eval-enabled server for subsequent tests.
      stopInspectionServer();
      const restoredPort = await startInspectionServer({
        getMainWindow: () => fakeWindow,
        getEvalEnabled: () => true,
        getSessionManager: () => null,
        getProjectRoot: () => null,
        getIpcContext: () => null,
        getProjectId: () => null,
      });
      serverPort = restoredPort!;
    });

    it('eval step with missing expression throws and trace entry is ok:false', async () => {
      const response = await httpRequest(serverPort, {
        method: 'POST',
        path: '/script',
        body: {
          steps: [{ type: 'eval' }], // no expression field
        },
      });
      expect(response.status).toBe(200);
      const responseBody = response.body as { trace: Array<{ ok: boolean; error?: string; type: string }> };
      expect(responseBody.trace).toHaveLength(1);
      expect(responseBody.trace[0].ok).toBe(false);
      expect(responseBody.trace[0].error).toContain('expression');
      expect(responseBody.trace[0].type).toBe('eval');
    });

    it('eval step where runtimeEvaluate returns an error propagates as ok:false', async () => {
      // Runtime.evaluate returns an exceptionDetails shape, which runtimeEvaluate
      // translates to { value: null, error: 'some error text' }.
      stubDebugger.responses.set('Runtime.evaluate', {
        result: { value: undefined },
        exceptionDetails: { text: 'ReferenceError: foo is not defined' },
      });

      const response = await httpRequest(serverPort, {
        method: 'POST',
        path: '/script',
        body: {
          steps: [{ type: 'eval', expression: 'foo' }],
        },
      });
      expect(response.status).toBe(200);
      const responseBody = response.body as { trace: Array<{ ok: boolean; error?: string; type: string }> };
      expect(responseBody.trace).toHaveLength(1);
      expect(responseBody.trace[0].ok).toBe(false);
      expect(responseBody.trace[0].error).toContain('ReferenceError');
    });

    it('eval step happy path: trace entry is ok:true and carries the evaluated value', async () => {
      // runtimeEvaluate uses Runtime.evaluate with returnByValue:true.
      // On success, it returns { value: <deserialized>, error: null }.
      stubDebugger.responses.set('Runtime.evaluate', {
        result: { value: 42 },
        exceptionDetails: undefined,
      });

      const response = await httpRequest(serverPort, {
        method: 'POST',
        path: '/script',
        body: {
          steps: [{ type: 'eval', expression: '6 * 7' }],
        },
      });
      expect(response.status).toBe(200);
      const responseBody = response.body as { trace: Array<{ ok: boolean; value?: unknown; type: string }> };
      expect(responseBody.trace).toHaveLength(1);
      expect(responseBody.trace[0].ok).toBe(true);
      // Core new behavior: the value from runtimeEvaluate propagates through
      // runScriptStep -> respondScript's trace spread as the `value` field.
      expect(responseBody.trace[0].value).toBe(42);
    });

    it('non-eval steps do NOT carry a value field in the trace entry', async () => {
      // A `wait` step should produce a trace entry with no `value` field at all.
      const response = await httpRequest(serverPort, {
        method: 'POST',
        path: '/script',
        body: {
          steps: [{ type: 'wait', ms: 1 }],
        },
      });
      expect(response.status).toBe(200);
      const responseBody = response.body as { trace: Array<Record<string, unknown>> };
      expect(responseBody.trace).toHaveLength(1);
      expect(responseBody.trace[0].ok).toBe(true);
      // `value` must be absent - not null, not undefined, but not present.
      expect('value' in responseBody.trace[0]).toBe(false);
    });

    it('eval step happy path with a null return value: trace carries value:null', async () => {
      // runtimeEvaluate returns { value: null, error: null } when the expression
      // evaluates to null (result.value is undefined in CDP, so runtimeEvaluate
      // coerces it to null). The trace entry should still carry `value: null`.
      stubDebugger.responses.set('Runtime.evaluate', {
        result: { value: undefined },
        exceptionDetails: undefined,
      });

      const response = await httpRequest(serverPort, {
        method: 'POST',
        path: '/script',
        body: {
          steps: [{ type: 'eval', expression: 'null' }],
        },
      });
      expect(response.status).toBe(200);
      const responseBody = response.body as { trace: Array<Record<string, unknown>> };
      expect(responseBody.trace[0].ok).toBe(true);
      // null evaluates via runtimeEvaluate to null; JSON round-trip keeps it null.
      expect(responseBody.trace[0].value).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // 2. respondQueryAll / respondBoundingBoxAll - missing-selector 400 guard
  // -------------------------------------------------------------------------

  describe('GET /query-all - missing-selector 400 guard', () => {
    it('returns 400 missing-selector when selector param is absent', async () => {
      const response = await httpRequest(serverPort, {
        path: '/query-all',
      });
      expect(response.status).toBe(400);
      const responseBody = response.body as { ok: boolean; error: { kind: string; detail: string } };
      expect(responseBody.ok).toBe(false);
      expect(responseBody.error.kind).toBe('missing-selector');
    });
  });

  describe('GET /bounding-box-all - missing-selector 400 guard', () => {
    it('returns 400 missing-selector when selector param is absent', async () => {
      const response = await httpRequest(serverPort, {
        path: '/bounding-box-all',
      });
      expect(response.status).toBe(400);
      const responseBody = response.body as { ok: boolean; error: { kind: string; detail: string } };
      expect(responseBody.ok).toBe(false);
      expect(responseBody.error.kind).toBe('missing-selector');
    });
  });

  describe('GET /query-all - evaluate-failed envelope', () => {
    it('returns 500 evaluate-failed when runtimeEvaluate reports an error', async () => {
      // `queryAllElements` calls runtimeEvaluate which calls Runtime.evaluate.
      // When CDP reports exceptionDetails, runtimeEvaluate returns { error: '...' }.
      // respondQueryAllVariant must surface that as a 500 evaluate-failed.
      stubDebugger.responses.set('Runtime.evaluate', {
        result: { value: undefined },
        exceptionDetails: { text: 'SyntaxError: invalid selector' },
      });

      const response = await httpRequest(serverPort, {
        path: '/query-all?selector=.test',
      });
      expect(response.status).toBe(500);
      const responseBody = response.body as { ok: boolean; error: { kind: string } };
      expect(responseBody.ok).toBe(false);
      expect(responseBody.error.kind).toBe('evaluate-failed');
    });
  });

  describe('GET /query-all - query-failed envelope', () => {
    it('returns 500 query-failed when runtimeEvaluate returns null value', async () => {
      // When Runtime.evaluate succeeds but returns no value (null), queryAllElements
      // returns { value: null, error: null } and respondQueryAllVariant returns
      // the `query-failed` 500 envelope.
      stubDebugger.responses.set('Runtime.evaluate', {
        result: { value: null },
        exceptionDetails: undefined,
      });

      const response = await httpRequest(serverPort, {
        path: '/query-all?selector=.no-match',
      });
      expect(response.status).toBe(500);
      const responseBody = response.body as { ok: boolean; error: { kind: string } };
      expect(responseBody.ok).toBe(false);
      expect(responseBody.error.kind).toBe('query-failed');
    });
  });

  // -------------------------------------------------------------------------
  // 3. respondStoreState - missing-store, mirror-not-installed, store-read-failed
  // -------------------------------------------------------------------------

  describe('GET /store-state - missing-store 400 guard', () => {
    it('returns 400 missing-store when store param is absent', async () => {
      // This guard fires BEFORE any window/CDP check, so it is reachable
      // regardless of window state.
      const response = await httpRequest(serverPort, {
        path: '/store-state',
      });
      expect(response.status).toBe(400);
      const responseBody = response.body as { ok: boolean; error: { kind: string; detail: string } };
      expect(responseBody.ok).toBe(false);
      expect(responseBody.error.kind).toBe('missing-store');
      expect(responseBody.error.detail).toContain('store');
    });
  });

  describe('GET /store-state - mirror-not-installed 503', () => {
    it('returns 503 mirror-not-installed when the reader function returns null', async () => {
      // The expression evaluated via Runtime.evaluate returns null when
      // window.__kangenticPreviewStoreState is not a function yet.
      // runtimeEvaluate translates a CDP result.value of null to { value: null }.
      // respondStoreState then returns the mirror-not-installed error.
      stubDebugger.responses.set('Runtime.evaluate', {
        result: { value: null },
        exceptionDetails: undefined,
      });

      const response = await httpRequest(serverPort, {
        path: '/store-state?store=board',
      });
      expect(response.status).toBe(503);
      const responseBody = response.body as { ok: boolean; error: { kind: string } };
      expect(responseBody.ok).toBe(false);
      expect(responseBody.error.kind).toBe('mirror-not-installed');
    });
  });

  describe('GET /store-state - store-read-failed 500', () => {
    it('returns 500 store-read-failed when the reader returns a __error envelope', async () => {
      // When window.__kangenticPreviewStoreState is installed and throws internally,
      // the IIFE wrapping in the expression catches the error and returns
      // { __error: String(error) }. respondStoreState detects the __error key
      // and returns the store-read-failed 500 envelope.
      stubDebugger.responses.set('Runtime.evaluate', {
        result: { value: { __error: 'getState threw: Cannot read properties of null' } },
        exceptionDetails: undefined,
      });

      const response = await httpRequest(serverPort, {
        path: '/store-state?store=board',
      });
      expect(response.status).toBe(500);
      const responseBody = response.body as { ok: boolean; error: { kind: string; detail: string } };
      expect(responseBody.ok).toBe(false);
      expect(responseBody.error.kind).toBe('store-read-failed');
      expect(responseBody.error.detail).toContain('getState threw');
    });
  });

  describe('GET /store-state - happy path', () => {
    it('returns 200 with the store state when the reader succeeds', async () => {
      // The reader returns a StoreStateResult-shaped object. When no __error
      // is present and value is not null, respondStoreState returns it directly.
      const fakeStoreResult = { store: 'board', path: null, available: ['board', 'session'], value: { taskCount: 3 } };
      stubDebugger.responses.set('Runtime.evaluate', {
        result: { value: fakeStoreResult },
        exceptionDetails: undefined,
      });

      const response = await httpRequest(serverPort, {
        path: '/store-state?store=board',
      });
      expect(response.status).toBe(200);
      const responseBody = response.body as Record<string, unknown>;
      expect(responseBody.store).toBe('board');
      expect(responseBody.value).toEqual({ taskCount: 3 });
    });
  });

  // -------------------------------------------------------------------------
  // 4. POST /cookie-jar-list - dispatch wiring
  // -------------------------------------------------------------------------

  describe('POST /cookie-jar-list - dispatch wiring', () => {
    it('returns 403 eval-disabled when Allow Unsafe Operations is off', async () => {
      stopInspectionServer();
      let disabledPort: number | null = null;
      try {
        disabledPort = await startInspectionServer({
          getMainWindow: () => fakeWindow,
          getEvalEnabled: () => false,
          getSessionManager: () => null,
          getProjectRoot: () => null,
          getIpcContext: () => null,
          getProjectId: () => null,
        });
        expect(disabledPort).not.toBeNull();

        const response = await httpRequest(disabledPort!, {
          method: 'POST',
          path: '/cookie-jar-list',
          body: { partition: 'persist:kng-aaaa-bbbb' },
        });
        expect(response.status).toBe(403);
        const responseBody = response.body as { ok: boolean; error: { kind: string; detail: string } };
        expect(responseBody.ok).toBe(false);
        expect(responseBody.error.kind).toBe('eval-disabled');
        expect(responseBody.error.detail).toContain('Allow Unsafe Operations');
      } finally {
        // Restore the shared eval-enabled server for subsequent tests, even if
        // an assertion above threw - a bare stop/start with no finally here
        // would leave the shared `activeOptions` binding pointed at a dead
        // server and cascade a failure into every later test in the file.
        stopInspectionServer();
        const restoredPort = await startInspectionServer({
          getMainWindow: () => fakeWindow,
          getEvalEnabled: () => true,
          getSessionManager: () => null,
          getProjectRoot: () => null,
          getIpcContext: () => null,
          getProjectId: () => null,
        });
        serverPort = restoredPort!;
      }
    });

    it('is reachable with no main window at all, because it is dispatched BEFORE the CDP-attached gate', async () => {
      stopInspectionServer();
      let noWindowPort: number | null = null;
      try {
        noWindowPort = await startInspectionServer({
          getMainWindow: () => null,
          getEvalEnabled: () => true,
          getSessionManager: () => null,
          getProjectRoot: () => null,
          getIpcContext: () => null,
          getProjectId: () => null,
        });
        expect(noWindowPort).not.toBeNull();

        // A request with no `partition` field reaches respondCookieJar's OWN
        // validation (400 missing-target) rather than the window/CDP gate's
        // 503 no-main-window - proving this route never falls through to the
        // CDP-backed dispatch below it. If the cookie-jar block were ever
        // moved after the `if (!window)` check, this would instead see 503
        // no-main-window.
        const response = await httpRequest(noWindowPort!, {
          method: 'POST',
          path: '/cookie-jar-list',
          body: {},
        });
        expect(response.status).toBe(400);
        const responseBody = response.body as { ok: boolean; error: { kind: string } };
        expect(responseBody.ok).toBe(false);
        expect(responseBody.error.kind).toBe('missing-target');
      } finally {
        stopInspectionServer();
        const restoredPort = await startInspectionServer({
          getMainWindow: () => fakeWindow,
          getEvalEnabled: () => true,
          getSessionManager: () => null,
          getProjectRoot: () => null,
          getIpcContext: () => null,
          getProjectId: () => null,
        });
        serverPort = restoredPort!;
      }
    });
  });
});
