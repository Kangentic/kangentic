import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shell } from 'electron';
import { attachmentDiskName } from '../../../shared/attachment-filename';

export const OPEN_PATH_TIMEOUT_MS = 5000;

export interface OpenableAttachment {
  id: string;
  filename: string;
  file_path: string;
}

export interface OpenAttachmentOptions {
  /** Defaults to process.platform. Injectable so the Windows-only temp-copy branch is testable on Linux CI. */
  platform?: NodeJS.Platform;
  /** Defaults to OPEN_PATH_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Defaults to os.tmpdir(). Injectable so tests never write to a hardcoded absolute path. */
  tempDirRoot?: string;
}

/**
 * Open an attachment with the OS default app, and guarantee the IPC invoke
 * that called this always gets a reply.
 *
 * shell.openPath() never rejects - it always resolves, with '' on success or
 * a non-empty error string on failure (Electron's
 * shell/common/api/electron_api_shell.cc). Nothing bounds how long that can
 * take: on Linux, OpenPath shells out to xdg-open, which can wait on
 * whatever viewer it launches. If that promise never settles, it can outlive
 * the renderer's ipcRenderer.invoke() call, and the reply channel gets torn
 * down without ever sending a reply - surfacing as "reply was never sent"
 * (Electron's ReplyChannel::EnsureReplySent pre-finalizer). Racing openPath
 * against a timeout does not un-stick that hang; it only guarantees this
 * handler's own promise settles, so the invoke is always answered.
 */
export async function openAttachmentFile(
  attachment: OpenableAttachment,
  options?: OpenAttachmentOptions,
): Promise<string> {
  const platform = options?.platform ?? process.platform;
  const timeoutMs = options?.timeoutMs ?? OPEN_PATH_TIMEOUT_MS;
  const tempDirRoot = options?.tempDirRoot ?? os.tmpdir();

  const targetPath = resolveOpenTarget(attachment, platform, tempDirRoot);

  const openPromise = shell.openPath(targetPath);
  const result = await raceWithTimeout(openPromise, timeoutMs);

  if (result.timedOut) {
    // The invoke is answered now. If openPath eventually does report an
    // error, still reveal the file - the renderer has already been told
    // this succeeded, so there is no toast for this late outcome.
    void openPromise.then(
      (lateError) => {
        if (lateError) shell.showItemInFolder(targetPath);
      },
      () => {
        // Nothing left to report: the invoke was answered at the timeout.
      },
    );
    return '';
  }

  if (result.value) {
    // Unsupported format or no default app - fall back to showing the file
    // in the file manager so the user can act on it manually.
    shell.showItemInFolder(targetPath);
  }
  return result.value;
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

type RaceResult = { timedOut: true } | { timedOut: false; value: string };

function raceWithTimeout(promise: Promise<string>, timeoutMs: number): Promise<RaceResult> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve({ timedOut: false, value });
      },
      (error: unknown) => {
        // openPath is documented never to reject, but this function exists to
        // guarantee the invoke is answered - so it cannot depend on an
        // upstream contract holding. Report a rejection as the failure it is
        // instead of stalling until the timer and then claiming success.
        clearTimeout(timer);
        const message = error instanceof Error ? error.message : String(error);
        // Never resolve '' here: '' is this function's success value.
        resolve({ timedOut: false, value: message || 'The file could not be opened.' });
      },
    );
  });
}
