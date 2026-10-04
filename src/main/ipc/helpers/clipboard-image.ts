import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ClipboardItem, NativeImage, clipboard as ElectronClipboard } from 'electron';
import { IMAGE_LONG_EDGE_CAP, resolveResizeTarget } from '../../../shared/image-fidelity';

/**
 * Pasted-image handling for the terminal: the Ctrl+V clipboard read and capture,
 * and the renderer-decoded copy of a dropped image the agent cannot take as-is.
 * Both land in the same temp directory under the same cap and prune.
 *
 * Kept out of `handlers/system.ts` so the sizing and pruning rules can be tested
 * directly rather than through `ipcMain`.
 */

/** Keep pasted images around long enough to survive a re-read or a slow agent,
 *  but not forever. */
export const CLIPBOARD_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Ceiling regardless of age, so a burst of pastes in one session cannot leave
 *  hundreds of multi-megabyte PNGs behind.
 *
 *  The prune runs BEFORE the current paste is written, so it trims what is
 *  already there and the write then lands on top: the observed steady state is
 *  this many plus the in-flight file, not exactly this many. */
export const CLIPBOARD_TEMP_MAX_FILES = 40;

const CLIPBOARD_TEMP_PREFIX = 'pasted-image-';

/** The one directory every pasted image is written to, so one prune covers
 *  the clipboard captures and the normalized drop copies alike. Resolved per
 *  call rather than at module load so a test can redirect `os.tmpdir()`. */
export function pastedImageTempDir(): string {
  return path.join(os.tmpdir(), 'kangentic-clipboard');
}

function isBlob(payload: unknown): payload is Blob {
  return typeof payload === 'object' && payload !== null && typeof (payload as Blob).arrayBuffer === 'function';
}

/** The image types `nativeImage` decodes, in the order a read tries them. */
const DECODABLE_IMAGE_TYPES = ['image/png', 'image/jpeg'];

/**
 * An item's `image/*` types with the decodable ones first, so a clipboard that
 * also offers an undecodable form costs one payload fetch, not two.
 */
function imageTypesInReadOrder(types: readonly string[]): string[] {
  const imageTypes = types.filter((type) => type.startsWith('image/'));
  const decodable = DECODABLE_IMAGE_TYPES.filter((type) => imageTypes.includes(type));
  const others = imageTypes.filter((type) => !DECODABLE_IMAGE_TYPES.includes(type));
  return [...decodable, ...others];
}

/**
 * Read the image the clipboard holds, or null when it holds none.
 *
 * Electron 44 removed the synchronous `clipboard.readImage()`. Its replacement,
 * `clipboard.read()`, resolves to items that each list their MIME types and
 * hand back a Blob per type, the shape of the W3C async clipboard. The first
 * `image/*` payload that decodes wins. `nativeImage` decodes only PNG and JPEG,
 * so those are tried first, and a type that does not decode is skipped so the
 * next one gets its chance.
 *
 * Never rejects. `readImage()` could not fail, and a clipboard another app is
 * holding open must not turn a Ctrl+V into an unhandled rejection in the
 * renderer, which treats null the way it treats an empty clipboard.
 *
 * The clipboard and the decoder are passed in so this stays testable without
 * Electron, like the rest of this file.
 */
export async function readClipboardImage(
  clipboardSource: Pick<typeof ElectronClipboard, 'read'>,
  decodeImage: (bytes: Buffer) => NativeImage,
): Promise<NativeImage | null> {
  try {
    for (const item of await clipboardSource.read()) {
      for (const type of imageTypesInReadOrder(item.types)) {
        const payload: unknown = await item.getType(type);
        if (!isBlob(payload)) continue;
        const image = decodeImage(Buffer.from(await payload.arrayBuffer()));
        if (!image.isEmpty()) return image;
      }
    }
  } catch (error) {
    console.error('[clipboard] Failed to read the clipboard image:', error);
  }
  return null;
}

/**
 * Put `image` on the clipboard as a PNG, for the Copy Image context menu.
 *
 * Electron 44 removed `clipboard.writeImage()`, so the image goes on as a PNG
 * Blob inside a ClipboardItem. An empty image (a data URL that did not decode)
 * writes nothing, rather than replacing what the clipboard held with a blank
 * image.
 *
 * Never rejects. A menu click has no caller to hand a failure to, so a failed
 * write is logged instead.
 *
 * The clipboard and the ClipboardItem constructor are passed in so this stays
 * testable without Electron, like `readClipboardImage`.
 */
export async function writeClipboardImage(
  image: NativeImage,
  clipboardTarget: Pick<typeof ElectronClipboard, 'write'>,
  createClipboardItem: (payloads: Record<string, Blob>) => ClipboardItem,
): Promise<void> {
  if (image.isEmpty()) return;
  try {
    // Copied into a Uint8Array because a Buffer's ArrayBufferLike backing is not a BlobPart.
    const png = new Blob([new Uint8Array(image.toPNG())], { type: 'image/png' });
    await clipboardTarget.write([createClipboardItem({ 'image/png': png })]);
  } catch (error) {
    console.error('[clipboard] Copy Image failed:', error);
  }
}

/**
 * Write a pasted image to the temp directory as a capped PNG and return its
 * path, or null when it could not be written.
 *
 * Null rather than a throw, deliberately: the disk can be full, a Windows
 * antivirus scanner can hold a just-created temp file, and on a shared Linux
 * /tmp the directory can already belong to another user. None of those should
 * turn a Ctrl+V or a drop into an unhandled rejection in the renderer, which
 * treats null exactly as it treats an empty clipboard.
 */
export function writePastedImage(image: NativeImage): string | null {
  const tempDir = pastedImageTempDir();
  try {
    fs.mkdirSync(tempDir, { recursive: true });
    // Nothing used to delete these, so the directory grew for the life of the
    // install. Disk hygiene only - it does not change what an agent is billed.
    pruneClipboardTempDir(tempDir);
    const filePath = path.join(tempDir, `${CLIPBOARD_TEMP_PREFIX}${Date.now()}.png`);
    fs.writeFileSync(filePath, capClipboardImage(image).toPNG());
    return filePath;
  } catch (error) {
    console.error('[clipboard] Failed to save pasted image:', error);
    return null;
  }
}

/**
 * Cap the long edge of a clipboard image before it is written to disk.
 *
 * This saves no tokens and is not meant to: the upstream clamp already charges
 * the same for a 4K grab as for a 2000px one (see `image-fidelity.ts`). What it
 * bounds is the temp file and the path handed across the bridge, so a 5K
 * screenshot does not land on disk at full size on every paste.
 *
 * Returns the input untouched when it already fits, so an ordinary screenshot is
 * never re-encoded for nothing.
 */
export function capClipboardImage(image: NativeImage, longEdge: number = IMAGE_LONG_EDGE_CAP): NativeImage {
  const size = image.getSize();
  const target = resolveResizeTarget(size.width, size.height, longEdge);
  if (!target) return image;

  // `quality: 'best'` is already Electron's default; it is passed explicitly
  // because this is a downscale of small UI text, where the resampling filter is
  // a legibility lever rather than a cosmetic one, and a future default change
  // should not silently degrade it.
  const resized = image.resize({ width: target.width, height: target.height, quality: 'best' });

  // Never hand an empty image on to toPNG(): a paste that writes a zero-byte file
  // is worse than a paste that costs a few extra bytes.
  return resized.isEmpty() ? image : resized;
}

/**
 * Delete stale pasted-image files from the clipboard temp directory.
 *
 * This is a DISK fix, not a token optimization. The obvious-looking alternative -
 * naming the file by a hash of its contents so a repeated paste of the same
 * screenshot reuses one path and is billed once - was measured and does not work.
 * Two Read calls in a single turn cost the same whether they name the same path
 * twice or two different paths holding identical bytes (measured 2026-08-10:
 * 139,945 vs 139,914 total input tokens, a 31-token difference that is pure
 * run-to-run noise). The billing unit is the image BLOCK in context, not the
 * path, so a second paste is a second block no matter what it is called. Do not
 * rebuild that idea on token grounds.
 *
 * Before this prune, every paste wrote a new file and nothing ever removed one,
 * so the directory grew for the life of the install.
 *
 * Best-effort by design. It runs on the paste path, so a locked or vanished file
 * must never turn into a failed paste.
 */
export function pruneClipboardTempDir(
  tempDir: string,
  options: { maxAgeMs?: number; maxFiles?: number; now?: number } = {},
): void {
  const maxAgeMs = options.maxAgeMs ?? CLIPBOARD_TEMP_MAX_AGE_MS;
  const maxFiles = options.maxFiles ?? CLIPBOARD_TEMP_MAX_FILES;
  const now = options.now ?? Date.now();

  let entries: string[];
  try {
    entries = fs.readdirSync(tempDir);
  } catch {
    return; // directory does not exist yet, or is unreadable
  }

  const files: { filePath: string; modifiedMs: number }[] = [];
  for (const entry of entries) {
    if (!entry.startsWith(CLIPBOARD_TEMP_PREFIX)) continue; // never touch a file we did not write
    const filePath = path.join(tempDir, entry);
    try {
      const stats = fs.statSync(filePath);
      if (!stats.isFile()) continue;
      files.push({ filePath, modifiedMs: stats.mtimeMs });
    } catch {
      // Raced with another delete, or unreadable. Skip it.
    }
  }

  // Newest first, so the count cap drops the oldest.
  files.sort((left, right) => right.modifiedMs - left.modifiedMs);

  for (let index = 0; index < files.length; index++) {
    const isTooOld = now - files[index].modifiedMs > maxAgeMs;
    const isOverCap = index >= maxFiles;
    if (!isTooOld && !isOverCap) continue;
    try {
      // `force` suppresses ENOENT only, for a file a concurrent paste already
      // removed. It does NOT suppress the EPERM/EBUSY Windows raises on a file
      // held open by a reader - the catch below is what tolerates that, so do
      // not drop it as redundant.
      fs.rmSync(files[index].filePath, { force: true });
    } catch {
      // Best-effort: a file we cannot remove is retried on the next paste.
    }
  }
}
