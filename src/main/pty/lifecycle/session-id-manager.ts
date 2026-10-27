import path from 'node:path';
import { stripAnsiEscapes } from '../buffer/transcript-writer';
import type { AgentParser, StoredCliTarget } from '../../../shared/types';

/**
 * Chunk-boundary-safe scanner for extracting agent session IDs from PTY output.
 *
 * PTY data arrives in arbitrary chunks. On Windows ConPTY that flushes at
 * ~4KB boundaries, a UUID printed at exactly the boundary splits across two
 * chunks and a per-chunk regex misses it. This scanner maintains a rolling
 * window (default 8KB = 2x ConPTY chunk size) of the most recent output and
 * runs the adapter's regex against the concatenation, so matches spanning any
 * single chunk boundary are preserved.
 *
 * ANSI escape sequences are stripped before matching so Windows ConPTY
 * cursor-positioning that interleaves with printable characters doesn't
 * break regexes that work on Unix pty.
 *
 * Used exclusively by SessionIdManager below. Exported so tests can
 * drive it directly against edge cases.
 */
export class SessionIdScanner {
  /** Rolling buffer of the most recent PTY output (capped at `bufferMax`). */
  private buffer = '';

  constructor(private readonly bufferMax: number = 8192) {}

  /**
   * Feed a raw PTY chunk. Returns the captured session ID on first match,
   * or null. Caller should stop invoking after a non-null return.
   */
  scanChunk(data: string, fromOutput: (d: string) => string | null): string | null {
    let combined = this.buffer + data;
    if (combined.length > this.bufferMax) {
      combined = combined.slice(combined.length - this.bufferMax);
    }
    this.buffer = combined;
    return fromOutput(stripAnsiEscapes(combined));
  }

  /**
   * Scan a full scrollback buffer once at suspend time. Does not mutate
   * the rolling buffer. Used as the last-resort fallback after the PTY exits.
   */
  scanScrollback(scrollback: string, fromOutput: (d: string) => string | null): string | null {
    return fromOutput(stripAnsiEscapes(scrollback));
  }

  /** Free the rolling buffer once a capture has succeeded. */
  reset(): void {
    this.buffer = '';
  }
}

export interface SessionIdManagerCallbacks {
  hasAgentSessionId(sessionId: string): boolean;
  notifyAgentSessionId(sessionId: string, capturedId: string): void;
  /** True if the session is still in the SessionManager map. Used to
   *  avoid logging a capture for a session that was killed while the
   *  filesystem promise was in flight. */
  sessionExists(sessionId: string): boolean;
  /** The agent session id a session already holds, or null. Read to tell
   *  whether a folder scan's match could be another session's. */
  agentSessionIdOf(sessionId: string): string | null;
}

/** A folder, compared the way the file system compares it. */
function folderKey(cwd: string): string {
  const resolved = path.resolve(cwd);
  // Case-insensitive by default on Windows and macOS; a case-sensitive macOS
  // volume only makes two folders look like one, which drops a match, never
  // records a wrong one.
  return process.platform === 'linux' ? resolved : resolved.toLowerCase();
}

/**
 * Coordinates the pathways by which SessionManager learns an agent's
 * internal session ID (the value passed to `--resume`).
 *
 * Pathways, tried concurrently - first to produce a non-null ID wins:
 *   1. Filesystem - adapter polls a DB or rollout file (fire-and-forget
 *      Promise). Primary path for Codex 0.118 where PTY output and
 *      hooks are both unavailable.
 *   2. Stream/output - per-chunk rolling-buffer scanner matches a
 *      regex across chunk boundaries. Primary path for Claude.
 *   3. Scrollback fallback - at suspend time, scan the whole
 *      scrollback once. Catches late prints (Gemini's on-exit banner,
 *      Codex startup headers that the stream scanner missed).
 *   4. Hook (not handled here) - Claude Code's SessionStart hook
 *      writes the ID to status.json; read by StatusFileReader.
 *
 * Additionally, arm a 30s diagnostic timer on spawn. If none of the
 * capture paths fire by then, log a warning - regression canary for
 * adapter changes that silently break --resume.
 *
 * A filesystem match is the one pathway that can name ANOTHER session's id:
 * it finds the newest session file the agent wrote in a folder, and the
 * output and hook pathways read the session's own stream. So a folder match is
 * dropped when it could be another's: an id another session in the folder
 * already holds, or any match while another session of the same agent, with
 * no id yet, started in the same folder close to this one. A dropped match
 * leaves the session with no id, which is recoverable (a workflow continues
 * from its saved plan, a task starts a new conversation); a wrong one would
 * make a Resume reopen another session's conversation. A session that ended or
 * was paused still counts while its row is registered: the file the scan found
 * may be the one it wrote before it stopped. Sessions in their own worktree
 * never share a folder, so this only touches sessions in a shared checkout
 * (no-worktree tasks, Command Terminals, a workflow's agent).
 */
export class SessionIdManager {
  /** Rolling buffer size for session-ID capture. Must be at least 2x the max
   *  PTY chunk size so any UUID straddling a single chunk boundary is preserved
   *  after slicing. Windows ConPTY flushes at 4KB, so 8KB gives a safe margin. */
  private static readonly BUFFER_MAX = 8192;
  /** Warn if capture hasn't fired by this timeout. */
  private static readonly DIAGNOSTIC_TIMEOUT_MS = 30_000;
  /** Two sessions of one agent started this close in one folder make a folder
   *  match ambiguous. Wider than any adapter's own match window (OpenCode's is
   *  5 s before to 30 s after the spawn). */
  private static readonly FOLDER_SCAN_AMBIGUITY_MS = 60_000;

  private scanners = new Map<string, SessionIdScanner>();
  private diagnosticTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Where and when each session with a capture strategy started, for the folder-match check. */
  private spawns = new Map<string, { folder: string; agentName: string; spawnedAt: number }>();

  constructor(private readonly callbacks: SessionIdManagerCallbacks) {}

  /**
   * Arm the diagnostic timer and kick off filesystem-based capture.
   * Call once at spawn time per session. Safe for adapters without a
   * session-ID strategy (returns early).
   *
   * `hasKnownAgentSessionId` lets the caller indicate that the agent
   * session ID is already known at spawn time (caller-owned UUID via
   * `--session-id` etc). When true, the diagnostic "not captured"
   * timer is skipped because the ID is fixed by us, not discovered
   * by the agent.
   */
  init(
    sessionId: string,
    agentParser: AgentParser | undefined,
    cwd: string,
    agentName: string,
    hasKnownAgentSessionId: boolean = false,
    cliTarget: StoredCliTarget | null = null,
  ): void {
    const strategy = agentParser?.runtime?.sessionId;
    if (!strategy) return;
    const spawnedAt = new Date();
    this.spawns.set(sessionId, { folder: folderKey(cwd), agentName, spawnedAt: spawnedAt.getTime() });

    const hasCapturePath = !!(strategy.fromHook || strategy.fromOutput || strategy.fromFilesystem);
    if (hasCapturePath && !hasKnownAgentSessionId) {
      const timer = setTimeout(() => {
        this.diagnosticTimers.delete(sessionId);
        if (!this.callbacks.hasAgentSessionId(sessionId)) {
          console.warn(
            `[session-manager] ${agentName} session ID not captured after `
            + `${SessionIdManager.DIAGNOSTIC_TIMEOUT_MS / 1000}s for session `
            + `${sessionId.slice(0, 8)} - --resume will not work.`,
          );
        }
      }, SessionIdManager.DIAGNOSTIC_TIMEOUT_MS);
      timer.unref();
      this.diagnosticTimers.set(sessionId, timer);
    }

    if (strategy.fromFilesystem) {
      strategy.fromFilesystem({ spawnedAt, cwd, cliTarget })
        .then((capturedId) => {
          if (!capturedId) return;
          if (this.callbacks.hasAgentSessionId(sessionId)) return;
          if (!this.callbacks.sessionExists(sessionId)) return;
          const conflict = this.folderMatchConflict(sessionId, capturedId);
          if (conflict) {
            console.warn(`[${agentName}] Dropped a session ID found in the folder for ${sessionId.slice(0, 8)}: ${conflict}.`);
            return;
          }
          console.log(`[${agentName}] Captured session ID from filesystem: ${capturedId.slice(0, 16)}...`);
          this.callbacks.notifyAgentSessionId(sessionId, capturedId);
        })
        .catch((err) => {
          console.warn(`[session-manager] fromFilesystem capture failed for session=${sessionId.slice(0, 8)}:`, err);
        });
    }
  }

  /**
   * Feed a fresh PTY chunk into the per-session rolling-buffer scanner.
   * No-op if the adapter has no `fromOutput` strategy, or if the ID has
   * already been captured via another pathway.
   */
  onData(sessionId: string, data: string, agentParser: AgentParser | undefined): void {
    const fromOutput = agentParser?.runtime?.sessionId?.fromOutput;
    if (!fromOutput) return;
    if (this.callbacks.hasAgentSessionId(sessionId)) return;

    let scanner = this.scanners.get(sessionId);
    if (!scanner) {
      scanner = new SessionIdScanner(SessionIdManager.BUFFER_MAX);
      this.scanners.set(sessionId, scanner);
    }
    const capturedId = scanner.scanChunk(data, fromOutput);
    if (capturedId) {
      scanner.reset();
      this.callbacks.notifyAgentSessionId(sessionId, capturedId);
    }
  }

  /**
   * Last-resort: scan the full scrollback for the agent session ID at
   * suspend time. Catches late prints (Gemini's on-exit banner) and
   * startup headers that the streaming scanner missed. No-op if the
   * ID has already been captured.
   */
  scanScrollback(
    sessionId: string,
    agentParser: AgentParser | undefined,
    rawScrollback: string,
  ): void {
    const fromOutput = agentParser?.runtime?.sessionId?.fromOutput;
    if (!fromOutput) return;
    if (this.callbacks.hasAgentSessionId(sessionId)) return;

    const scanner = this.scanners.get(sessionId) ?? new SessionIdScanner();
    const capturedId = scanner.scanScrollback(rawScrollback, fromOutput);
    if (capturedId) {
      this.callbacks.notifyAgentSessionId(sessionId, capturedId);
    }
  }

  /**
   * Cancel the diagnostic timer without dropping the scanner. Called
   * from the PTY exit handler so a spurious "not captured" warning
   * cannot fire after exit, but the scanner remains available for
   * the suspend-time scrollback fallback.
   */
  clearDiagnostic(sessionId: string): void {
    const timer = this.diagnosticTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.diagnosticTimers.delete(sessionId);
    }
  }

  /** Full cleanup. Called on remove() and during respawn teardown. */
  removeSession(sessionId: string): void {
    this.clearDiagnostic(sessionId);
    this.scanners.delete(sessionId);
    this.spawns.delete(sessionId);
  }

  /**
   * Why a folder scan's match for this session could be another session's, or
   * null when it can only be its own. See the class comment.
   */
  private folderMatchConflict(sessionId: string, capturedId: string): string | null {
    const own = this.spawns.get(sessionId);
    if (!own) return null;
    for (const [otherId, other] of this.spawns) {
      if (otherId === sessionId || other.folder !== own.folder || !this.callbacks.sessionExists(otherId)) continue;
      const otherAgentSessionId = this.callbacks.agentSessionIdOf(otherId);
      if (otherAgentSessionId === capturedId) return `session ${otherId.slice(0, 8)} already holds it`;
      const startedClose = Math.abs(other.spawnedAt - own.spawnedAt) <= SessionIdManager.FOLDER_SCAN_AMBIGUITY_MS;
      if (other.agentName === own.agentName && otherAgentSessionId === null && startedClose) {
        return `session ${otherId.slice(0, 8)} of the same agent started in the same folder at nearly the same time`;
      }
    }
    return null;
  }
}
