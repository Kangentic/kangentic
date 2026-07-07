import { EventEmitter } from 'node:events';
import { v4 as uuidv4 } from 'uuid';
import { resolveDebugDumpDir } from '../diagnostics/debug-dump-resolver';
import { ShellResolver } from './spawn/shell-resolver';
import { SessionQueue } from './session-queue';
import { PtyBufferManager } from './buffer/pty-buffer-manager';
import { SessionHistoryReader } from './readers/session-history-reader';
import { StatusFileReader } from './readers/status-file-reader';
import { SessionTelemetry } from '../activity-engine/session-telemetry';
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
import { SessionRegistry, toSession, filterCacheByProject, type ManagedSession } from './session-registry';
import { createWriteQueue, type WriteQueue } from './write-queue';
import { BackpressureController } from './buffer/backpressure-controller';
import { isShuttingDown } from '../shutdown-state';
import type { TranscriptRepository } from '../db/repositories/transcript-repository';
import type {
  Session,
  SessionUsage,
  ActivityState,
  ActivityReason,
  SessionEvent,
  SpawnSessionInput,
  PerToolStat,
} from '../../shared/types';
import type { ActivityEngineOptions, ActivityStatsSnapshot } from '../activity-engine/engine';

export interface SessionManagerOptions {
  /**
   * Override activity-engine timings. Production code does not pass
   * this; tests use it to shrink debounce/escape-hatch/watchdog
   * windows so assertions don't have to wall-clock-wait the production
   * defaults.
   */
  activityEngineOptions?: ActivityEngineOptions;
}

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
   * (user input, paste, terminal-submit keystrokes) so bracketed-paste sequences
   * cannot be fragmented by interleaved writes.
   */
  private writeQueues = new Map<string, WriteQueue>();
  /**
   * Terminal dimensions from a resize that arrived before the session's PTY
   * existed (the renderer mounted and fit its container before the auto-resume
   * spawn landed, or while the session was queued/suspended awaiting spawn).
   * performSpawn consumes this so the PTY spawns at the real fitted size
   * instead of the 120x30 default, so no post-spawn corrective resize (and its
   * stale-width repaint window) is needed. Keyed by session id, independent of
   * the registry so it survives the registry.delete during a respawn. Consumed
   * at spawn (takePendingResize) or dropped on kill.
   */
  private pendingResizes = new Map<string, { cols: number; rows: number }>();
  /**
   * Per-session output backpressure: pauses a session's PTY when the renderer
   * falls behind on its emitted bytes, resuming as the renderer acks. Only
   * tracks sessions actively emitting to the renderer (focused); reset on focus
   * change and per-session on teardown. See BackpressureController.
   */
  private backpressure = new BackpressureController(
    (sessionId) => this.registry.get(sessionId)?.pty ?? null,
  );
  private transcriptWriter: TranscriptWriter | null = null;

  // Sub-modules owned by SessionManager. Cross-wired in the constructor
  // below; `telemetry` and `sessionHistoryReader` form a cycle (the
  // telemetry's onAgentSessionId attaches the history reader; the reader
  // calls back into telemetry) which is resolved via definite-
  // assignment (`!`) so their callbacks can reference each other.
  private sessionQueue: SessionQueue;
  private bufferManager: PtyBufferManager;
  private telemetry!: SessionTelemetry;
  private sessionHistoryReader!: SessionHistoryReader;
  private statusFileReader: StatusFileReader;
  private sessionFiles: SessionFileManager;
  private sessionIdManager: SessionIdManager;
  private activityEngineOptions: ActivityEngineOptions | undefined;

  constructor(options: SessionManagerOptions = {}) {
    super();
    this.activityEngineOptions = options.activityEngineOptions;

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
          this.backpressure.recordEmitted(sessionId, data.length);
        }
      },
    });

    this.sessionIdManager = new SessionIdManager({
      hasAgentSessionId: (id) => this.telemetry.hasAgentSessionId(id),
      notifyAgentSessionId: (id, capturedId) => this.telemetry.notifyAgentSessionId(id, capturedId),
      sessionExists: (id) => this.registry.has(id),
    });

    this.telemetry = new SessionTelemetry({
      onUsageChange: (sessionId, usage) => this.emit('usage', sessionId, usage),
      onActivityChange: (sessionId, activity, reason) => this.emit('activity', sessionId, activity, reason),
      onEvent: (sessionId, event) => this.emit('event', sessionId, event),
      onIdleTimeout: (sessionId) => {
        const session = this.registry.get(sessionId);
        if (session) this.emit('idle-timeout', sessionId, session.taskId, this.telemetry.idleTimeoutMinutes);
      },
      onPlanExit: (sessionId) => this.emit('plan-exit', sessionId),
      onPRCandidate: (sessionId) => {
        // A `gh pr ...` Bash command finished - this is just the hint that NOW is
        // a good time to resolve. The authoritative branch->PR query happens in
        // the IPC listener; forward the raw scrollback so it can degrade to
        // scraping if gh is unavailable.
        const scrollback = this.bufferManager.getRawScrollback(sessionId);
        this.emit('pr-candidate', sessionId, scrollback);
      },
      onAgentSessionId: (sessionId, agentReportedId) => {
        // Agent session ID capture covers two cases:
        // 1. Fresh capture: agent_session_id was null (Codex/Gemini), now captured from hooks/PTY output.
        // 2. Stale recovery: agent_session_id was pre-specified (Claude --resume) but the agent
        //    created a different session (--resume failed silently). DB needs the correct ID.
        // recoverStaleSessionId() handles both cases - emit unconditionally.
        const session = this.registry.get(sessionId);
        if (!session) return;
        // Reflect the captured ID on the live Session so the renderer (and
        // tests) can observe it via sessions.list() without a DB round-trip.
        if (session.agentSessionId !== agentReportedId) {
          session.agentSessionId = agentReportedId;
          this.emit('session-changed', sessionId, toSession(session));
        }
        this.emit('agent-session-id', sessionId, session.taskId, session.projectId, agentReportedId);
        // Hand off to the session-history reader if the adapter declares
        // a native history hook. Fire-and-forget - the reader logs any
        // failures and degrades gracefully to PtyActivityTracker.
        //
        // For Claude the transcript reader is a background-session FALLBACK,
        // and processStatusUpdate's one-shot id capture routes back here. The
        // guard skips a re-attach once status.json has been handed off. Note:
        // on the normal Claude path this callback fires synchronously nested
        // inside the FIRST onUsageParsed - before StatusFileReader sets
        // firstStatusDelivered - so hasReceivedStatus is still false here and
        // the guard does not fire. The no-race guarantee on that path instead
        // comes from SessionHistoryReader.attach being idempotent (the eager
        // spawn-time attach already holds the slot) plus the detach in
        // onFirstStatus (fired right after onUsageParsed) cancelling any
        // in-flight re-attach. The guard covers any path where an id capture
        // could arrive after that handoff.
        const historyHook = session.agentParser?.runtime?.sessionHistory;
        if (historyHook && !this.statusFileReader.hasReceivedStatus(sessionId)) {
          // No startAtEnd here: this attach only ever runs when the agent id was
          // NOT known at spawn time - either a fresh Codex/Gemini capture (a
          // brand-new transcript whose early entries we want) or a
          // stale-session-id recovery (also a fresh file, under the newly
          // captured id). Reading from the start is correct in both. The
          // resumed-existing-file EOF case never reaches here: it is held by the
          // idempotent spawn-time attach (which passes startAtEnd), so this path
          // never re-parses pre-resume content.
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
      getSessionRootPid: (sessionId) => {
        const session = this.registry.get(sessionId);
        return session?.pty?.pid;
      },
      resolveBackgroundShellOutputFile: (sessionId, shellId) => {
        const session = this.registry.get(sessionId);
        if (!session) return null;
        return session.agentParser?.runtime?.backgroundShells
          ?.resolveOutputFile({ cwd: session.cwd, shellId }) ?? null;
      },
    }, {
      activityEngineOptions: this.activityEngineOptions,
      // Activity-engine debug snapshots land at `<projectRoot>/.kangentic/debug/<sessionId>.json`
      // when `developer.activityDebugOverlay` is on (toggled in Settings →
      // Developer). When that toggle is off, falls back to the existing
      // env-based path used by production installs. Returns `undefined` when
      // neither applies, disabling the dump entirely. The resolver is
      // configured by `installDiagnostics()` at process startup.
      //
      // Pass the function (not its current return value) so SessionTelemetry
      // re-resolves on every snapshot write - this lets toggle changes flip
      // the dump on/off live without restarting the session.
      debugDumpDir: resolveDebugDumpDir,
    });

    this.sessionHistoryReader = new SessionHistoryReader({
      onUsageUpdate: (sessionId, usage) => this.telemetry.setSessionUsage(sessionId, usage),
      onEvents: (sessionId, events) => this.telemetry.ingestEvents(sessionId, events),
      onActivity: (sessionId, activity) => this.telemetry.forceActivity(sessionId, activity),
      onFirstTelemetry: (sessionId) => {
        // Only suppress PTY detection when the adapter uses hooks_and_pty
        // (meaning hook-based events can drive activity transitions). For
        // pure PTY adapters (Codex, Aider), session history provides usage
        // data (model, tokens) but NOT real-time activity signals, so the
        // silence timer must remain active.
        const session = this.registry.get(sessionId);
        const activityKind = session?.agentParser?.runtime?.activity?.kind;
        if (activityKind === 'hooks_and_pty') {
          this.telemetry.suppressPty(sessionId);
        }
      },
    });

    this.statusFileReader = new StatusFileReader({
      onUsageParsed: (sessionId, usage) => this.telemetry.processStatusUpdate(sessionId, usage),
      onEventsParsed: (sessionId, rawLines, events) => {
        this.telemetry.captureHookSessionIds(sessionId, rawLines);
        this.telemetry.ingestEvents(sessionId, events);
      },
      onFirstStatus: (sessionId) => {
        // status.json just started flowing - it is authoritative (full usage
        // replace incl. Claude's own used_percentage, cost, rate limits). Stop
        // the transcript-based fallback reader (Claude's runtime.sessionHistory)
        // so its partial-merge can never overwrite fresher status data; detach
        // also cancels any in-flight re-attach. No-op for adapters (Codex,
        // Gemini) that never emit a parseable status, so onFirstStatus never
        // fires for them.
        this.sessionHistoryReader.detach(sessionId);
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
      // The PTY is gone; drop any backpressure accounting (resume is moot).
      this.backpressure.release(sessionId);
    });
  }

  setMaxConcurrent(max: number): void {
    this.sessionQueue.setMaxConcurrent(max);
  }

  setIdleTimeout(minutes: number): void {
    this.telemetry.setIdleTimeout(minutes);
  }

  /**
   * Hydrate known context windows from persisted metrics
   * (config `discoveredContextWindowsByAgent`), relayed from
   * `applyRuntimeConfig`. See `SessionTelemetry.hydrateKnownWindows`.
   */
  hydrateDiscoveredContextWindows(entries: Array<{ modelId: string; contextWindowSize: number }>): void {
    this.telemetry.hydrateKnownWindows(entries);
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
    this.telemetry.dispose();
    this.transcriptWriter?.finalizeAll();
  }

  /** Set which sessions are currently visible (terminal panel + command bar overlay). */
  setFocusedSessions(sessionIds: string[]): void {
    this.focusedSessionIds = new Set(sessionIds);
    // The emit set just changed, so prior in-flight accounting is stale (a
    // session leaving the focused set would otherwise stay paused forever
    // because the renderer no longer acks its data). Resume every paused PTY
    // and clear the counters; backpressure rebuilds from zero as fresh data
    // flows to the now-focused terminals (the scrollback replay catches them
    // up). Focus changes are user-driven and infrequent, so a blanket reset is
    // cheap and robust.
    this.backpressure.reset();
  }

  /**
   * The renderer reports that it has consumed `bytes` of this session's output
   * (written to xterm or deliberately dropped during scrollback replay), which
   * drops the in-flight count and resumes a paused PTY once it has caught up.
   * Acking dropped bytes too is essential: otherwise a session whose data is
   * dropped (overlay / scrollback reload) would never resume.
   */
  acknowledgeDrain(sessionId: string, bytes: number): void {
    this.backpressure.acknowledge(sessionId, bytes);
  }

  /**
   * User pressed Ctrl+C in the terminal. Forwarded to telemetry's
   * `UserInterruptCoordinator`, which arms a settle timer; if the
   * agent's own hooks don't recover the engine state within the
   * window, telemetry synthesizes an Interrupted event. The renderer
   * has already sent \x03 to the PTY via the normal `write` path -
   * this is purely a parallel signal for engine recovery.
   *
   * Named `signalUserInterrupt` (not `notifyUserInterrupt`) to convey
   * "fire-and-forget signal to a downstream coordinator" rather than
   * "telemetry call". The IPC handler invokes this; the actual
   * coordinator method is `UserInterruptCoordinator.notify`.
   */
  signalUserInterrupt(sessionId: string): void {
    this.telemetry.notifyUserInterrupt(sessionId);
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
        isolatedSwimlaneId: input.isolatedSwimlaneId,
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
      telemetry: this.telemetry,
      sessionIdManager: this.sessionIdManager,
      sessionFiles: this.sessionFiles,
      resizeManager: this.resizeManager,
      statusFileReader: this.statusFileReader,
      sessionHistoryReader: this.sessionHistoryReader,
      sessionQueue: this.sessionQueue,
      getTranscriptWriter: () => this.transcriptWriter,
      getShell: () => this.getShell(),
      takePendingResize: (sessionId) => {
        const dims = this.pendingResizes.get(sessionId);
        this.pendingResizes.delete(sessionId);
        return dims;
      },
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

  /**
   * Resolve once the session's write queue has flushed all enqueued bytes
   * to the PTY. Used by callers that need to sequence follow-up keystrokes
   * after a large paste (e.g. the embedded browser pane sends payload ->
   * await drain -> Escape -> Enter so the submit keystrokes don't race the
   * chunked drain loop and split the paste mid-stream).
   * Resolves immediately if there is no active queue or it is already idle.
   */
  drain(sessionId: string): Promise<void> {
    const queue = this.writeQueues.get(sessionId);
    if (!queue) return Promise.resolve();
    return queue.drained();
  }

  /**
   * Write `data` to the session's PTY in a single, un-chunked `pty.write`
   * call. This BYPASSES the per-session FIFO write queue and the 4KB
   * chunking that the queue enforces.
   *
   * Use this only when atomicity matters more than backpressure-friendly
   * chunking, e.g. for the bracketed-paste-and-submit packet
   * (`\e[200~ ... \e[201~\r`) where chunking can split the close marker
   * and the trailing Enter across separate kernel reads, causing the TUI
   * to see them as racing events. Empirically reproduced via
   * `scripts/paste-harness.js` `split-cr`: 4/5 success vs `combined-cr`
   * 10/10 success.
   *
   * Caller responsibility: await `drain(sessionId)` first if the queue
   * may have pending bytes; otherwise `writeRaw` can interleave with
   * still-draining chunks.
   */
  writeRaw(sessionId: string, data: string): void {
    const session = this.registry.get(sessionId);
    if (!session?.pty || data.length === 0) return;
    session.pty.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): { colsChanged: boolean } {
    const session = this.registry.get(sessionId);

    // Guard against NaN/Infinity from layout edge cases (e.g. getComputedStyle
    // returning "" during unmount, yielding parseInt -> NaN)
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return { colsChanged: false };

    // Clamp to valid dimensions (node-pty throws on 0 or negative)
    const clampedCols = Math.max(2, Math.floor(cols));
    const clampedRows = Math.max(1, Math.floor(rows));

    if (!session?.pty) {
      // The PTY does not exist yet. A resize can beat the auto-resume spawn (the
      // renderer mounts and fits before the main-process spawn lands), or arrive
      // while a session is queued/suspended awaiting (re)spawn. Stash the dims so
      // performSpawn spawns the PTY at the real size instead of the default,
      // closing the stale-width race at the source. Never stash for an
      // exited/killed session - it is not coming back, and xterm never re-sends
      // unchanged dims, so a resurrected 120x30 would stick forever.
      if (session && (session.status === 'queued' || session.status === 'suspended')) {
        this.pendingResizes.set(sessionId, { cols: clampedCols, rows: clampedRows });
      }
      return { colsChanged: false };
    }

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
    this.telemetry.removeSession(sessionId);
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
    // Every kill() is a deliberate Kangentic-initiated teardown (user kill,
    // session reset, task delete, worktree cleanup, move-to-To-Do/Backlog,
    // project relocate, shutdown), never a crash. Mark the session BEFORE the
    // force-kill so the async onExit handler (session-spawn-flow.ts) and the
    // queued-session direct emit below tag the 'exit' event intentional, so the
    // renderer suppresses the false "Session crashed" notification. A genuine
    // crash never calls kill() - the PTY's onExit fires on its own with
    // intentionalExit unset. Unlike suspend(), kill() does not set
    // status='suspended' (a hard reset is 'exited', not resumable), so this
    // orthogonal marker carries the intent.
    if (session) session.intentionalExit = true;
    // Drop any queued pre-spawn resize: a killed session will not respawn to
    // consume it, and a stale entry keyed by this id must not survive.
    this.pendingResizes.delete(sessionId);
    // Release backpressure BEFORE nulling the PTY so a paused session is
    // resumed (lets any buffered output flush) and its accounting entry is
    // dropped immediately, rather than waiting for the async onExit handler.
    // release() is idempotent, so the later 'exit'-driven release is a no-op.
    this.backpressure.release(sessionId);
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
      // Queued sessions never spawn a PTY, so onExit (which reads
      // intentionalExit) never runs; forward the flag on this direct emit.
      this.emit('exit', sessionId, -1, true);
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
    this.telemetry.emitSessionEnd(sessionId);

    // Clear subagent depth - session is no longer active
    this.telemetry.clearSessionTracking(sessionId);

    // Mark suspended BEFORE killing so the async onExit handler preserves it
    session.status = 'suspended';

    // Resume a backpressure-paused PTY so the agent's exit-sequence output is
    // not held back during the graceful shutdown window.
    this.backpressure.release(sessionId);

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

  async getScrollback(sessionId: string): Promise<string> {
    // If a width-changing resize just fired, wait for the agent TUI's async
    // repaint to land before sampling, so the replay shows the frame at the
    // fitted width rather than the stale pre-resize one. No-op for sessions
    // with no pending width change (see PtyBufferManager.waitForResizeRepaint).
    await this.bufferManager.waitForResizeRepaint(sessionId);
    return this.bufferManager.getScrollback(sessionId);
  }

  /**
   * Dev diagnostics: per-session terminal output-pipeline stats - the pending
   * (un-flushed) buffer and scrollback sizes, backpressure state (paused +
   * in-flight bytes), and whether the session is currently emitting to the
   * renderer (focused). Surfaced by the inspection server's terminal-pipeline
   * route to diagnose terminal-driven lag: a paused session with high in-flight
   * bytes, or a ballooning pending buffer, points straight at a flooding agent.
   */
  getPipelineStats(): Array<{
    sessionId: string;
    taskId: string;
    status: string;
    focused: boolean;
    pendingBytes: number;
    scrollbackBytes: number;
    paused: boolean;
    inFlightBytes: number;
  }> {
    const allFocused = this.focusedSessionIds.size === 0;
    const stats: Array<{
      sessionId: string;
      taskId: string;
      status: string;
      focused: boolean;
      pendingBytes: number;
      scrollbackBytes: number;
      paused: boolean;
      inFlightBytes: number;
    }> = [];
    for (const session of this.registry.values()) {
      const buffer = this.bufferManager.getBufferStats(session.id);
      stats.push({
        sessionId: session.id,
        taskId: session.taskId,
        status: session.status,
        focused: allFocused || this.focusedSessionIds.has(session.id),
        pendingBytes: buffer?.pendingBytes ?? 0,
        scrollbackBytes: buffer?.scrollbackBytes ?? 0,
        paused: this.backpressure.isPaused(session.id),
        inFlightBytes: this.backpressure.getInFlight(session.id),
      });
    }
    return stats;
  }

  getSession(sessionId: string): Session | undefined {
    return this.registry.getSession(sessionId);
  }

  listSessions(): Session[] {
    return this.registry.listSessions();
  }

  /** Return cached usage data for all sessions (survives renderer reloads). */
  getUsageCache(): Record<string, SessionUsage> {
    return this.telemetry.getUsageCache();
  }

  /**
   * Upsert a partial SessionUsage entry for a session. Thin wrapper
   * around SessionTelemetry.setSessionUsage for external callers.
   */
  setSessionUsage(sessionId: string, partial: Partial<SessionUsage>): void {
    this.telemetry.setSessionUsage(sessionId, partial);
  }

  /** Return cached activity state for all sessions (survives renderer reloads). */
  getActivityCache(): Record<string, ActivityState> {
    return this.telemetry.getActivityCache();
  }

  /** Return the latest ActivityReason for a session, or null if unknown. */
  getActivityReason(sessionId: string): ActivityReason | null {
    return this.telemetry.getActivityReason(sessionId);
  }

  /** Return cached ActivityReason for all sessions (HMR/full-reload reconcile). */
  getActivityReasonsCache(): Record<string, ActivityReason> {
    return this.telemetry.getActivityReasonsCache();
  }

  /**
   * Rich activity stats snapshot for the debug overlay (Developer tab).
   * Returns null for unknown sessions.
   */
  getActivityStatsSnapshot(sessionId: string): ActivityStatsSnapshot | null {
    return this.telemetry.getActivityStatsSnapshot(sessionId);
  }

  /** Return cached events for a specific session (survives renderer reloads). */
  getEventsForSession(sessionId: string): SessionEvent[] {
    return this.telemetry.getEventsForSession(sessionId);
  }

  /**
   * Cumulative ToolEnd count for a session. Tracked independently of the
   * bounded event cache so captureSessionMetrics can write a faithful
   * tool_call_count even after the cache has rolled past 500 events.
   */
  getToolCallCount(sessionId: string): number {
    return this.telemetry.getToolCallCount(sessionId);
  }

  /**
   * Per-tool aggregate snapshot for a session. Used by captureSessionMetrics
   * to persist a JSON breakdown so the Session Summary panel can render a
   * "By tool" section for archived tasks.
   */
  getToolBreakdown(sessionId: string): PerToolStat[] {
    return this.telemetry.getToolBreakdown(sessionId);
  }

  /**
   * Context-compaction count for a session's current run (Claude PreCompact
   * hook). Per-run; captureSessionMetrics persists it so the per-task lifetime
   * rollup can SUM it across the task's session records.
   */
  getCompactionCount(sessionId: string): number {
    return this.telemetry.getCompactionCount(sessionId);
  }

  /** Return the transcript writer instance (if enabled). */
  getTranscriptWriter(): TranscriptWriter | null {
    return this.transcriptWriter;
  }

  /** Return cached events for all sessions (survives renderer reloads). */
  getEventsCache(): Record<string, SessionEvent[]> {
    return this.telemetry.getEventsCache();
  }

  /**
   * Map of sessionId -> true for every session that has emitted first output.
   * Unscoped (the set is tiny). Lets the renderer rebuild `sessionFirstOutput`
   * after an HMR reload so a running session that already produced output is
   * not flashed back to its "Starting agent..." boot state.
   */
  getFirstOutputCache(): Record<string, boolean> {
    const result: Record<string, boolean> = {};
    for (const sessionId of this.firstOutputTracker.snapshot()) {
      result[sessionId] = true;
    }
    return result;
  }

  /** Return cached usage data filtered to a specific project. */
  getUsageCacheForProject(projectId: string): Record<string, SessionUsage> {
    return filterCacheByProject(
      this.telemetry.getUsageCache(),
      (sessionId) => this.registry.getSessionProjectId(sessionId),
      projectId,
    );
  }

  /** Return cached activity state filtered to a specific project. */
  getActivityCacheForProject(projectId: string): Record<string, ActivityState> {
    return filterCacheByProject(
      this.telemetry.getActivityCache(),
      (sessionId) => this.registry.getSessionProjectId(sessionId),
      projectId,
    );
  }

  /** Return cached ActivityReason filtered to a specific project. */
  getActivityReasonsCacheForProject(projectId: string): Record<string, ActivityReason> {
    return filterCacheByProject(
      this.telemetry.getActivityReasonsCache(),
      (sessionId) => this.registry.getSessionProjectId(sessionId),
      projectId,
    );
  }

  /** Return cached events filtered to a specific project. */
  getEventsCacheForProject(projectId: string): Record<string, SessionEvent[]> {
    return filterCacheByProject(
      this.telemetry.getEventsCache(),
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
   *
   * Emits `session-changed` so the renderer's onStatus listener evicts any
   * stale prior session entry for the same taskId immediately. Without this
   * push the renderer would only learn about the placeholder via the next
   * syncSessions(), leaving a window where stale sessions[] entries from
   * before a project switch can mask the real placeholder state.
   */
  registerSuspendedPlaceholder(input: { taskId: string; projectId: string; cwd: string }): Session {
    const session = this.registry.registerSuspendedPlaceholder(input);
    this.emit('session-changed', session.id, session);
    return session;
  }

  /** Check whether a session (any status) already exists for a given task. */
  hasSessionForTask(taskId: string): boolean {
    return this.registry.hasSessionForTask(taskId);
  }

  /**
   * Find the first live (running/queued) Session for a task. Used by
   * reconcileTaskSessionRef to heal `task.session_id` drift when the
   * registry still holds a live PTY for the task but the DB pointer was
   * cleared (or points at a now-suspended id).
   */
  findLiveSessionByTaskId(taskId: string): Session | undefined {
    return this.registry.findLiveSessionByTaskId(taskId);
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
   * session-shutdown.killAllSessions and
   * .claude/rules/synchronous-shutdown.md.
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
