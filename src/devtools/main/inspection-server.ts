import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { app, type BrowserWindow } from 'electron';
import {
  clickAtCenterOfSelector,
  dispatchKeyEvent,
  dispatchKeypress,
  dispatchMouseEvent,
  dragFromTo,
  getAccessibilityTree,
  getBoundingBox,
  getBoundingBoxByNodeId,
  getComputedStyle,
  getConsoleEntries,
  getLayoutMetrics,
  getOuterHtml,
  getOuterHtmlByNodeId,
  isDebuggerAttached,
  queryAllElements,
  resolveSelectorPublic,
  runtimeEvaluate,
  typeText,
} from './cdp';
import {
  captureElementClip,
  captureScreenshotWithBudget,
  configureScreenshotProjectRoot,
  type ScreenshotCaptureOptions,
} from './screenshot';
// `commandHandlers` and `buildCommandContextForProject` are loaded lazily
// inside respondCommand. Eagerly importing them at module top would pull
// the full agent/analytics import graph into every consumer of this
// file, including unit tests that transitively load
// `notifyDevtoolsRefresh` via applyRuntimeConfig - those tests then blow
// up on aptabase's `import { ipcMain } from 'electron'` because their
// own `vi.mock('electron', ...)` only takes effect for their own module
// graph. The cost of the lazy import is one microtask per /command call.
import type { IpcContext } from '../../main/ipc/ipc-context';
import { getProcessMetrics } from '../../main/diagnostics/process-metrics';
import { getEventLoopLagReport } from '../../main/diagnostics/event-loop-lag';
import type { SessionManager } from '../../main/pty/session-manager';

/**
 * Localhost-only HTTP inspection bridge. Bound to a random port via
 * `.listen(0)` so multiple preview instances on the same machine never
 * collide. The port is published into the per-worktree lockfile so
 * external tools can discover it.
 *
 * No auth: localhost-bound is the boundary. Production builds drop this
 * entire module via `__KANGENTIC_DEV__` dead-code elimination, so the
 * server cannot be enabled in shipped binaries.
 *
 * Endpoint dispatch is a flat `if/else` ladder rather than a router
 * library - the surface is small enough that the explicit form is
 * easier to grep than a registration DSL.
 */

interface InspectionServerOptions {
  getMainWindow: () => BrowserWindow | null;
  getEvalEnabled: () => boolean;
  getSessionManager: () => SessionManager | null;
  getProjectRoot: () => string | null;
  getIpcContext: () => IpcContext | null;
  getProjectId: () => string | null;
}

let server: http.Server | null = null;
let boundPort: number | null = null;
let activeOptions: InspectionServerOptions | null = null;

export async function startInspectionServer(
  options: InspectionServerOptions,
): Promise<number | null> {
  if (server !== null) return boundPort;
  activeOptions = options;
  configureScreenshotProjectRoot(() => options.getProjectRoot());

  const httpServer = http.createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      respondError(response, 500, 'internal-error', error instanceof Error ? error.message : String(error));
    });
  });

  return new Promise((resolve) => {
    httpServer.on('error', () => {
      server = null;
      boundPort = null;
      resolve(null);
    });
    httpServer.listen(0, '127.0.0.1', () => {
      const address = httpServer.address();
      if (typeof address === 'object' && address !== null && 'port' in address) {
        server = httpServer;
        boundPort = address.port;
        resolve(boundPort);
      } else {
        resolve(null);
      }
    });
  });
}

export function stopInspectionServer(): void {
  if (server) {
    closeInspectionServerSafely(server);
    server = null;
    boundPort = null;
    activeOptions = null;
  }
}

/**
 * Synchronous, best-effort shutdown for the inspection server. See
 * `closeMcpHttpServerSafely` in mcp-http-server.ts for the full
 * keep-alive-zombie rationale -- the contract is identical.
 *
 * Exported so unit tests can verify the call ordering without booting
 * the full inspection-server module (it transitively pulls in CDP,
 * screenshot, and the agent commands map).
 */
export function closeInspectionServerSafely(httpServer: Pick<http.Server, 'closeAllConnections' | 'close'>): void {
  try {
    httpServer.closeAllConnections();
    httpServer.close();
  } catch {
    // best-effort
  }
}

async function handleRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  const options = activeOptions;
  if (!options) {
    return respondError(response, 503, 'not-installed', 'Inspection server is not active.');
  }
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const method = request.method ?? 'GET';
  const route = `${method} ${url.pathname}`;

  if (route === 'GET /info') {
    return respondJson(response, 200, buildInfo(options));
  }

  if (route === 'GET /process-metrics') {
    return respondJson(response, 200, getProcessMetrics());
  }

  if (route === 'GET /event-loop-lag') {
    return respondEventLoopLag(options, response);
  }

  if (route === 'GET /pty-pipeline') {
    return respondPtyPipeline(options, response);
  }

  if (route === 'GET /logs') {
    return respondLogs(options, url, response);
  }

  if (route === 'GET /crashes') {
    return respondCrashes(options, url, response);
  }

  if (route === 'GET /ipc-log') {
    return respondIpcLog(options, url, response);
  }

  if (route === 'GET /engine-state') {
    return respondEngineState(options, url, response);
  }

  if (route === 'GET /renderer-state') {
    return respondRendererState(options, response);
  }

  if (route === 'GET /store-state') {
    return respondStoreState(options, url, response);
  }

  if (route === 'GET /console') {
    return respondConsole(options, url, response);
  }

  // CDP-backed endpoints from this point on need a main window AND an
  // attached debugger. The debugger can be externally detached at any
  // time (most commonly: the user opened DevTools, which steals the
  // connection). Fail fast with an actionable error instead of letting
  // each endpoint reject with a generic "not attached" message.
  const window = options.getMainWindow();
  if (!window) {
    return respondError(response, 503, 'no-main-window', 'Main window is not available yet.');
  }
  if (!isDebuggerAttached(window)) {
    return respondError(
      response,
      503,
      'cdp-not-attached',
      'Chrome DevTools Protocol is not currently attached to the main window. Close DevTools (if open) and toggle Settings -> Developer -> Preview Inspection Server off and on to re-attach.',
    );
  }

  if (route === 'GET /screenshot') {
    return respondScreenshot(window, url, response);
  }

  if (route === 'GET /screenshot-element') {
    return respondScreenshotElement(window, url, response);
  }

  if (route === 'GET /dom') {
    return respondDom(window, url, response);
  }

  if (route === 'GET /computed-style') {
    return respondComputedStyle(window, url, response);
  }

  if (route === 'GET /bounding-box') {
    return respondBoundingBox(window, url, response);
  }

  if (route === 'GET /query-all') {
    return respondQueryAll(window, url, response);
  }

  if (route === 'GET /bounding-box-all') {
    return respondBoundingBoxAll(window, url, response);
  }

  if (route === 'GET /accessibility-tree') {
    const tree = await getAccessibilityTree(window);
    return respondJson(response, 200, tree ?? { nodes: [] });
  }

  if (route === 'GET /react-component') {
    return respondReactComponent(window, url, response);
  }

  if (route === 'GET /react-tree') {
    return respondReactTree(window, url, response);
  }

  if (route === 'GET /react-recent-renders') {
    return respondReactRecentRenders(window, url, response);
  }

  if (route === 'GET /mutations') {
    return respondMutations(window, url, response);
  }

  if (method === 'POST') {
    return handlePostRequest(route, options, window, request, response);
  }

  return respondError(response, 404, 'unknown-route', route);
}

async function handlePostRequest(
  route: string,
  options: InspectionServerOptions,
  window: BrowserWindow,
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  const body = await readJsonBody(request);
  if (body === null) {
    return respondError(response, 400, 'invalid-json', 'Request body must be valid JSON.');
  }

  if (route === 'POST /click') {
    return respondClick(window, body, response);
  }

  if (route === 'POST /type') {
    return respondType(window, body, response);
  }

  if (route === 'POST /keypress') {
    return respondKeypress(window, body, response);
  }

  if (route === 'POST /drag') {
    return respondDrag(window, body, response);
  }

  if (route === 'POST /wait') {
    return respondWait(window, body, response);
  }

  if (route === 'POST /script') {
    return respondScript(options, window, body, response);
  }

  if (route === 'POST /command') {
    return respondCommand(options, body, response);
  }

  if (route === 'POST /pty-input') {
    return respondPtyInput(options, body, response);
  }

  if (route === 'POST /eval') {
    if (!options.getEvalEnabled()) {
      return respondError(
        response,
        403,
        'eval-disabled',
        'Settings → Developer → Allow Eval is off.',
      );
    }
    return respondEval(window, body, response);
  }

  if (route === 'POST /inject-session-event') {
    if (!options.getEvalEnabled()) {
      return respondError(
        response,
        403,
        'eval-disabled',
        'Settings → Developer → Allow Eval is off (gates session-event injection).',
      );
    }
    return respondInjectSessionEvent(options, body, response);
  }

  if (route === 'POST /capture-trace') {
    return respondCaptureTrace(options, body, response);
  }

  return respondError(response, 404, 'unknown-route', route);
}

// ---------------------------------------------------------------------------
// /info
// ---------------------------------------------------------------------------

function buildInfo(options: InspectionServerOptions): Record<string, unknown> {
  const sessionManager = options.getSessionManager();
  const sessionIds = sessionManager
    ? sessionManager.listSessions().map((session) => session.id)
    : [];
  return {
    pid: process.pid,
    port: boundPort ?? 0,
    sessionIds,
    ts: new Date().toISOString(),
    evalEnabled: options.getEvalEnabled(),
    mainWindowAttached: options.getMainWindow() !== null,
    kangenticVersion: app.getVersion(),
    worktreePath: options.getProjectRoot() ?? null,
  };
}

// ---------------------------------------------------------------------------
// Product diagnostics passthroughs
// ---------------------------------------------------------------------------

interface JsonLineFilter {
  since?: string;
  level?: string;
  source?: string;
  channel?: string;
  limit: number;
}

function respondLogs(
  options: InspectionServerOptions,
  url: URL,
  response: http.ServerResponse,
): void {
  const projectRoot = options.getProjectRoot();
  if (!projectRoot) {
    return respondJson(response, 200, []);
  }
  const date = url.searchParams.get('date') ?? today();
  const filter: JsonLineFilter = {
    since: url.searchParams.get('since') ?? undefined,
    level: url.searchParams.get('level') ?? undefined,
    source: url.searchParams.get('source') ?? undefined,
    limit: clampLimit(url.searchParams.get('limit'), 200, 2000),
  };
  const file = path.join(projectRoot, '.kangentic', 'logs', `${date}.log`);
  const entries = readJsonLines<Record<string, unknown>>(file);
  const filtered = entries.filter((entry) => {
    if (filter.since && typeof entry.ts === 'string' && entry.ts < filter.since) return false;
    if (filter.level && entry.level !== filter.level) return false;
    if (filter.source && entry.source !== filter.source) return false;
    return true;
  });
  respondJson(response, 200, filtered.slice(-filter.limit));
}

function respondCrashes(
  options: InspectionServerOptions,
  url: URL,
  response: http.ServerResponse,
): void {
  const projectRoot = options.getProjectRoot();
  if (!projectRoot) return respondJson(response, 200, []);
  const directory = path.join(projectRoot, '.kangentic', 'logs', 'crashes');
  let files: string[];
  try {
    files = fs.readdirSync(directory).filter((name) => name.endsWith('.json'));
  } catch {
    return respondJson(response, 200, []);
  }
  files.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  const since = url.searchParams.get('since') ?? undefined;
  const limit = clampLimit(url.searchParams.get('limit'), 10, 50);
  const records: unknown[] = [];
  for (const name of files) {
    if (records.length >= limit) break;
    try {
      const raw = fs.readFileSync(path.join(directory, name), 'utf-8');
      const record = JSON.parse(raw) as { ts?: string };
      if (since && record.ts && record.ts < since) continue;
      records.push(record);
    } catch {
      // Skip corrupt file
    }
  }
  respondJson(response, 200, records);
}

function respondIpcLog(
  options: InspectionServerOptions,
  url: URL,
  response: http.ServerResponse,
): void {
  const projectRoot = options.getProjectRoot();
  if (!projectRoot) return respondJson(response, 200, []);
  const date = url.searchParams.get('date') ?? today();
  const filter: JsonLineFilter = {
    since: url.searchParams.get('since') ?? undefined,
    channel: url.searchParams.get('channel') ?? undefined,
    limit: clampLimit(url.searchParams.get('limit'), 200, 2000),
  };
  const file = path.join(projectRoot, '.kangentic', 'logs', `ipc-${date}.jsonl`);
  const entries = readJsonLines<Record<string, unknown>>(file);
  const filtered = entries.filter((entry) => {
    if (filter.since && typeof entry.ts === 'string' && entry.ts < filter.since) return false;
    if (filter.channel && entry.channel !== filter.channel) return false;
    return true;
  });
  respondJson(response, 200, filtered.slice(-filter.limit));
}

// ---------------------------------------------------------------------------
// Engine state (live, in-memory)
// ---------------------------------------------------------------------------

function respondEngineState(
  options: InspectionServerOptions,
  url: URL,
  response: http.ServerResponse,
): void {
  const sessionManager = options.getSessionManager();
  if (!sessionManager) {
    return respondError(response, 503, 'no-session-manager', 'SessionManager is not available.');
  }
  // SessionManager exposes the active engine via session-manager + telemetry
  // accessors. We surface the per-session ActivityStatsSnapshot through the
  // existing IPC channels (session:getActivityStats); reuse the same code
  // path here by reaching into the telemetry directly. Defensive null
  // checks keep this resilient to API drift.
  type EngineHolder = {
    telemetry?: { activityEngine?: { getStatsSnapshot(id: string): unknown } };
  };
  const holder = sessionManager as unknown as EngineHolder;
  const engine = holder.telemetry?.activityEngine;
  if (!engine || typeof engine.getStatsSnapshot !== 'function') {
    return respondError(response, 503, 'no-engine', 'Activity engine is not exposed.');
  }
  const sessionIdParam = url.searchParams.get('sessionId');
  if (sessionIdParam) {
    return respondJson(response, 200, engine.getStatsSnapshot(sessionIdParam));
  }
  const out: Record<string, unknown> = {};
  for (const session of sessionManager.listSessions()) {
    out[session.id] = engine.getStatsSnapshot(session.id);
  }
  respondJson(response, 200, out);
}

// ---------------------------------------------------------------------------
// Performance diagnostics (freeze flight recorder + terminal pipeline)
// ---------------------------------------------------------------------------

/**
 * Event-loop lag for BOTH processes: the main-process report is always
 * available (in-process); the renderer report is a best-effort CDP read of the
 * `window.__kangenticLagReport` global, returning an `unavailable` marker when
 * the debugger is not attached or the recorder is not installed. Together they
 * are a retroactive freeze log - recorded stalls with timestamps + durations.
 */
async function respondEventLoopLag(
  options: InspectionServerOptions,
  response: http.ServerResponse,
): Promise<void> {
  const main = getEventLoopLagReport();
  let renderer: unknown = { unavailable: 'cdp-not-attached' };
  const window = options.getMainWindow();
  if (window && isDebuggerAttached(window)) {
    try {
      const result = await runtimeEvaluate(
        window,
        `(() => {
          const report = window.__kangenticLagReport;
          return typeof report === 'function' ? report() : null;
        })()`,
      );
      if (result.error) {
        renderer = { error: result.error };
      } else {
        renderer = result.value ?? { unavailable: 'recorder-not-installed' };
      }
    } catch (error) {
      renderer = { error: error instanceof Error ? error.message : String(error) };
    }
  }
  respondJson(response, 200, { ts: new Date().toISOString(), main, renderer });
}

/** Per-session terminal output-pipeline stats (in-process). Diagnoses
 *  terminal-driven lag: a paused session with high in-flight bytes or a
 *  ballooning pending buffer points at a flooding agent. */
function respondPtyPipeline(
  options: InspectionServerOptions,
  response: http.ServerResponse,
): void {
  const sessionManager = options.getSessionManager();
  if (!sessionManager) {
    return respondError(response, 503, 'no-session-manager', 'Session manager is not available.');
  }
  respondJson(response, 200, {
    ts: new Date().toISOString(),
    sessions: sessionManager.getPipelineStats(),
  });
}

// ---------------------------------------------------------------------------
// Renderer state (Runtime.evaluate'd window globals)
// ---------------------------------------------------------------------------

async function respondRendererState(
  options: InspectionServerOptions,
  response: http.ServerResponse,
): Promise<void> {
  const window = options.getMainWindow();
  if (!window) {
    return respondError(response, 503, 'no-main-window', 'Main window is not available yet.');
  }
  const result = await runtimeEvaluate(
    window,
    `(() => {
      const builder = window.__kangenticPreviewSnapshot;
      if (typeof builder !== 'function') return null;
      try {
        return builder();
      } catch (error) {
        return { error: String(error) };
      }
    })()`,
  );
  if (result.error) {
    return respondError(response, 500, 'evaluate-failed', result.error);
  }
  if (result.value === null) {
    return respondError(
      response,
      503,
      'mirror-not-installed',
      'window.__kangenticPreviewSnapshot is not installed yet.',
    );
  }
  respondJson(response, 200, result.value);
}

/**
 * Read a renderer Zustand store (optionally at `path`) via the dev-only
 * `window.__kangenticPreviewStoreState` reader. Mirrors
 * `respondRendererState`. An unknown store / missing path is reported as a
 * 200 whose body carries `error` + the `available` store list, so the
 * agent can self-correct (a 4xx would strip the extra fields at the MCP
 * bridge layer).
 */
async function respondStoreState(
  options: InspectionServerOptions,
  url: URL,
  response: http.ServerResponse,
): Promise<void> {
  const store = url.searchParams.get('store');
  if (!store) {
    return respondError(response, 400, 'missing-store', 'store query parameter is required.');
  }
  const requestedPath = url.searchParams.get('path') ?? '';
  const window = options.getMainWindow();
  if (!window) {
    return respondError(response, 503, 'no-main-window', 'Main window is not available yet.');
  }
  const expression = `(() => {
      const reader = window.__kangenticPreviewStoreState;
      if (typeof reader !== 'function') return null;
      try {
        return reader(${JSON.stringify(store)}, ${JSON.stringify(requestedPath)});
      } catch (error) {
        return { __error: String(error) };
      }
    })()`;
  const result = await runtimeEvaluate<{ __error?: string } | Record<string, unknown> | null>(
    window,
    expression,
  );
  if (result.error) {
    return respondError(response, 500, 'evaluate-failed', result.error);
  }
  if (result.value === null) {
    return respondError(
      response,
      503,
      'mirror-not-installed',
      'window.__kangenticPreviewStoreState is not installed yet.',
    );
  }
  if (typeof result.value === 'object' && result.value !== null && '__error' in result.value) {
    return respondError(response, 500, 'store-read-failed', String(result.value.__error));
  }
  respondJson(response, 200, result.value);
}

function respondConsole(
  options: InspectionServerOptions,
  url: URL,
  response: http.ServerResponse,
): void {
  const window = options.getMainWindow();
  if (!window) return respondJson(response, 200, []);
  const since = url.searchParams.get('since') ?? undefined;
  const level = url.searchParams.get('level') ?? undefined;
  const limit = clampLimit(url.searchParams.get('limit'), 100, 500);
  const entries = getConsoleEntries(window).filter((entry) => {
    if (since && entry.ts < since) return false;
    if (level && level !== 'all' && entry.level !== level) return false;
    return true;
  });
  respondJson(response, 200, entries.slice(-limit));
}

// ---------------------------------------------------------------------------
// CDP-backed endpoints
// ---------------------------------------------------------------------------

async function respondScreenshot(
  window: BrowserWindow,
  url: URL,
  response: http.ServerResponse,
): Promise<void> {
  const fullPage = url.searchParams.get('fullPage') === 'true';
  const formatParam = url.searchParams.get('format') as 'png' | 'jpeg' | null;
  const format = formatParam ?? (fullPage ? 'jpeg' : 'jpeg');
  const qualityParam = url.searchParams.get('quality');
  const defaultQuality = format === 'jpeg' ? (fullPage ? 75 : 80) : undefined;
  const quality = qualityParam ? Number.parseInt(qualityParam, 10) : defaultQuality;
  const maxBytesParam = url.searchParams.get('maxBytes') ?? url.searchParams.get('maxKb');
  const maxBytes = parseMaxBytes(maxBytesParam, url.searchParams.get('maxKb') !== null);
  const captureOptions: ScreenshotCaptureOptions = {
    format,
    quality,
    fullPage,
    maxBytes,
  };
  const result = await captureScreenshotWithBudget(window, captureOptions);
  if (!result) {
    return respondError(response, 500, 'screenshot-failed', 'Page.captureScreenshot returned no data.');
  }
  respondJson(response, 200, result);
}

async function respondScreenshotElement(
  window: BrowserWindow,
  url: URL,
  response: http.ServerResponse,
): Promise<void> {
  const selector = url.searchParams.get('selector');
  if (!selector) {
    return respondError(response, 400, 'missing-selector', 'selector query parameter is required.');
  }
  const formatParam = url.searchParams.get('format') as 'png' | 'jpeg' | null;
  const qualityParam = url.searchParams.get('quality');
  const maxBytesParam = url.searchParams.get('maxBytes') ?? url.searchParams.get('maxKb');
  const maxBytes = parseMaxBytes(maxBytesParam, url.searchParams.get('maxKb') !== null);
  const result = await captureElementClip(window, selector, {
    format: formatParam ?? 'png',
    quality: qualityParam ? Number.parseInt(qualityParam, 10) : undefined,
    maxBytes,
  });
  if (!result) {
    return respondError(response, 500, 'screenshot-failed', 'Element clip capture returned no data.');
  }
  if ('error' in result) {
    return respondError(response, 404, 'selector-not-found', `No element matched ${selector}.`);
  }
  respondJson(response, 200, result);
}

function parseMaxBytes(rawValue: string | null, isKb: boolean): number | undefined {
  if (!rawValue) return undefined;
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return isKb ? parsed * 1024 : parsed;
}

async function respondDom(
  window: BrowserWindow,
  url: URL,
  response: http.ServerResponse,
): Promise<void> {
  const selector = url.searchParams.get('selector') ?? 'html';
  const includeBox = url.searchParams.get('includeBox') === 'true';
  // Resolve the selector once so getOuterHTML and (optionally)
  // getBoxModel can target the same nodeId without paying for a second
  // DOM.getDocument + DOM.querySelector roundtrip.
  const nodeId = await resolveSelectorPublic(window, selector);
  if (!nodeId) {
    return respondError(response, 404, 'selector-not-found', `No element matched ${selector}.`);
  }
  const html = await getOuterHtmlByNodeId(window, nodeId);
  if (html === null) {
    return respondError(response, 404, 'selector-not-found', `No element matched ${selector}.`);
  }
  if (!includeBox) {
    return respondJson(response, 200, { selector, outerHTML: html });
  }
  const box = await getBoundingBoxByNodeId(window, nodeId);
  if (!box || !Array.isArray(box.content) || box.content.length < 8) {
    return respondJson(response, 200, { selector, outerHTML: html, box: null });
  }
  // Reduce the box quad to the {x,y,width,height} the agent actually
  // wants for click/screenshot follow-ups. The full quad is still
  // available via /bounding-box for callers that need the raw shape.
  const cornerXs = [box.content[0], box.content[2], box.content[4], box.content[6]];
  const cornerYs = [box.content[1], box.content[3], box.content[5], box.content[7]];
  const minX = Math.min(...cornerXs);
  const minY = Math.min(...cornerYs);
  const maxX = Math.max(...cornerXs);
  const maxY = Math.max(...cornerYs);
  respondJson(response, 200, {
    selector,
    outerHTML: html,
    box: {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
    },
  });
}

async function respondComputedStyle(
  window: BrowserWindow,
  url: URL,
  response: http.ServerResponse,
): Promise<void> {
  const selector = url.searchParams.get('selector');
  if (!selector) {
    return respondError(response, 400, 'missing-selector', 'selector query parameter is required.');
  }
  const styles = await getComputedStyle(window, selector);
  if (!styles) {
    return respondError(response, 404, 'selector-not-found', `No element matched ${selector}.`);
  }
  respondJson(response, 200, { selector, computedStyle: styles });
}

async function respondBoundingBox(
  window: BrowserWindow,
  url: URL,
  response: http.ServerResponse,
): Promise<void> {
  const selector = url.searchParams.get('selector');
  if (!selector) {
    return respondError(response, 400, 'missing-selector', 'selector query parameter is required.');
  }
  const box = await getBoundingBox(window, selector);
  if (!box) {
    return respondError(response, 404, 'selector-not-found', `No element matched ${selector}.`);
  }
  respondJson(response, 200, { selector, ...box });
}

async function respondQueryAll(
  window: BrowserWindow,
  url: URL,
  response: http.ServerResponse,
): Promise<void> {
  return respondQueryAllVariant(window, url, response, {
    includeHtml: url.searchParams.get('includeHtml') === 'true',
    includeAttributes: true,
    htmlMaxChars: 1024,
  });
}

async function respondBoundingBoxAll(
  window: BrowserWindow,
  url: URL,
  response: http.ServerResponse,
): Promise<void> {
  return respondQueryAllVariant(window, url, response, {
    includeHtml: false,
    includeAttributes: false,
    htmlMaxChars: 0,
  });
}

/**
 * Shared body for `/query-all` (rich: attributes, optional HTML) and
 * `/bounding-box-all` (lean: box + tag only). Both validate the selector,
 * clamp the limit, and measure every matching element in one round-trip;
 * they differ only in which per-element fields are collected.
 */
async function respondQueryAllVariant(
  window: BrowserWindow,
  url: URL,
  response: http.ServerResponse,
  fields: { includeHtml: boolean; includeAttributes: boolean; htmlMaxChars: number },
): Promise<void> {
  const selector = url.searchParams.get('selector');
  if (!selector) {
    return respondError(response, 400, 'missing-selector', 'selector query parameter is required.');
  }
  const limit = clampLimit(url.searchParams.get('limit'), 100, 1000);
  const result = await queryAllElements(window, selector, { ...fields, limit });
  if (result.error) {
    return respondError(response, 500, 'evaluate-failed', result.error);
  }
  if (!result.value) {
    return respondError(response, 500, 'query-failed', 'query-all returned no result.');
  }
  respondJson(response, 200, result.value);
}

async function respondReactComponent(
  window: BrowserWindow,
  url: URL,
  response: http.ServerResponse,
): Promise<void> {
  const selector = url.searchParams.get('selector');
  if (!selector) {
    return respondError(response, 400, 'missing-selector', 'selector query parameter is required.');
  }
  const result = await runtimeEvaluate(
    window,
    `(() => {
      const bridge = window.__kangenticPreviewReact;
      if (!bridge || typeof bridge.query !== 'function') return null;
      try {
        return bridge.query(${JSON.stringify(selector)});
      } catch (error) {
        return { error: String(error) };
      }
    })()`,
  );
  if (result.error) return respondError(response, 500, 'evaluate-failed', result.error);
  if (result.value === null) {
    return respondError(
      response,
      503,
      'react-bridge-not-installed',
      'window.__kangenticPreviewReact is not installed yet.',
    );
  }
  respondJson(response, 200, result.value);
}

async function respondReactTree(
  window: BrowserWindow,
  url: URL,
  response: http.ServerResponse,
): Promise<void> {
  const rootSelector = url.searchParams.get('rootSelector') ?? 'body';
  const maxDepth = clampLimit(url.searchParams.get('maxDepth'), 6, 20);
  const result = await runtimeEvaluate(
    window,
    `(() => {
      const bridge = window.__kangenticPreviewReact;
      if (!bridge || typeof bridge.tree !== 'function') return null;
      return bridge.tree(${JSON.stringify(rootSelector)}, ${maxDepth});
    })()`,
  );
  if (result.error) return respondError(response, 500, 'evaluate-failed', result.error);
  respondJson(response, 200, result.value ?? null);
}

async function respondReactRecentRenders(
  window: BrowserWindow,
  url: URL,
  response: http.ServerResponse,
): Promise<void> {
  const limit = clampLimit(url.searchParams.get('limit'), 50, 100);
  const result = await runtimeEvaluate(
    window,
    `(() => {
      const bridge = window.__kangenticPreviewReact;
      if (!bridge || typeof bridge.recentRenders !== 'function') return [];
      return bridge.recentRenders(${limit});
    })()`,
  );
  if (result.error) return respondError(response, 500, 'evaluate-failed', result.error);
  respondJson(response, 200, result.value ?? []);
}

async function respondMutations(
  window: BrowserWindow,
  url: URL,
  response: http.ServerResponse,
): Promise<void> {
  const sinceMs = Number.parseInt(url.searchParams.get('sinceMs') ?? '5000', 10);
  const result = await runtimeEvaluate(
    window,
    `(() => {
      const bridge = window.__kangenticPreviewMutations;
      if (typeof bridge !== 'function') return [];
      return bridge(${Number.isFinite(sinceMs) ? sinceMs : 5000});
    })()`,
  );
  if (result.error) return respondError(response, 500, 'evaluate-failed', result.error);
  respondJson(response, 200, result.value ?? []);
}

// ---------------------------------------------------------------------------
// Interaction (POST /click /type /keypress /drag /wait /script)
// ---------------------------------------------------------------------------

interface ClickBody {
  selector?: string;
  x?: number;
  y?: number;
  coordSpace?: 'viewport' | 'image';
}

async function respondClick(
  window: BrowserWindow,
  body: unknown,
  response: http.ServerResponse,
): Promise<void> {
  const click = body as ClickBody;
  if (typeof click.selector === 'string') {
    const ok = await clickAtCenterOfSelector(window, click.selector);
    if (!ok) {
      return respondError(response, 404, 'selector-not-found', `No element matched ${click.selector}.`);
    }
    return respondJson(response, 200, { ok: true });
  }
  if (typeof click.x === 'number' && typeof click.y === 'number') {
    const mapped = await mapClickCoordsToViewport(
      window,
      { x: click.x, y: click.y },
      click.coordSpace ?? 'viewport',
    );
    if (!mapped) {
      return respondError(
        response,
        500,
        'coord-mapping-failed',
        'Could not read deviceScaleFactor for image-space coordinate mapping.',
      );
    }
    await dispatchMouseEvent(window, { type: 'mousePressed', x: mapped.x, y: mapped.y });
    await dispatchMouseEvent(window, { type: 'mouseReleased', x: mapped.x, y: mapped.y });
    return respondJson(response, 200, {
      ok: true,
      coordSpace: click.coordSpace ?? 'viewport',
      dispatched: { x: mapped.x, y: mapped.y },
    });
  }
  return respondError(response, 400, 'missing-target', 'Provide either `selector` or both `x` and `y`.');
}

async function mapClickCoordsToViewport(
  window: BrowserWindow,
  point: { x: number; y: number },
  coordSpace: 'viewport' | 'image',
): Promise<{ x: number; y: number } | null> {
  if (coordSpace === 'viewport') return point;
  const layout = await getLayoutMetrics(window);
  if (!layout) return null;
  return {
    x: point.x / layout.deviceScaleFactor,
    y: point.y / layout.deviceScaleFactor,
  };
}

interface TypeBody {
  selector?: string;
  text: string;
  clearFirst?: boolean;
}

async function respondType(
  window: BrowserWindow,
  body: unknown,
  response: http.ServerResponse,
): Promise<void> {
  const params = body as TypeBody;
  if (typeof params.text !== 'string') {
    return respondError(response, 400, 'missing-text', '`text` is required.');
  }
  if (typeof params.selector === 'string') {
    const ok = await clickAtCenterOfSelector(window, params.selector);
    if (!ok) {
      return respondError(response, 404, 'selector-not-found', `No element matched ${params.selector}.`);
    }
    if (params.clearFirst) {
      await dispatchKeypress(window, 'Ctrl+a');
      await dispatchKeyEvent(window, { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
      await dispatchKeyEvent(window, { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    }
  }
  await typeText(window, params.text);
  respondJson(response, 200, { ok: true });
}

interface KeypressBody {
  keys: string;
}

async function respondKeypress(
  window: BrowserWindow,
  body: unknown,
  response: http.ServerResponse,
): Promise<void> {
  const params = body as KeypressBody;
  if (typeof params.keys !== 'string') {
    return respondError(response, 400, 'missing-keys', '`keys` is required.');
  }
  const ok = await dispatchKeypress(window, params.keys);
  if (!ok) {
    return respondError(response, 400, 'unknown-key', `Could not parse key combo: ${params.keys}.`);
  }
  respondJson(response, 200, { ok: true });
}

interface DragBody {
  fromSelector: string;
  toSelector: string;
  steps?: number;
}

async function respondDrag(
  window: BrowserWindow,
  body: unknown,
  response: http.ServerResponse,
): Promise<void> {
  const params = body as DragBody;
  if (typeof params.fromSelector !== 'string' || typeof params.toSelector !== 'string') {
    return respondError(
      response,
      400,
      'missing-selectors',
      '`fromSelector` and `toSelector` are required.',
    );
  }
  const ok = await dragFromTo(window, params.fromSelector, params.toSelector, {
    steps: params.steps,
  });
  if (!ok) {
    return respondError(response, 404, 'selector-not-found', 'Drag source or target selector did not match.');
  }
  respondJson(response, 200, { ok: true });
}

interface WaitBody {
  selector?: string;
  domText?: string;
  timeoutMs?: number;
  intervalMs?: number;
}

async function respondWait(
  window: BrowserWindow,
  body: unknown,
  response: http.ServerResponse,
): Promise<void> {
  const params = body as WaitBody;
  const timeoutMs = clampNumber(params.timeoutMs, 30000, 60000);
  const intervalMs = clampNumber(params.intervalMs, 100, 1000);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (params.selector) {
      const html = await getOuterHtml(window, params.selector);
      if (html !== null) {
        if (!params.domText || html.includes(params.domText)) {
          return respondJson(response, 200, { ok: true, matchedAt: new Date().toISOString() });
        }
      }
    } else if (params.domText) {
      const html = await getOuterHtml(window, 'body');
      if (html !== null && html.includes(params.domText)) {
        return respondJson(response, 200, { ok: true, matchedAt: new Date().toISOString() });
      }
    } else {
      return respondError(response, 400, 'missing-condition', 'Provide either `selector` or `domText`.');
    }
    await sleep(intervalMs);
  }
  respondError(response, 408, 'timeout', `Condition not met within ${timeoutMs}ms.`);
}

interface ScriptStep {
  type: 'click' | 'type' | 'keypress' | 'drag' | 'wait' | 'screenshot' | 'eval';
  [key: string]: unknown;
}

interface ScriptStepTrace {
  index: number;
  type: string;
  ok: boolean;
  durationMs: number;
  error?: string;
  screenshotPath?: string;
  screenshotUri?: string;
  /** Serialized return value of an `eval` step (undefined for other steps). */
  value?: unknown;
}

async function respondScript(
  options: InspectionServerOptions,
  window: BrowserWindow,
  body: unknown,
  response: http.ServerResponse,
): Promise<void> {
  const params = body as { steps?: ScriptStep[]; abortOnError?: boolean };
  if (!Array.isArray(params.steps)) {
    return respondError(response, 400, 'missing-steps', '`steps` array is required.');
  }
  const trace: ScriptStepTrace[] = [];
  for (let stepIndex = 0; stepIndex < params.steps.length; stepIndex++) {
    const step = params.steps[stepIndex];
    const stepStart = performance.now();
    try {
      const stepOutput = await runScriptStep(options, window, step);
      trace.push({
        index: stepIndex,
        type: step.type,
        ok: true,
        durationMs: performance.now() - stepStart,
        ...(stepOutput ?? {}),
      });
    } catch (error) {
      trace.push({
        index: stepIndex,
        type: step.type,
        ok: false,
        durationMs: performance.now() - stepStart,
        error: error instanceof Error ? error.message : String(error),
      });
      if (params.abortOnError !== false) break;
    }
  }
  respondJson(response, 200, { trace });
}

interface ScriptStepOutput {
  screenshotPath?: string;
  screenshotUri?: string;
  value?: unknown;
}

async function runScriptStep(
  options: InspectionServerOptions,
  window: BrowserWindow,
  step: ScriptStep,
): Promise<ScriptStepOutput | void> {
  switch (step.type) {
    case 'click': {
      const selector = step.selector as string | undefined;
      if (!selector) throw new Error('click step requires `selector`.');
      const ok = await clickAtCenterOfSelector(window, selector);
      if (!ok) throw new Error(`No element matched ${selector}.`);
      return;
    }
    case 'type': {
      const text = step.text as string | undefined;
      if (typeof text !== 'string') throw new Error('type step requires `text`.');
      const selector = step.selector as string | undefined;
      if (selector) {
        const focused = await clickAtCenterOfSelector(window, selector);
        if (!focused) throw new Error(`No element matched ${selector}.`);
      }
      await typeText(window, text);
      return;
    }
    case 'keypress': {
      const keys = step.keys as string | undefined;
      if (!keys) throw new Error('keypress step requires `keys`.');
      const ok = await dispatchKeypress(window, keys);
      if (!ok) throw new Error(`Unknown key combo: ${keys}.`);
      return;
    }
    case 'drag': {
      const fromSelector = step.fromSelector as string | undefined;
      const toSelector = step.toSelector as string | undefined;
      if (!fromSelector || !toSelector) throw new Error('drag step requires `fromSelector` + `toSelector`.');
      const ok = await dragFromTo(window, fromSelector, toSelector);
      if (!ok) throw new Error('drag selectors did not match.');
      return;
    }
    case 'wait': {
      const ms = clampNumber(step.ms as number | undefined, 250, 30000);
      await sleep(ms);
      return;
    }
    case 'screenshot': {
      // Always persist screenshots taken during a script to disk so the
      // trace stays small. The agent reads the resulting file via Read
      // (the path is included in the per-step trace entry). This keeps
      // a 50-step script trace from ballooning even if the agent
      // requests a screenshot every step.
      const captured = await captureScreenshotWithBudget(window, {
        format: 'jpeg',
        quality: 75,
        // Force file mode by setting a tight inline ceiling.
        inlineCeiling: 1,
      });
      if (!captured || captured.mode !== 'file') return;
      return { screenshotPath: captured.filePath, screenshotUri: captured.fileUri };
    }
    case 'eval': {
      if (!options.getEvalEnabled()) throw new Error('eval step requires `previewEvalEnabled`.');
      const expression = step.expression as string | undefined;
      if (typeof expression !== 'string') throw new Error('eval step requires `expression`.');
      const result = await runtimeEvaluate(window, expression);
      if (result.error) throw new Error(result.error);
      return { value: result.value };
    }
    default:
      throw new Error(`Unknown step type: ${step.type}.`);
  }
}

interface CommandBody {
  command: string;
  params?: Record<string, unknown>;
  projectId?: string;
}

/**
 * Proxy that runs a product MCP command (`commandHandlers`) inside the
 * preview process. Solves the "ephemeral preview projects can't be
 * targeted by project tools" gap: an outer agent can call
 * kangentic_devtools_run_command with `instanceId` to operate on the
 * preview's actual DB, since the preview holds the only live IpcContext
 * for its data dir.
 *
 * Optional `projectId` lets the caller target a specific project the
 * preview knows about (rare). Default uses whatever project the preview
 * has open right now.
 */
async function respondCommand(
  options: InspectionServerOptions,
  body: unknown,
  response: http.ServerResponse,
): Promise<void> {
  const params = body as CommandBody;
  if (typeof params.command !== 'string') {
    return respondError(response, 400, 'missing-command', '`command` is required.');
  }
  const ipcContext = options.getIpcContext();
  if (!ipcContext) {
    return respondError(response, 503, 'no-ipc-context', 'IPC context is not available yet.');
  }
  const targetProjectId = params.projectId ?? options.getProjectId();
  if (!targetProjectId) {
    return respondError(
      response,
      503,
      'no-project',
      'Preview has no project open and no projectId was provided.',
    );
  }
  const { commandHandlers } = await import('../../main/agent/commands');
  const { buildCommandContextForProject } = await import('../../main/agent/mcp-project-context');
  const commandContext = buildCommandContextForProject(ipcContext, targetProjectId);
  if (!commandContext) {
    return respondError(
      response,
      404,
      'unknown-project',
      `Project ${targetProjectId} is not registered in this preview.`,
    );
  }
  const handler = (commandHandlers as Record<string, unknown>)[params.command];
  if (typeof handler !== 'function') {
    return respondError(response, 400, 'unknown-command', `Unknown command: ${params.command}.`);
  }
  try {
    const handlerFn = handler as (
      params: Record<string, unknown>,
      context: typeof commandContext,
    ) => Promise<unknown> | unknown;
    const result = await Promise.resolve(handlerFn(params.params ?? {}, commandContext));
    respondJson(response, 200, result);
  } catch (error) {
    respondJson(response, 200, {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

interface PtyInputBody {
  sessionId: string;
  keys?: string;
  bytes?: string;
}

async function respondPtyInput(
  options: InspectionServerOptions,
  body: unknown,
  response: http.ServerResponse,
): Promise<void> {
  const params = body as PtyInputBody;
  const sessionManager = options.getSessionManager();
  if (!sessionManager) {
    return respondError(response, 503, 'no-session-manager', 'SessionManager is not available.');
  }
  if (typeof params.sessionId !== 'string') {
    return respondError(response, 400, 'missing-sessionId', '`sessionId` is required.');
  }
  let toWrite: string | null = null;
  if (typeof params.keys === 'string') {
    toWrite = mapKeysToBytes(params.keys);
  } else if (typeof params.bytes === 'string') {
    if (!options.getEvalEnabled()) {
      return respondError(
        response,
        403,
        'eval-disabled',
        'Raw `bytes` form requires Settings → Developer → Allow Eval.',
      );
    }
    toWrite = Buffer.from(params.bytes, 'base64').toString('utf-8');
  } else {
    return respondError(response, 400, 'missing-input', 'Provide `keys` or `bytes`.');
  }
  if (toWrite === null) {
    return respondError(response, 400, 'unknown-keys', `Could not map keys: ${params.keys}.`);
  }
  type SessionWriter = { write(sessionId: string, data: string): void | boolean };
  const writer = sessionManager as unknown as SessionWriter;
  if (typeof writer.write !== 'function') {
    return respondError(response, 503, 'no-writer', 'SessionManager.write is not exposed.');
  }
  writer.write(params.sessionId, toWrite);
  respondJson(response, 200, { ok: true });
}

function mapKeysToBytes(keys: string): string | null {
  const map: Record<string, string> = {
    Enter: '\r',
    Escape: '\x1b',
    Tab: '\t',
    Backspace: '\x7f',
    'Ctrl+C': '\x03',
    'Ctrl+D': '\x04',
    Up: '\x1b[A',
    Down: '\x1b[B',
    Left: '\x1b[D',
    Right: '\x1b[C',
  };
  if (map[keys]) return map[keys];
  // Unknown chord: treat as literal text (the caller probably wants that).
  return keys;
}

interface EvalBody {
  expression: string;
}

async function respondEval(
  window: BrowserWindow,
  body: unknown,
  response: http.ServerResponse,
): Promise<void> {
  const params = body as EvalBody;
  if (typeof params.expression !== 'string') {
    return respondError(response, 400, 'missing-expression', '`expression` is required.');
  }
  const result = await runtimeEvaluate(window, params.expression);
  if (result.error) return respondError(response, 500, 'evaluate-failed', result.error);
  respondJson(response, 200, { value: result.value });
}

interface InjectSessionEventBody {
  sessionId: string;
  event: unknown;
}

function respondInjectSessionEvent(
  options: InspectionServerOptions,
  body: unknown,
  response: http.ServerResponse,
): void {
  const params = body as InjectSessionEventBody;
  const sessionManager = options.getSessionManager();
  if (!sessionManager) {
    return respondError(response, 503, 'no-session-manager', 'SessionManager is not available.');
  }
  type EventInjector = {
    telemetry?: { ingestEvents(sessionId: string, events: unknown[]): void };
  };
  const injector = sessionManager as unknown as EventInjector;
  if (typeof injector.telemetry?.ingestEvents !== 'function') {
    return respondError(response, 503, 'no-injector', 'telemetry.ingestEvents is not exposed.');
  }
  if (typeof params.sessionId !== 'string' || params.event === undefined) {
    return respondError(response, 400, 'missing-fields', '`sessionId` and `event` are required.');
  }
  injector.telemetry.ingestEvents(params.sessionId, [params.event]);
  respondJson(response, 200, { ok: true });
}

interface CaptureTraceBody {
  sessionId: string;
}

/**
 * Bundle a session's full input stream into a portable replay fixture.
 *
 * Reads four passively-recorded streams from `.kangentic/sessions/<id>/`
 * (events.jsonl, status-deltas.jsonl, pty-chunks.jsonl), snapshots the
 * engine's recent transitions ring, and writes them all into
 * `.kangentic/traces/<isoTs>-<id>/` along with a meta.json. The
 * resulting directory can be copied straight into
 * `tests/fixtures/replay/` to pin the engine's behavior on this trace.
 *
 * Pre-condition: passive recording has been active during the session
 * (always-on in dev builds via trace-recorder.ts). Missing input files
 * are skipped silently. For rotatable files (status-deltas / pty-chunks)
 * the rotated `.1` copy is concatenated before the live primary so the
 * bundle is a single chronological file representing the recorder's
 * full retained stream.
 */
function respondCaptureTrace(
  options: InspectionServerOptions,
  body: unknown,
  response: http.ServerResponse,
): void {
  const params = body as CaptureTraceBody;
  if (typeof params.sessionId !== 'string' || !params.sessionId) {
    return respondError(response, 400, 'missing-sessionId', '`sessionId` is required.');
  }
  // Defense in depth: the inspection bridge is localhost-only and
  // dev-only, but the sessionId flows directly into path.join below.
  // Rejecting traversal-shaped values prevents an MCP caller from
  // mkdir'ing outside .kangentic/traces/.
  if (/[/\\\0]/.test(params.sessionId) || params.sessionId.includes('..')) {
    return respondError(response, 400, 'invalid-sessionId', '`sessionId` contains illegal characters.');
  }
  const projectRoot = options.getProjectRoot();
  if (!projectRoot) {
    return respondError(response, 503, 'no-project', 'Preview has no project open.');
  }
  const sessionManager = options.getSessionManager();
  if (!sessionManager) {
    return respondError(response, 503, 'no-session-manager', 'SessionManager is not available.');
  }
  type EngineHolder = {
    telemetry?: { activityEngine?: { getStatsSnapshot(id: string): unknown } };
  };
  const holder = sessionManager as unknown as EngineHolder;
  const engine = holder.telemetry?.activityEngine;

  const sessionDir = path.join(projectRoot, '.kangentic', 'sessions', params.sessionId);
  if (!fs.existsSync(sessionDir)) {
    return respondError(response, 404, 'no-session-dir', `No session directory at ${sessionDir}.`);
  }

  const isoTs = new Date().toISOString().replace(/[:.]/g, '-');
  const traceDir = path.join(projectRoot, '.kangentic', 'traces', `${isoTs}-${params.sessionId}`);
  try {
    fs.mkdirSync(traceDir, { recursive: true });
  } catch (error) {
    return respondError(
      response,
      500,
      'mkdir-failed',
      error instanceof Error ? error.message : String(error),
    );
  }

  // Files the trace recorder writes (and may have rotated). For these,
  // bundle the rotated copy + the live primary concatenated in
  // chronological order so the resulting bundle is a single file
  // representing the recorder's full retained stream. events.jsonl is
  // not in this set because the agent's hook writes it directly and
  // never rotates it.
  const ROTATABLE_FILES = new Set(['status-deltas.jsonl', 'pty-chunks.jsonl']);
  const copied: string[] = [];
  const skipped: string[] = [];
  for (const name of ['events.jsonl', 'status-deltas.jsonl', 'pty-chunks.jsonl']) {
    const sourcePath = path.join(sessionDir, name);
    const rotatedPath = sourcePath + '.1';
    const destPath = path.join(traceDir, name);
    const parts: Buffer[] = [];
    if (ROTATABLE_FILES.has(name) && fs.existsSync(rotatedPath)) {
      try {
        parts.push(fs.readFileSync(rotatedPath));
      } catch {
        // Rotated copy unreadable - fall through and keep just the
        // primary so the bundle is partial rather than missing.
      }
    }
    if (fs.existsSync(sourcePath)) {
      try {
        parts.push(fs.readFileSync(sourcePath));
      } catch {
        // Primary unreadable - bundle whatever we already collected.
      }
    }
    if (parts.length === 0) {
      skipped.push(name);
      continue;
    }
    try {
      fs.writeFileSync(destPath, parts.length === 1 ? parts[0] : Buffer.concat(parts));
      copied.push(name);
    } catch {
      skipped.push(name);
    }
  }

  // Save the full ActivityStatsSnapshot (counters, recentTransitions
  // ring, compensation tallies) so the trace bundle is self-contained
  // for human inspection. The replay harness only consumes the JSONL
  // streams; this file is for "what was the engine seeing at capture
  // time" diagnostics.
  const engineSnapshot = engine ? engine.getStatsSnapshot(params.sessionId) : null;
  fs.writeFileSync(
    path.join(traceDir, 'transitions.json'),
    JSON.stringify(engineSnapshot, null, 2),
  );

  const meta = {
    capturedAt: new Date().toISOString(),
    sessionId: params.sessionId,
    kangenticVersion: app.getVersion(),
    copied,
    skipped,
    note: 'Bundled by kangentic_devtools_capture_trace. Replay via tests/unit/activity-engine-trace-replay.test.ts:replayBundle.',
  };
  fs.writeFileSync(path.join(traceDir, 'meta.json'), JSON.stringify(meta, null, 2));

  respondJson(response, 200, { path: traceDir, copied, skipped });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readJsonBody(request: http.IncomingMessage): Promise<unknown | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(null);
      }
    });
    request.on('error', () => resolve(null));
  });
}

function readJsonLines<T>(filePath: string): T[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // skip corrupt
    }
  }
  return out;
}

function respondJson(
  response: http.ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(body));
}

function respondError(
  response: http.ServerResponse,
  statusCode: number,
  kind: string,
  detail: string,
): void {
  respondJson(response, statusCode, { ok: false, error: { kind, detail } });
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function clampLimit(value: string | null, defaultValue: number, max: number): number {
  if (!value) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  return Math.min(parsed, max);
}

function clampNumber(value: number | undefined, defaultValue: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return defaultValue;
  return Math.min(value, max);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
