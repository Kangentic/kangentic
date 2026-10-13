import * as path from 'node:path';

/**
 * The comparison key for a folder: resolved (separators, `.` and `..`, a
 * trailing separator), and lower-cased on Windows, whose paths ignore case, so
 * `C:\Proj` and `c:\proj\` are one folder. macOS keeps its case: a volume can
 * be case-sensitive there, and folding would merge two real folders. Same
 * policy as `zombie-reaper.normalizePath`. It does not resolve 8.3 short
 * names or symlinks.
 */
export function sharedFolderKey(folder: string): string {
  const resolved = path.resolve(folder);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

interface FolderHold {
  /** The folder as the adapter wrote to it, handed back for the strip. */
  folder: string;
  /** `sharedFolderKey(folder)`, so two spellings of one folder compare equal. */
  key: string;
}

/**
 * Which sessions still need a file that every session in a folder shares.
 *
 * Some agent CLIs read their hooks or the Kangentic MCP entry only from a file
 * in the working folder (Gemini's `.gemini/settings.json`, Cursor's
 * `.cursor/mcp.json`, ...), so every session in that folder shares one copy.
 * The adapter writes it in `buildCommand` and strips it in `removeHooks`, and
 * the strip must wait for the folder's last session.
 *
 * A hold is keyed by the session's own id (`CommandOptions.ptySessionId`, the
 * id the session layer releases with), never by its task. Two sessions of one
 * task overlap: a young session's kill leaves its PTY exiting for up to the
 * grace while the task's next session starts, and a release keyed by the task
 * let the old exit strip the new session's file while it ran.
 *
 * A hold also records the folder it was taken in, and a release strips that
 * folder rather than the one it was handed. The session layer releases with
 * the cwd the command was built for, but an adapter that writes into the
 * project root (Codex, OpenCode) holds a different folder from a worktree
 * session's cwd.
 */
export class SharedFolderHolds {
  private readonly holdBySession = new Map<string, FolderHold>();

  /** Record that `sessionId` needs `folder`'s shared file. No id records nothing. */
  retain(sessionId: string | undefined, folder: string): void {
    if (!sessionId) return;
    this.holdBySession.set(sessionId, { folder, key: sharedFolderKey(folder) });
  }

  /**
   * End `sessionId`'s hold. Returns the folder whose shared file to strip now,
   * or null while another session still holds it.
   *
   * - A held session: its own recorded folder, once no other session holds it.
   * - A session that took no hold (a build with no shared write, or a second
   *   release after a suspend): `folder`, once nobody holds it.
   * - No session id at all (project delete's sweep): drops every hold on
   *   `folder` and strips it.
   *
   * Idempotent per session: a second release of the same id is the unheld case.
   */
  release(sessionId: string | undefined, folder: string): string | null {
    if (!sessionId) {
      const key = sharedFolderKey(folder);
      for (const [heldSessionId, hold] of this.holdBySession) {
        if (hold.key === key) this.holdBySession.delete(heldSessionId);
      }
      return folder;
    }
    const recorded = this.holdBySession.get(sessionId);
    this.holdBySession.delete(sessionId);
    const target = recorded?.folder ?? folder;
    return this.isHeld(target) ? null : target;
  }

  /** True while any session holds `folder`. */
  isHeld(folder: string): boolean {
    const key = sharedFolderKey(folder);
    for (const hold of this.holdBySession.values()) {
      if (hold.key === key) return true;
    }
    return false;
  }
}
