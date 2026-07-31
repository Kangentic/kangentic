import { EventEmitter } from 'node:events';
import { v4 as uuidv4 } from 'uuid';

/**
 * Renderer key used when a caller does not identify itself (headless callers, and
 * tests that drive `setFocusedSessions` directly). Real renderers key on their
 * webContents id, which is never negative.
 */
export const SHARED_RENDERER_ID = -1;
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
import { DEFAULT_PTY_COLS, DEFAULT_PTY_ROWS, performSpawn } from './lifecycle/session-spawn-flow';
import { SessionRegistry, toSession, filterCacheByProject, type ManagedSession, type ManagedSessionSummary } from './session-registry';
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
   * flooding when many sessions run concurrently.
   *
   * Default-closed: an empty set means NO session's data is forwarded. The
   * renderer pushes the real set from AppLayout's first render
   * (useFocusedSessionsSync) and sends a legitimately empty set when no
   * terminal is visible (Backlog view, hidden panel); an unfocused session
   * catches up via getScrollback() on focus. Any headless caller listening on
   * the manager's 'data' event must call setFocusedSessions first - the
   * unfiltered 'data-tap' event is the focus-independent seam.
   */
  private focusedSessionIds = new Set<string>();
  /**
   * Per-renderer visible sets, unioned into `focusedSessionIds` above. The union
   * is what gates emitting at all; the individual sets are the ROUTING TABLE for
   * which renderer each session's bytes belong to (a session is hosted by exactly
   * one renderer, because the task-detail owner registry says so).
   */
  private focusedByRenderer = new Map<number, Set<string>>();
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
   * stale-geometry repaint window) is needed. Keyed by session id, independent of
   * the registry so it survives the registry.delete during a respawn. Consumed
   * at spawn (takePendingResize) or dropped on kill.
   */
  private pendingResizes = new Map<string, { cols: number; rows: number }>();
  /**
   * The last grid a DESKTOP-origin resize set per session - the restore
   * target when a paired phone that resized the PTY (fit-to-phone mode)
   * releases it. Written on every desktop-origin resize (live or pre-spawn
   * stash); lazily seeded with the current PTY grid the first time a
   * mobile-origin resize arrives for a session the desktop never resized,
   * so the restore always lands on what the desktop last had, never on a
   * phone-shaped grid. Cleared on kill/remove with pendingResizes.
   */
  private lastDesktopDimensions = new Map<string, { cols: number; rows: number }>();
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
    // The mobile bridge's read-stream feed attaches per-subscription listeners
    // (data-tap/activity/usage/event) for every session a paired phone streams,
    // on top of the app's own baseline listeners. That legitimately crosses
    // Node's default max of 10 per event, so raise the cap to keep a normal
    // multi-session fan-out from tripping a spurious MaxListenersExceededWarning
    // (a genuine leak still shows as an unbounded climb well past this).
    this.setMaxListeners(100);
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
        // Unfiltered output tap: fires for EVERY session regardless of
        // renderer focus, unlike 'data' below. This is the mobile bridge's
        // seam onto live PTY output (see src/main/mobile-bridge/handlers)
        // - it deliberately does NOT feed backpressure.recordEmitted,
        // since that accounting exists only for the renderer's focused-tab
        // drain protocol, which a bridge subscriber does not participate
        // in. With no listener attached this emit is a no-op call, so it
        // costs nothing when no device is paired.
        this.emit('data-tap', sessionId, data);

        // Only emit IPC data for focused sessions. Background sessions
        // accumulate in scrollback and reload via getScrollback() on tab
        // switch. Default-closed (see focusedSessionIds): an empty set
        // forwards nothing, so sessions spawned before the renderer's first
        // SESSION_SET_FOCUSED never fan out over IPC.
        if (this.focusedSessionIds.has(sessionId)) {
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
      reportTerminatedBackgroundShells: (sessionId, shellIds) => {
        const session = this.registry.get(sessionId);
        if (!session?.agentSessionId) return [];
        return session.agentParser?.runtime?.backgroundShells
          ?.reportTerminatedShells?.({ cwd: session.cwd, agentSessionId: session.agentSessionId, shellIds }) ?? [];
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

  /**
   * Set which sessions a RENDERER currently has visible (terminal panel, command
   * bar overlay, task-detail windows).
   *
   * Keyed by renderer, not global, because more than one renderer can host a
   * terminal: the detached Agent Monitor is its own window with its own visible
   * set. A single shared set meant last-writer-wins, so two renderers publishing
   * focus would silently starve each other's terminals of PTY data.
   *
   * The emit gate stays the UNION (`isSessionFocused`), so nothing about when
   * data is produced changes; what the per-renderer split buys is knowing WHERE
   * to send it.
   */
  setFocusedSessions(sessionIds: string[], rendererId = SHARED_RENDERER_ID): void {
    const previousForRenderer = this.focusedByRenderer.get(rendererId);
    if (sessionIds.length === 0) this.focusedByRenderer.delete(rendererId);
    else this.focusedByRenderer.set(rendererId, new Set(sessionIds));
    this.recomputeFocusedUnion();
    // Prior in-flight accounting is stale for the sessions THIS renderer just
    // changed: one leaving its visible set would otherwise stay paused forever,
    // because that renderer no longer acks its data. Resume those and clear
    // their counters; backpressure rebuilds from zero as fresh data flows to the
    // now-focused terminals (the scrollback replay catches them up).
    //
    // Scoped to the caller's own sessions on purpose. This used to be a blanket
    // `backpressure.reset()`, which was safe only while a single renderer
    // published focus. The detached Agent Monitor is a second publisher, and its
    // effect re-runs on any session-list change, so a blanket reset would
    // force-resume a PTY the OTHER window is still actively throttling and zero
    // its unacked byte count, defeating backpressure for a session this renderer
    // has no relationship to.
    const affectedSessionIds = new Set(previousForRenderer);
    for (const sessionId of sessionIds) affectedSessionIds.add(sessionId);
    for (const sessionId of affectedSessionIds) this.backpressure.release(sessionId);
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

  /** Return the union of every renderer's focused session IDs. */
  getFocusedSessions(): Set<string> {
    return this.focusedSessionIds;
  }

  /**
   * The renderers that currently have this session visible. The IPC layer sends
   * that session's data to exactly these, instead of blanket-sending to the main
   * window - which is both correct for a detached host and strictly less IPC
   * than before for everyone else.
   */
  getRenderersFocusedOn(sessionId: string): number[] {
    const renderers: number[] = [];
    for (const [rendererId, sessionIds] of this.focusedByRenderer) {
      if (sessionIds.has(sessionId)) renderers.push(rendererId);
    }
    return renderers;
  }

  /** Drop a renderer's focus set when its window goes away. */
  clearFocusedSessionsFor(rendererId: number): void {
    const departingSessionIds = this.focusedByRenderer.get(rendererId);
    if (!this.focusedByRenderer.delete(rendererId)) return;
    this.recomputeFocusedUnion();
    // Rescue only the sessions this renderer was the LAST consumer of. Their
    // in-flight bytes can never be acked (the window that was reading them is
    // gone), so without this a session that crossed the high-water mark just as
    // its sole renderer died would stay paused forever and the agent would
    // stall. A session another renderer still has visible keeps its accounting,
    // which the blanket reset this replaces would have wrongly zeroed.
    for (const sessionId of departingSessionIds ?? []) {
      if (!this.focusedSessionIds.has(sessionId)) this.backpressure.release(sessionId);
    }
  }

  private recomputeFocusedUnion(): void {
    const union = new Set<string>();
    for (const sessionIds of this.focusedByRenderer.values()) {
      for (const sessionId of sessionIds) union.add(sessionId);
    }
    this.focusedSessionIds = union;
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

  /**
   * True when the session has a live PTY that `write()` will actually deliver
   * to (as opposed to a suspended/queued/exited session still in the registry
   * with a null pty, whose writes `write()` silently drops). Lets a caller
   * distinguish "delivered" from "dropped" instead of assuming existence means
   * writability.
   */
  isWritable(sessionId: string): boolean {
    return !!this.registry.get(sessionId)?.pty;
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

  resize(
    sessionId: string,
    cols: number,
    rows: number,
    origin: 'desktop' | 'mobile' = 'desktop',
  ): { colsChanged: boolean } {
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
      // closing the stale-geometry race at the source. Never stash for an
      // exited/killed session - it is not coming back, and xterm never re-sends
      // unchanged dims, so a resurrected 120x30 would stick forever.
      if (session && (session.status === 'queued' || session.status === 'suspended')) {
        this.pendingResizes.set(sessionId, { cols: clampedCols, rows: clampedRows });
        if (origin === 'desktop') {
          this.lastDesktopDimensions.set(sessionId, { cols: clampedCols, rows: clampedRows });
        }
      }
      return { colsChanged: false };
    }

    if (origin === 'desktop') {
      this.lastDesktopDimensions.set(sessionId, { cols: clampedCols, rows: clampedRows });
    } else if (!this.lastDesktopDimensions.has(sessionId)) {
      // First mobile-origin resize for a session the desktop never resized:
      // snapshot the current grid as the restore target before changing it.
      this.lastDesktopDimensions.set(sessionId, { cols: session.pty.cols, rows: session.pty.rows });
    }

    const colsChanged = this.bufferManager.onResize(sessionId, clampedCols, clampedRows);
    session.pty.resize(clampedCols, clampedRows);
    // Mark resize time so the dispatch can suppress idle->thinking
    // transitions during the redraw burst that follows.
    this.resizeManager.notifyResize(sessionId);
    // The mobile bridge's seam onto grid changes, mirroring 'data-tap':
    // read-stream forwards this to subscribed phones as a terminal-resize
    // event so their renderer matches the grid before the repaint bytes land.
    this.emit('pty-resize', sessionId, clampedCols, clampedRows);
    return { colsChanged };
  }

  /**
   * The grid the session's terminal bytes are currently laid out for: the
   * live PTY's dimensions, or for a queued/suspended session the stashed
   * pre-spawn resize, falling back to the spawn defaults. Null only when
   * the session does not exist.
   */
  getDimensions(sessionId: string): { cols: number; rows: number } | null {
    const session = this.registry.get(sessionId);
    if (!session) return null;
    if (session.pty) return { cols: session.pty.cols, rows: session.pty.rows };
    const pending = this.pendingResizes.get(sessionId);
    if (pending) return { ...pending };
    return { cols: DEFAULT_PTY_COLS, rows: DEFAULT_PTY_ROWS };
  }

  /**
   * The restore target for a phone-held grid: the last desktop-origin
   * dimensions (see lastDesktopDimensions). Null when nothing was recorded,
   * i.e. no resize of either origin has touched the session.
   */
  getLastDesktopDimensions(sessionId: string): { cols: number; rows: number } | null {
    const dims = this.lastDesktopDimensions.get(sessionId);
    return dims ? { ...dims } : null;
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
    // consume it, and a stale entry keyed by this id must not survive. The
    // desktop-dims restore target dies with the session for the same reason.
    this.pendingResizes.delete(sessionId);
    this.lastDesktopDimensions.delete(sessionId);
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
    // If a geometry-changing resize just fired, wait for the agent TUI's async
    // repaint to land before sampling, so the replay shows the frame at the
    // fitted geometry rather than the stale pre-resize one. No-op for sessions
    // with no pending geometry change (see PtyBufferManager.waitForResizeRepaint).
    // Skipped entirely when the session has no live PTY (suspended/killed, or
    // queued pre-spawn): no process means no SIGWINCH repaint can ever arrive,
    // so a wait armed just before teardown would only burn its deadline against
    // a repaint that cannot come.
    if (this.registry.get(sessionId)?.pty) {
      await this.bufferManager.waitForResizeRepaint(sessionId);
    }
    return this.bufferManager.getScrollback(sessionId);
  }

  /**
   * The MOBILE seed frame: a snapshot of the PARSED grid from the per-session
   * headless xterm, serialized as a self-contained escape-sequence frame the
   * phone cold-replays into a fresh terminal. Unlike getScrollback's raw 512KB
   * byte replay, this never drops a fullscreen TUI's write-once static cells
   * whose drawing bytes have aged out of the byte window.
   *
   * Preserves the same repaint settle as getScrollback (awaits
   * waitForResizeRepaint, and like getScrollback skips it when no live PTY can
   * deliver a repaint) so the grid is never serialized mid-repaint at a stale
   * geometry. Desktop consumers keep using getScrollback unchanged.
   */
  async getSerializedFrame(sessionId: string): Promise<string> {
    if (this.registry.get(sessionId)?.pty) {
      await this.bufferManager.waitForResizeRepaint(sessionId);
    }
    return this.bufferManager.getSerializedFrame(sessionId);
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
        focused: this.focusedSessionIds.has(session.id),
        pendingBytes: buffer?.pendingBytes ?? 0,
        scrollbackBytes: buffer?.scrollbackBytes ?? 0,
        paused: this.backpressure.isPaused(session.id),
        inFlightBytes: this.backpressure.getInFlight(session.id),
      });
    }
    return stats;
  }

  /**
   * Dev diagnostics: every dimension MAIN knows for each session's terminal.
   *
   * The renderer can only see its own xterm's grid, so a PTY whose geometry has
   * drifted from the grid showing it is invisible from there - and that
   * divergence is exactly the failure where a terminal opens with its content
   * wrapped or clipped and no refit ever corrects it (xterm only re-sends
   * dimensions when ITS OWN size changes, so a mismatch has no path back).
   *
   * `ptyCols`/`ptyRows` is the live node-pty grid. `lastCols`/`lastRows` is the
   * geometry the bytes now in the scrollback were drawn at.
   * `lastDesktopDimensions` is the size the desktop last asked for, and
   * `pendingResize` a size stashed for a session with no PTY yet. Comparing
   * them against the renderer's grid (see the `dims` section of the
   * terminal-state route) localizes a drift to a specific layer instead of
   * leaving it to be inferred from pixels.
   */
  getTerminalDimensions(): Array<{
    sessionId: string;
    taskId: string;
    status: string;
    ptyCols: number | null;
    ptyRows: number | null;
    lastCols: number | null;
    lastRows: number | null;
    lastDesktopCols: number | null;
    lastDesktopRows: number | null;
    pendingResizeCols: number | null;
    pendingResizeRows: number | null;
    pendingRepaintAt: number | null;
    pendingRepaintStacked: boolean;
    inAltScreen: boolean;
  }> {
    const rows = [];
    for (const session of this.registry.values()) {
      const buffer = this.bufferManager.getDimensionState(session.id);
      const desktop = this.lastDesktopDimensions.get(session.id) ?? null;
      const pending = this.pendingResizes.get(session.id) ?? null;
      rows.push({
        sessionId: session.id,
        taskId: session.taskId,
        status: session.status,
        ptyCols: session.pty?.cols ?? null,
        ptyRows: session.pty?.rows ?? null,
        lastCols: buffer?.lastCols ?? null,
        lastRows: buffer?.lastRows ?? null,
        lastDesktopCols: desktop?.cols ?? null,
        lastDesktopRows: desktop?.rows ?? null,
        pendingResizeCols: pending?.cols ?? null,
        pendingResizeRows: pending?.rows ?? null,
        pendingRepaintAt: buffer?.pendingRepaintAt ?? null,
        pendingRepaintStacked: buffer?.pendingRepaintStacked ?? false,
        inAltScreen: buffer?.inAltScreen ?? false,
      });
    }
    return rows;
  }

  getSession(sessionId: string): Session | undefined {
    return this.registry.getSession(sessionId);
  }

  listSessions(): Session[] {
    return this.registry.listSessions();
  }

  /** Registry rows carrying `agentName`, for the cross-project Agent Monitor.
   *  See SessionRegistry.listManagedSummaries for why this is separate from listSessions. */
  listManagedSummaries(): ManagedSessionSummary[] {
    return this.registry.listManagedSummaries();
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
