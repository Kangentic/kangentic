import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WebContents } from 'electron';
import { z } from 'zod/v4';
import {
  withGuest,
  validateNavigationUrl,
  navigateGuest,
  type BrowserCapability,
  type DriverResult,
} from '../../browser/browser-pane-driver';
import {
  browserPaneRegistry,
  type BrowserPaneEntry,
  type ResolveTargetSelector,
} from '../../browser/browser-pane-registry';
import { openPaneForCallerTask, closePanes } from '../../browser/browser-pane-opener';
import { popOutPaneForCallerTask, dockPaneForCallerTask } from '../../browser/browser-pane-detach';
import type { ResolvedBrowserAutomationConfig } from '../../browser/browser-automation-config';
import { detectDevServerError, describeDevServerError, type DevServerError } from '../../browser/dev-server-error';
import {
  clickAtCenterOfSelector,
  dispatchMouseEvent,
  dispatchKeyEvent,
  dispatchKeypress,
  dragFromTo,
  dropFilesOnSelector,
  getDialogEntries,
  getNetworkEntries,
  getOuterHtml,
  getBoundingBox,
  getConsoleEntries,
  getLayoutMetrics,
  hoverSelector,
  queryAllElements,
  runtimeEvaluate,
  scrollBy,
  selectOptionOnSelector,
  setDialogResponse,
  typeText,
} from '../../browser/cdp/cdp';
import {
  captureScreenshotWithBudget,
  captureElementClip,
} from '../../browser/cdp/screenshot';
import {
  applyViewport,
  clearViewport,
  MAX_VIEWPORT_DIMENSION,
  MIN_VIEWPORT_DIMENSION,
  WINDOW_ANCHORS,
  type ApplyViewportOutcome,
} from '../../browser/viewport-override';
import { driverToolResult, screenshotToolResult, errorToolResult } from './tool-result';
import { READ_ONLY_ANNOTATIONS, MUTATING_ANNOTATIONS } from './annotations';

/**
 * The user-facing `kangentic_browser_*` MCP tool family. Drives the embedded
 * Browser pane (an Electron `<webview>` guest) via the in-process CDP driver -
 * no HTTP bridge, no lockfile. Unlike the dev-only `kangentic_devtools_*`
 * tools (which target the app's own window over HTTP), these ship in
 * production and target the dev server the USER has loaded in a task's pane.
 *
 * Every tool routes through `withGuest`, which gates the call against the
 * global automation policy, resolves the target pane, attaches CDP, and shapes
 * a `{ kind, detail }` error envelope. Capability tiers: observe (screenshot,
 * query, console, wait), interact (click/type/keypress/drag), navigate, eval.
 *
 * Every target is scoped to the connection's own project (the `<projectId>`
 * segment of the MCP URL). This family deliberately takes NO `project`
 * argument and is deliberately NOT handed the `RequestResolver`, so "there is
 * no path to another project's pane" is a type-level guarantee rather than a
 * convention. See `.claude/rules/browser-automation-driver.md`.
 */

const SESSION_DESC =
  'Optional browser surface handle (pane_… or lane_…) from kangentic_browser_open_pane or kangentic_browser_list_panes. A handle names exactly one tab for its lifetime; if that tab is gone the call fails with surface-gone and names your task\'s current surface. Must be in your own project. Omit to use your own task\'s one surface (its visible pane, or the offscreen form of it); a caller with no task falls back to the single pane open in the project. This is NOT a Kangentic agent session id.';
const TASK_DESC =
  "Optional Kangentic taskId whose Browser surface to target. An alternative to sessionId, and must likewise be a task in your own project. Omit both to use your own task's surface.";

const TARGET_SHAPE = {
  sessionId: z.string().optional().describe(SESSION_DESC),
  taskId: z.string().optional().describe(TASK_DESC),
};

type TargetArgs = { sessionId?: string; taskId?: string };

type ClickOutcome =
  | { ok: true; dispatched?: { x: number; y: number } }
  | { error: 'selector-not-found' | 'coord-mapping-failed' | 'missing-target' };

/** Reads the live automation policy once per call so a Settings flip applies immediately. */
export type AutomationConfigReader = () => ResolvedBrowserAutomationConfig;

/**
 * The `SessionManager` lookup these tools need to find the caller's own task.
 * Declared narrowly here rather than imported from `steering-tools.ts` so the
 * browser family carries no dependency on the steering family; `SessionManager`
 * satisfies it structurally.
 */
export interface BrowserSessionLookup {
  getSessionTaskId(sessionId: string): string | undefined;
}

export interface BrowserToolDependencies {
  /**
   * The project this connection is bound to, from the MCP URL path. Always
   * present: `buildContext(projectId)` 404s an unknown project before any tool
   * is registered.
   */
  projectId: string;
  /**
   * The caller's session id, from the MCP URL path
   * (`/mcp/<projectId>/<callerSessionId>`). Undefined for a human-driven
   * client, the two-segment `.kangentic/mcp-config.json` URL, and Command
   * Terminal sessions. Never required: it only sharpens the implicit default.
   */
  callerSessionId?: string;
  /**
   * Session lookup used to map `callerSessionId` to the caller's own task.
   * Null before the IPC context exists (the MCP server starts ahead of
   * `createWindow`), which degrades the default rather than refusing.
   */
  sessions?: BrowserSessionLookup | null;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function clampNumber(value: number | undefined, defaultValue: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return defaultValue;
  return Math.min(value, max);
}

/** How long caller-authored JavaScript may hold the guest before it is abandoned. */
const EVALUATE_TIMEOUT_MS = 20_000;

/** How long a history move waits for its navigation to commit before the URL
 *  is read anyway. A same-document back (a hash change) fires no
 *  `did-navigate` at all, so this bound is the normal path there, not an
 *  error case. */
const HISTORY_NAVIGATE_TIMEOUT_MS = 3_000;

/**
 * `runtimeEvaluate`, bounded, in the shape that function already returns.
 *
 * A timeout is reported as an ordinary evaluation error rather than thrown, so
 * `kangentic_browser_eval` surfaces `evaluate-failed` exactly as it does for a
 * page exception. Abandons rather than cancels: CDP offers no way to cancel an
 * in-flight `Runtime.evaluate`, so the expression may still settle later - what
 * matters is that the guest's drive lock is released.
 */
async function boundedEvaluate(
  webContents: WebContents,
  expression: string,
): Promise<{ value: unknown; error: string | null }> {
  let timer: NodeJS.Timeout | undefined;
  const bounded = new Promise<{ value: null; error: string }>((resolve) => {
    timer = setTimeout(
      () => resolve({
        value: null,
        error: `The expression did not settle within ${EVALUATE_TIMEOUT_MS / 1000}s and was abandoned. It probably awaits a promise that never resolves.`,
      }),
      EVALUATE_TIMEOUT_MS,
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([runtimeEvaluate(webContents, expression), bounded]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function registerBrowserTools(
  server: McpServer,
  getAutomationConfig: AutomationConfigReader,
  dependencies: BrowserToolDependencies,
): void {
  const { projectId, callerSessionId, sessions } = dependencies;

  // Resolved ONCE per request, not per tool call: the McpServer is rebuilt for
  // every HTTP request, so this closure can never go stale. A missing lookup or
  // an unknown session leaves it undefined, which degrades the implicit default
  // to "the single pane in my project" rather than refusing.
  const callerTaskId =
    callerSessionId && sessions ? sessions.getSessionTaskId(callerSessionId) : undefined;

  // Caller scope is stamped here, not taken from tool arguments, so no tool can
  // opt out of it. This is the single point that scopes the 20 tools driving
  // through `drive()` below. The two lifecycle tools (open_pane / close_pane)
  // build their own equivalent selector in `browser-pane-opener.ts`, from the
  // same caller identity - see .claude/rules/browser-automation-driver.md.
  const selectorFrom = (args: TargetArgs): ResolveTargetSelector => ({
    sessionId: args.sessionId,
    taskId: args.taskId,
    projectId,
    callerSessionId,
    callerTaskId,
  });

  // Helper: run a capability-gated CDP operation against the target pane.
  const drive = <Result>(
    capability: BrowserCapability,
    target: TargetArgs,
    fn: (webContents: WebContents, entry: BrowserPaneEntry) => Promise<Result>,
    configOverride?: ResolvedBrowserAutomationConfig,
  ): Promise<DriverResult<Result>> =>
    withGuest<Result>(
      { selector: selectorFrom(target), capability, config: configOverride ?? getAutomationConfig() },
      fn,
    );

  // ── Discovery ─────────────────────────────────────────────────────────
  server.registerTool(
    'kangentic_browser_list_panes',
    {
      description:
        'List the embedded Browser surfaces open in your project - at most one per task: each entry carries its surface handle (`sessionId`, pass it back as sessionId), `ownerSessionId` (the agent session it serves), taskId, kind (`pane` = a visible pane, `lane` = the offscreen form of the same surface, used when no pane can mount), `visibility` (showing = the user can see it; hidden = the user hid it behind the terminal; parked = the user closed its window; offscreen = a lane; every value is still driveable), current URL, and whether it is alive / debugger-attached. A pane the user CLOSED is not listed: its handle answers `surface-gone` saying the user closed the browser, and kangentic_browser_open_pane opens a fresh one. Use this to discover a handle or taskId to pass to the other kangentic_browser_* tools, or to confirm the user has a dev server loaded. Panes in other projects are excluded by default and cannot be driven from this connection; pass includeOtherProjects to see them too. Returns an empty list when no pane is open.',
      inputSchema: z.object({
        includeOtherProjects: z
          .boolean()
          .optional()
          .describe(
            'Also list Browser panes in other projects. They are listed for visibility only and cannot be driven from this connection. Default false.',
          ),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args: { includeOtherProjects?: boolean }) => {
      const config = getAutomationConfig();
      const scoped = browserPaneRegistry.listForProject(projectId);
      // `driveable` tracks `sameProject` today and is reported separately so a
      // future liveness or policy gate has somewhere to live without the agent
      // having to re-derive what it may act on.
      const panes = (args.includeOtherProjects ? browserPaneRegistry.list() : scoped.panes).map(
        (pane) => ({
          ...pane,
          sameProject: pane.projectId === projectId,
          driveable: pane.projectId === projectId,
        }),
      );
      const payload = {
        automationEnabled: config.enabled,
        projectId,
        panes,
        otherProjectPaneCount: scoped.otherProjectPaneCount,
        unknownProjectPaneCount: scoped.unknownProjectPaneCount,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        structuredContent: { ...payload, items: panes },
      };
    },
  );

  // ── Lifecycle (open / close a pane) ───────────────────────────────────
  server.registerTool(
    'kangentic_browser_open_pane',
    {
      description:
        "Open the user's VISIBLE embedded Browser pane for YOUR OWN task and load a URL, so you can then drive it with the other kangentic_browser_* tools. Use this instead of asking the user to open the Browser pill. Opens the task's detail window if it is not already open. Returns the surface once it is registered and driveable, so the very next call can act on it; `pane.sessionId` is its handle. A task has exactly ONE browser surface: there is no argument for a second one, and no way to open a pane for another task or project. Calling it again with a different url navigates that surface rather than opening another, and if the user had hidden the pane or closed its window, it is shown again: the same tab, nothing reloads. If your project is not the one currently open in Kangentic, no pane can be mounted, so the surface comes up OFFSCREEN instead and the response says `offscreen: true` - it is fully driveable, the user can see it exists on the task card, and it turns back into a visible pane by itself as soon as one can mount.",
      inputSchema: z.object({
        url: z
          .string()
          .optional()
          .describe(
            "Absolute http(s) URL to load, e.g. http://localhost:5173. Omit to reuse the task's saved Browser URL, or the project default. If neither exists, pass one - a pane with no URL registers nothing and cannot be driven.",
          ),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ url }) => {
      const result = await openPaneForCallerTask({
        projectId,
        callerSessionId,
        callerTaskId,
        url,
        // Opening always loads a URL, so this is a navigation-tier action:
        // "Allow navigation" off in Settings disables this tool too.
        capability: 'navigate',
        config: getAutomationConfig(),
      });
      return driverToolResult(result);
    },
  );

  server.registerTool(
    'kangentic_browser_close_pane',
    {
      description:
        "Close embedded Browser panes, putting them away exactly as the user's Browser pill does. The task's detail window stays open. With no arguments this closes your own task's pane; pass all to close every pane in your project; a lane named by its handle is destroyed. A pane you close this way is not handed off to a lane. Panes in other projects are left alone and reported as a count unless you pass includeOtherProjects. The response lists the surfaces actually closed, so a partial close is never reported as complete.",
      inputSchema: z.object({
        ...TARGET_SHAPE,
        all: z
          .boolean()
          .optional()
          .describe(
            'Close every pane in scope instead of a single target. Use this for "close all browsers". Takes precedence over sessionId and taskId, which are ignored when this is set.',
          ),
        includeOtherProjects: z
          .boolean()
          .optional()
          .describe(
            'Also close Browser panes belonging to other projects. Off by default, because another project may have an agent mid-verification in its pane. Only pass this when the user asked for every browser everywhere.',
          ),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ sessionId, taskId, all, includeOtherProjects }) => {
      const result = await closePanes({
        projectId,
        callerSessionId,
        callerTaskId,
        sessionId,
        taskId,
        all,
        includeOtherProjects,
        config: getAutomationConfig(),
      });
      return driverToolResult(result);
    },
  );

  // ── Navigate (adopt a URL) ────────────────────────────────────────────
  server.registerTool(
    'kangentic_browser_navigate',
    {
      description:
        "Point the task's embedded Browser pane at a URL (e.g. http://localhost:4200) so you can drive and verify a dev server. This navigates the in-app pane the user has open, not a general web browser. The pane's URL bar and per-task saved URL update automatically. http(s) only.",
      inputSchema: z.object({
        ...TARGET_SHAPE,
        url: z.string().describe('Absolute http(s) URL to load, e.g. http://localhost:4200.'),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ sessionId, taskId, url }) => {
      // Read the policy once and reuse it for both the URL/host validation and
      // the capability gate, so a mid-call Settings flip cannot let a URL pass
      // validation against one snapshot and gate against another.
      const config = getAutomationConfig();
      const validated = validateNavigationUrl(url, config);
      if (!validated.ok) return errorToolResult(validated.error);
      const result = await drive<{ ok: true; url: string }>('navigate', { sessionId, taskId }, async (webContents) => {
        // Bounded: an unbounded load holds the guest's drive lock against every
        // other caller if the dev server accepts the connection and then stalls.
        await navigateGuest(webContents, validated.url);
        return { ok: true, url: validated.url };
      }, config);
      return driverToolResult(result);
    },
  );

  // ── Observe: screenshot ───────────────────────────────────────────────
  server.registerTool(
    'kangentic_browser_screenshot',
    {
      description:
        "Capture a screenshot of the task's Browser pane (the loaded dev server). Returns an inline image. Defaults to JPEG; the response includes viewport + scale metadata for mapping image coordinates back to the page.",
      inputSchema: z.object({
        ...TARGET_SHAPE,
        fullPage: z.boolean().optional().describe('Capture the full scrollable page instead of just the viewport.'),
        format: z.enum(['png', 'jpeg']).optional().describe('Image format. Default jpeg.'),
        quality: z.number().int().min(1).max(100).optional().describe('JPEG quality 1-100 (ignored for png).'),
        maxBytes: z.number().int().positive().optional().describe('Soft cap on decoded image bytes; the capture downscales/recompresses to fit.'),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ sessionId, taskId, fullPage, format, quality, maxBytes }) => {
      // Probe for a build-error overlay in the SAME drive as the capture, so the
      // two cannot disagree about what was on screen. Returning a picture of a
      // full-screen error overlay is technically correct and practically
      // useless: the agent spends a turn identifying the red rectangle, and
      // when several agents share one dev server the one that sees the overlay
      // usually is not the one who broke the build.
      type ScreenshotOutcome =
        | { blocked: DevServerError }
        | { blocked: null; shot: Awaited<ReturnType<typeof captureScreenshotWithBudget>> };

      const result = await drive<ScreenshotOutcome>('observe', { sessionId, taskId }, async (webContents) => {
        const devServerError = await detectDevServerError(webContents);
        if (devServerError) return { blocked: devServerError };
        return {
          blocked: null,
          shot: await captureScreenshotWithBudget(webContents, {
            format: format ?? 'jpeg',
            quality: quality ?? (format === 'png' ? undefined : 80),
            fullPage: fullPage === true,
            maxBytes,
          }),
        };
      });
      if (!result.ok) return errorToolResult(result.error);
      if (result.data.blocked) {
        return errorToolResult({ kind: 'dev-server-error', detail: describeDevServerError(result.data.blocked) });
      }
      if (!result.data.shot) return errorToolResult({ kind: 'screenshot-failed', detail: 'Page.captureScreenshot returned no data.' });
      return screenshotToolResult({ ok: true, data: result.data.shot });
    },
  );

  server.registerTool(
    'kangentic_browser_screenshot_element',
    {
      description: "Capture a screenshot clipped to a single element in the task's Browser pane.",
      inputSchema: z.object({
        ...TARGET_SHAPE,
        selector: z.string().describe('CSS selector (or text=/aria= form) of the element to capture.'),
        format: z.enum(['png', 'jpeg']).optional().describe('Image format. Default png.'),
        quality: z.number().int().min(1).max(100).optional(),
        maxBytes: z.number().int().positive().optional(),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ sessionId, taskId, selector, format, quality, maxBytes }) => {
      const result = await drive('observe', { sessionId, taskId }, (webContents) =>
        captureElementClip(webContents, selector, { format: format ?? 'png', quality, maxBytes }),
      );
      if (!result.ok) return errorToolResult(result.error);
      if (!result.data) return errorToolResult({ kind: 'screenshot-failed', detail: 'Element clip capture returned no data.' });
      if ('error' in result.data) return errorToolResult({ kind: 'selector-not-found', detail: `No element matched ${selector}.` });
      return screenshotToolResult({ ok: true, data: result.data });
    },
  );

  // ── Observe: DOM ──────────────────────────────────────────────────────
  server.registerTool(
    'kangentic_browser_query_dom',
    {
      description: "Get the outerHTML (and optionally bounding box) of the first element matching a selector in the task's Browser pane.",
      inputSchema: z.object({
        ...TARGET_SHAPE,
        selector: z.string().describe('CSS selector (or text=/aria= form). Defaults to "html".').default('html'),
        includeBox: z.boolean().optional().describe('Also return the element\'s {x,y,width,height} viewport box.'),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ sessionId, taskId, selector, includeBox }) => {
      const result = await drive('observe', { sessionId, taskId }, async (webContents) => {
        const html = await getOuterHtml(webContents, selector);
        if (html === null) return { error: 'selector-not-found' as const };
        if (!includeBox) return { selector, outerHTML: html };
        const box = await getBoundingBox(webContents, selector);
        if (!box || !Array.isArray(box.content) || box.content.length < 8) {
          return { selector, outerHTML: html, box: null };
        }
        const xs = [box.content[0], box.content[2], box.content[4], box.content[6]];
        const ys = [box.content[1], box.content[3], box.content[5], box.content[7]];
        const minX = Math.min(...xs);
        const minY = Math.min(...ys);
        return {
          selector,
          outerHTML: html,
          box: { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY },
        };
      });
      if (result.ok && 'error' in result.data) {
        return errorToolResult({ kind: 'selector-not-found', detail: `No element matched ${selector}.` });
      }
      return driverToolResult(result);
    },
  );

  server.registerTool(
    'kangentic_browser_query_all',
    {
      description: "Measure every element matching a selector in the task's Browser pane in one round-trip (tag, box, optionally attributes/outerHTML).",
      inputSchema: z.object({
        ...TARGET_SHAPE,
        selector: z.string().describe('CSS selector (or text=/aria= form).'),
        includeHtml: z.boolean().optional().describe('Include each element\'s outerHTML (clipped).'),
        limit: z.number().int().positive().max(1000).optional().describe('Max elements to return (default 100).'),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ sessionId, taskId, selector, includeHtml, limit }) => {
      const result = await drive('observe', { sessionId, taskId }, (webContents) =>
        queryAllElements(webContents, selector, {
          includeHtml: includeHtml === true,
          includeAttributes: true,
          limit: clampNumber(limit, 100, 1000),
          htmlMaxChars: 1024,
        }),
      );
      if (result.ok && result.data.error) {
        return errorToolResult({ kind: 'evaluate-failed', detail: result.data.error });
      }
      if (result.ok && !result.data.value) {
        return errorToolResult({ kind: 'query-failed', detail: 'query-all returned no result.' });
      }
      if (result.ok) return driverToolResult({ ok: true, data: result.data.value });
      return driverToolResult(result);
    },
  );

  server.registerTool(
    'kangentic_browser_bounding_box',
    {
      // The coordinate-space warning is load-bearing, not pedantry: these quads
      // are PAGE space, while kangentic_browser_click takes VIEWPORT
      // coordinates. Feeding a box from here straight into click as x/y is
      // correct only at scroll position zero, and silently clicks the wrong
      // place otherwise. Clicking by selector needs none of this - it scrolls
      // and measures for itself.
      description: "Get the raw CDP box-model (content/padding/border/margin quads) of an element in the task's Browser pane. Coordinates are PAGE space and do not account for scroll, so do not pass them to kangentic_browser_click as x/y - click by selector instead, which scrolls the element into view and measures it there.",
      inputSchema: z.object({ ...TARGET_SHAPE, selector: z.string().describe('CSS selector of the element.') }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ sessionId, taskId, selector }) => {
      const result = await drive('observe', { sessionId, taskId }, async (webContents) => {
        const box = await getBoundingBox(webContents, selector);
        return box ? { selector, ...box } : { error: 'selector-not-found' as const };
      });
      if (result.ok && 'error' in result.data) {
        return errorToolResult({ kind: 'selector-not-found', detail: `No element matched ${selector}.` });
      }
      return driverToolResult(result);
    },
  );

  server.registerTool(
    'kangentic_browser_console',
    {
      description: "Read the recent console messages (log/warn/error/info) captured from the task's Browser pane.",
      inputSchema: z.object({
        ...TARGET_SHAPE,
        since: z.string().optional().describe('ISO timestamp; only return entries at or after this time.'),
        level: z.enum(['log', 'warn', 'error', 'info', 'debug', 'verbose', 'all']).optional().describe('Filter by level. Default all.'),
        limit: z.number().int().positive().max(500).optional().describe('Max entries (default 100, newest last).'),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ sessionId, taskId, since, level, limit }) => {
      const result = await drive('observe', { sessionId, taskId }, async (webContents) => {
        const entries = getConsoleEntries(webContents).filter((entry) => {
          if (since && entry.ts < since) return false;
          if (level && level !== 'all' && entry.level !== level) return false;
          return true;
        });
        return entries.slice(-clampNumber(limit, 100, 500));
      });
      return driverToolResult(result);
    },
  );

  server.registerTool(
    'kangentic_browser_wait',
    {
      description: "Wait until an element appears (and optionally contains text) in the task's Browser pane, or a string appears anywhere in the body. Polls until the timeout.",
      inputSchema: z.object({
        ...TARGET_SHAPE,
        selector: z.string().optional().describe('CSS selector to wait for.'),
        domText: z.string().optional().describe('Text to wait for (within the selector if given, else anywhere in body).'),
        timeoutMs: z.number().int().positive().max(60000).optional().describe('Max wait in ms (default 30000).'),
        intervalMs: z.number().int().positive().max(5000).optional().describe('Poll interval in ms (default 250).'),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ sessionId, taskId, selector, domText, timeoutMs, intervalMs }) => {
      if (!selector && !domText) {
        return errorToolResult({ kind: 'missing-condition', detail: 'Provide a selector or domText to wait for.' });
      }
      const timeout = clampNumber(timeoutMs, 30000, 60000);
      const interval = clampNumber(intervalMs, 250, 5000);
      const deadline = Date.now() + timeout;

      // Each POLL takes the guest, not the whole wait.
      //
      // This body used to sit inside one `drive()` for up to 60 seconds. Once
      // drives are serialized per guest, that would make `wait` a 60-second
      // denial of service on the pane: any other caller's click or screenshot
      // would queue behind it and most would hit the acquisition bound. A poll
      // is a single DOM read, so acquiring per poll costs one extra lock
      // round-trip and lets other work interleave between polls, which is the
      // correct granularity - the waiting is not driving.
      //
      // The sleep happens OUTSIDE the lock deliberately. At the default 250ms
      // interval the drive-burst quiet window (400ms) keeps the burst open
      // across polls, so the pane does not flap. At a longer interval the burst
      // legitimately closes between polls, which is also right: an agent
      // sleeping five seconds between DOM reads is not driving the pane, and
      // the user should get their focus back.
      let result: DriverResult<{ matched: boolean; matchedAt?: string; timedOutAfterMs?: number }>;
      for (;;) {
        result = await drive('observe', { sessionId, taskId }, async (webContents) => {
          const target = selector ?? 'body';
          const html = await getOuterHtml(webContents, target);
          const hit = selector
            ? html !== null && (!domText || html.includes(domText))
            : html !== null && !!domText && html.includes(domText);
          return hit
            ? { matched: true, matchedAt: new Date().toISOString() }
            : { matched: false };
        });

        // A refusal (pane gone, busy, policy) ends the wait immediately rather
        // than being retried until the deadline: re-polling a pane that has
        // been destroyed just burns the full timeout to report the same thing.
        if (!result.ok) break;
        if (result.data.matched) break;
        if (Date.now() >= deadline) {
          result = { ok: true, data: { matched: false, timedOutAfterMs: timeout } };
          break;
        }
        await sleep(interval);
      }
      return driverToolResult(result);
    },
  );

  // ── Interact ──────────────────────────────────────────────────────────
  server.registerTool(
    'kangentic_browser_click',
    {
      description: "Click an element (by selector) or a point (by viewport x/y) in the task's Browser pane.",
      inputSchema: z.object({
        ...TARGET_SHAPE,
        selector: z.string().optional().describe('CSS selector (or text=/aria= form) to click at its center.'),
        x: z.number().optional().describe('Viewport X (use with y instead of selector).'),
        y: z.number().optional().describe('Viewport Y.'),
        coordSpace: z.enum(['viewport', 'image']).optional().describe('Coordinate space for x/y. Default viewport. "image" maps screenshot pixels back via the device scale factor.'),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ sessionId, taskId, selector, x, y, coordSpace }) => {
      const result = await drive<ClickOutcome>('interact', { sessionId, taskId }, async (webContents) => {
        if (typeof selector === 'string') {
          const ok = await clickAtCenterOfSelector(webContents, selector);
          if (!ok) return { error: 'selector-not-found' as const };
          return { ok: true };
        }
        if (typeof x === 'number' && typeof y === 'number') {
          let targetX = x;
          let targetY = y;
          if (coordSpace === 'image') {
            const layout = await getLayoutMetrics(webContents);
            if (!layout) return { error: 'coord-mapping-failed' as const };
            targetX = x / layout.deviceScaleFactor;
            targetY = y / layout.deviceScaleFactor;
          }
          await dispatchMouseEvent(webContents, { type: 'mousePressed', x: targetX, y: targetY });
          await dispatchMouseEvent(webContents, { type: 'mouseReleased', x: targetX, y: targetY });
          return { ok: true, dispatched: { x: targetX, y: targetY } };
        }
        return { error: 'missing-target' as const };
      });
      if (result.ok && 'error' in result.data) {
        const kind = result.data.error;
        const detail = kind === 'selector-not-found'
          ? `No element matched ${selector}.`
          : kind === 'coord-mapping-failed'
            ? 'Could not read deviceScaleFactor for image-space coordinate mapping.'
            : 'Provide either selector or both x and y.';
        return errorToolResult({ kind, detail });
      }
      return driverToolResult(result);
    },
  );

  server.registerTool(
    'kangentic_browser_type',
    {
      description: "Type text into the task's Browser pane. With a selector, the element is focused (clicked) first; clearFirst selects-all and deletes before typing.",
      inputSchema: z.object({
        ...TARGET_SHAPE,
        text: z.string().describe('Text to type.'),
        selector: z.string().optional().describe('CSS selector to focus before typing.'),
        clearFirst: z.boolean().optional().describe('Select-all + delete before typing.'),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ sessionId, taskId, text, selector, clearFirst }) => {
      const result = await drive('interact', { sessionId, taskId }, async (webContents) => {
        if (typeof selector === 'string') {
          const focused = await clickAtCenterOfSelector(webContents, selector);
          if (!focused) return { error: 'selector-not-found' as const };
          if (clearFirst) {
            // Select-all is Cmd+A on macOS; Ctrl+A there is the emacs
            // beginning-of-line binding, so the clear silently selected nothing
            // and the new text appended to the old value instead of replacing
            // it. The guest is Chromium on this same OS, so the host platform is
            // the right thing to branch on.
            await dispatchKeypress(webContents, process.platform === 'darwin' ? 'Meta+a' : 'Ctrl+a');
            await dispatchKeyEvent(webContents, { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
            await dispatchKeyEvent(webContents, { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
          }
        }
        await typeText(webContents, text);
        return { ok: true };
      });
      if (result.ok && 'error' in result.data) {
        return errorToolResult({ kind: 'selector-not-found', detail: `No element matched ${selector}.` });
      }
      return driverToolResult(result);
    },
  );

  server.registerTool(
    'kangentic_browser_keypress',
    {
      description: "Send ONE key or chord to the task's Browser pane. Single printable characters are typed. Named keys: Enter, Escape, Tab, Backspace, Delete, Space, Home, End, PageUp, PageDown, ArrowUp, ArrowDown, ArrowLeft, ArrowRight - anything else named is refused with unknown-key rather than guessed. Modifiers are joined with +, e.g. Ctrl+a or Ctrl+Shift+P. This takes a SINGLE combo, not a sequence: \"ArrowDown ArrowDown\" is not valid, so call it again for each press. The key is DELIVERED to the page, but the browser default action is not performed: PageDown and End reach a page that handles them itself and do NOT scroll the document. Use kangentic_browser_scroll to scroll.",
      inputSchema: z.object({
        ...TARGET_SHAPE,
        keys: z.string().describe('One key or chord, e.g. "Enter", "PageDown", "Ctrl+Shift+P". Not a sequence - one press per call.'),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ sessionId, taskId, keys }) => {
      const result = await drive('interact', { sessionId, taskId }, async (webContents) => {
        const ok = await dispatchKeypress(webContents, keys);
        return ok ? { ok: true } : { error: 'unknown-key' as const };
      });
      if (result.ok && 'error' in result.data) {
        return errorToolResult({ kind: 'unknown-key', detail: `Could not parse key combo: ${keys}.` });
      }
      return driverToolResult(result);
    },
  );

  server.registerTool(
    'kangentic_browser_drag',
    {
      description: "Drag from one element to another in the task's Browser pane (mouse press, move in steps, release).",
      inputSchema: z.object({
        ...TARGET_SHAPE,
        fromSelector: z.string().describe('CSS selector of the drag source.'),
        toSelector: z.string().describe('CSS selector of the drop target.'),
        steps: z.number().int().positive().max(60).optional().describe('Intermediate move steps (default 10).'),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ sessionId, taskId, fromSelector, toSelector, steps }) => {
      const result = await drive('interact', { sessionId, taskId }, async (webContents) => {
        const ok = await dragFromTo(webContents, fromSelector, toSelector, { steps });
        return ok ? { ok: true } : { error: 'selector-not-found' as const };
      });
      if (result.ok && 'error' in result.data) {
        return errorToolResult({ kind: 'selector-not-found', detail: 'Drag source or target selector did not match.' });
      }
      return driverToolResult(result);
    },
  );

  server.registerTool(
    'kangentic_browser_hover',
    {
      description:
        "Move the pointer over an element in the task's Browser pane, without clicking. Use this to open a hover menu, show a tooltip, or reveal a control that only appears on hover, then screenshot or query what appeared. kangentic_browser_click already hovers before it presses, so this is for VERIFYING hover state rather than a step before clicking.",
      inputSchema: z.object({
        ...TARGET_SHAPE,
        selector: z.string().describe('CSS selector of the element to hover. Scrolled into view first.'),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ sessionId, taskId, selector }) => {
      const result = await drive('interact', { sessionId, taskId }, async (webContents) => {
        const ok = await hoverSelector(webContents, selector);
        return ok ? { ok: true } : { error: 'selector-not-found' as const };
      });
      if (result.ok && 'error' in result.data) {
        return errorToolResult({ kind: 'selector-not-found', detail: `No element matched ${selector}.` });
      }
      return driverToolResult(result);
    },
  );

  server.registerTool(
    'kangentic_browser_scroll',
    {
      description:
        "Scroll the page in the task's Browser pane by a wheel delta, the way a real scroll wheel does. Positive deltaY scrolls DOWN. Pass a selector to scroll a specific scrollable element (a panel, a list) instead of the page behind it. This is the way to reach content below the fold: keypress only moves a line at a time, and kangentic_browser_eval is usually turned off.",
      inputSchema: z.object({
        ...TARGET_SHAPE,
        deltaY: z.number().int().min(-50000).max(50000).optional().describe('Vertical scroll in CSS pixels. Positive scrolls down. Default 0.'),
        deltaX: z.number().int().min(-50000).max(50000).optional().describe('Horizontal scroll in CSS pixels. Positive scrolls right. Default 0.'),
        selector: z.string().optional().describe('CSS selector of a scrollable element to scroll. Omit to scroll the page.'),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ sessionId, taskId, deltaX, deltaY, selector }) => {
      if (!deltaX && !deltaY) {
        return errorToolResult({
          kind: 'invalid-scroll',
          detail: 'Pass deltaY (or deltaX) - a scroll of zero would do nothing. Positive deltaY scrolls down.',
        });
      }
      const result = await drive('interact', { sessionId, taskId }, async (webContents) => {
        const ok = await scrollBy(webContents, { selector, deltaX, deltaY });
        if (!ok) return { error: 'selector-not-found' as const };
        // Report where the page ended up, not what was asked for: a scroll
        // past the end of the document silently does less than requested, and
        // an agent that believes it moved 5000px reads the wrong element next.
        const metrics = await getLayoutMetrics(webContents);
        return { ok: true, viewport: metrics ? { width: metrics.viewportWidth, height: metrics.viewportHeight } : null };
      });
      if (result.ok && 'error' in result.data) {
        return errorToolResult({ kind: 'selector-not-found', detail: `No element matched ${selector}.` });
      }
      return driverToolResult(result);
    },
  );

  server.registerTool(
    'kangentic_browser_select_option',
    {
      description:
        "Choose an option in a native <select> dropdown in the task's Browser pane. Clicking cannot do this: the list a <select> opens is drawn by the operating system outside the page, so a synthesized click reaches the control and has nothing to aim at. Identify the option by value, by its visible label, or by index. Fires input and change, so framework bindings react exactly as they do for a real choice.",
      inputSchema: z.object({
        ...TARGET_SHAPE,
        selector: z.string().describe('CSS selector of the <select> element.'),
        value: z.string().optional().describe('The option\'s value attribute.'),
        label: z.string().optional().describe('The option\'s visible text, matched after trimming.'),
        index: z.number().int().min(0).optional().describe('Zero-based option index.'),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ sessionId, taskId, selector, value, label, index }) => {
      if (value === undefined && label === undefined && index === undefined) {
        return errorToolResult({
          kind: 'missing-target',
          detail: 'Pass one of value, label or index to say which option to choose.',
        });
      }
      const result = await drive('interact', { sessionId, taskId }, async (webContents) =>
        selectOptionOnSelector(webContents, selector, { value, label, index }));
      if (result.ok && !result.data.ok) {
        const reason = result.data.reason;
        return errorToolResult({
          kind: reason === 'not-a-select' ? 'not-a-select' : reason === 'no-match' ? 'no-match' : 'selector-not-found',
          detail:
            reason === 'not-a-select'
              ? `${selector} matched an element that is not a <select>. A custom dropdown built from divs is ordinary UI - use kangentic_browser_click on the control and then on the option.`
              : reason === 'no-match'
                ? `${selector} is a <select>, but no option matched. Read its options with kangentic_browser_query_all on "${selector} option" and pass one of their values.`
                : `No element matched ${selector}.`,
        });
      }
      return driverToolResult(result);
    },
  );

  server.registerTool(
    'kangentic_browser_drop_files',
    {
      description:
        "Drop real files onto an element in the task's Browser pane, exactly as dragging them out of the file manager would. The paths are absolute paths on this machine, and the page receives genuine File objects through dataTransfer.files. This is the one thing page script cannot fake, so it is the only way to test a drop zone or a file input end to end.",
      inputSchema: z.object({
        ...TARGET_SHAPE,
        selector: z.string().describe('CSS selector of the drop target.'),
        paths: z.array(z.string()).min(1).max(20).describe('Absolute file paths on this machine.'),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ sessionId, taskId, selector, paths }) => {
      const result = await drive('interact', { sessionId, taskId }, async (webContents) => {
        const ok = await dropFilesOnSelector(webContents, selector, paths);
        return ok ? { ok: true, dropped: paths.length } : { error: 'selector-not-found' as const };
      });
      if (result.ok && 'error' in result.data) {
        return errorToolResult({ kind: 'selector-not-found', detail: `No element matched ${selector}.` });
      }
      return driverToolResult(result);
    },
  );

  server.registerTool(
    'kangentic_browser_history',
    {
      description:
        "Go back or forward in the task's Browser pane history, the way the pane's own arrows do. Returns the URL it landed on. Refuses when there is nothing to go back or forward to, rather than silently doing nothing.",
      inputSchema: z.object({
        ...TARGET_SHAPE,
        direction: z.enum(['back', 'forward']).describe('Which way to move through history.'),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ sessionId, taskId, direction }) => {
      const result = await drive('navigate', { sessionId, taskId }, async (webContents) => {
        const history = webContents.navigationHistory;
        const canMove = direction === 'back' ? history.canGoBack() : history.canGoForward();
        if (!canMove) return { error: 'no-history' as const };
        if (direction === 'back') history.goBack();
        else history.goForward();
        // The navigation is asynchronous, so the URL is read after it commits
        // rather than immediately - reporting the pre-navigation URL would be
        // the echoed-not-measured mistake the viewport work exists to avoid.
        await new Promise((resolve) => {
          const done = (): void => { webContents.off('did-navigate', done); resolve(null); };
          webContents.once('did-navigate', done);
          setTimeout(done, HISTORY_NAVIGATE_TIMEOUT_MS);
        });
        return { ok: true, url: webContents.getURL() };
      });
      if (result.ok && 'error' in result.data) {
        return errorToolResult({
          kind: 'no-history',
          detail: `There is nothing to go ${direction} to in this pane's history.`,
        });
      }
      return driverToolResult(result);
    },
  );

  server.registerTool(
    'kangentic_browser_network',
    {
      description:
        "List the network requests the task's Browser pane has made, newest last: method, URL, resource type, HTTP status, failure text and duration. Use it to answer whether an API call actually fired and what it returned - the console only shows what the page chose to log. A request still in flight is listed with a null status rather than hidden, because a dev server that accepted the connection and went quiet is usually the answer you are looking for.",
      inputSchema: z.object({
        ...TARGET_SHAPE,
        limit: z.number().int().positive().max(300).optional().describe('Most recent N requests (default 50).'),
        urlContains: z.string().optional().describe('Only requests whose URL contains this substring, e.g. "/api/".'),
        failedOnly: z.boolean().optional().describe('Only requests that failed or returned status >= 400.'),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ sessionId, taskId, limit, urlContains, failedOnly }) => {
      const result = await drive('observe', { sessionId, taskId }, async (webContents) => {
        let entries = getNetworkEntries(webContents);
        if (urlContains) entries = entries.filter((entry) => entry.url.includes(urlContains));
        if (failedOnly) {
          entries = entries.filter((entry) => entry.errorText !== null || (entry.status ?? 0) >= 400);
        }
        const tail = entries.slice(-(limit ?? 50));
        return { requests: tail, returned: tail.length, total: entries.length };
      });
      return driverToolResult(result);
    },
  );

  server.registerTool(
    'kangentic_browser_handle_dialog',
    {
      description:
        "Decide how the page's JavaScript dialogs (alert, confirm, prompt, beforeunload) are answered, and read the ones already seen. Arm this BEFORE the action that triggers the dialog - a dialog blocks the page while it is open, so there is no moment afterwards in which a tool call could answer it. By default every dialog is DISMISSED (Cancel) and recorded, so a confirm() can never wedge your pane; call this with accept true to get through one. Note that prompt() is not implemented in this runtime - it throws in the page instead of opening a dialog - so promptText only matters for a page that reaches one some other way. The response lists the dialogs this pane has raised, with the text they showed.",
      inputSchema: z.object({
        ...TARGET_SHAPE,
        accept: z.boolean().optional().describe('True to press OK, false to Cancel. Default false.'),
        promptText: z.string().optional().describe('Text to enter for a prompt(). Only used when accept is true.'),
        persist: z.boolean().optional().describe('True to answer every later dialog this way. Default false: the arm is consumed by the next dialog, then reverts to dismiss.'),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ sessionId, taskId, accept, promptText, persist }) => {
      const result = await drive('interact', { sessionId, taskId }, async (webContents) => {
        const armed = { accept: accept === true, promptText, once: persist !== true };
        setDialogResponse(webContents, armed);
        return { armed, seen: getDialogEntries(webContents) };
      });
      return driverToolResult(result);
    },
  );

  // ── Viewport ──────────────────────────────────────────────────────────
  server.registerTool(
    'kangentic_browser_set_viewport',
    {
      description:
        "Set the viewport the task's Browser surface lays out against, so you can verify a responsive layout at a real desktop width instead of guessing from CSS. A docked pane is only as wide as the task window leaves it, which is usually below every desktop breakpoint. Pass width and height in CSS pixels; the response reports the viewport you actually GOT, measured from the page. `exact` tolerates 2px, so a requested 1080 reported as 1079 with `exact: true` is a correct result, not a clamp - the fit rounds to whole pixels. `exact: false` means a real shortfall, and `note` says what caused it. On an offscreen lane or a popped-out window this resizes the real surface, un-maximizing it first if it has to. On a docked pane it overrides the viewport in place, which is the option that KEEPS YOUR PAGE: no reload, sessionStorage and in-memory state survive, and your surface handle stays valid. The pane is zoomed out to fit, so the user sees the whole layout you asked for rather than a corner of it, and your screenshots still come back at full resolution. Pass `reset: true` to put both the viewport and the zoom back. An override survives navigation and lasts until you reset it, your session ends, or the user clears it from the pane.",
      inputSchema: z.object({
        ...TARGET_SHAPE,
        width: z
          .number()
          .int()
          .min(MIN_VIEWPORT_DIMENSION)
          .max(MAX_VIEWPORT_DIMENSION)
          .optional()
          .describe('Viewport width in CSS pixels, e.g. 1920. Omit to keep the current width.'),
        height: z
          .number()
          .int()
          .min(MIN_VIEWPORT_DIMENSION)
          .max(MAX_VIEWPORT_DIMENSION)
          .optional()
          .describe('Viewport height in CSS pixels, e.g. 1080. Omit to keep the current height.'),
        deviceScaleFactor: z
          .number()
          .min(0)
          .max(4)
          .optional()
          .describe(
            'Device pixel ratio for the emulated viewport. 0 (the default) keeps the display\'s own, which is what you want unless you are testing hidpi assets. Note 2 quadruples screenshot bytes and will push a wide capture out to a file.',
          ),
        zoom: z
          .number()
          .min(0.25)
          .max(5)
          .optional()
          .describe(
            'Page zoom factor, the same one the pane\'s zoom pill shows. Omit it and a docked pane is zoomed to FIT the width and height above, which is almost always what you want. Pass 1 to render 1:1 instead, which crops a wide layout to the pane but is the sharpest capture. The width and height mean the same thing either way: the layout is always the size you asked for.',
          ),
        position: z
          .enum(WINDOW_ANCHORS)
          .optional()
          .describe(
            'Where to put a DETACHED window on its display, as a nine-point anchor: top-left, top, top-right, left, center, right, bottom-left, bottom, bottom-right. Use this with width and height for a window snap: half the display width plus `left` docks it to the left half of the monitor the window is on. Ignored with an explanation on a docked pane (it has no position of its own - pop it out first) and on a lane (offscreen).',
          ),
        reset: z
          .boolean()
          .optional()
          .describe('Drop the viewport override and return the surface to its natural size. Ignores width and height.'),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ sessionId, taskId, width, height, deviceScaleFactor, zoom, position, reset }) => {
      // Validated here as well as in zod, because a value that reaches the
      // guest as NaN or a fraction becomes a compositor surface rather than an
      // error, and the failure then looks like a broken page.
      for (const [name, value] of [['width', width], ['height', height]] as const) {
        if (value === undefined) continue;
        if (!Number.isFinite(value) || value < MIN_VIEWPORT_DIMENSION || value > MAX_VIEWPORT_DIMENSION) {
          return errorToolResult({
            kind: 'invalid-viewport',
            detail: `${name} must be a whole number of CSS pixels between ${MIN_VIEWPORT_DIMENSION} and ${MAX_VIEWPORT_DIMENSION}. Got ${String(value)}.`,
          });
        }
      }

      const result = await drive<ApplyViewportOutcome>(
        'interact',
        { sessionId, taskId },
        (webContents, entry) =>
          reset === true
            ? clearViewport(webContents, entry)
            : applyViewport(
                webContents,
                entry,
                { width, height, deviceScaleFactor, zoom, position },
                callerSessionId ?? null,
              ),
      );
      return driverToolResult(result);
    },
  );

  // ── Detach / dock ─────────────────────────────────────────────────────
  server.registerTool(
    'kangentic_browser_pop_out',
    {
      description:
        "Detach YOUR OWN task's Browser pane into its own OS window, optionally at a given size and position, so you can test against a real desktop viewport with no emulation: 1:1 coordinates and screenshots that are the thing itself. The response carries `display`, the usable size of the monitor the window landed on, so sizing relative to the screen (half the width, full height) takes no extra call. Pass width and height in CSS pixels, or maximized. IMPORTANT: this MOVES the page, which RELOADS it - sessionStorage and in-memory state are lost and your current surface handle dies, so use the sessionId this returns from now on. Cookies and localStorage carry over. If you are midway through a signed-in flow, use kangentic_browser_set_viewport instead; it changes the viewport in place and keeps the page. Returns only once the new window's pane is driveable. Does not take the user's keyboard focus. Put it back with kangentic_browser_dock.",
      inputSchema: z.object({
        width: z
          .number()
          .int()
          .min(MIN_VIEWPORT_DIMENSION)
          .max(MAX_VIEWPORT_DIMENSION)
          .optional()
          .describe('Requested viewport width in CSS pixels. The window is capped by the physical display, and the response reports what the page actually got.'),
        height: z
          .number()
          .int()
          .min(MIN_VIEWPORT_DIMENSION)
          .max(MAX_VIEWPORT_DIMENSION)
          .optional()
          .describe('Requested viewport height in CSS pixels. Same capping and reporting as width.'),
        maximized: z.boolean().optional().describe('Open the window maximized instead of at a given size.'),
        position: z
          .enum(WINDOW_ANCHORS)
          .optional()
          .describe(
            'Where to place the window on its display: top-left, top, top-right, left, center, right, bottom-left, bottom, bottom-right. Combine with width and height for a snap, e.g. half the display width plus `left`.',
          ),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ width, height, maximized, position }) => {
      const result = await popOutPaneForCallerTask({
        projectId,
        callerSessionId,
        callerTaskId,
        width,
        height,
        maximized,
        position,
        // Detaching reloads the page at its URL, so it is a navigation-tier
        // action for the same reason opening a pane is: "Allow navigation" off
        // disables this tool too.
        capability: 'navigate',
        config: getAutomationConfig(),
      });
      return driverToolResult(result);
    },
  );

  server.registerTool(
    'kangentic_browser_dock',
    {
      description:
        "Put YOUR OWN task's detached Browser window back into the task, undoing kangentic_browser_pop_out. Like detaching, this MOVES the page and therefore RELOADS it: sessionStorage and in-memory state are lost and the detached window's handle dies, so use the sessionId this returns from now on. Returns only once the docked pane is driveable again. Fails with not-detached when the pane is already in the task window.",
      inputSchema: z.object({}),
      annotations: MUTATING_ANNOTATIONS,
    },
    async () => {
      const result = await dockPaneForCallerTask({
        projectId,
        callerSessionId,
        callerTaskId,
        capability: 'navigate',
        config: getAutomationConfig(),
      });
      return driverToolResult(result);
    },
  );

  // ── Eval (gated) ──────────────────────────────────────────────────────
  server.registerTool(
    'kangentic_browser_eval',
    {
      description: "Evaluate a JavaScript expression in the task's Browser pane (the loaded page's origin) and return its value. Off by default - enable in Settings -> Agent Browser -> Allow eval.",
      inputSchema: z.object({
        ...TARGET_SHAPE,
        expression: z.string().describe('JavaScript expression to evaluate. The resolved value is returned.'),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ sessionId, taskId, expression }) => {
      const result = await drive('eval', { sessionId, taskId }, (webContents) =>
        // Bounded, because this is the one body that runs CALLER-AUTHORED page
        // JavaScript and `runtimeEvaluate` defaults to `awaitPromise: true`. An
        // expression that never settles (`new Promise(() => {})`, an await on an
        // unreachable host) holds the guest's drive lock forever: the drive lock
        // bounds ACQUISITION only, so once the body starts it runs to
        // completion, and every later call on that guest then fails with
        // GuestBusyError until the app restarts. The other `runtimeEvaluate`
        // callers pass fixed, short probes, so the bound lives here rather than
        // in the shared CDP driver, which the dev inspection bridge also uses.
        boundedEvaluate(webContents, expression),
      );
      if (result.ok && result.data.error) {
        return errorToolResult({ kind: 'evaluate-failed', detail: result.data.error });
      }
      if (result.ok) return driverToolResult({ ok: true, data: { value: result.data.value } });
      return driverToolResult(result);
    },
  );
}
