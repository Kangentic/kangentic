import * as pty from 'node-pty';
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
import { attachAdapter, disposeAdapterAttachment, removeAdapterHooks } from './lifecycle/adapter-lifecycle';
import {
  resolveShellArgs,
  buildSpawnEnv,
  resolveSpawnCwd,
  diagnoseSpawnFailure,
  recordSpawnFailure,
} from './spawn/pty-spawn';
import { detectPR } from './pr/pr-connectors';
import { adaptCommandForShell } from '../../shared/paths';
import { isShuttingDown } from '../shutdown-state';
import type { TranscriptRepository } from '../db/repositories/transcript-repository';
import type {
  Session,
  SessionStatus,
  SessionUsage,
  ActivityState,
  SessionEvent,
  SpawnSessionInput,
  SessionContext,
} from '../../shared/types';

interface ManagedSession {
  id: string;
  taskId: string;
  projectId: string;
  pty: pty.IPty | null;
  status: SessionStatus;
  shell: string;
  cwd: string;
  startedAt: string;
  exitCode: number | null;
  resuming: boolean;
  transient: boolean;
  /** Sequence of strings to write to PTY for graceful exit before force-killing. */
  exitSequence: string[];
  /** Agent adapter for adapter-specific behavior (readiness detection, parsing,
   *  runtime strategy, exit sequence, etc.). Typed as AgentParser for historical
   *  reasons but the actual value is always the full AgentAdapter instance. */
  agentParser?: import('../../shared/types').AgentParser;
  /** Human-readable adapter name captured at spawn time (e.g. "claude",
   *  "gemini"). Used for diagnostic logs - survives minification unlike
   *  `agentParser.constructor.name`. */
  agentName?: string;
  /** Per-session telemetry parser for adapters that emit machine-readable
   *  output over the PTY (e.g. Cursor's stream-json). Built on first PTY
   *  data via `agentParser.runtime.streamOutput.createParser()`. */
  streamParser?: import('../../shared/types').StreamOutputParser;
  /** Handle returned from the adapter's optional `attachSession` hook.
   *  Disposed on session end so fire-and-forget adapter work can be
   *  cancelled cleanly. Adapters drive all their own per-session
   *  orchestration through this; SessionManager never inspects the
   *  attachment. */
  adapterAttachment?: import('../../shared/types').SessionAttachment;
}

/**
 * Kill a node-pty instance without propagating errors.
 *
 * On Windows, libuv returns EACCES from the underlying kill syscall when the
 * child PID handle is dead (e.g. Claude Code already flushed `/exit` before
 * we got here, or node-pty's conpty bridge closed the handle). On POSIX the
 * equivalent is ESRCH. The calling site has already nulled the pty reference
 * to prevent double-kill, so the session state is consistent - any throw is
 * just log noise that can abort surrounding cleanup loops like killAll() or
 * syncShutdownCleanup().
 *
 * Returns true if the kill landed on a live process, false if the process was
 * already dead. Callers that wait on the 'exit' event can use the return
 * value to skip the wait - the event already fired before we got here.
 */
function safeKillPty(ptyRef: pty.IPty): boolean {
  try {
    ptyRef.kill();
    return true;
  } catch (error) {
    const errnoCode = (error as NodeJS.ErrnoException)?.code;
    if (errnoCode !== 'EACCES' && errnoCode !== 'ESRCH') {
      console.warn('[SESSION] pty.kill() failed:', error);
    }
    return false;
  }
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, ManagedSession>();
  private sessionQueue: SessionQueue;
  private shellResolver = new ShellResolver();
  private configuredShell: string | null = null;
  private bufferManager: PtyBufferManager;
  private usageTracker: UsageTracker;
  /**
   * TUI redraw suppression: dedup ring buffer + resize grace window.
   * See ResizeManager for the full contract.
   */
  private resizeManager = new ResizeManager();
  private sessionHistoryReader: SessionHistoryReader;
  private statusFileReader: StatusFileReader;
  private firstOutputTracker = new FirstOutputTracker();
  private sessionIdManager = new SessionIdManager({
    hasAgentSessionId: (id) => this.usageTracker.hasAgentSessionId(id),
    notifyAgentSessionId: (id, capturedId) => this.usageTracker.notifyAgentSessionId(id, capturedId),
    sessionExists: (id) => this.sessions.has(id),
  });

  /**
   * Sessions currently visible in the renderer (terminal panel + command bar overlay).
   * Only these sessions' PTY data is emitted via IPC - background sessions
   * accumulate silently in the scrollback buffer. This eliminates O(N) IPC
   * flooding when many sessions run concurrently. An empty set means "all
   * sessions are focused" (no filtering).
   */
  private focusedSessionIds = new Set<string>();
  private transcriptWriter: TranscriptWriter | null = null;
  private sessionFiles!: SessionFileManager;

  constructor() {
    super();
    this.sessionQueue = new SessionQueue({
      spawner: (input) => this.doSpawn(input).then(() => {}),
      getActiveCount: () => this.activeCount,
      maxConcurrent: 5,
    });

    this.bufferManager = new PtyBufferManager({
      onFlush: (sessionId, data) => {
        const session = this.sessions.get(sessionId);
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
            this.emit('session-changed', sessionId, this.toSession(session));
          }
        }
        // Only emit IPC data for focused sessions. Background sessions
        // accumulate in scrollback and reload via getScrollback() on tab switch.
        if (this.focusedSessionIds.size === 0 || this.focusedSessionIds.has(sessionId)) {
          this.emit('data', sessionId, data);
        }
      },
    });

    this.usageTracker = new UsageTracker({
      onUsageChange: (sessionId, usage) => this.emit('usage', sessionId, usage),
      onActivityChange: (sessionId, activity, permissionIdle) => this.emit('activity', sessionId, activity, permissionIdle),
      onEvent: (sessionId, event) => this.emit('event', sessionId, event),
      onIdleTimeout: (sessionId) => {
        const session = this.sessions.get(sessionId);
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
        const session = this.sessions.get(sessionId);
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
      isSessionRunning: (sessionId) => this.sessions.get(sessionId)?.status === 'running',
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
        const session = this.sessions.get(sessionId);
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
    let count = this.spawningCount;
    for (const session of this.sessions.values()) {
      if (session.status === 'running') count++;
    }
    return count;
  }

  get queuedCount(): number {
    return this.sessionQueue.length;
  }

  /** Lightweight session counts without allocating mapped Session objects. */
  getSessionCounts(): { active: number; suspended: number; total: number } {
    let active = 0;
    let suspended = 0;
    let total = 0;
    for (const session of this.sessions.values()) {
      total++;
      if (session.status === 'running') active++;
      else if (session.status === 'suspended') suspended++;
    }
    return { active, suspended, total };
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
      this.sessions.set(id, session);
      this.sessionQueue.enqueue(inputWithId);
      this.emit('session-changed', id, this.toSession(session));
      return this.toSession(session);
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

  private async doSpawn(input: SpawnSessionInput): Promise<Session> {
    if (isShuttingDown()) {
      throw new Error('Cannot spawn session during shutdown');
    }

    const shell = await this.getShell();
    const existing = input.taskId ? this.findByTaskId(input.taskId) : null;

    // Use the caller-provided ID, or generate a fresh one as fallback.
    // For queue promotions, the ID was set on the input when the placeholder
    // was created in spawn(), so it matches the task's DB reference.
    // For respawns without a caller ID, a fresh UUID forces the renderer to
    // remount (TerminalTab is keyed by session ID).
    const id = input.id ?? uuidv4();

    // Kill any existing PTY for this task to prevent orphaned processes
    // that would emit data with the same session ID (double output).
    if (existing?.pty) {
      const ptyRef = existing.pty;
      existing.pty = null;
      safeKillPty(ptyRef);
    }

    if (existing) {
      // Detach watchers and readers but preserve files on disk and
      // nullify paths so the old session's onExit handler cannot
      // race-delete files the new spawn is about to reuse. See
      // SessionFileManager.detachPreservingFiles.
      this.sessionFiles.detachPreservingFiles(existing.id);
      // Cancel the old session's diagnostic timer and drop its scanner
      // so a spurious "session ID not captured" warning cannot fire
      // 30s after respawn.
      this.sessionIdManager.removeSession(existing.id);
      // Tear down any adapter-attached work from the previous spawn.
      disposeAdapterAttachment(existing);
    }

    // Carry over previous scrollback BEFORE removing state so scroll history
    // is preserved across respawns (including resume). Claude CLI's TUI uses
    // full-screen draws that overwrite the active viewport without corrupting
    // scroll history.
    const previousScrollback = existing ? this.bufferManager.getRawScrollback(existing.id) : '';

    // Remove old session from map and caches so findByTaskId returns
    // the new session, and stale usage/activity data doesn't persist.
    if (existing) {
      this.sessions.delete(existing.id);
      this.usageTracker.removeSession(existing.id);
      this.bufferManager.removeSession(existing.id);
      this.sessionFiles.removeSession(existing.id);
    }

    // Shell invocation (exe + args) and spawn env. See pty-spawn.ts.
    const shellName = shell.toLowerCase();
    const { exe: shellExe, args: shellArgs } = resolveShellArgs(shell);
    const cleanEnv = buildSpawnEnv(input.env);

    // Validate cwd + apply Windows UNC fallback for cmd.exe. See pty-spawn.ts.
    const { effectiveCwd, uncPushdPrefix } = resolveSpawnCwd({
      requestedCwd: input.cwd,
      shellName,
      platform: process.platform,
    });

    let ptyProcess: pty.IPty;
    try {
      ptyProcess = pty.spawn(shellExe, shellArgs, {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: effectiveCwd,
        env: cleanEnv,
      });
    } catch (err) {
      const diagnostic = diagnoseSpawnFailure({
        err,
        shellExe,
        effectiveCwd,
        originalCwd: input.cwd,
      });
      console.error(`[PTY] spawn failed session=${id.slice(0, 8)} task=${input.taskId.slice(0, 8)} shell=${shellExe} error=${diagnostic.errorMessage} errno=${diagnostic.errno} cwdExists=${diagnostic.cwdExists} shellExists=${diagnostic.shellExists}`);
      recordSpawnFailure({ diagnostic, shellExe, shellArgs });

      // Append actionable guidance to scrollback (empty suffix if no
      // known recipe for this error shape).
      let diagnosticScrollback = previousScrollback;
      if (diagnostic.scrollbackSuffix) {
        diagnosticScrollback += diagnostic.scrollbackSuffix;
        console.error(`[PTY] posix_spawnp failed for shell "${shellExe}" in "${effectiveCwd}". Likely missing +x on spawn-helper.`);
      }

      // PTY spawn failed - return a dead session so the renderer sees
      // a failed session instead of crashing the main process
      const failedSession: ManagedSession = {
        id,
        taskId: input.taskId,
        projectId: input.projectId,
        pty: null,
        status: 'exited',
        shell,
        cwd: effectiveCwd,
        startedAt: new Date().toISOString(),
        exitCode: -1,
        resuming: input.resuming ?? false,
        transient: input.transient ?? false,
        exitSequence: input.exitSequence ?? ['\x03'],
        agentParser: input.agentParser,
      };
      this.sessions.set(id, failedSession);
      // Initialize buffer manager with diagnostic scrollback for failed sessions
      this.bufferManager.initSession(id, diagnosticScrollback, 120);
      this.emit('exit', id, -1);
      return this.toSession(failedSession);
    }

    const session: ManagedSession = {
      id,
      taskId: input.taskId,
      projectId: existing?.projectId || input.projectId,
      pty: ptyProcess,
      status: 'running',
      shell,
      cwd: effectiveCwd,
      startedAt: new Date().toISOString(),
      exitCode: null,
      resuming: input.resuming ?? false,
      transient: input.transient ?? false,
      exitSequence: input.exitSequence ?? ['\x03'],
      agentParser: input.agentParser,
      agentName: input.agentName ?? 'agent',
    };

    this.sessions.set(id, session);

    // Initialize extracted modules for this session
    this.bufferManager.initSession(id, previousScrollback, 0);
    this.sessionFiles.register({
      sessionId: id,
      statusOutputPath: input.statusOutputPath || null,
    });
    this.usageTracker.initSession(id, input.agentParser);
    // Attach the status-file telemetry reader for sessions that provide
    // status/events file paths (today only Claude). The reader owns the
    // FileWatcher instances and dispatches parsed telemetry via the
    // generic UsageTracker primitives wired in this.statusFileReader's
    // callbacks. When the session has no parser, the reader still runs
    // startup file cleanup (delete stale status.json, truncate stale
    // events.jsonl) but skips watcher setup.
    if (input.statusOutputPath || input.eventsOutputPath) {
      this.statusFileReader.attach({
        sessionId: id,
        statusOutputPath: input.statusOutputPath || null,
        eventsOutputPath: input.eventsOutputPath || null,
        statusFileHook: input.agentParser?.runtime?.statusFile ?? null,
      });
    }

    // Session-ID capture: arm the diagnostic timer and kick off the
    // filesystem-based pathway. See SessionIdManager for the
    // full capture strategy.
    this.sessionIdManager.init(id, input.agentParser, effectiveCwd, session.agentName ?? 'agent');

    // Generic adapter lifecycle hook. See adapter-lifecycle.ts for the
    // contract. The attachment is disposed on PTY exit and on remove()
    // so adapter fire-and-forget work is cancelled cleanly.
    const adapterContext: SessionContext = {
      sessionId: id,
      applyUsage: (usage) => {
        if (!this.sessions.has(id)) return;
        this.usageTracker.setSessionUsage(id, usage);
      },
    };
    attachAdapter(session, adapterContext);

    // Batched data output (~60fps)
    ptyProcess.onData((data: string) => {
      this.bufferManager.onData(id, data);
      // Transient sessions (command terminal) have no DB row - the
      // TranscriptWriter's lazy init will fail silently on first flush
      // (caught by try/catch in flush()), so we skip them entirely.
      if (!session.transient) {
        this.transcriptWriter?.onData(id, data);
      }
      // Per-adapter session ID capture from PTY output. Handles chunk-
      // boundary safety (rolling buffer) and ANSI stripping (Windows
      // ConPTY cursor positioning that defeats raw regexes).
      this.sessionIdManager.onData(id, data, session.agentParser);
      // Per-adapter stream telemetry (e.g. Cursor stream-json: model from
      // the init event, ToolStart/ToolEnd events for activity tracking).
      // Each adapter owns whatever carry-over state it needs across PTY
      // chunks (the parser is constructed lazily on first chunk).
      const streamFactory = input.agentParser?.runtime?.streamOutput;
      if (streamFactory) {
        if (!session.streamParser) {
          session.streamParser = streamFactory.createParser();
        }
        const result = session.streamParser.parseTelemetry(data);
        if (result?.usage) {
          this.usageTracker.setSessionUsage(id, result.usage);
        }
        if (result?.events && result.events.length > 0) {
          this.usageTracker.ingestEvents(id, result.events);
        }
      }
      // PTY-based activity detection for agents using 'pty' or 'hooks_and_pty'
      // strategies. For 'hooks_and_pty', yields to hook-based detection once
      // hooks deliver a thinking event.
      const strategy = input.agentParser?.runtime?.activity;
      if (strategy && strategy.kind !== 'hooks') {
        if (strategy.detectIdle?.(data)) {
          this.usageTracker.notifyPtyIdle(id);
        } else if (data.length > 0) {
          const currentActivity = this.usageTracker.getSessionActivity(id);
          if (this.resizeManager.shouldNotifyOnData(id, data, currentActivity)) {
            this.usageTracker.notifyPtyData(id);
          }
        }
      }
    });

    ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
      // Don't overwrite 'suspended' - suspend() sets that before killing PTY
      if (session.status !== 'suspended') {
        session.status = 'exited';
        // Synthetic session_end - Claude Code's hook won't fire on kill
        this.usageTracker.emitSessionEnd(id);
      }
      session.exitCode = exitCode;
      session.pty = null;
      // Cancel the session-ID diagnostic timer but keep the scanner so
      // the scrollback fallback in suspend() can still use its buffer.
      this.sessionIdManager.clearDiagnostic(id);
      disposeAdapterAttachment(session);

      // Flush transcript to DB before closing out the session
      this.transcriptWriter?.finalize(id);

      // Final flush: process any unread events written before PTY exited.
      // Catches the common race where the agent writes ToolEnd just before
      // the PTY exits, but fs.watch hasn't fired the callback yet.
      this.flushPendingEvents(id);

      // Strip agent hooks from the project's settings file so they don't
      // accumulate across sessions. See adapter-lifecycle.removeAdapterHooks.
      removeAdapterHooks(session);

      // Close watchers but preserve session files on disk - they are
      // needed for crash recovery. Files are cleaned up by
      // pruneStaleResources(), remove(), or killAll(). See
      // SessionFileManager.detachOnPtyExit.
      this.sessionFiles.detachOnPtyExit(id);

      // Fallback PR scan: if a PR command was flagged (ToolStart seen) but
      // ToolEnd was never processed (event lost or never written), scan the
      // scrollback now as a last resort before the session is fully closed.
      if (this.usageTracker.hasPendingPRCommand(id)) {
        this.usageTracker.clearPendingPRCommand(id);
        const scrollback = this.bufferManager.getRawScrollback(id);
        const detected = detectPR(scrollback);
        if (detected) {
          this.emit('pr-detected', id, detected.url, detected.number);
        }
      }

      this.emit('exit', id, exitCode);
      this.sessionQueue.notifySlotFreed();
    });

    this.emit('session-changed', id, this.toSession(session));

    // If there's a command to run, send it after a brief delay
    if (input.command) {
      setTimeout(() => {
        const cmd = adaptCommandForShell(input.command!, shellName);
        if (uncPushdPrefix) {
          // pushd maps UNC path to a temporary drive letter, then run the command
          ptyProcess.write(uncPushdPrefix + '\r');
          setTimeout(() => ptyProcess.write(cmd + '\r'), 200);
        } else {
          ptyProcess.write(cmd + '\r');
        }
      }, 100);
    }

    return this.toSession(session);
  }

  write(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (!session?.pty) return;

    const CHUNK_SIZE = 4096;
    if (data.length <= CHUNK_SIZE) {
      session.pty.write(data);
      return;
    }
    let offset = 0;
    const writeNextChunk = () => {
      if (!session.pty || offset >= data.length) return;
      session.pty.write(data.slice(offset, offset + CHUNK_SIZE));
      offset += CHUNK_SIZE;
      if (offset < data.length) setTimeout(writeNextChunk, 1);
    };
    writeNextChunk();
  }

  resize(sessionId: string, cols: number, rows: number): { colsChanged: boolean } {
    const session = this.sessions.get(sessionId);
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
   * Final synchronous read of the events file to catch any unprocessed events.
   * Called from onExit before watchers are closed so that ToolEnd events
   * written just before PTY exit are not lost to the fs.watch race.
   */
  private flushPendingEvents(sessionId: string): void {
    this.statusFileReader.flushPendingEvents(sessionId);
  }

  /**
   * Fully remove a session from all internal maps: kill the PTY, clean up
   * session files, and delete from sessions/usage/activity caches.
   * Used during project deletion to prevent cross-project bleed.
   */
  remove(sessionId: string): void {
    // kill() may emit 'exit' events that depend on the session still being
    // in the map (the exit handler looks up the session by ID). Delete AFTER.
    const session = this.sessions.get(sessionId);
    this.sessionIdManager.removeSession(sessionId);
    if (session) disposeAdapterAttachment(session);
    this.kill(sessionId);
    // Full cleanup including file deletion - the session is not coming back.
    this.sessionFiles.detachAndDelete(sessionId);
    this.sessions.delete(sessionId);
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
    const session = this.findByTaskId(taskId);
    if (session) this.kill(session.id);
  }

  /**
   * Fully remove any PTY session belonging to a task from all internal
   * maps. Like killByTaskId but also cleans up caches and session files.
   */
  removeByTaskId(taskId: string): void {
    const session = this.findByTaskId(taskId);
    if (session) this.remove(session.id);
  }

  kill(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.pty) {
      const ptyRef = session.pty;
      session.pty = null; // prevent double-kill (conpty heap corruption on Windows)
      safeKillPty(ptyRef);
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
    const session = this.sessions.get(sessionId);
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
      const currentSession = this.sessions.get(sessionId);
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
    const session = this.sessions.get(sessionId);
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

    this.emit('session-changed', sessionId, this.toSession(session));

    // Remove from queue (queued sessions have no PTY yet) and promote
    this.sessionQueue.remove(sessionId);
    this.sessionQueue.notifySlotFreed();
  }

  getScrollback(sessionId: string): string {
    return this.bufferManager.getScrollback(sessionId);
  }

  getSession(sessionId: string): Session | undefined {
    const session = this.sessions.get(sessionId);
    return session ? this.toSession(session) : undefined;
  }

  listSessions(): Session[] {
    return Array.from(this.sessions.values()).map(session => this.toSession(session));
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
    const allUsage = this.usageTracker.getUsageCache();
    const result: Record<string, SessionUsage> = {};
    for (const [id, usage] of Object.entries(allUsage)) {
      const session = this.sessions.get(id);
      if (session?.projectId === projectId) {
        result[id] = usage;
      }
    }
    return result;
  }

  /** Return cached activity state filtered to a specific project. */
  getActivityCacheForProject(projectId: string): Record<string, ActivityState> {
    const allActivity = this.usageTracker.getActivityCache();
    const result: Record<string, ActivityState> = {};
    for (const [id, state] of Object.entries(allActivity)) {
      const session = this.sessions.get(id);
      if (session?.projectId === projectId) {
        result[id] = state;
      }
    }
    return result;
  }

  /** Return cached events filtered to a specific project. */
  getEventsCacheForProject(projectId: string): Record<string, SessionEvent[]> {
    const allEvents = this.usageTracker.getEventsCache();
    const result: Record<string, SessionEvent[]> = {};
    for (const [id, events] of Object.entries(allEvents)) {
      const session = this.sessions.get(id);
      if (session?.projectId === projectId) {
        result[id] = events;
      }
    }
    return result;
  }

  /** Return the projectId for a given session, or undefined if not found. */
  getSessionProjectId(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.projectId;
  }

  /** Return the taskId for a given session, or undefined if not found. */
  getSessionTaskId(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.taskId;
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
    const id = uuidv4();
    const session: ManagedSession = {
      id,
      taskId: input.taskId,
      projectId: input.projectId,
      pty: null,
      status: 'suspended',
      shell: '',
      cwd: input.cwd,
      startedAt: new Date().toISOString(),
      exitCode: null,
      resuming: false,
      transient: false,
      exitSequence: ['\x03'],
    };
    this.sessions.set(id, session);
    return this.toSession(session);
  }

  /** Check whether a session (any status) already exists for a given task. */
  hasSessionForTask(taskId: string): boolean {
    return this.findByTaskId(taskId) !== undefined;
  }

  private findByTaskId(taskId: string): ManagedSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.taskId === taskId) return session;
    }
    return undefined;
  }

  private toSession(session: ManagedSession): Session {
    return {
      id: session.id,
      taskId: session.taskId,
      projectId: session.projectId,
      pid: session.pty?.pid ?? null,
      status: session.status,
      shell: session.shell,
      cwd: session.cwd,
      startedAt: session.startedAt,
      exitCode: session.exitCode,
      resuming: session.resuming,
      transient: session.transient || undefined,
    };
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
      sessions: this.sessions,
      sessionQueue: this.sessionQueue,
      sessionFiles: this.sessionFiles,
      firstOutputTracker: this.firstOutputTracker,
      killPty: safeKillPty,
    };
  }
}
