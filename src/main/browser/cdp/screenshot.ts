import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { WebContents } from 'electron';
import type { ValueLocation } from '../../../shared/types';
import {
  captureScreenshot,
  decodeImageDimensions,
  getBoundingBox,
  getDeviceMetrics,
  getLayoutMetrics,
  isDebuggerAttached,
  runtimeEvaluate,
  type ScreenshotOptions,
} from './cdp';
import {
  BELOW_ONE_TO_ONE,
  SURFACE_BOUND_TOLERANCE_PX,
  planCapture,
  plannedPixelBound,
  surfacePixelBound,
  type CapturePlan,
  type CaptureTarget,
  type CssRect,
  type GuestCaptureSurface,
  type PageCaptureState,
  type Size,
} from './capture-bounds';

export type { GuestCaptureSurface } from './capture-bounds';

/**
 * Screenshot capture orchestrator. Wraps the bare CDP `Page.captureScreenshot`
 * call with four behaviours the agent-facing MCP layer cares about:
 *
 *   1. Always return rich metadata (viewport, image dimensions, scale factor,
 *      image pixels per CSS pixel, decoded byte length) so the caller can map
 *      image-space coords back to viewport-space without guessing.
 *   2. Never ask a `<webview>` guest for more pixels than its pane holds, which
 *      is what makes Chromium tile the image (see `capture-bounds.ts`). Every
 *      capture is planned first. A guest capture whose request carried a size
 *      (a clip, a full page, or a viewport override) and still comes back
 *      larger than its pane is refused rather than returned. One whose request
 *      carried none is returned. Nothing can have tiled it, so the recorded
 *      pane size was the thing that was wrong.
 *   3. Fit-to-budget: when `maxBytes` is provided, retry with progressively
 *      smaller jpeg quality / density until the decoded image fits, or give up
 *      and persist to disk.
 *   4. Auto-tier to disk when the decoded byte length exceeds the inline
 *      ceiling (about 3.5 MB, comfortably under Anthropic's documented 5 MB
 *      vision limit). The bridge response carries `mode: 'inline' | 'file'`
 *      so the MCP wrapper picks the right content block (image vs.
 *      resource_link).
 */

/**
 * Inline ceiling for screenshot payloads. Anthropic's documented vision
 * limit is 5 MB per image; we keep well under that to leave room for
 * MCP/JSON wrapping overhead. Decoded bytes (not base64-encoded length).
 */
export const DEFAULT_INLINE_BYTE_CEILING = 3_500_000;

/**
 * Floor on retry quality. Below this, jpeg artifacts make UI text
 * unreadable for review, which is the whole point of the screenshot.
 * If even q35 + scale 0.5 cannot fit, we fall back to a file.
 */
const MIN_RETRY_QUALITY = 35;
const MIN_RETRY_SCALE = 0.5;
const ROLLING_FILE_CAP = 100;
const MAX_FILE_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Element-clip metadata returned alongside element captures so the agent
 * can confirm which element produced the image. Defined as a top-level
 * type so consumers don't have to subscript through a wider option union.
 */
export interface ElementClipMeta {
  selector: string;
  box: { x: number; y: number; width: number; height: number };
}

export interface ScreenshotCaptureOptions extends Omit<ScreenshotOptions, 'clip' | 'captureBeyondViewport'> {
  /**
   * The pane this capture's guest renders into, or null when the target is
   * not a `<webview>` guest (a lane's own window, Kangentic's window under the
   * dev bridge).
   *
   * Required and nullable on purpose, so a new call site has to decide. A
   * guest capture that passed nothing would be planned with no bound, and
   * Chromium would tile it the moment the page asked for more pixels than the
   * pane has. Read as null when a caller outside the type system leaves it out.
   */
  surface: GuestCaptureSurface | null;
  /**
   * Decoded byte budget. When set, the orchestrator may downscale or
   * recompress to fit, then fall back to a file if it still cannot.
   */
  maxBytes?: number;
  /**
   * Inline ceiling override (decoded bytes). Defaults to
   * DEFAULT_INLINE_BYTE_CEILING. Above this, the response is persisted
   * to disk regardless of `maxBytes`.
   */
  inlineCeiling?: number;
}

interface ScreenshotResponseBase {
  format: 'png' | 'jpeg';
  byteLength: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  deviceScaleFactor: number;
  /**
   * Image pixels per CSS pixel. Divide an image coordinate by it to get the
   * page's. Not always `deviceScaleFactor`: a capture scaled to fit its pane,
   * or to fit a byte budget, holds fewer pixels than the page renders at.
   */
  pixelsPerCssPixel: number;
  metricsAvailable: boolean;
  /** The byte-budget downscale applied, 1 when none was needed. */
  scale: number;
  fullPage: boolean;
  elementClip: ElementClipMeta | null;
  retries: number;
  /** Why the capture is smaller than the page, and where to go for more. */
  note: string | null;
}

export interface InlineScreenshotResponse extends ScreenshotResponseBase {
  mode: 'inline';
  base64: string;
}

export interface FileScreenshotResponse extends ScreenshotResponseBase {
  mode: 'file';
  filePath: string;
  fileUri: string;
  /** Why the image is a file: past a byte budget, or the caller asked (`saveToFile`). */
  reason: 'over-inline-ceiling' | 'over-max-bytes' | 'requested';
  /** Which machine `filePath` is on: the host, for a capture delivered to a remote project's agent. */
  location?: ValueLocation;
  /** This computer's copy of a capture delivered to a host. */
  localFilePath?: string;
}

export type ScreenshotResponse = InlineScreenshotResponse | FileScreenshotResponse;

export type ProjectRootResolver = () => string | null;

let resolveProjectRoot: ProjectRootResolver = () => null;

export function configureScreenshotProjectRoot(resolver: ProjectRootResolver): void {
  resolveProjectRoot = resolver;
}

/** Whether a device-metrics override was active when a capture was asked for. */
export type CaptureEmulation = 'on' | 'off' | 'unknown';

/**
 * What a refused capture's request looked like, for the driver's report. Fixed
 * enums only. Nothing here is a size, a selector or anything a page wrote.
 */
export interface CaptureRefusalDiagnostics {
  target: 'viewport' | 'full_page' | 'element';
  /**
   * The plan carried a clip of its own, one of the three things that give a
   * request a size. The other two are a viewport override and a full page
   * with no clip, which Chromium clips to the whole page itself.
   */
  clipped: boolean;
  emulation: CaptureEmulation;
  widgetSource: GuestCaptureSurface['widgetSource'];
}

/**
 * A guest capture came back larger than its recorded pane, from a request
 * that carried a size.
 *
 * The source bitmap of a guest capture is pane-sized, so when a request asks
 * for more, Chromium fills the difference by repeating the bitmap. The result
 * is a tiled image an agent would read as a broken page. Refused rather than
 * returned. The planner sizes every request it plans inside the bound, so this
 * is the backstop for a request it could not plan (the page could not describe
 * itself) and for the day Chromium's sizing rule changes under it.
 *
 * It does not fire for a viewport request with no clip and no override.
 * Chromium asks for no size there and returns the surface as it is, so an
 * image past the bound means the recorded pane size was wrong, not that the
 * image tiled (Sentry DESKTOP-48). `captureWithPlan` returns that image.
 *
 * A full page with no clip is not that request. Chromium measures the page
 * and builds a clip of all of it (`CaptureFullPageScreenshot` in
 * `page_handler.cc`), and a guest tiles that clip like any other. The planner
 * never asks a guest for one. Only a page that could not describe itself
 * does, through `unplannedCapture`, and the refusal covers it.
 *
 * The fields say what the request looked like. The message carries the sizes,
 * and the message is never sent.
 */
export class CaptureExceedsSurface extends Error implements CaptureRefusalDiagnostics {
  readonly target: CaptureRefusalDiagnostics['target'];
  readonly clipped: boolean;
  readonly emulation: CaptureEmulation;
  readonly widgetSource: GuestCaptureSurface['widgetSource'];

  constructor(image: Size, bound: Size, diagnostics: CaptureRefusalDiagnostics) {
    super(
      `The screenshot came back ${image.width}x${image.height}, larger than the ${bound.width}x${bound.height} pixels this pane can render, so Chromium tiled it and nothing was returned. Retry; if it happens again, kangentic_browser_set_viewport { reset: true } clears any viewport override, and kangentic_browser_pop_out gives the page a real window.`,
    );
    this.name = 'CaptureExceedsSurface';
    this.target = diagnostics.target;
    this.clipped = diagnostics.clipped;
    this.emulation = diagnostics.emulation;
    this.widgetSource = diagnostics.widgetSource;
  }
}

/**
 * Whether a device-metrics override is active, as far as this process can say.
 *
 * `off` is positive knowledge. A CDP session is attached and records no
 * override. With no session attached the record is empty either way, so the
 * answer is `unknown`, never `off`. Read from the session's own record rather
 * than `PageCaptureState.emulated`, which does not exist when the page could
 * not describe itself.
 */
function emulationState(webContents: WebContents): CaptureEmulation {
  if (getDeviceMetrics(webContents) !== null) return 'on';
  return isDebuggerAttached(webContents) ? 'off' : 'unknown';
}

/**
 * Everything the planner needs from the page, in one evaluate.
 *
 * Null when the page cannot answer (a blocked renderer, a detached debugger).
 * The capture then falls back to asking Chromium for exactly what it asked for
 * before any planning existed, and the surface bound still refuses an image
 * past the pane from any such request that carried a size.
 */
export async function readPageCaptureState(webContents: WebContents): Promise<PageCaptureState | null> {
  const evaluated = await runtimeEvaluate<{
    width?: unknown;
    height?: unknown;
    devicePixelRatio?: unknown;
    scrollX?: unknown;
    scrollY?: unknown;
    contentWidth?: unknown;
    contentHeight?: unknown;
  }>(
    webContents,
    '(() => { const root = document.documentElement; const body = document.body; return { width: innerWidth, height: innerHeight, devicePixelRatio, scrollX, scrollY, contentWidth: Math.max(root ? root.scrollWidth : 0, body ? body.scrollWidth : 0), contentHeight: Math.max(root ? root.scrollHeight : 0, body ? body.scrollHeight : 0) }; })()',
  );
  const value = evaluated.value;
  const isFiniteNumber = (candidate: unknown): candidate is number =>
    typeof candidate === 'number' && Number.isFinite(candidate);
  if (
    !value ||
    !isFiniteNumber(value.width) ||
    !isFiniteNumber(value.height) ||
    !isFiniteNumber(value.devicePixelRatio)
  ) {
    return null;
  }
  const numberOr = (candidate: unknown, fallback: number): number =>
    isFiniteNumber(candidate) ? candidate : fallback;
  return {
    zoom: webContents.getZoomFactor() || 1,
    devicePixelRatio: value.devicePixelRatio,
    viewport: { width: value.width, height: value.height },
    scroll: { x: numberOr(value.scrollX, 0), y: numberOr(value.scrollY, 0) },
    content: {
      width: Math.max(value.width, numberOr(value.contentWidth, value.width)),
      height: Math.max(value.height, numberOr(value.contentHeight, value.height)),
    },
    emulated: getDeviceMetrics(webContents) !== null,
  };
}

export interface ViewportCaptureDescription {
  image: Size;
  pixelsPerCssPixel: number;
}

/**
 * What a viewport screenshot of this page returns right now, without taking
 * one: for `set_viewport` to say so up front, and for an image-space click to
 * map back through the density a screenshot uses.
 *
 * This is the density of a capture with no byte-budget downscale (`scale` 1).
 * A screenshot that had to shrink to fit `maxBytes` holds fewer pixels than
 * this describes, and nothing here knows that it happened.
 */
export async function describeViewportCapture(
  webContents: WebContents,
  surface: GuestCaptureSurface | null,
  knownState?: PageCaptureState | null,
): Promise<ViewportCaptureDescription | null> {
  const state = knownState === undefined ? await readPageCaptureState(webContents) : knownState;
  if (!state) return null;
  const plan = planCapture(state, { kind: 'viewport' }, surface);
  return {
    image: {
      width: Math.round(state.viewport.width * plan.pixelsPerCssPixel),
      height: Math.round(state.viewport.height * plan.pixelsPerCssPixel),
    },
    pixelsPerCssPixel: plan.pixelsPerCssPixel,
  };
}

/**
 * Capture a viewport (or, with `fullPage`, whole-document) screenshot,
 * applying the pane bound, maxBytes and inline-ceiling logic and persisting
 * to disk when needed. Returns a discriminated-union response the caller can
 * pass straight into the MCP wrapper.
 */
export async function captureScreenshotWithBudget(
  webContents: WebContents,
  options: ScreenshotCaptureOptions,
): Promise<ScreenshotResponse | null> {
  return captureWithPlan(
    webContents,
    options,
    options.fullPage === true ? { kind: 'fullPage' } : { kind: 'viewport' },
    null,
  );
}

/**
 * Plan, capture, and retry until the image fits the budget.
 *
 * Layout metrics and the page state are read once, before the first capture,
 * because the plan depends on them. Retries re-plan with a smaller density
 * rather than re-reading: nothing a retry does changes the page.
 */
async function captureWithPlan(
  webContents: WebContents,
  options: ScreenshotCaptureOptions,
  target: CaptureTarget,
  clipMeta: ElementClipMeta | null,
): Promise<ScreenshotResponse | null> {
  const surface = options.surface ?? null;
  const inlineCeiling = options.inlineCeiling ?? DEFAULT_INLINE_BYTE_CEILING;
  const effectiveBudget =
    typeof options.maxBytes === 'number' && options.maxBytes > 0
      ? Math.min(options.maxBytes, inlineCeiling)
      : inlineCeiling;

  let format: 'png' | 'jpeg' = options.format ?? 'png';
  let quality = options.quality;
  let densityScale = 1;
  let retries = 0;

  const [layoutResult, pageState] = await Promise.all([
    getLayoutMetrics(webContents),
    readPageCaptureState(webContents),
  ]);
  const metricsAvailable = layoutResult !== null;
  const layout = layoutResult ?? {
    viewportWidth: 0,
    viewportHeight: 0,
    deviceScaleFactor: 1,
    contentWidth: 0,
    contentHeight: 0,
  };
  const planFor = (scale: number): CapturePlan =>
    pageState
      ? planCapture(pageState, target, surface, { densityScale: scale })
      : unplannedCapture(target, scale, layout.deviceScaleFactor);
  // The RECORDED bound, not the one the planner may have lowered to the page's
  // own pixels. The refusal asks whether the image is past what the pane was
  // recorded to hold, and a lower bound here would only add refusals.
  const pane = surface ? { surface, bound: surfacePixelBound(surface) } : null;

  const attemptWith = async (plan: CapturePlan): Promise<CaptureAttempt | null> => {
    // Read before the capture, not after. Every path that turns an override ON
    // runs inside this guest's drive lock, so it cannot change under the
    // capture. The pane's own clear button can turn one OFF mid-capture, and a
    // read taken afterwards would then call a sized request unsized.
    const emulation: CaptureEmulation = pane ? emulationState(webContents) : 'unknown';
    const attempt = await captureOnce(webContents, {
      format,
      quality,
      clip: plan.clip ?? undefined,
      captureBeyondViewport: plan.captureBeyondViewport,
    });
    if (
      attempt &&
      pane &&
      (attempt.width > pane.bound.width + SURFACE_BOUND_TOLERANCE_PX ||
        attempt.height > pane.bound.height + SURFACE_BOUND_TOLERANCE_PX)
    ) {
      // A request with no clip, no full page and no override asks Chromium for
      // no size. The surface came back as it is, so nothing can have tiled
      // this image, and the bound trailed the pane. A full page with no clip
      // does carry a size, because Chromium builds a clip of the whole page
      // for it, so it is refused like any other clip. Keyed on the plan's own
      // request and the session's own record, never on the planner's inputs,
      // which are missing when the page could not describe itself.
      if (plan.clip === null && !plan.captureBeyondViewport && emulation === 'off') return attempt;
      throw new CaptureExceedsSurface({ width: attempt.width, height: attempt.height }, pane.bound, {
        target: target.kind === 'fullPage' ? 'full_page' : target.kind,
        clipped: plan.clip !== null,
        emulation,
        widgetSource: pane.surface.widgetSource,
      });
    }
    return attempt;
  };

  let plan = planFor(densityScale);
  const firstAttempt = await attemptWith(plan);
  if (!firstAttempt) return null;
  let attempt = firstAttempt;

  while (attempt.byteLength > effectiveBudget) {
    if (format !== 'jpeg') {
      // First retry: switch to jpeg q70 without changing dims.
      format = 'jpeg';
      quality = quality ?? 70;
    } else if ((quality ?? 70) > MIN_RETRY_QUALITY) {
      quality = Math.max(MIN_RETRY_QUALITY, (quality ?? 70) - 15);
    } else if (densityScale > MIN_RETRY_SCALE) {
      densityScale = Math.max(MIN_RETRY_SCALE, densityScale - 0.2);
    } else {
      break;
    }
    retries += 1;
    const nextPlan = planFor(densityScale);
    const next = await attemptWith(nextPlan);
    if (!next) break;
    attempt = next;
    plan = nextPlan;
  }

  const overInlineCeiling = attempt.byteLength > inlineCeiling;
  const overUserBudget =
    typeof options.maxBytes === 'number' &&
    options.maxBytes > 0 &&
    attempt.byteLength > options.maxBytes;
  const persist = overInlineCeiling || overUserBudget;

  const baseFields = {
    format,
    byteLength: attempt.byteLength,
    width: attempt.width,
    height: attempt.height,
    viewportWidth: layout.viewportWidth,
    viewportHeight: layout.viewportHeight,
    deviceScaleFactor: layout.deviceScaleFactor,
    pixelsPerCssPixel: plan.pixelsPerCssPixel,
    metricsAvailable,
    scale: densityScale,
    fullPage: options.fullPage === true,
    elementClip: clipMeta,
    retries,
    note: surface && pageState ? captureNote(target, plan, pageState, surface, attempt) : null,
  } as const;

  if (!persist) {
    return {
      mode: 'inline',
      base64: attempt.base64,
      ...baseFields,
    };
  }

  const persisted = persistShot(attempt.buffer, format);
  if (!persisted) {
    return {
      mode: 'inline',
      base64: attempt.base64,
      ...baseFields,
    };
  }
  return {
    mode: 'file',
    filePath: persisted.filePath,
    fileUri: persisted.fileUri,
    reason: overInlineCeiling ? 'over-inline-ceiling' : 'over-max-bytes',
    ...baseFields,
  };
}

/**
 * What to ask for when the page could not describe itself: exactly the
 * request every capture made before planning existed. A guest capture whose
 * request carries a size (an element's clip, a full page, or anything under a
 * viewport override) is still covered by the surface bound, which refuses an
 * image past the pane.
 */
function unplannedCapture(target: CaptureTarget, densityScale: number, devicePixelRatio: number): CapturePlan {
  if (target.kind === 'element') {
    return {
      clip: { ...target.box, scale: densityScale },
      captureBeyondViewport: false,
      pixelsPerCssPixel: devicePixelRatio * densityScale,
      limitedByPane: false,
    };
  }
  return {
    clip: null,
    captureBeyondViewport: target.kind === 'fullPage',
    pixelsPerCssPixel: devicePixelRatio,
    limitedByPane: false,
  };
}

/**
 * Say why a pane capture is smaller than the page, once, in the terms the
 * agent can act on.
 *
 * Only when the PANE is the reason. A page the user zoomed out with
 * Ctrl+wheel also captures below 1:1, but that is their choice rather than a
 * limit, and explaining it on every screenshot would be noise. So a viewport
 * shot is explained under a viewport override (the fit is what shrank it) or
 * when the pane capped it, and an element or full page only when the pane
 * capped it.
 */
function captureNote(
  target: CaptureTarget,
  plan: CapturePlan,
  state: PageCaptureState,
  surface: GuestCaptureSurface,
  image: Size,
): string | null {
  const explain =
    target.kind === 'viewport'
      ? plan.limitedByPane || (state.emulated && plan.pixelsPerCssPixel < BELOW_ONE_TO_ONE)
      : plan.limitedByPane;
  if (!explain) return null;
  const density = plan.pixelsPerCssPixel.toFixed(2);
  const pane = plannedPaneSize(surface, state);
  if (target.kind === 'element') {
    // The density the planner aimed for: 1:1, or the page's own ratio above it.
    const wanted = Math.max(1, state.devicePixelRatio);
    const aimedFor = wanted > 1.005 ? `the page's own ${wanted.toFixed(2)} image px per CSS px` : '1:1';
    return (
      `This element is larger than this ${pane} pane can hold at ${aimedFor}, so it came back at ${image.width}x${image.height}, ` +
      `${density} image px per CSS px. Capture a smaller element inside it for detail, or use kangentic_browser_pop_out for a real window.`
    );
  }
  if (target.kind === 'fullPage') {
    return (
      `A screenshot can hold no more pixels than this ${pane} pane has, so the ${Math.round(state.content.width)}x${Math.round(state.content.height)} ` +
      `page came back at ${image.width}x${image.height}, ${density} image px per CSS px. For detail, scroll and take viewport screenshots, ` +
      'or use kangentic_browser_screenshot_element on a section.'
    );
  }
  return (
    `A screenshot can hold no more pixels than this ${pane} pane has, so the ${Math.round(state.viewport.width)}x${Math.round(state.viewport.height)} ` +
    `viewport came back at ${image.width}x${image.height}, ${density} image px per CSS px. kangentic_browser_screenshot_element captures ` +
    'a region at up to 1:1, and kangentic_browser_pop_out gives a real window for 1:1 captures.'
  );
}

/**
 * The pane's size in DIP, as the plan believed it, for a note to name.
 *
 * The recorded widget, except on an axis where the planner lowered its bound
 * to the page's own pixel count. There the page's viewport times its zoom is
 * the pane in DIP as the page sees it. Naming the recorded size there told an
 * agent "this 2000x2000 pane" beside an image planned for a 740x749 one (seen
 * in a live capture with the recorded size forced stale).
 */
function plannedPaneSize(surface: GuestCaptureSurface, state: PageCaptureState): string {
  const recorded = surfacePixelBound(surface);
  const planned = plannedPixelBound(surface, state);
  const zoom = state.zoom > 0 ? state.zoom : 1;
  const axis = (plannedPixels: number, recordedPixels: number, widgetDip: number, viewportCss: number): number =>
    Math.round(plannedPixels < recordedPixels ? viewportCss * zoom : widgetDip);
  const width = axis(planned.width, recorded.width, surface.widget.width, state.viewport.width);
  const height = axis(planned.height, recorded.height, surface.widget.height, state.viewport.height);
  return `${width}x${height}`;
}

interface CaptureAttempt {
  base64: string;
  buffer: Buffer;
  byteLength: number;
  width: number;
  height: number;
}

async function captureOnce(
  webContents: WebContents,
  options: ScreenshotOptions,
): Promise<CaptureAttempt | null> {
  const base64 = await captureScreenshot(webContents, options);
  if (!base64) return null;
  const buffer = Buffer.from(base64, 'base64');
  const dimensions = decodeImageDimensions(options.format ?? 'png', buffer);
  return {
    base64,
    buffer,
    byteLength: buffer.byteLength,
    width: dimensions?.width ?? 0,
    height: dimensions?.height ?? 0,
  };
}

interface PersistedShot {
  filePath: string;
  fileUri: string;
}

function persistShot(buffer: Buffer, format: 'png' | 'jpeg'): PersistedShot | null {
  const directory = devtoolsShotsDir();
  if (!directory) return null;
  try {
    fs.mkdirSync(directory, { recursive: true });
  } catch {
    return null;
  }
  pruneShotsDir(directory);
  const extension = format === 'jpeg' ? 'jpg' : 'png';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${stamp}-${randomBytes(3).toString('hex')}.${extension}`;
  const filePath = path.join(directory, filename);
  try {
    fs.writeFileSync(filePath, buffer);
  } catch {
    return null;
  }
  return { filePath, fileUri: pathToFileURL(filePath).toString() };
}

/**
 * Resolve the per-worktree shots directory. Returns null when the
 * inspection server has no project root configured (e.g. before the
 * main window is open). Callers must skip persistence in that case.
 */
function devtoolsShotsDir(): string | null {
  const root = resolveProjectRoot();
  if (!root) return null;
  return path.join(root, '.kangentic', 'devtools-shots');
}

/**
 * Keep the newest files in `directory`, none older than a day. `isOwnFile`
 * limits both to the files one writer made, in a folder another writer shares.
 */
export function pruneShotsDir(directory: string, isOwnFile: (fileName: string) => boolean = () => true): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  const now = Date.now();
  const records: { name: string; mtimeMs: number }[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !isOwnFile(entry.name)) continue;
    const filePath = path.join(directory, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (now - stat.mtimeMs > MAX_FILE_AGE_MS) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // best-effort
      }
      continue;
    }
    records.push({ name: entry.name, mtimeMs: stat.mtimeMs });
  }
  if (records.length <= ROLLING_FILE_CAP) return;
  records.sort((a, b) => a.mtimeMs - b.mtimeMs);
  const toRemove = records.length - ROLLING_FILE_CAP;
  for (let removeIndex = 0; removeIndex < toRemove; removeIndex += 1) {
    try {
      fs.unlinkSync(path.join(directory, records[removeIndex].name));
    } catch {
      // best-effort
    }
  }
}

/**
 * Wipe the per-worktree shots directory. Wired to the lockfile lifecycle
 * (preview start clears any leftover shots; preview shutdown clears the
 * dir again) so we never accumulate from one run to the next.
 */
export function resetShotsDir(projectRoot: string): void {
  const directory = path.join(projectRoot, '.kangentic', 'devtools-shots');
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

/**
 * Element-clip helper. Takes a selector, resolves its bounding box, and
 * captures it through the same planner as every other capture, tagging the
 * response with the originating selector so the agent can confirm which
 * element produced the image.
 *
 * The box is `DOM.getBoxModel`'s content quad: CSS pixels, relative to the
 * viewport. The planner turns it into a clip, which Chromium reads in DIP and
 * relative to the document. Passing the box through unconverted, as this did
 * before, captured the wrong region on any zoomed or scrolled page.
 */
export async function captureElementClip(
  webContents: WebContents,
  selector: string,
  options: Omit<ScreenshotCaptureOptions, 'fullPage'>,
): Promise<ScreenshotResponse | { error: 'selector-not-found' } | null> {
  const box = await getBoundingBox(webContents, selector);
  if (!box || !Array.isArray(box.content) || box.content.length < 8) {
    return { error: 'selector-not-found' };
  }
  const xs = [box.content[0], box.content[2], box.content[4], box.content[6]];
  const ys = [box.content[1], box.content[3], box.content[5], box.content[7]];
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const rect: CssRect = {
    x: minX,
    y: minY,
    width: Math.max(...xs) - minX,
    height: Math.max(...ys) - minY,
  };
  return captureWithPlan(
    webContents,
    { ...options, fullPage: false, format: options.format ?? 'png' },
    { kind: 'element', box: rect },
    { selector, box: { ...rect } },
  );
}
