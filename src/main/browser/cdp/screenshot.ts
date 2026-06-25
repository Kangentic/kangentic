import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { WebContents } from 'electron';
import {
  captureScreenshot,
  decodeImageDimensions,
  getBoundingBox,
  getLayoutMetrics,
  type ScreenshotOptions,
} from './cdp';

/**
 * Screenshot capture orchestrator. Wraps the bare CDP `Page.captureScreenshot`
 * call with three behaviours the agent-facing MCP layer cares about:
 *
 *   1. Always return rich metadata (viewport, image dimensions, scale factor,
 *      decoded byte length) so the caller can map image-space coords back to
 *      viewport-space without guessing.
 *   2. Fit-to-budget: when `maxBytes` is provided, retry with progressively
 *      smaller jpeg quality / clip.scale until the decoded image fits, or
 *      give up and persist to disk.
 *   3. Auto-tier to disk when the decoded byte length exceeds the inline
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

export interface ScreenshotCaptureOptions extends ScreenshotOptions {
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
  /**
   * Element clip information (used by element captures so we can include
   * it in the response metadata).
   */
  clipMeta?: ElementClipMeta;
}

export interface InlineScreenshotResponse {
  mode: 'inline';
  format: 'png' | 'jpeg';
  base64: string;
  byteLength: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  deviceScaleFactor: number;
  metricsAvailable: boolean;
  scale: number;
  fullPage: boolean;
  elementClip: ElementClipMeta | null;
  retries: number;
}

export interface FileScreenshotResponse {
  mode: 'file';
  format: 'png' | 'jpeg';
  filePath: string;
  fileUri: string;
  byteLength: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  deviceScaleFactor: number;
  metricsAvailable: boolean;
  scale: number;
  fullPage: boolean;
  elementClip: ElementClipMeta | null;
  retries: number;
  reason: 'over-inline-ceiling' | 'over-max-bytes';
}

export type ScreenshotResponse = InlineScreenshotResponse | FileScreenshotResponse;

export type ProjectRootResolver = () => string | null;

let resolveProjectRoot: ProjectRootResolver = () => null;

export function configureScreenshotProjectRoot(resolver: ProjectRootResolver): void {
  resolveProjectRoot = resolver;
}

/**
 * Capture a screenshot, applying maxBytes / inline-ceiling logic and
 * persisting to disk when needed. Returns a discriminated-union response
 * the caller can pass straight into the MCP wrapper.
 *
 * Layout metrics (viewport dims, deviceScaleFactor) are fetched in
 * parallel with the first capture - they're independent CDP calls and
 * the metrics rarely change between requests, so paying for them twice
 * in the retry loop would be wasted work. Retries reuse the layout from
 * the first attempt.
 */
export async function captureScreenshotWithBudget(
  webContents: WebContents,
  options: ScreenshotCaptureOptions,
): Promise<ScreenshotResponse | null> {
  const inlineCeiling = options.inlineCeiling ?? DEFAULT_INLINE_BYTE_CEILING;
  const effectiveBudget =
    typeof options.maxBytes === 'number' && options.maxBytes > 0
      ? Math.min(options.maxBytes, inlineCeiling)
      : inlineCeiling;

  let format: 'png' | 'jpeg' = options.format ?? 'png';
  let quality = options.quality;
  let scale = options.clip?.scale ?? 1;
  let retries = 0;

  const [layoutResult, firstAttempt] = await Promise.all([
    getLayoutMetrics(webContents),
    captureOnce(webContents, { ...options, format, quality }),
  ]);
  if (!firstAttempt) return null;
  const metricsAvailable = layoutResult !== null;
  const layout = layoutResult ?? {
    viewportWidth: 0,
    viewportHeight: 0,
    deviceScaleFactor: 1,
    contentWidth: 0,
    contentHeight: 0,
  };
  let attempt = firstAttempt;

  while (attempt.byteLength > effectiveBudget) {
    if (format !== 'jpeg') {
      // First retry: switch to jpeg q70 without changing dims.
      format = 'jpeg';
      quality = quality ?? 70;
    } else if ((quality ?? 70) > MIN_RETRY_QUALITY) {
      quality = Math.max(MIN_RETRY_QUALITY, (quality ?? 70) - 15);
    } else if (scale > MIN_RETRY_SCALE) {
      scale = Math.max(MIN_RETRY_SCALE, scale - 0.2);
    } else {
      break;
    }
    retries += 1;
    const nextOptions: ScreenshotOptions = {
      ...options,
      format,
      quality,
      clip: options.clip ? { ...options.clip, scale } : undefined,
    };
    const next = await captureOnce(webContents, nextOptions);
    if (!next) break;
    attempt = next;
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
    metricsAvailable,
    scale,
    fullPage: options.fullPage === true,
    elementClip: options.clipMeta ?? null,
    retries,
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

export function pruneShotsDir(directory: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  const now = Date.now();
  const records: { name: string; mtimeMs: number }[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
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
 * Element-clip helper. Takes a selector, resolves its bounding box,
 * delegates to `captureScreenshotWithBudget` with a tight clip, and
 * tags the response with the originating selector so the agent can
 * confirm which element produced the image.
 */
export async function captureElementClip(
  webContents: WebContents,
  selector: string,
  options: Omit<ScreenshotCaptureOptions, 'clip' | 'fullPage'>,
): Promise<ScreenshotResponse | { error: 'selector-not-found' } | null> {
  const box = await getBoundingBox(webContents, selector);
  if (!box || !Array.isArray(box.content) || box.content.length < 8) {
    return { error: 'selector-not-found' };
  }
  const xs = [box.content[0], box.content[2], box.content[4], box.content[6]];
  const ys = [box.content[1], box.content[3], box.content[5], box.content[7]];
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  const width = maxX - minX;
  const height = maxY - minY;
  return captureScreenshotWithBudget(webContents, {
    ...options,
    fullPage: false,
    format: options.format ?? 'png',
    clip: { x: minX, y: minY, width, height, scale: 1 },
    clipMeta: { selector, box: { x: minX, y: minY, width, height } },
  });
}

