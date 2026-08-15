import fs from 'node:fs';
import path from 'node:path';
import type { NativeImage } from 'electron';
import { IMAGE_LONG_EDGE_CAP, resolveResizeTarget } from '../../../shared/image-fidelity';

/**
 * Clipboard-image handling for the terminal Ctrl+V paste path.
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
