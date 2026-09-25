import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shell } from 'electron';
import { attachmentDiskName } from '../../../shared/attachment-filename';
import { openPathBounded } from './open-path';

export interface OpenableAttachment {
  id: string;
  filename: string;
  file_path: string;
}

export interface OpenAttachmentOptions {
  /** Defaults to process.platform. Injectable so the Windows-only temp-copy branch is testable on Linux CI. */
  platform?: NodeJS.Platform;
  /** Passed through to openPathBounded, which defaults it to OPEN_PATH_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Defaults to os.tmpdir(). Injectable so tests never write to a hardcoded absolute path. */
  tempDirRoot?: string;
}

/**
 * Open an attachment with the OS default app, and guarantee the IPC invoke
 * that called this always gets a reply.
 *
 * openPathBounded owns the bounded wait and the reason for it (an xdg-open
 * hang outliving the renderer's invoke); this function adds only the
 * attachment-specific parts: the win32 temp copy and the reveal-in-file-manager
 * fallback.
 */
export async function openAttachmentFile(
  attachment: OpenableAttachment,
  options?: OpenAttachmentOptions,
): Promise<string> {
  const platform = options?.platform ?? process.platform;
  const tempDirRoot = options?.tempDirRoot ?? os.tmpdir();

  const targetPath = resolveOpenTarget(attachment, platform, tempDirRoot);

  const errorMessage = await openPathBounded(targetPath, {
    timeoutMs: options?.timeoutMs,
    // The invoke was already answered '' at the timeout. If openPath
    // eventually does report an error, still reveal the file - the renderer
    // has been told this succeeded, so there is no toast for this outcome.
    onLateOutcome: (lateError) => {
      if (lateError) shell.showItemInFolder(targetPath);
    },
  });

  if (errorMessage) {
    // Unsupported format or no default app - fall back to showing the file
    // in the file manager so the user can act on it manually.
    shell.showItemInFolder(targetPath);
  }
  return errorMessage;
}

/**
 * Windows keeps the temp-copy workaround: the short temp path stays clear of
 * MAX_PATH inside the LAUNCHED VIEWER, which may still use the legacy Win32
 * path APIs (Kangentic's own write of the stored file already succeeded at
 * the longer path, so the limit being dodged is never ours), and it lets the
 * OS pick a default app off a filename we control. Every other platform opens
 * the stored file directly - the stored path already keeps the sanitized
 * filename's extension, and the copy only adds a failure surface with nothing
 * to show for it off Windows.
 */
function resolveOpenTarget(
  attachment: OpenableAttachment,
  platform: NodeJS.Platform,
  tempDirRoot: string,
): string {
  if (platform !== 'win32') return attachment.file_path;

  const tempDir = path.join(tempDirRoot, 'kangentic-attachments');
  fs.mkdirSync(tempDir, { recursive: true });
  const tempPath = path.join(tempDir, attachmentDiskName(attachment.id, attachment.filename));

  // An attachment's bytes never change once stored (the repositories only add
  // and remove), so a same-size copy is already the file to open. Reusing it
  // is not just cheaper: the temp name is deterministic, and on Windows a
  // viewer still holding the previous copy open locks it, which would make
  // every REopen of an attachment throw a sharing violation.
  if (copyIsCurrent(attachment.file_path, tempPath)) return tempPath;

  try {
    fs.copyFileSync(attachment.file_path, tempPath);
    return tempPath;
  } catch {
    // Locked or otherwise uncopyable. Opening the stored file directly is
    // worse only in the MAX_PATH case above, and far better than failing.
    return attachment.file_path;
  }
}

/** True when `copyPath` already holds a same-size copy of `sourcePath`. */
function copyIsCurrent(sourcePath: string, copyPath: string): boolean {
  try {
    return fs.statSync(copyPath).size === fs.statSync(sourcePath).size;
  } catch {
    return false;
  }
}
