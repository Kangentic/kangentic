import type { WebContents } from 'electron';
import type { QueryAllResult } from './types';

/**
 * Wraps `webContents.debugger.attach('1.3')` and exposes typed helpers
 * for the Chrome DevTools Protocol calls. Content-agnostic: it drives any
 * `WebContents` the caller hands it. Two consumers share it - the shipped
 * browser-pane driver (an embedded `<webview>` guest) and the dev-only
 * inspection bridge (the app's own main window). All CDP `sendCommand`
 * calls in the codebase route through this single module.
 *
 * Single attach per webContents. Subsequent `attach()` calls are no-ops.
 * `detach()` is wired into each consumer's synchronous shutdown path so
 * the debugger is released cleanly on app quit.
 *
 * Console.messageAdded events feed an internal ring buffer so the
 * `/console` endpoint can return the last N messages without keeping
 * a live websocket open. Buffer size is fixed at 500 entries.
 */

const CDP_VERSION = '1.3';
const CONSOLE_RING_SIZE = 500;

interface AttachedState {
  webContents: WebContents;
  consoleRing: ConsoleEntry[];
  consoleListener: (event: Electron.Event, method: string, params: unknown) => void;
  detachListener: (event: Electron.Event, reason: string) => void;
  /** `Emulation.setFocusEmulationEnabled` has been sent for THIS CDP session.
   *  Lives on the attached state, not in a module Set, so it resets with the
   *  session for free: the detach listener drops this whole entry. */
  focusEmulated: boolean;
}

export interface ConsoleEntry {
  ts: string;
  level: 'log' | 'warn' | 'error' | 'info' | 'debug' | 'verbose';
  text: string;
  url: string | null;
  lineNumber: number | null;
}

const attached = new WeakMap<WebContents, AttachedState>();

export function attachDebugger(webContents: WebContents): boolean {
  if (attached.has(webContents)) return true;
  try {
    webContents.debugger.attach(CDP_VERSION);
  } catch {
    return false;
  }
  const state: AttachedState = {
    webContents,
    focusEmulated: false,
    consoleRing: [],
    consoleListener: (_event, method, params) => {
      if (method === 'Console.messageAdded') {
        const message = (params as { message: ConsoleMessage }).message;
        state.consoleRing.push({
          ts: new Date().toISOString(),
          level: normalizeLevel(message.level),
          text: message.text ?? '',
          url: message.url ?? null,
          lineNumber: typeof message.line === 'number' ? message.line : null,
        });
        while (state.consoleRing.length > CONSOLE_RING_SIZE) {
          state.consoleRing.shift();
        }
      }
    },
    detachListener: (_event, _reason) => {
      // Fires when the debugger is detached for any reason: explicit
      // `webContents.debugger.detach()` from us, the user opening
      // DevTools (which steals the connection), or the webContents being
      // destroyed. Drop the WeakMap entry so subsequent calls see "not
      // attached" instead of stale state - they'll either return null /
      // 5xx through the inspection-server, or the bridge can re-attach
      // explicitly via attachDebugger() when appropriate. We deliberately
      // do NOT auto-reattach: the typical cause is the user opening
      // DevTools, and stealing it back would be hostile.
      attached.delete(state.webContents);
    },
  };
  webContents.debugger.on('message', state.consoleListener);
  webContents.debugger.on('detach', state.detachListener);
  // Enable the domains we use. Each `sendCommand` is fire-and-forget;
  // failures during enable are non-fatal and the corresponding endpoint
  // returns 5xx if its capability is missing. Console.* is technically
  // deprecated in modern CDP in favor of Runtime.consoleAPICalled, but
  // it still works on Chromium 120+ which is what current Electron ships.
  void webContents.debugger.sendCommand('Console.enable').catch(() => {});
  void webContents.debugger.sendCommand('DOM.enable').catch(() => {});
  void webContents.debugger.sendCommand('Runtime.enable').catch(() => {});
  void webContents.debugger.sendCommand('CSS.enable').catch(() => {});
  attached.set(webContents, state);
  return true;
}

export function detachDebugger(webContents: WebContents): void {
  // `before-quit` may fire after the webContents is destroyed; bail rather
  // than throw "Object has been destroyed" when touching the debugger.
  if (webContents.isDestroyed()) return;
  const state = attached.get(webContents);
  if (!state) return;
  try {
    webContents.debugger.removeListener('message', state.consoleListener);
    webContents.debugger.removeListener('detach', state.detachListener);
    webContents.debugger.detach();
  } catch {
    // best-effort
  }
  attached.delete(webContents);
}

/**
 * Returns true when CDP is currently attached to the given webContents.
 * Callers can use this to fail-fast with a clear error instead of waiting
 * for the underlying sendCommand to reject.
 */
export function isDebuggerAttached(webContents: WebContents): boolean {
  return attached.has(webContents);
}

/**
 * Make a guest render and behave as a FOCUSED page, without the browser ever
 * giving it real keyboard focus.
 *
 * What it buys, stated carefully because a stronger claim here was wrong once:
 * the page BEHAVES as focused. A page that hides UI, pauses a render loop, or
 * drops a selection highlight on blur keeps working while an agent drives it,
 * and the guest's own focused element survives the renderer handing the user's
 * focus back (`src/renderer/utils/agent-input-focus-guard.ts`).
 *
 * What it does NOT do is affect input ROUTING. Measured inside a guest during a
 * drive whose keystrokes were being dropped: `document.hasFocus()` was already
 * `true` while nothing landed. Chromium routes keyboard input to the widget that
 * genuinely holds focus, and emulation does not change which widget that is - so
 * do not reach for this when a `type` call is not landing. See
 * `.claude/rules/agent-driven-focus.md` for what actually governs that.
 *
 * Idempotent per CDP session, and deliberately NOT called from
 * `attachDebugger`: the dev inspection bridge attaches through that same
 * function against Kangentic's OWN window (`src/devtools/install.ts`), where a
 * permanently-focused page would change `document.hasFocus()` under the app
 * itself. Only the browser-pane driver arms it.
 *
 * Fire-and-forget like the domain enables above: a guest that refuses the
 * command is not a reason to fail the tool call.
 *
 * See `.claude/rules/agent-driven-focus.md`.
 */
export function ensureFocusEmulation(webContents: WebContents): void {
  const state = attached.get(webContents);
  if (!state || state.focusEmulated) return;
  state.focusEmulated = true;
  void webContents.debugger
    .sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    .catch(() => {});
}

interface ConsoleMessage {
  level?: string;
  text?: string;
  url?: string;
  line?: number;
}

function normalizeLevel(level: string | undefined): ConsoleEntry['level'] {
  switch (level) {
    case 'log':
    case 'warn':
    case 'error':
    case 'info':
    case 'debug':
    case 'verbose':
      return level;
    default:
      return 'log';
  }
}

export function getConsoleEntries(webContents: WebContents): ConsoleEntry[] {
  const state = attached.get(webContents);
  return state ? [...state.consoleRing] : [];
}

// ---------------------------------------------------------------------------
// Page / Screenshot
// ---------------------------------------------------------------------------

export interface ScreenshotOptions {
  format?: 'png' | 'jpeg';
  quality?: number;
  clip?: { x: number; y: number; width: number; height: number; scale?: number };
  fullPage?: boolean;
}

/**
 * `Page.captureScreenshot` waits for a composited frame, so it NEVER RESOLVES
 * when the guest is not being composited: a minimized or fully occluded host
 * window, a `visibility: hidden` or offscreen subtree. Worse than the missing
 * image, the un-settled command wedges that guest's CDP queue and every later
 * command stacks behind it, so one screenshot at the wrong moment bricks the
 * pane for the rest of the session.
 *
 * Measured on Electron 41: minimized and occluded hosts both hang indefinitely,
 * while an `opacity: 0` subtree in a visible window still composites and
 * captures normally. Occlusion is not observable from the main process, so a
 * precondition check cannot cover every case and this bound is the real
 * guarantee: the call fails cleanly and the agent gets an actionable error
 * rather than a tool call that never returns.
 */
export const SCREENSHOT_TIMEOUT_MS = 5000;

export class ScreenshotNotComposited extends Error {
  constructor() {
    // The bound is interpolated, never restated: the agent-facing message, the
    // race below, and the test all have to move together when it changes.
    super(
      `The Browser pane produced no frame within ${SCREENSHOT_TIMEOUT_MS / 1000}s, which means its window is not being composited (minimized, or fully covered by another window). Ask the user to bring the Kangentic window to the front, then retry. Other tools that do not need pixels, such as query_dom and click, still work.`,
    );
    this.name = 'ScreenshotNotComposited';
  }
}

export async function captureScreenshot(
  webContents: WebContents,
  options: ScreenshotOptions = {},
): Promise<string | null> {
  let timer: NodeJS.Timeout | undefined;
  const capture = webContents.debugger.sendCommand('Page.captureScreenshot', {
    format: options.format ?? 'png',
    quality: options.quality,
    clip: options.clip
      ? { ...options.clip, scale: options.clip.scale ?? 1 }
      : undefined,
    captureBeyondViewport: options.fullPage ?? false,
  }) as Promise<{ data: string }>;
  const bounded = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ScreenshotNotComposited()), SCREENSHOT_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([capture, bounded]);
    return result.data ?? null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface LayoutMetrics {
  /** Layout viewport in CSS pixels (matches `window.innerWidth/Height`). */
  viewportWidth: number;
  viewportHeight: number;
  /** Device pixel ratio applied by `Page.captureScreenshot` to produce raster output. */
  deviceScaleFactor: number;
  /** Full document size in CSS pixels (used by `fullPage: true` capture). */
  contentWidth: number;
  contentHeight: number;
}

/**
 * Returns the layout viewport, device scale factor, and full content size.
 * Used by the screenshot response to surface scale metadata so the agent
 * can map image-space coordinates back to viewport-space without guessing.
 */
export async function getLayoutMetrics(webContents: WebContents): Promise<LayoutMetrics | null> {
  try {
    const result = (await webContents.debugger.sendCommand('Page.getLayoutMetrics')) as {
      cssLayoutViewport?: { clientWidth: number; clientHeight: number };
      layoutViewport?: { clientWidth: number; clientHeight: number };
      cssVisualViewport?: { scale?: number };
      visualViewport?: { scale?: number };
      cssContentSize?: { width: number; height: number };
      contentSize?: { width: number; height: number };
    };
    const viewport = result.cssLayoutViewport ?? result.layoutViewport;
    const content = result.cssContentSize ?? result.contentSize;
    if (!viewport) return null;
    const deviceScaleFactorResult = (await webContents.debugger.sendCommand('Runtime.evaluate', {
      expression: 'window.devicePixelRatio',
      returnByValue: true,
    })) as { result: { value?: number } };
    const deviceScaleFactor =
      typeof deviceScaleFactorResult.result.value === 'number'
        ? deviceScaleFactorResult.result.value
        : 1;
    return {
      viewportWidth: viewport.clientWidth,
      viewportHeight: viewport.clientHeight,
      deviceScaleFactor,
      contentWidth: content?.width ?? viewport.clientWidth,
      contentHeight: content?.height ?? viewport.clientHeight,
    };
  } catch {
    return null;
  }
}

/**
 * Parse PNG/JPEG header bytes to recover the rasterized image dimensions.
 * Avoids paying for a separate CDP roundtrip just to learn what we
 * already produced. PNG dimensions live at offset 16/20; JPEG SOF
 * markers carry them in the marker payload.
 */
export function decodeImageDimensions(
  format: 'png' | 'jpeg',
  buffer: Buffer,
): { width: number; height: number } | null {
  if (format === 'png') {
    if (buffer.length < 24) return null;
    if (buffer.readUInt32BE(0) !== 0x89504e47) return null;
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset < buffer.length - 9) {
    if (buffer[offset] !== 0xff) break;
    const marker = buffer[offset + 1];
    const segmentLength = buffer.readUInt16BE(offset + 2);
    const isStartOfFrame =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isStartOfFrame) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + segmentLength;
  }
  return null;
}

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

interface DocumentRoot {
  root: { nodeId: number; backendNodeId: number };
}

interface QueriedNode {
  nodeId: number;
}

interface OuterHtml {
  outerHTML: string;
}

interface BoxModel {
  model: {
    width: number;
    height: number;
    border: number[];
    content: number[];
    margin: number[];
    padding: number[];
  };
}

/**
 * Selector spec parsed out of the user-supplied string. Supports the
 * standard CSS form plus three convenience prefixes that match
 * Playwright vocabulary:
 *
 *   - `text="Cancel"` (or `text=Cancel`)         -> exact visible-text match
 *   - `text*="Cancel"` (or `text*=Cancel`)       -> substring visible-text match
 *   - `aria="Cancel"` (or `aria=Cancel`)         -> accessible name match
 *   - `:has-text("Cancel")`                       -> alias for text*=
 *
 * Anything that doesn't match those prefixes falls through to plain
 * CSS, so existing callers continue to work without changes.
 */
interface SelectorSpec {
  kind: 'css' | 'text' | 'text-contains' | 'aria';
  value: string;
}

const TEXT_RE = /^text=(?:"([^"]*)"|'([^']*)'|(.+))$/;
const TEXT_CONTAINS_RE = /^text\*=(?:"([^"]*)"|'([^']*)'|(.+))$/;
const ARIA_RE = /^aria=(?:"([^"]*)"|'([^']*)'|(.+))$/;
const HAS_TEXT_RE = /:has-text\((?:"([^"]*)"|'([^']*)')\)/;

export function parseSelectorSpec(selector: string): SelectorSpec {
  const trimmed = selector.trim();
  let match = trimmed.match(TEXT_RE);
  if (match) return { kind: 'text', value: match[1] ?? match[2] ?? match[3] ?? '' };
  match = trimmed.match(TEXT_CONTAINS_RE);
  if (match) return { kind: 'text-contains', value: match[1] ?? match[2] ?? match[3] ?? '' };
  match = trimmed.match(ARIA_RE);
  if (match) return { kind: 'aria', value: match[1] ?? match[2] ?? match[3] ?? '' };
  match = trimmed.match(HAS_TEXT_RE);
  if (match) return { kind: 'text-contains', value: match[1] ?? match[2] ?? '' };
  return { kind: 'css', value: trimmed };
}

interface EvaluateNodeResult {
  result: { objectId?: string; subtype?: string };
  exceptionDetails?: unknown;
}

async function resolveSelector(webContents: WebContents, selector: string): Promise<number | null> {
  const spec = parseSelectorSpec(selector);
  if (spec.kind === 'css') {
    const root = (await webContents.debugger.sendCommand('DOM.getDocument', {
      depth: 0,
    })) as DocumentRoot;
    const queried = (await webContents.debugger.sendCommand('DOM.querySelector', {
      nodeId: root.root.nodeId,
      selector: spec.value,
    })) as QueriedNode;
    return queried.nodeId || null;
  }
  const expression = buildSelectorExpression(spec);
  const evalResult = (await webContents.debugger.sendCommand('Runtime.evaluate', {
    expression,
    returnByValue: false,
  })) as EvaluateNodeResult;
  if (evalResult.exceptionDetails) return null;
  const objectId = evalResult.result?.objectId;
  if (!objectId || evalResult.result.subtype === 'null') return null;
  try {
    const nodeResult = (await webContents.debugger.sendCommand('DOM.requestNode', {
      objectId,
    })) as { nodeId: number };
    return nodeResult.nodeId || null;
  } finally {
    try {
      await webContents.debugger.sendCommand('Runtime.releaseObject', { objectId });
    } catch {
      // best-effort
    }
  }
}

/**
 * Candidate pool for `text=` / `text*=` matching, shared by
 * `buildSelectorExpression` (first match) and `buildSelectorAllExpression`
 * (all matches) so the two paths cannot drift. Favors interactive / labeled
 * elements so a parent wrapper does not over-match; missing a candidate is
 * better than a benign over-match because the agent gets a clear "not found".
 */
const CANDIDATE_POOL_SELECTOR =
  'button, a, input, textarea, select, label, summary, [role], [aria-label], [aria-labelledby], [contenteditable="true"]';

/**
 * Content-named element pool for `aria=` matching: elements whose accessible
 * name derives from their text content per WAI-ARIA (button, link, heading,
 * etc.). Shared by both selector builders so the single-match and all-match
 * aria paths cannot drift.
 */
const ARIA_CONTENT_NAME_SELECTOR =
  'button, a, [role="button"], [role="link"], [role="menuitem"], [role="tab"], h1, h2, h3, h4, h5, h6';

export function buildSelectorExpression(spec: SelectorSpec): string {
  const targetLiteral = JSON.stringify(spec.value);
  const candidatesJs = `document.querySelectorAll(${JSON.stringify(CANDIDATE_POOL_SELECTOR)})`;
  if (spec.kind === 'text') {
    return `(() => {
      const target = ${targetLiteral};
      for (const element of ${candidatesJs}) {
        const ariaLabel = element.getAttribute('aria-label');
        const visibleText = (ariaLabel ?? element.innerText ?? element.textContent ?? '').trim();
        if (visibleText === target) return element;
      }
      return null;
    })()`;
  }
  if (spec.kind === 'text-contains') {
    return `(() => {
      const target = ${targetLiteral};
      for (const element of ${candidatesJs}) {
        const ariaLabel = element.getAttribute('aria-label');
        const visibleText = (ariaLabel ?? element.innerText ?? element.textContent ?? '').trim();
        if (visibleText.includes(target)) return element;
      }
      return null;
    })()`;
  }
  // aria=: prefer aria-label, fall back to text content for unlabeled
  // elements whose name derives from their content per the WAI-ARIA spec
  // (button, link, heading, etc.).
  return `(() => {
    const target = ${targetLiteral};
    for (const element of document.querySelectorAll('[aria-label]')) {
      if ((element.getAttribute('aria-label') ?? '').trim() === target) return element;
    }
    for (const element of document.querySelectorAll(${JSON.stringify(ARIA_CONTENT_NAME_SELECTOR)})) {
      const visibleText = (element.innerText ?? element.textContent ?? '').trim();
      if (visibleText === target) return element;
    }
    return null;
  })()`;
}

/**
 * Build a single self-contained expression that measures EVERY element
 * matching `spec` (unlike `buildSelectorExpression`, which returns the
 * first match). Evaluated once via `Runtime.evaluate` so N elements cost
 * one CDP round-trip. `attributes` / `outerHTML` are included only when
 * requested to keep multi-element payloads lean. Pure + exported so the
 * collection logic is unit-testable without a live window.
 */
export function buildSelectorAllExpression(
  spec: SelectorSpec,
  opts: { includeHtml: boolean; includeAttributes: boolean; limit: number; htmlMaxChars: number },
): string {
  let collectExpr: string;
  if (spec.kind === 'css') {
    collectExpr = 'Array.from(document.querySelectorAll(target))';
  } else if (spec.kind === 'text' || spec.kind === 'text-contains') {
    const comparison = spec.kind === 'text' ? 'visibleText === target' : 'visibleText.includes(target)';
    collectExpr = `Array.from(document.querySelectorAll(${JSON.stringify(CANDIDATE_POOL_SELECTOR)})).filter((element) => {
        const ariaLabel = element.getAttribute('aria-label');
        const visibleText = (ariaLabel ?? element.innerText ?? element.textContent ?? '').trim();
        return ${comparison};
      })`;
  } else {
    // aria=: aria-label matches first, then content-derived names, deduped.
    collectExpr = `(() => {
        const matched = new Set();
        for (const element of document.querySelectorAll('[aria-label]')) {
          if ((element.getAttribute('aria-label') ?? '').trim() === target) matched.add(element);
        }
        for (const element of document.querySelectorAll(${JSON.stringify(ARIA_CONTENT_NAME_SELECTOR)})) {
          const visibleText = (element.innerText ?? element.textContent ?? '').trim();
          if (visibleText === target) matched.add(element);
        }
        return Array.from(matched);
      })()`;
  }
  return `(() => {
    const target = ${JSON.stringify(spec.value)};
    const LIMIT = ${opts.limit};
    const HTML_MAX = ${opts.htmlMaxChars};
    const INCLUDE_HTML = ${opts.includeHtml ? 'true' : 'false'};
    const INCLUDE_ATTRS = ${opts.includeAttributes ? 'true' : 'false'};
    const all = ${collectExpr};
    const total = all.length;
    const elements = all.slice(0, LIMIT).map((element, index) => {
      const rect = element.getBoundingClientRect();
      const entry = {
        index,
        tag: element.tagName.toLowerCase(),
        box: {
          x: rect.x, y: rect.y, width: rect.width, height: rect.height,
          top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left,
        },
      };
      if (INCLUDE_ATTRS) {
        const attributes = {};
        for (const attribute of element.attributes) attributes[attribute.name] = attribute.value;
        entry.attributes = attributes;
      }
      if (INCLUDE_HTML) {
        const html = element.outerHTML ?? '';
        entry.outerHTML = html.length > HTML_MAX ? html.slice(0, HTML_MAX) : html;
        if (html.length > HTML_MAX) entry.outerHTMLTruncated = true;
      }
      return entry;
    });
    return {
      selector: target,
      kind: ${JSON.stringify(spec.kind)},
      total,
      returned: elements.length,
      truncated: total > elements.length,
      elements,
    };
  })()`;
}

/**
 * Measure every element matching `selector` in one round-trip. Returns
 * the raw `runtimeEvaluate` envelope so callers can distinguish an
 * evaluation error (invalid selector) from an empty match set.
 */
export async function queryAllElements(
  webContents: WebContents,
  selector: string,
  opts: { includeHtml: boolean; includeAttributes: boolean; limit: number; htmlMaxChars: number },
): Promise<{ value: QueryAllResult | null; error: string | null }> {
  const spec = parseSelectorSpec(selector);
  const expression = buildSelectorAllExpression(spec, opts);
  return runtimeEvaluate<QueryAllResult>(webContents, expression);
}

export async function getOuterHtml(
  webContents: WebContents,
  selector: string,
): Promise<string | null> {
  const nodeId = await resolveSelector(webContents, selector);
  if (!nodeId) return null;
  return getOuterHtmlByNodeId(webContents, nodeId);
}

export async function getOuterHtmlByNodeId(
  webContents: WebContents,
  nodeId: number,
): Promise<string | null> {
  const result = (await webContents.debugger.sendCommand('DOM.getOuterHTML', {
    nodeId,
  })) as OuterHtml;
  return result.outerHTML ?? null;
}

export async function getBoundingBox(
  webContents: WebContents,
  selector: string,
): Promise<BoxModel['model'] | null> {
  const nodeId = await resolveSelector(webContents, selector);
  if (!nodeId) return null;
  return getBoundingBoxByNodeId(webContents, nodeId);
}

export async function getBoundingBoxByNodeId(
  webContents: WebContents,
  nodeId: number,
): Promise<BoxModel['model'] | null> {
  try {
    const result = (await webContents.debugger.sendCommand('DOM.getBoxModel', {
      nodeId,
    })) as BoxModel;
    return result.model;
  } catch {
    return null;
  }
}

/**
 * Public selector resolver. Useful when callers want to do multiple CDP
 * operations against the same element without re-running DOM.querySelector
 * each time. Returns null when the selector doesn't match.
 */
export async function resolveSelectorPublic(
  webContents: WebContents,
  selector: string,
): Promise<number | null> {
  return resolveSelector(webContents, selector);
}

export async function getComputedStyle(
  webContents: WebContents,
  selector: string,
): Promise<Record<string, string> | null> {
  const nodeId = await resolveSelector(webContents, selector);
  if (!nodeId) return null;
  try {
    const result = (await webContents.debugger.sendCommand(
      'CSS.getComputedStyleForNode',
      { nodeId },
    )) as { computedStyle: { name: string; value: string }[] };
    const out: Record<string, string> = {};
    for (const entry of result.computedStyle) out[entry.name] = entry.value;
    return out;
  } catch {
    return null;
  }
}

export async function getAccessibilityTree(
  webContents: WebContents,
): Promise<unknown> {
  try {
    return await webContents.debugger.sendCommand('Accessibility.getFullAXTree');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Input (mouse + keyboard)
// ---------------------------------------------------------------------------

export type MouseEventType = 'mousePressed' | 'mouseReleased' | 'mouseMoved';
export type MouseButton = 'none' | 'left' | 'middle' | 'right';

export interface MouseEventOptions {
  type: MouseEventType;
  x: number;
  y: number;
  button?: MouseButton;
  clickCount?: number;
}

export async function dispatchMouseEvent(
  webContents: WebContents,
  options: MouseEventOptions,
): Promise<void> {
  await webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type: options.type,
    x: options.x,
    y: options.y,
    button: options.button ?? (options.type === 'mouseMoved' ? 'none' : 'left'),
    clickCount: options.clickCount ?? (options.type === 'mouseMoved' ? 0 : 1),
  });
}

/**
 * Bring an element into the viewport before it is measured or clicked.
 *
 * REQUIRED, not an optimization. `Input.dispatchMouseEvent` takes coordinates
 * relative to the VIEWPORT, while `DOM.getBoxModel` measures in page space - so
 * for anything below the fold the click was dispatched at a y far outside the
 * viewport and simply never landed. Measured on a real page: an element 11,122px
 * down reported that exact y, the click reported success, and the page did not
 * react at all. That is the worst shape a bug can take here, because the tool
 * told the agent it had clicked.
 *
 * Best-effort: a node that cannot be scrolled (detached, `display: none`) just
 * leaves the caller measuring what it would have measured anyway, and the caller
 * still reports honestly from the box it gets back.
 */
async function scrollNodeIntoView(webContents: WebContents, nodeId: number): Promise<void> {
  try {
    await webContents.debugger.sendCommand('DOM.scrollIntoViewIfNeeded', { nodeId });
  } catch {
    // best-effort
  }
}

/** Centroid of a box-model content quad: x0,y0, x1,y1, x2,y2, x3,y3
 *  (top-left, top-right, bottom-right, bottom-left). */
function contentCentroid(box: BoxModel['model']): { x: number; y: number } | null {
  if (!box || !Array.isArray(box.content) || box.content.length < 8) return null;
  return {
    x: (box.content[0] + box.content[4]) / 2,
    y: (box.content[1] + box.content[5]) / 2,
  };
}

/**
 * Scroll an element into view and return the viewport centroid to click.
 * Returns null when the selector does not resolve or cannot be measured.
 */
async function resolveClickPoint(
  webContents: WebContents,
  selector: string,
): Promise<{ x: number; y: number } | null> {
  const nodeId = await resolveSelector(webContents, selector);
  if (!nodeId) return null;
  await scrollNodeIntoView(webContents, nodeId);
  // Measured AFTER the scroll: the box is only meaningful once the element is
  // actually in the viewport the click coordinates address.
  const box = await getBoundingBoxByNodeId(webContents, nodeId);
  if (!box) return null;
  return contentCentroid(box);
}

export async function clickAtCenterOfSelector(
  webContents: WebContents,
  selector: string,
): Promise<boolean> {
  const point = await resolveClickPoint(webContents, selector);
  if (!point) return false;
  // A `mouseMoved` before the press, which a real pointer always produces.
  // Without it a page never sees `mouseover` / `mouseenter`, so hover-gated UI
  // (dropdown menus, hover-revealed action buttons, tooltips) is not open when
  // the press arrives and the click hits whatever is underneath instead.
  await dispatchMouseEvent(webContents, { type: 'mouseMoved', x: point.x, y: point.y });
  await dispatchMouseEvent(webContents, { type: 'mousePressed', x: point.x, y: point.y });
  await dispatchMouseEvent(webContents, { type: 'mouseReleased', x: point.x, y: point.y });
  return true;
}

export async function dragFromTo(
  webContents: WebContents,
  fromSelector: string,
  toSelector: string,
  options: { steps?: number } = {},
): Promise<boolean> {
  // Same viewport-coordinate requirement as a click: measure only after both
  // ends are scrolled into view, or a drag involving anything below the fold
  // silently does nothing. Source first, then target, because scrolling to the
  // target can move the source - so the source is re-measured last, once the
  // page has settled where the drag will actually run.
  const fromNodeId = await resolveSelector(webContents, fromSelector);
  const toNodeId = await resolveSelector(webContents, toSelector);
  if (!fromNodeId || !toNodeId) return false;
  await scrollNodeIntoView(webContents, fromNodeId);
  await scrollNodeIntoView(webContents, toNodeId);
  const fromBox = await getBoundingBoxByNodeId(webContents, fromNodeId);
  const toBox = await getBoundingBoxByNodeId(webContents, toNodeId);
  const source = fromBox ? contentCentroid(fromBox) : null;
  const target = toBox ? contentCentroid(toBox) : null;
  if (!source || !target) return false;
  const sourceX = source.x;
  const sourceY = source.y;
  const targetX = target.x;
  const targetY = target.y;
  const steps = Math.max(2, options.steps ?? 10);

  await dispatchMouseEvent(webContents, { type: 'mousePressed', x: sourceX, y: sourceY });
  for (let stepIndex = 1; stepIndex <= steps; stepIndex++) {
    const fraction = stepIndex / steps;
    await dispatchMouseEvent(webContents, {
      type: 'mouseMoved',
      x: sourceX + (targetX - sourceX) * fraction,
      y: sourceY + (targetY - sourceY) * fraction,
    });
  }
  await dispatchMouseEvent(webContents, { type: 'mouseReleased', x: targetX, y: targetY });
  return true;
}

export interface KeyEventOptions {
  type: 'keyDown' | 'keyUp' | 'char' | 'rawKeyDown';
  text?: string;
  key?: string;
  code?: string;
  windowsVirtualKeyCode?: number;
  modifiers?: number;
}

export async function dispatchKeyEvent(
  webContents: WebContents,
  options: KeyEventOptions,
): Promise<void> {
  await webContents.debugger.sendCommand('Input.dispatchKeyEvent', options);
}

/**
 * Type a string, one character at a time, as a real keyboard would.
 *
 * Each character sends `keyDown` / `char` / `keyUp` rather than a bare `char`.
 * The bare `char` alone delivers the text and nothing else, so a page that does
 * ANY of its work in a `keydown` handler never reacts: React inputs that filter
 * or transform keys, search-as-you-type boxes, form libraries that validate per
 * keystroke, and editors with hotkeys. Those pages took the text into the DOM
 * and then behaved as though nothing had been typed, which reads as "the agent
 * typed but the app ignored it".
 *
 * ONLY THE `char` CARRIES `text`, deliberately. In CDP a `keyDown` with a
 * non-empty `text` performs the insertion by itself (it is how Puppeteer types),
 * so carrying `text` on both would insert every character TWICE. Splitting the
 * roles - `keyDown` to fire handlers, `char` to insert - keeps the insertion
 * path exactly the one that has always worked here and adds the missing events
 * around it, so this cannot regress typing that works today.
 *
 * Special keys (Enter, Tab, arrows) still go through `dispatchKeypress`, which
 * owns the virtual-key-code mapping.
 */
export async function typeText(webContents: WebContents, text: string): Promise<void> {
  for (const character of text) {
    const keyIdentity = printableKeyIdentity(character);
    await dispatchKeyEvent(webContents, { type: 'keyDown', ...keyIdentity });
    await dispatchKeyEvent(webContents, { type: 'char', text: character });
    await dispatchKeyEvent(webContents, { type: 'keyUp', ...keyIdentity });
  }
}

/**
 * `key` / `code` / `windowsVirtualKeyCode` for a printable character, so a
 * page's `keydown` handler sees a plausible event rather than an empty one.
 *
 * Only letters, digits, and Enter get a real `code`; everything else (symbols,
 * punctuation, non-Latin text) carries `key` and the uppercased char code, which
 * is what matters to handlers keying off `event.key`. A full physical-layout map
 * would be a lie for any non-US keyboard, so it is deliberately not attempted.
 */
function printableKeyIdentity(character: string): {
  key: string;
  code?: string;
  windowsVirtualKeyCode?: number;
} {
  if (character === '\n' || character === '\r') {
    return { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 };
  }
  const upper = character.toUpperCase();
  if (character >= 'a' && character <= 'z') {
    return { key: character, code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0) };
  }
  if (character >= 'A' && character <= 'Z') {
    return { key: character, code: `Key${character}`, windowsVirtualKeyCode: character.charCodeAt(0) };
  }
  if (character >= '0' && character <= '9') {
    return { key: character, code: `Digit${character}`, windowsVirtualKeyCode: character.charCodeAt(0) };
  }
  return { key: character, windowsVirtualKeyCode: upper.charCodeAt(0) };
}

const SPECIAL_KEY_MAP: Record<string, { code: string; key: string; vk: number }> = {
  Enter: { code: 'Enter', key: 'Enter', vk: 13 },
  Escape: { code: 'Escape', key: 'Escape', vk: 27 },
  Tab: { code: 'Tab', key: 'Tab', vk: 9 },
  Backspace: { code: 'Backspace', key: 'Backspace', vk: 8 },
  ArrowUp: { code: 'ArrowUp', key: 'ArrowUp', vk: 38 },
  ArrowDown: { code: 'ArrowDown', key: 'ArrowDown', vk: 40 },
  ArrowLeft: { code: 'ArrowLeft', key: 'ArrowLeft', vk: 37 },
  ArrowRight: { code: 'ArrowRight', key: 'ArrowRight', vk: 39 },
  Space: { code: 'Space', key: ' ', vk: 32 },
};

const MODIFIER_FLAGS: Record<string, number> = {
  Alt: 1,
  Ctrl: 2,
  Meta: 4,
  Shift: 8,
  Cmd: 4, // alias for Meta
};

/**
 * Parse a chord like `Ctrl+Shift+P` and dispatch the keyDown / keyUp
 * pair. Single-character segments fall through to `typeText` so
 * `dispatchKeypress('a')` types the letter.
 */
export async function dispatchKeypress(
  webContents: WebContents,
  combo: string,
): Promise<boolean> {
  const parts = combo.split('+').map((part) => part.trim());
  if (parts.length === 0) return false;
  const target = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1);

  let modifierFlags = 0;
  for (const modifier of modifiers) {
    const flag = MODIFIER_FLAGS[modifier];
    if (flag === undefined) return false;
    modifierFlags |= flag;
  }

  const special = SPECIAL_KEY_MAP[target];
  if (special) {
    await dispatchKeyEvent(webContents, {
      type: 'keyDown',
      key: special.key,
      code: special.code,
      windowsVirtualKeyCode: special.vk,
      modifiers: modifierFlags,
    });
    await dispatchKeyEvent(webContents, {
      type: 'keyUp',
      key: special.key,
      code: special.code,
      windowsVirtualKeyCode: special.vk,
      modifiers: modifierFlags,
    });
    return true;
  }

  if (target.length === 1) {
    if (modifierFlags === 0) {
      await typeText(webContents, target);
      return true;
    }
    const upper = target.toUpperCase();
    const vk = upper.charCodeAt(0);
    // Shift alone PRODUCES TEXT; Ctrl / Alt / Meta do not.
    //
    // Without this, `Shift+a` sent a keyDown/keyUp pair carrying no `text` and
    // typed nothing at all - silently, while the tool reported success. That
    // contradicts this function's own contract, where a bare `a` types the
    // letter. A shortcut chord (`Ctrl+a`, `Meta+s`) correctly stays text-free:
    // inserting a character there would be wrong.
    //
    // Scoped to ASCII letters deliberately. `Shift+1` is `!` on a US layout and
    // something else on most others, and this has no keyboard-layout map, so
    // guessing would be a lie. Use `kangentic_browser_type` for symbols.
    const isShiftedLetter = modifierFlags === MODIFIER_FLAGS.Shift
      && /^[a-zA-Z]$/.test(target);
    const shiftedText = isShiftedLetter ? upper : null;
    await dispatchKeyEvent(webContents, {
      type: 'keyDown',
      key: shiftedText ?? target,
      code: `Key${upper}`,
      windowsVirtualKeyCode: vk,
      modifiers: modifierFlags,
    });
    if (shiftedText) {
      // Same split as `typeText`: the keyDown fires handlers, the char inserts.
      await dispatchKeyEvent(webContents, { type: 'char', text: shiftedText });
    }
    await dispatchKeyEvent(webContents, {
      type: 'keyUp',
      key: shiftedText ?? target,
      code: `Key${upper}`,
      windowsVirtualKeyCode: vk,
      modifiers: modifierFlags,
    });
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Runtime.evaluate
// ---------------------------------------------------------------------------

export async function runtimeEvaluate<T = unknown>(
  webContents: WebContents,
  expression: string,
  options: { awaitPromise?: boolean; returnByValue?: boolean } = {},
): Promise<{ value: T | null; error: string | null }> {
  try {
    const result = (await webContents.debugger.sendCommand('Runtime.evaluate', {
      expression,
      awaitPromise: options.awaitPromise ?? true,
      returnByValue: options.returnByValue ?? true,
    })) as { result: { value?: T }; exceptionDetails?: { text?: string } };
    if (result.exceptionDetails) {
      return { value: null, error: result.exceptionDetails.text ?? 'evaluation error' };
    }
    return { value: (result.result.value as T | undefined) ?? null, error: null };
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : String(error) };
  }
}
