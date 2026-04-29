import { EventEmitter } from 'node:events';
import { v4 as uuidv4 } from 'uuid';
import { ShellResolver } from './spawn/shell-resolver';
import { SessionQueue } from './session-queue';
import { PtyBufferManager } from './buffer/pty-buffer-manager';
import { SessionHistoryReader } from './readers/session-history-reader';
import { StatusFileReader } from './readers/status-file-reader';
import { UsageTracker } from './activity/usage-tracker';
import { TranscriptWriter } from './buffer/transcript-writer';
import { SessionIdManager } from './lifecycle/session-id-manager';
import { SessionFileManager } from './lifecycle/session-file-manager';
import { gracefulPtyShutdown } from './shutdown/session-suspend';
import { suspendAllSessions, killAllSessions } from './shutdown/session-shutdown';
import { ResizeManager } from './lifecycle/resize-manager';
import { FirstOutputTracker } from './lifecycle/first-output-tracker';
import { disposeAdapterAttachment, removeAdapterHooks } from './lifecycle/adapter-lifecycle';
import { safeKillPty } from './lifecycle/pty-kill';
import { performSpawn } from './lifecycle/session-spawn-flow';
import { detectPR } from './pr/pr-connectors';
import { SessionRegistry, toSession, filterCacheByProject, type ManagedSession } from './session-registry';
import { createWriteQueue, type WriteQueue } from './write-queue';
import { isShuttingDown } from '../shutdown-state';
import type { TranscriptRepository } from '../db/repositories/transcript-repository';
import type {
  Session,
  SessionUsage,
  ActivityState,
  SessionEvent,
  SpawnSessionInput,
} from '../../shared/types';

export class SessionManager extends EventEmitter {
  private registry = new SessionRegistry();
  private shellResolver = new ShellResolver();
  private configuredShell: string | null = null;
  private firstOutputTracker = new FirstOutputTracker();
  /**
   * TUI redraw suppression: dedup ring buffer + resize grace window.
   * See ResizeManager for the full contract.
   */
  private resizeManager = new ResizeManager();
  /**
   * Sessions currently visible in the renderer (terminal panel + command bar overlay).
   * Only these sessions' PTY data is emitted via IPC - background sessions
   * accumulate silently in the scrollback buffer. This eliminates O(N) IPC
   * flooding when many sessions run concurrently. An empty set means "all
   * sessions are focused" (no filtering).
   */
  private focusedSessionIds = new Set<string>();
  /**
   * Per-session FIFO write queue. Every `write()` call appends to the same
   * buffer and is drained by a single loop that yields via setImmediate
   * between 4KB chunks. Guarantees byte order across concurrent callers
   * (user input, paste, command-injector) so bracketed-paste sequences
   * cannot be fragmented by interleaved writes.
   */
  private writeQueues = new Map<string, WriteQueue>();
  private transcriptWriter: TranscriptWriter | null = null;

  // Sub-modules owned by SessionManager. Cross-wired in the constructor
  // below; `usageTracker` and `sessionHistoryReader` form a cycle (the
  // tracker's onAgentSessionId attaches the history reader; the reader
  // calls back into the tracker) which is resolved via definite-
  // assignment (`!`) so their callbacks can reference each other.
  private sessionQueue: SessionQueue;
  private bufferManager: PtyBufferManager;
  private usageTracker!: UsageTracker;
  private sessionHistoryReader!: SessionHistoryReader;
  private statusFileReader: StatusFileReader;
  private sessionFiles: SessionFileManager;
  private sessionIdManager: SessionIdManager;

  constructor() {
    super();

    this.sessionQueue = new SessionQueue({
      spawner: (input) => this.doSpawn(input).then(() => {}),
      getActiveCount: () => this.activeCount,
      maxConcurrent: 5,
    });

    this.bufferManager = new PtyBufferManager({
      onFlush: (sessionId, data) => {
        const session = this.registry.get(sessionId);
        const detector = session?.agentParser
          ? (chunk: string) => session.agentParser!.detectFirstOutput(chunk)
          : undefined;
        if (this.firstOutputTracker.consume(sessionId, data, detector)) {
          this.emit('first-output', sessionId);
          // Clear the resuming flag once the resumed CLI has actually
          // produced output. This unblocks card / overlay labels for
          // adapters (Codex, Gemini) that don't emit a usage statusline.
          if (session && session.resuming) {
            session.resuming = false;
            this.emit('session-changed', sessionId, toSession(session));
          }
        }
        // Only emit IPC data for focused sessions. Background sessions
        // accumulate in scrollback and reload via getScrollback() on tab switch.
        if (this.focusedSessionIds.size === 0 || this.focusedSessionIds.has(sessionId)) {
          this.emit('data', sessionId, data);
        }
      },
    });

    this.sessionIdManager = new SessionIdManager({
      hasAgentSessionId: (id) => this.usageTracker.hasAgentSessionId(id),
      notifyAgentSessionId: (id, capturedId) => this.usageTracker.notifyAgentSessionId(id, capturedId),
      sessionExists: (id) => this.registry.has(id),
    });

    this.usageTracker = new UsageTracker({
      onUsageChange: (sessionId, usage) => this.emit('usage', sessionId, usage),
      onActivityChange: (sessionId, activity, permissionIdle) => this.emit('activity', sessionId, activity, permissionIdle),
      onEvent: (sessionId, event) => this.emit('event', sessionId, event),
      onIdleTimeout: (sessionId) => {
        const session = this.registry.get(sessionId);
        if (session) this.emit('idle-timeout', sessionId, session.taskId, this.usageTracker.idleTimeoutMinutes);
      },
      onPlanExit: (sessionId) => this.emit('plan-exit', sessionId),
      onPRCandidate: (sessionId) => {
        const scrollback = this.bufferManager.getRawScrollback(sessionId);
        const detected = detectPR(scrollback);
        if (detected) {
          this.emit('pr-detected', sessionId, detected.url, detected.number);
        }
      },
      onAgentSessionId: (sessionId, agentReportedId) => {
        // Agent session ID capture covers two cases:
        // 1. Fresh capture: agent_session_id was null (Codex/Gemini), now captured from hooks/PTY output.
        // 2. Stale recovery: agent_session_id was pre-specified (Claude --resume) but the agent
        //    created a different session (--resume failed silently). DB needs the correct ID.
        // recoverStaleSessionId() handles both cases - emit unconditionally.
        const session = this.registry.get(sessionId);
        if (!session) return;
        this.emit('agent-session-id', sessionId, session.taskId, session.projectId, agentReportedId);
        // Hand off to the session-history reader if the adapter declares
        // a native history hook. Fire-and-forget - the reader logs any
        // failures and degrades gracefully to PtyActivityTracker.
        const historyHook = session.agentParser?.runtime?.sessionHistory;
        if (historyHook) {
          this.sessionHistoryReader.attach({
            sessionId,
            agentSessionId: agentReportedId,
            cwd: session.cwd,
            hook: historyHook,
            agentName: session.agentName,
          }).catch((err) => {
            console.warn(`[session-history] attach failed for session=${sessionId.slice(0, 8)}:`, err);
          });
        }
      },
      requestSuspend: (sessionId) => this.suspend(sessionId),
      isSessionRunning: (sessionId) => this.registry.get(sessionId)?.status === 'running',
    });

    this.sessionHistoryReader = new SessionHistoryReader({
      onUsageUpdate: (sessionId, usage) => this.usageTracker.setSessionUsage(sessionId, usage),
      onEvents: (sessionId, events) => this.usageTracker.ingestEvents(sessionId, events),
      onActivity: (sessionId, activity) => this.usageTracker.forceActivity(sessionId, activity),
      onFirstTelemetry: (sessionId) => {
        // Only suppress PTY detection when the adapter uses hooks_and_pty
        // (meaning hook-based events can drive activity transitions). For
        // pure PTY adapters (Codex, Aider), session history provides usage
        // data (model, tokens) but NOT real-time activity signals, so the
        // silence timer must remain active.
        const session = this.registry.get(sessionId);
        const activityKind = session?.agentParser?.runtime?.activity?.kind;
        if (activityKind === 'hooks_and_pty') {
          this.usageTracker.suppressPty(sessionId);
        }
      },
    });

    this.statusFileReader = new StatusFileReader({
      onUsageParsed: (sessionId, usage) => this.usageTracker.processStatusUpdate(sessionId, usage),
      onEventsParsed: (sessionId, rawLines, events) => {
        this.usageTracker.captureHookSessionIds(sessionId, rawLines);
        this.usageTracker.ingestEvents(sessionId, events);
      },
    });

    this.sessionFiles = new SessionFileManager(
      this.sessionHistoryReader,
      this.statusFileReader,
    );

    // Free the per-session write queue when a PTY exits naturally (without
    // going through kill()). dispose() is idempotent so the kill() path
    // double-disposing is harmless.
    this.on('exit', (sessionId: string) => {
      const writeQueue = this.writeQueues.get(sessionId);
      if (writeQueue) {
        writeQueue.dispose();
        this.writeQueues.delete(sessionId);
      }
    });
  }

  setMaxConcurrent(max: number): void {
    this.sessionQueue.setMaxConcurrent(max);
  }

  setIdleTimeout(minutes: number): void {
    this.usageTracker.setIdleTimeout(minutes);
  }

  /**
   * Enable transcript capture by providing a TranscriptRepository.
   * Called after the project DB is available. Without this, PTY output
   * is not persisted (only kept in the in-memory ring buffer).
   */
  setTranscriptRepository(transcriptRepo: TranscriptRepository): void {
    this.transcriptWriter = new TranscriptWriter(transcriptRepo);
  }

  dispose(): void {
    this.usageTracker.dispose();
    this.transcriptWriter?.finalizeAll();
  }

  /** Set which sessions are currently visible (terminal panel + command bar overlay). */
  setFocusedSessions(sessionIds: string[]): void {
    this.focusedSessionIds = new Set(sessionIds);
  }

  /** Return the set of currently focused session IDs. */
  getFocusedSessions(): Set<string> {
    return this.focusedSessionIds;
  }

  setShell(shell: string | null): void {
    this.configuredShell = shell;
  }

  /** Return the resolved shell name (configured or system default). */
  async getShell(): Promise<string> {
    return this.configuredShell || await this.shellResolver.getDefaultShell();
  }

  // Tracks sessions currently inside doSpawn() but not yet stored in the
  // sessions map. Included in activeCount so shouldQueue() sees the true load.
  private spawningCount = 0;

  private get activeCount(): number {
    return this.spawningCount + this.registry.countRunning();
  }

  get queuedCount(): number {
    return this.sessionQueue.length;
  }

  /** Lightweight session counts without allocating mapped Session objects. */
  getSessionCounts(): { active: number; suspended: number; total: number } {
    return this.registry.getSessionCounts();
  }

  async spawn(input: SpawnSessionInput): Promise<Session> {
    if (isShuttingDown()) {
      throw new Error('Cannot spawn session during shutdown');
    }

    if (this.sessionQueue.shouldQueue()) {
      // Return a queued placeholder immediately (don't block the caller).
      // SessionQueue will promote it to a running PTY when a slot opens.
      const id = input.id ?? uuidv4();
      const inputWithId = { ...input, id };
      const session: ManagedSession = {
        id,
        taskId: input.taskId,
        projectId: input.projectId,
        pty: null,
        status: 'queued',
        shell: '',
        cwd: input.cwd,
        startedAt: new Date().toISOString(),
        exitCode: null,
        resuming: input.resuming ?? false,
        transient: input.transient ?? false,
        exitSequence: input.exitSequence ?? ['\x03'],
        agentParser: input.agentParser,
      };
      this.registry.set(id, session);
      this.sessionQueue.enqueue(inputWithId);
      this.emit('session-changed', id, toSession(session));
      return toSession(session);
    }

    // Reserve a slot so concurrent spawn() calls see the correct count
    this.spawningCount++;
    try {
      return await this.doSpawn(input);
    } finally {
      this.spawningCount--;
      // Essential on failure path (doSpawn throws before onExit is registered).
      // On success path this is a no-op absorbed by the reentrancy guard -
      // the real promotion happens later in onExit when the PTY exits.
      this.sessionQueue.notifySlotFreed();
    }
  }

  private doSpawn(input: SpawnSessionInput): Promise<Session> {
    return performSpawn(input, {
      registry: this.registry,
      bufferManager: this.bufferManager,
      usageTracker: this.usageTracker,
      sessionIdManager: this.sessionIdManager,
      sessionFiles: this.sessionFiles,
      resizeManager: this.resizeManager,
      statusFileReader: this.statusFileReader,
      sessionHistoryReader: this.sessionHistoryReader,
      sessionQueue: this.sessionQueue,
      getTranscriptWriter: () => this.transcriptWriter,
      getShell: () => this.getShell(),
      emit: (event, ...args) => this.emit(event, ...args),
    });
  }

  write(sessionId: string, data: string): void {
    const session = this.registry.get(sessionId);
    if (!session?.pty || data.length === 0) return;

    let queue = this.writeQueues.get(sessionId);
    if (!queue) {
      queue = createWriteQueue(
        () => this.registry.get(sessionId)?.pty ?? null,
        undefined,
        { onAutoDispose: () => this.writeQueues.delete(sessionId) },
      );
      this.writeQueues.set(sessionId, queue);
    }
    queue.enqueue(data);
  }

  resize(sessionId: string, cols: number, rows: number): { colsChanged: boolean } {
    const session = this.registry.get(sessionId);
    if (!session?.pty) return { colsChanged: false };

    // Guard against NaN/Infinity from layout edge cases (e.g. getComputedStyle
    // returning "" during unmount, yielding parseInt -> NaN)
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return { colsChanged: false };

    // Clamp to valid dimensions (node-pty throws on 0 or negative)
    const clampedCols = Math.max(2, Math.floor(cols));
    const clampedRows = Math.max(1, Math.floor(rows));

    const colsChanged = this.bufferManager.onResize(sessionId, clampedCols);
    session.pty.resize(clampedCols, clampedRows);
    // Mark resize time so the dispatch can suppress idle->thinking
    // transitions during the redraw burst that follows.
    this.resizeManager.notifyResize(sessionId);
    return { colsChanged };
  }

  /**
   * Fully remove a session from all internal maps: kill the PTY, clean up
   * session files, and delete from sessions/usage/activity caches.
   * Used during project deletion to prevent cross-project bleed.
   */
  remove(sessionId: string): void {
    // kill() may emit 'exit' events that depend on the session still being
    // in the map (the exit handler looks up the session by ID). Delete AFTER.
    const session = this.registry.get(sessionId);
    this.sessionIdManager.removeSession(sessionId);
    if (session) disposeAdapterAttachment(session);
    this.kill(sessionId);
    // Full cleanup including file deletion - the session is not coming back.
    this.sessionFiles.detachAndDelete(sessionId);
    this.registry.delete(sessionId);
    this.bufferManager.removeSession(sessionId);
    this.transcriptWriter?.remove(sessionId);
    this.usageTracker.removeSession(sessionId);
    this.firstOutputTracker.removeSession(sessionId);
    this.resizeManager.removeSession(sessionId);
  }

  /**
   * Kill any PTY session belonging to a task, regardless of whether the
   * task's session_id field has been written to the DB yet. This handles
   * the race where a concurrent handleTaskMove spawned a session but
   * hasn't updated the task record.
   */
  killByTaskId(taskId: string): void {
    const session = this.registry.findByTaskId(taskId);
    if (session) this.kill(session.id);
  }

  /**
   * Fully remove any PTY session belonging to a task from all internal
   * maps. Like killByTaskId but also cleans up caches and session files.
   */
  removeByTaskId(taskId: string): void {
    const session = this.registry.findByTaskId(taskId);
    if (session) this.remove(session.id);
  }

  kill(sessionId: string): void {
    const session = this.registry.get(sessionId);
    if (session?.pty) {
      const ptyRef = session.pty;
      session.pty = null; // prevent double-kill (conpty heap corruption on Windows)
      safeKillPty(ptyRef);
    }
    // Drop pending bytes; a stale drain loop scheduled via setImmediate will
    // observe the disposed flag on its next tick and exit cleanly.
    const writeQueue = this.writeQueues.get(sessionId);
    if (writeQueue) {
      writeQueue.dispose();
      this.writeQueues.delete(sessionId);
    }
    // Remove from queue if queued, and mark as exited.
    // Queued sessions have no PTY, so onExit never fires. Emit the exit
    // event explicitly so the DB listener marks the record as exited.
    if (this.sessionQueue.remove(sessionId) && session) {
      session.status = 'exited';
      session.exitCode = -1;
      this.emit('exit', sessionId, -1);
    }
    // A slot may have opened - let the queue promote
    this.sessionQueue.notifySlotFreed();
  }

  /**
   * Wait for a session's PTY process to exit. Returns immediately if the
   * process is already dead (pty is null) or the session doesn't exist.
   *
   * Uses the 'exit' event emitted by onExit (line 368) as the signal.
   * Safety timeout (10s) prevents hanging if onExit never fires (conpty bug).
   */
  awaitExit(sessionId: string): Promise<void> {
    const session = this.registry.get(sessionId);
    // Session doesn't exist, already exited, or suspended - resolve immediately.
    // IMPORTANT: Do NOT check session.pty here. kill() sets pty=null before
    // the process actually dies (to prevent double-kill on Windows conpty).
    // Checking pty would cause awaitExit to resolve before file handles are
    // released, leading to EPERM/hang during worktree removal on Windows.
    if (!session || session.status === 'exited' || session.status === 'suspended' || session.status === 'queued') {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      const safetyTimeout = setTimeout(() => {
        this.removeListener('exit', onExit);
        console.warn(`[SessionManager] awaitExit safety timeout for session ${sessionId.slice(0, 8)} - process may still hold handles`);
        resolve();
      }, 10_000);

      const onExit = (exitedSessionId: string) => {
        if (exitedSessionId === sessionId) {
          clearTimeout(safetyTimeout);
          this.removeListener('exit', onExit);
          resolve();
        }
      };

      this.on('exit', onExit);

      // Re-check after subscribing (process may have exited between the
      // initial check and event registration)
      const currentSession = this.registry.get(sessionId);
      if (!currentSession || currentSession.status === 'exited' || currentSession.status === 'suspended' || currentSession.status === 'queued') {
        clearTimeout(safetyTimeout);
        this.removeListener('exit', onExit);
        resolve();
      }
    });
  }

  /**
   * Suspend a session: gracefully exit the agent, then kill the PTY.
   * Preserves session files on disk so the session can be resumed later.
   *
   * Sends the agent's exit sequence (e.g. Ctrl+C + /exit for Claude Code)
   * and waits up to 1500ms for the process to exit naturally. This gives
   * the agent time to flush its conversation transcript (JSONL) to disk,
   * which is required for --resume to work. Force-kills if still alive.
   *
   * Unlike kill(), the onExit handler will NOT clean up files because
   * file paths are nulled before the PTY is destroyed.
   */
  async suspend(sessionId: string): Promise<void> {
    const session = this.registry.get(sessionId);
    if (!session) return;

    // Strip agent hooks from the project's settings file before
    // closing down. Prevents hook accumulation across sessions. Both
    // this path and the onExit handler call removeAdapterHooks;
    // adapters key on taskId so the duplicate call is idempotent.
    removeAdapterHooks(session);

    // Close watchers and detach telemetry readers WITHOUT deleting
    // files - they persist for resume. Null out paths so the onExit
    // handler's cleanup skips settings.json deletion. See
    // SessionFileManager.detachPreservingFiles.
    this.sessionFiles.detachPreservingFiles(sessionId);

    // Flush transcript to DB before killing PTY
    this.transcriptWriter?.finalize(sessionId);

    // Synthetic session_end before we kill - Claude Code's hook won't fire
    this.usageTracker.emitSessionEnd(sessionId);

    // Clear subagent depth - session is no longer active
    this.usageTracker.clearSessionTracking(sessionId);

    // Mark suspended BEFORE killing so the async onExit handler preserves it
    session.status = 'suspended';

    if (session.pty) {
      // Send exit sequence, wait up to 1500ms for natural exit, then
      // force-kill and wait another 1500ms for kill propagation so
      // callers that immediately delete the CWD (worktree removal on
      // move-to-Done) don't race Windows ConPTY still holding handles.
      // See session-suspend.gracefulPtyShutdown.
      await gracefulPtyShutdown({
        ptyRef: session.pty,
        exitSequence: session.exitSequence,
        emitter: this,
        sessionId,
        clearPty: () => { session.pty = null; },
        killPty: safeKillPty,
      });
    }

    // Last-resort: scan full scrollback for agent session ID if not yet
    // captured. Handles Gemini printing session ID at shutdown, Codex
    // startup header missed by streaming handler, etc. Uses raw (pre-TUI)
    // scrollback so startup headers remain in scope.
    const rawScrollback = this.bufferManager.getRawScrollback(sessionId);
    this.sessionIdManager.scanScrollback(sessionId, session.agentParser, rawScrollback);

    this.emit('session-changed', sessionId, toSession(session));

    // Remove from queue (queued sessions have no PTY yet) and promote
    this.sessionQueue.remove(sessionId);
    this.sessionQueue.notifySlotFreed();
  }

  getScrollback(sessionId: string): string {
    return this.bufferManager.getScrollback(sessionId);
  }

  getSession(sessionId: string): Session | undefined {
    return this.registry.getSession(sessionId);
  }

  listSessions(): Session[] {
    return this.registry.listSessions();
  }

  /** Return cached usage data for all sessions (survives renderer reloads). */
  getUsageCache(): Record<string, SessionUsage> {
    return this.usageTracker.getUsageCache();
  }

  /**
   * Upsert a partial SessionUsage entry for a session. Thin wrapper
   * around UsageTracker.setSessionUsage for external callers.
   */
  setSessionUsage(sessionId: string, partial: Partial<SessionUsage>): void {
    this.usageTracker.setSessionUsage(sessionId, partial);
  }

  /** Return cached activity state for all sessions (survives renderer reloads). */
  getActivityCache(): Record<string, ActivityState> {
    return this.usageTracker.getActivityCache();
  }

  /** Return cached events for a specific session (survives renderer reloads). */
  getEventsForSession(sessionId: string): SessionEvent[] {
    return this.usageTracker.getEventsForSession(sessionId);
  }

  /** Return the transcript writer instance (if enabled). */
  getTranscriptWriter(): TranscriptWriter | null {
    return this.transcriptWriter;
  }

  /** Return cached events for all sessions (survives renderer reloads). */
  getEventsCache(): Record<string, SessionEvent[]> {
    return this.usageTracker.getEventsCache();
  }

  /** Return cached usage data filtered to a specific project. */
  getUsageCacheForProject(projectId: string): Record<string, SessionUsage> {
    return filterCacheByProject(
      this.usageTracker.getUsageCache(),
      (sessionId) => this.registry.getSessionProjectId(sessionId),
      projectId,
    );
  }

  /** Return cached activity state filtered to a specific project. */
  getActivityCacheForProject(projectId: string): Record<string, ActivityState> {
    return filterCacheByProject(
      this.usageTracker.getActivityCache(),
      (sessionId) => this.registry.getSessionProjectId(sessionId),
      projectId,
    );
  }

  /** Return cached events filtered to a specific project. */
  getEventsCacheForProject(projectId: string): Record<string, SessionEvent[]> {
    return filterCacheByProject(
      this.usageTracker.getEventsCache(),
      (sessionId) => this.registry.getSessionProjectId(sessionId),
      projectId,
    );
  }

  /** Return the projectId for a given session, or undefined if not found. */
  getSessionProjectId(sessionId: string): string | undefined {
    return this.registry.getSessionProjectId(sessionId);
  }

  /** Return the taskId for a given session, or undefined if not found. */
  getSessionTaskId(sessionId: string): string | undefined {
    return this.registry.getSessionTaskId(sessionId);
  }

  /** Return the adapter name (e.g. "claude", "codex") for a given session,
   *  or undefined if not found or the spawn predates agentName tracking. */
  getSessionAgentName(sessionId: string): string | undefined {
    return this.registry.getSessionAgentName(sessionId);
  }

  /**
   * Register a suspended placeholder session for a task that was user-paused
   * before app restart. The placeholder has no PTY but makes the renderer
   * show "Paused" state and the "Resume session" button.
   *
   * Safe to call even if a session already exists for the task - doSpawn
   * handles existing sessions by taskId (cleans up and replaces).
   */
  registerSuspendedPlaceholder(input: { taskId: string; projectId: string; cwd: string }): Session {
    return this.registry.registerSuspendedPlaceholder(input);
  }

  /** Check whether a session (any status) already exists for a given task. */
  hasSessionForTask(taskId: string): boolean {
    return this.registry.hasSessionForTask(taskId);
  }

  /**
   * Gracefully suspend all running PTY sessions.
   *
   * Sends Ctrl+C then /exit to each Claude Code process so it saves its
   * conversation state (JSONL) before exiting. Waits up to `timeoutMs`
   * for processes to exit on their own, then force-kills any remaining.
   *
   * Returns task IDs so the caller can mark them as 'suspended' in the DB.
   */
  async suspendAll(timeoutMs = 2000): Promise<string[]> {
    return suspendAllSessions(this.shutdownContext(), timeoutMs);
  }

  /**
   * Synchronously kill every PTY and clean up. Runs from Electron's
   * `before-quit` handler. Must NOT become async - see
   * session-shutdown.killAllSessions and the "Shutdown (CRITICAL)"
   * section in CLAUDE.md.
   */
  killAll(): void {
    killAllSessions(this.shutdownContext());
  }

  private shutdownContext() {
    return {
      sessions: this.registry.raw(),
      sessionQueue: this.sessionQueue,
      sessionFiles: this.sessionFiles,
      firstOutputTracker: this.firstOutputTracker,
      killPty: safeKillPty,
    };
  }
}
