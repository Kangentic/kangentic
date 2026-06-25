import type { BrowserWindow, WebContents } from 'electron';
import * as driver from '../../main/browser/cdp/cdp';

/**
 * Dev-only BrowserWindow-compat shim over the shipped CDP driver
 * (`src/main/browser/cdp/cdp.ts`). The inspection bridge drives the app's
 * own main window and historically passed a `BrowserWindow`; the shipped
 * driver was generalized to take any `WebContents` (so the user-facing
 * browser-pane driver can reuse it against an embedded `<webview>` guest).
 *
 * This shim re-exposes the same helpers with the old `BrowserWindow`
 * signature by forwarding `window.webContents`, so `inspection-server.ts`
 * and `install.ts` keep working byte-identically. It performs NO CDP work
 * itself (no `sendCommand`) - it is pure delegation, which keeps the
 * single-driver invariant intact.
 */

/** Forward a `(WebContents, ...args)` driver fn as a `(BrowserWindow, ...args)` one. */
function viaWindow<Args extends unknown[], Result>(
  fn: (webContents: WebContents, ...args: Args) => Result,
): (window: BrowserWindow, ...args: Args) => Result {
  return (window, ...args) => fn(window.webContents, ...args);
}

export const attachDebugger = viaWindow(driver.attachDebugger);
export const isDebuggerAttached = viaWindow(driver.isDebuggerAttached);
export const getConsoleEntries = viaWindow(driver.getConsoleEntries);
export const getLayoutMetrics = viaWindow(driver.getLayoutMetrics);
export const getAccessibilityTree = viaWindow(driver.getAccessibilityTree);
export const getBoundingBox = viaWindow(driver.getBoundingBox);
export const getBoundingBoxByNodeId = viaWindow(driver.getBoundingBoxByNodeId);
export const getComputedStyle = viaWindow(driver.getComputedStyle);
export const getOuterHtml = viaWindow(driver.getOuterHtml);
export const getOuterHtmlByNodeId = viaWindow(driver.getOuterHtmlByNodeId);
export const resolveSelectorPublic = viaWindow(driver.resolveSelectorPublic);
export const queryAllElements = viaWindow(driver.queryAllElements);
export const typeText = viaWindow(driver.typeText);
export const dispatchKeyEvent = viaWindow(driver.dispatchKeyEvent);
export const dispatchKeypress = viaWindow(driver.dispatchKeypress);
export const dispatchMouseEvent = viaWindow(driver.dispatchMouseEvent);
export const clickAtCenterOfSelector = viaWindow(driver.clickAtCenterOfSelector);
export const dragFromTo = viaWindow(driver.dragFromTo);

/**
 * `detachDebugger` keeps the original destroyed-window guard: `before-quit`
 * can fire after the window is gone, and the `window.webContents` getter
 * throws "Object has been destroyed" in that case.
 */
export function detachDebugger(window: BrowserWindow): void {
  try {
    if (window.isDestroyed()) return;
    driver.detachDebugger(window.webContents);
  } catch {
    // best-effort
  }
}

/** Preserves the `<T>` generic the inspection bridge relies on. */
export function runtimeEvaluate<T = unknown>(
  window: BrowserWindow,
  expression: string,
  options: { awaitPromise?: boolean; returnByValue?: boolean } = {},
): Promise<{ value: T | null; error: string | null }> {
  return driver.runtimeEvaluate<T>(window.webContents, expression, options);
}

export {
  decodeImageDimensions,
  parseSelectorSpec,
  buildSelectorExpression,
  buildSelectorAllExpression,
} from '../../main/browser/cdp/cdp';
export type {
  ConsoleEntry,
  ScreenshotOptions,
  LayoutMetrics,
  MouseEventType,
  MouseButton,
  MouseEventOptions,
  KeyEventOptions,
} from '../../main/browser/cdp/cdp';
