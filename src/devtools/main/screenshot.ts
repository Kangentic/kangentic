import type { BrowserWindow, WebContents } from 'electron';
import * as driver from '../../main/browser/cdp/screenshot';

/**
 * Dev-only BrowserWindow-compat shim over the shipped screenshot
 * orchestrator (`src/main/browser/cdp/screenshot.ts`). See the sibling
 * `cdp.ts` shim for the rationale: the inspection bridge passes a
 * `BrowserWindow`; the shipped orchestrator takes any `WebContents`. This
 * forwards `window.webContents` so the bridge keeps working unchanged.
 */

/** Forward a `(WebContents, ...args)` driver fn as a `(BrowserWindow, ...args)` one. */
function viaWindow<Args extends unknown[], Result>(
  fn: (webContents: WebContents, ...args: Args) => Result,
): (window: BrowserWindow, ...args: Args) => Result {
  return (window, ...args) => fn(window.webContents, ...args);
}

export const captureScreenshotWithBudget = viaWindow(driver.captureScreenshotWithBudget);
export const captureElementClip = viaWindow(driver.captureElementClip);

export {
  DEFAULT_INLINE_BYTE_CEILING,
  configureScreenshotProjectRoot,
  pruneShotsDir,
  resetShotsDir,
} from '../../main/browser/cdp/screenshot';
export type {
  ElementClipMeta,
  ScreenshotCaptureOptions,
  InlineScreenshotResponse,
  FileScreenshotResponse,
  ScreenshotResponse,
  ProjectRootResolver,
} from '../../main/browser/cdp/screenshot';
