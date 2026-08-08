import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WebContents } from 'electron';
import { z } from 'zod/v4';
import {
  withGuest,
  validateNavigationUrl,
  type BrowserCapability,
  type DriverResult,
} from '../../browser/browser-pane-driver';
import {
  browserPaneRegistry,
  type ResolveTargetSelector,
} from '../../browser/browser-pane-registry';
import type { ResolvedBrowserAutomationConfig } from '../../browser/browser-automation-config';
import {
  clickAtCenterOfSelector,
  dispatchMouseEvent,
  dispatchKeyEvent,
  dispatchKeypress,
  dragFromTo,
  getOuterHtml,
  getBoundingBox,
  getConsoleEntries,
  getLayoutMetrics,
  queryAllElements,
  runtimeEvaluate,
  typeText,
} from '../../browser/cdp/cdp';
import {
  captureScreenshotWithBudget,
  captureElementClip,
} from '../../browser/cdp/screenshot';
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
  "Optional Kangentic sessionId of the task whose Browser pane to target. Must name a pane in your own project; a pane in another project is refused. Omit to use your own task's pane, or the single pane open in your project. Use kangentic_browser_list_panes to discover panes.";
const TASK_DESC =
  "Optional Kangentic taskId whose Browser pane to target. An alternative to sessionId, and must likewise be a task in your own project. Omit to use your own task's pane, or the single pane open in your project.";

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
  // opt out of it. This is the single point that scopes all 13 driving tools.
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
    fn: (webContents: WebContents) => Promise<Result>,
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
        'List the embedded Browser panes open in your project, with their sessionId, taskId, current URL, and whether the pane is alive / debugger-attached. Use this to discover a sessionId/taskId to pass to the other kangentic_browser_* tools, or to confirm the user has a dev server loaded. Panes in other projects are excluded by default and cannot be driven from this connection; pass includeOtherProjects to see them too. Returns an empty list when no pane is open.',
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
        await webContents.loadURL(validated.url);
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
      const result = await drive('observe', { sessionId, taskId }, (webContents) =>
        captureScreenshotWithBudget(webContents, {
          format: format ?? 'jpeg',
          quality: quality ?? (format === 'png' ? undefined : 80),
          fullPage: fullPage === true,
          maxBytes,
        }),
      );
      if (!result.ok) return errorToolResult(result.error);
      if (!result.data) return errorToolResult({ kind: 'screenshot-failed', detail: 'Page.captureScreenshot returned no data.' });
      return screenshotToolResult({ ok: true, data: result.data });
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
      description: "Get the raw CDP box-model (content/padding/border/margin quads) of an element in the task's Browser pane.",
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
      const result = await drive('observe', { sessionId, taskId }, async (webContents) => {
        const timeout = clampNumber(timeoutMs, 30000, 60000);
        const interval = clampNumber(intervalMs, 250, 5000);
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          if (selector) {
            const html = await getOuterHtml(webContents, selector);
            if (html !== null && (!domText || html.includes(domText))) {
              return { matched: true, matchedAt: new Date().toISOString() };
            }
          } else if (domText) {
            const html = await getOuterHtml(webContents, 'body');
            if (html !== null && html.includes(domText)) {
              return { matched: true, matchedAt: new Date().toISOString() };
            }
          }
          await sleep(interval);
        }
        return { matched: false, timedOutAfterMs: timeout };
      });
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
            await dispatchKeypress(webContents, 'Ctrl+a');
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
      description: "Send a key or chord to the task's Browser pane (e.g. Enter, Escape, Tab, Ctrl+a, ArrowDown). Single printable characters are typed.",
      inputSchema: z.object({
        ...TARGET_SHAPE,
        keys: z.string().describe('Key or chord, e.g. "Enter", "Escape", "Ctrl+Shift+P", "ArrowDown".'),
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
        runtimeEvaluate(webContents, expression),
      );
      if (result.ok && result.data.error) {
        return errorToolResult({ kind: 'evaluate-failed', detail: result.data.error });
      }
      if (result.ok) return driverToolResult({ ok: true, data: { value: result.data.value } });
      return driverToolResult(result);
    },
  );
}
