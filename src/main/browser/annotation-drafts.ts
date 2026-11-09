import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  BrowserAnnotation,
  BrowserAnnotationDraft,
  BrowserAnnotationItem,
  BrowserAnnotationStroke,
} from '../../shared/types';

// A Browser pane's annotation session, saved per task as it changes, so a
// restart or a crash in the middle of a long review loses nothing. Lives at
// `<projectPath>/.kangentic/browser-annotations/<owner>/`: `draft.json` (notes,
// items, which capture each annotation keeps) and `capture-<id>.png` (the
// visible page, badges included, taken when an item joined an annotation).
//
// Every write is async (`fs.promises`), so the guarded-sync-writes rule does
// not apply; each is temp + rename so a crash mid-write leaves the last good
// draft rather than half a file.
//
// Every operation on one owner's folder runs in the order it arrived, so a
// discard can never land between a save's write and its prune, and a save
// sent before a discard never recreates the folder after it.

const DRAFTS_FOLDER = 'browser-annotations';
const DRAFT_FILE = 'draft.json';
const CAPTURE_PREFIX = 'capture-';
const CAPTURE_SUFFIX = '.png';
const TEMPORARY_SUFFIX = '.tmp';
const CAPTURE_ID_PATTERN = /^[0-9a-f]{16}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * A capture newer than this is never pruned. The renderer names a new capture
 * in its draft only after `saveAnnotationCapture` resolves, so a save already
 * on its way when the capture landed does not name it yet.
 */
export const CAPTURE_PRUNE_GRACE_MS = 60_000;

/**
 * After a task's session ends (a reset, a demote, a delete, a Command Terminal
 * closing), its pane may still flush one last save as it unmounts. Saves that
 * arrive this soon after are dropped, so the ended review does not come back.
 */
export const RETIRED_OWNER_MS = 5_000;

/** The largest capture accepted, in base64 characters: a 4K page is well under it. */
export const MAX_CAPTURE_BASE64_LENGTH = 64 * 1024 * 1024;

/** Windows reports a file another handle has open, or one a scanner is reading, with these. */
const BUSY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const BUSY_RETRIES = 5;
const BUSY_RETRY_DELAY_MS = 40;

/**
 * The folder name for a pane owner. An owner is a task id, or a Command
 * Terminal's owner key (`command-terminal::<projectId>::<slot>`), whose colons
 * no filesystem accepts on Windows. Anything that could leave the folder is
 * refused rather than rewritten.
 */
export function annotationOwnerSegment(ownerKey: string): string {
  if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(ownerKey) || ownerKey.includes('..')) {
    throw new Error('Annotation draft received a malformed task id');
  }
  return ownerKey.replace(/:/g, '-');
}

export function isAnnotationCaptureId(value: unknown): value is string {
  return typeof value === 'string' && CAPTURE_ID_PATTERN.test(value);
}

export function annotationDraftFolder(projectPath: string, ownerKey: string): string {
  return path.join(projectPath, '.kangentic', DRAFTS_FOLDER, annotationOwnerSegment(ownerKey));
}

export function annotationCapturePath(projectPath: string, ownerKey: string, captureId: string): string {
  if (!isAnnotationCaptureId(captureId)) throw new Error('Annotation capture id is malformed');
  return path.join(annotationDraftFolder(projectPath, ownerKey), `${CAPTURE_PREFIX}${captureId}${CAPTURE_SUFFIX}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isStroke(value: unknown): value is BrowserAnnotationStroke {
  return Array.isArray(value)
    && value.every((point) => isRecord(point) && isFiniteNumber(point.x) && isFiniteNumber(point.y));
}

/** Every field the pane and the Send prompt read off a selected element. */
function isPickedElement(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const rect = value.rect;
  return typeof value.selector === 'string'
    && typeof value.tagName === 'string'
    && Array.isArray(value.classes)
    && Array.isArray(value.ancestors)
    && isRecord(value.computedStyles)
    && typeof value.outerHTML === 'string'
    && isRecord(rect)
    && isFiniteNumber(rect.x)
    && isFiniteNumber(rect.y)
    && isFiniteNumber(rect.width)
    && isFiniteNumber(rect.height);
}

export function isAnnotationItem(value: unknown): value is BrowserAnnotationItem {
  if (!isRecord(value) || typeof value.id !== 'string') return false;
  if (value.kind === 'element') return isPickedElement(value.element);
  if (value.kind === 'drawing') return Array.isArray(value.strokes) && value.strokes.every(isStroke);
  return false;
}

function isAnnotation(value: unknown): value is BrowserAnnotation {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && typeof value.note === 'string'
    && typeof value.url === 'string'
    && Array.isArray(value.items)
    && value.items.every(isAnnotationItem)
    && (value.captureId === null || isAnnotationCaptureId(value.captureId));
}

/**
 * A draft from outside the type system (a file, an IPC payload), keeping only
 * the annotations whose every item is one the pane can draw and Send can
 * describe. Null when nothing of it is a draft.
 */
export function normalizeAnnotationDraft(value: unknown): BrowserAnnotationDraft | null {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.annotations)) return null;
  const annotations = value.annotations.filter(isAnnotation);
  if (annotations.length === 0) return null;
  const activeId = typeof value.activeId === 'string' && annotations.some((annotation) => annotation.id === value.activeId)
    ? value.activeId
    : null;
  return { version: 1, annotations, activeId };
}

/** Reads a draft back, dropping anything that is not one. A missing or corrupt file is no draft. */
export function parseAnnotationDraft(raw: string): BrowserAnnotationDraft | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return normalizeAnnotationDraft(parsed);
}

function errorCode(caught: unknown): string | undefined {
  return isRecord(caught) && typeof caught.code === 'string' ? caught.code : undefined;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Runs a file operation again while Windows reports the file as held open. */
async function retryWhileBusy<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (caught) {
      const code = errorCode(caught);
      if (!code || !BUSY_CODES.has(code) || attempt >= BUSY_RETRIES) throw caught;
      await delay(BUSY_RETRY_DELAY_MS * attempt);
    }
  }
}

async function writeAtomic(filePath: string, contents: string | Buffer): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomBytes(4).toString('hex')}${TEMPORARY_SUFFIX}`;
  try {
    await fs.promises.writeFile(temporaryPath, contents);
    await retryWhileBusy(() => fs.promises.rename(temporaryPath, filePath));
  } catch (caught) {
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw caught;
  }
}

// One promise chain per owner folder. An entry leaves the map once its chain
// is idle, so the map holds only owners with work in flight.
const ownerChains = new Map<string, Promise<unknown>>();
const retiredOwners = new Map<string, number>();

function inOwnerOrder<T>(folder: string, operation: () => Promise<T>): Promise<T> {
  const previous = ownerChains.get(folder) ?? Promise.resolve();
  const run = previous.then(operation, operation);
  const settled = run.then(() => undefined, () => undefined);
  ownerChains.set(folder, settled);
  void settled.then(() => {
    if (ownerChains.get(folder) === settled) ownerChains.delete(folder);
  });
  return run;
}

function isRetired(folder: string): boolean {
  const retiredAt = retiredOwners.get(folder);
  if (retiredAt === undefined) return false;
  if (Date.now() - retiredAt < RETIRED_OWNER_MS) return true;
  retiredOwners.delete(folder);
  return false;
}

export async function loadAnnotationDraft(projectPath: string, ownerKey: string): Promise<BrowserAnnotationDraft | null> {
  const folder = annotationDraftFolder(projectPath, ownerKey);
  return inOwnerOrder(folder, async () => {
    let raw: string;
    try {
      raw = await retryWhileBusy(() => fs.promises.readFile(path.join(folder, DRAFT_FILE), 'utf-8'));
    } catch (caught) {
      if (errorCode(caught) !== 'ENOENT') console.warn('[browser] Could not read annotation draft:', caught);
      return null;
    }
    return parseAnnotationDraft(raw);
  });
}

/**
 * Replaces the draft, then deletes every capture it no longer names: a capture
 * a newer one of the same view replaced, or one whose annotations are gone. A
 * capture younger than `CAPTURE_PRUNE_GRACE_MS` stays, since the renderer may
 * not have named it yet.
 */
export async function saveAnnotationDraft(projectPath: string, ownerKey: string, draft: unknown): Promise<void> {
  const normalized = normalizeAnnotationDraft(draft);
  if (!normalized) throw new Error('Annotation draft is malformed');
  const folder = annotationDraftFolder(projectPath, ownerKey);
  return inOwnerOrder(folder, async () => {
    if (isRetired(folder)) return;
    await writeAtomic(path.join(folder, DRAFT_FILE), JSON.stringify(normalized));
    const kept = new Set(normalized.annotations.map((annotation) => annotation.captureId).filter(isAnnotationCaptureId));
    let entries: string[];
    try {
      entries = await fs.promises.readdir(folder);
    } catch {
      return;
    }
    const now = Date.now();
    await Promise.all(entries.map(async (entry) => {
      const isCapture = entry.startsWith(CAPTURE_PREFIX) && entry.endsWith(CAPTURE_SUFFIX);
      // A temp file a failed write left behind goes too, once it is old enough
      // that no write in flight can still own it.
      const isLeftover = entry.endsWith(TEMPORARY_SUFFIX);
      if (!isCapture && !isLeftover) return;
      if (isCapture && kept.has(entry.slice(CAPTURE_PREFIX.length, -CAPTURE_SUFFIX.length))) return;
      const entryPath = path.join(folder, entry);
      try {
        const stats = await fs.promises.stat(entryPath);
        if (now - stats.mtimeMs < CAPTURE_PRUNE_GRACE_MS) return;
      } catch {
        return;
      }
      await fs.promises.rm(entryPath, { force: true, maxRetries: 3, retryDelay: 50 }).catch(() => undefined);
    }));
  });
}

/** Saves one capture of the visible page and resolves its id. */
export async function saveAnnotationCapture(projectPath: string, ownerKey: string, pngBase64: unknown): Promise<string> {
  if (typeof pngBase64 !== 'string' || pngBase64.length === 0) throw new Error('Annotation capture is empty');
  if (pngBase64.length > MAX_CAPTURE_BASE64_LENGTH) throw new Error('Annotation capture is too large');
  const bytes = Buffer.from(pngBase64, 'base64');
  if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error('Annotation capture is not a PNG');
  }
  const folder = annotationDraftFolder(projectPath, ownerKey);
  return inOwnerOrder(folder, async () => {
    if (isRetired(folder)) throw new Error('Annotation draft was discarded');
    const captureId = randomBytes(8).toString('hex');
    await writeAtomic(annotationCapturePath(projectPath, ownerKey, captureId), bytes);
    return captureId;
  });
}

export interface DiscardAnnotationDraftOptions {
  /**
   * The session the draft belonged to ended: drop the saves its pane may still
   * send for `RETIRED_OWNER_MS`. A user's Clear leaves this off, since they go
   * on annotating.
   */
  retire?: boolean;
}

export async function discardAnnotationDraft(
  projectPath: string,
  ownerKey: string,
  options: DiscardAnnotationDraftOptions = {},
): Promise<void> {
  const folder = annotationDraftFolder(projectPath, ownerKey);
  // A plain discard leaves a retirement in place: the empty-session flush a
  // pane sends as it unmounts must not reopen the folder to its own late save.
  if (options.retire) retiredOwners.set(folder, Date.now());
  return inOwnerOrder(folder, () => fs.promises.rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
}
