import fs from 'node:fs';
import os from 'node:os';
import * as pty from 'node-pty';
import { EventEmitter } from 'node:events';
import { v4 as uuidv4 } from 'uuid';
import { ShellResolver } from './shell-resolver';
import { SessionQueue } from './session-queue';
import { PtyBufferManager } from './pty-buffer-manager';
import { SessionFileWatcher } from './session-file-watcher';
import { SessionHistoryReader } from './session-history-reader';
import { StatusFileReader } from './status-file-reader';
import { UsageTracker } from './usage-tracker';
import { TranscriptWriter, stripAnsiEscapes } from './transcript-writer';
import { SessionIdScanner } from './session-id-scanner';
import { detectPR } from './pr-connectors';
import { adaptCommandForShell, isUncPath } from '../../shared/paths';
import { trackEvent, sanitizeErrorMessage } from '../analytics/analytics';
import { isShuttingDown } from '../shutdown-state';
import type { TranscriptRepository } from '../db/repositories/transcript-repository';
import type { Session, SessionStatus, SessionUsage, ActivityState, SessionEvent, SpawnSessionInput } from '../../shared/types';

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
  /** Per-session session-ID scanner (rolling buffer + ANSI strip). Reset on
   *  first successful capture. */
  sessionIdScanner?: import('./session-id-scanner').SessionIdScanner;
  /** One-shot timer that warns if session-ID capture fails within the timeout. */
  sessionIdCaptureTimer?: ReturnType<typeof setTimeout>;
  /** Per-session telemetry parser for adapters that emit machine-readable
   *  output over the PTY (e.g. Cursor's stream-json). Built on first PTY
   *  data via `agentParser.runtime.streamOutput.createParser()`. */
  streamParser?: import('../../shared/types').StreamOutputParser;
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
  private fileWatcher: SessionFileWatcher;
  private usageTracker: UsageTracker;
  /**
   * Per-session ring buffer of recent normalized PTY content for TUI
   * redraw dedup. TUI agents (Codex, Gemini) redraw the screen on resize
   * (panel mount/unmount, project switch). Codex specifically rotates
   * input placeholder text on each redraw, so byte-comparison against
   * just the last frame fails. Storing the last N normalized frames lets
   * us catch redraws even when the placeholder text differs.
   * Agent-agnostic - applies to all PTY-based strategies automatically.
   */
  private lastPtyContent = new Map<string, string[]>();
  private static readonly PTY_DEDUP_HISTORY_SIZE = 16;
  /**
   * Per-session timestamp of the last PTY resize. Used to suppress
   * idle->thinking transitions for a brief window after a resize, since
   * resize triggers the child process (TUI) to redraw the entire screen.
   * Without this, switching projects (which remounts the panel and triggers
   * a fit/resize) causes a brief active flicker even when nothing changed.
   */
  private lastResizeTime = new Map<string, number>();
  private static readonly RESIZE_GRACE_PERIOD_MS = 1500;
  /**
   * Sessions that have been woken at least once via PTY data. Used to
   * gate the resize grace period - we only suppress idle->thinking
   * transitions for sessions that were already settled-idle (not for
   * brand new sessions where the very first output IS the initial wake).
   */
  private sessionsEverWoken = new Set<string>();
  private sessionHistoryReader: SessionHistoryReader;
  private statusFileReader: StatusFileReader;
  private firstOutputEmitted = new Set<string>();

  /** Rolling buffer size for session-ID capture. Must be at least 2x the max
   *  PTY chunk size so any UUID straddling a single chunk boundary is preserved
   *  after slicing. Windows ConPTY flushes at 4KB, so 8KB gives a safe margin. */
  private static readonly SESSION_ID_BUFFER_MAX = 8192;
  /** Capture diagnostic timeout: warn if session-ID capture hasn't fired by then. */
  private static readonly SESSION_ID_CAPTURE_TIMEOUT_MS = 30_000;

  /**
   * Sessions currently visible in the renderer (terminal panel + command bar overlay).
   * Only these sessions' PTY data is emitted via IPC - background sessions
   * accumulate silently in the scrollback buffer. This eliminates O(N) IPC
   * flooding when many sessions run concurrently. An empty set means "all
   * sessions are focused" (no filtering).
   */
  private focusedSessionIds = new Set<string>();
  private transcriptWriter: TranscriptWriter | null = null;

  constructor() {
    super();
    this.sessionQueue = new SessionQueue({
      spawner: (input) => this.doSpawn(input).then(() => {}),
      getActiveCount: () => this.activeCount,
      maxConcurrent: 5,
    });

    this.bufferManager = new PtyBufferManager({
      onFlush: (sessionId, data) => {
        // Detect first meaningful output using the adapter's detection logic.
        // Claude checks for alternate screen buffer (\x1b[?1049h), other agents
        // default to any non-empty output. This lifts the shimmer overlay.
        if (!this.firstOutputEmitted.has(sessionId)) {
          const session = this.sessions.get(sessionId);
          const isReady = session?.agentParser
            ? session.agentParser.detectFirstOutput(data)
            : data.length > 0;
          if (isReady) {
            this.firstOutputEmitted.add(sessionId);
            this.emit('first-output', sessionId);
            // Clear the resuming flag once the resumed CLI has actually
            // produced output. This unblocks card / overlay labels for
            // adapters (Codex, Gemini) that don't emit a usage statusline.
            if (session && session.resuming) {
              session.resuming = false;
              this.emit('session-changed', sessionId, this.toSession(session));
            }
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

    // SessionFileWatcher is now a thin path-cleanup tracker -- the
    // per-session command bridge it used to host has been replaced by
    // the in-process MCP HTTP server (mcp-http-server.ts), so no
    // callbacks are needed. The previous task-{created,updated,deleted,
    // move,...} EventEmitter wiring lives directly on the HTTP server's
    // CommandContext now (see mcp-project-context.ts).
    this.fileWatcher = new SessionFileWatcher();
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

    // Stop any existing watchers for this task
    if (existing) {
      this.fileWatcher.stopAll(existing.id);
      // Detach the old session-history + status-file readers WITHOUT
      // deleting their files. The new session is about to reuse the
      // same paths, so deleting here would race with its attach.
      this.sessionHistoryReader.detach(existing.id);
      this.statusFileReader.detachWithoutCleanup(existing.id);
    }

    // Null out file paths on the old session object to prevent its
    // onExit callback (which runs asynchronously after ptyRef.kill())
    // from deleting files that the new session will create at the same
    // paths. This race occurs when resuming a session: the old and new
    // sessions share the same claudeSessionId, so the merged settings
    // files all resolve to the same path. Status/events file races are
    // handled by statusFileReader.detachWithoutCleanup above.
    if (existing) {
      this.fileWatcher.nullifyPaths(existing.id);
      // Cancel the old session's diagnostic timer so it can't fire a
      // spurious "session ID not captured" warning 30s after respawn.
      if (existing.sessionIdCaptureTimer) {
        clearTimeout(existing.sessionIdCaptureTimer);
        existing.sessionIdCaptureTimer = undefined;
      }
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
      this.fileWatcher.removeSession(existing.id);
    }

    // Determine shell args and actual executable based on shell type
    const shellName = shell.toLowerCase();
    let shellExe = shell;
    let shellArgs: string[];

    if (shellName.startsWith('wsl ')) {
      // WSL: e.g. "wsl -d Ubuntu" - split into exe + args
      const parts = shell.split(/\s+/);
      shellExe = parts[0];
      shellArgs = parts.slice(1);
    } else if (shellName.includes('cmd')) {
      shellArgs = [];
    } else if (shellName.includes('powershell') || shellName.includes('pwsh')) {
      shellArgs = ['-NoLogo'];
    } else if (shellName.includes('fish') || shellName.includes('nu')) {
      shellArgs = [];
    } else {
      shellArgs = ['--login'];
    }

    // Strip CLAUDECODE so spawned Claude CLI sessions don't refuse to start
    // when Kangentic itself was launched from inside a Claude Code session.
    const { CLAUDECODE: _, ...cleanEnv } = { ...process.env, ...input.env };

    // Validate CWD exists before spawning. If the project directory was
    // deleted or moved, fall back to home directory (a session in ~ is
    // strictly better than a dead session with exitCode: -1).
    let effectiveCwd = input.cwd;
    if (!fs.existsSync(input.cwd)) {
      effectiveCwd = os.homedir();
      trackEvent('app_error', {
        source: 'pty_spawn_cwd_missing',
        message: 'CWD does not exist, falling back to home directory',
        platform: process.platform,
      });
    }

    // cmd.exe does not support UNC paths as working directory. It prints
    // "UNC paths are not supported" and defaults to C:\Windows. Use pushd
    // which auto-maps a temporary drive letter (e.g. Z: -> \\server\share).
    // Other shells (PowerShell, Git Bash) handle UNC natively.
    let uncPushdPrefix: string | null = null;
    if (process.platform === 'win32' && isUncPath(effectiveCwd) && shellName.includes('cmd')) {
      uncPushdPrefix = `pushd "${effectiveCwd}"`;
      effectiveCwd = os.homedir();
    }

    let ptyProcess: pty.IPty;
    try {
      ptyProcess = pty.spawn(shellExe, shellArgs, {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: effectiveCwd,
        env: cleanEnv as Record<string, string>,
      });
    } catch (err) {
      // Track PTY spawn failures with full diagnostics
      const spawnError = err instanceof Error ? err.message : String(err);
      const errnoCode = (err as NodeJS.ErrnoException).code || '';
      const errnoNumber = (err as NodeJS.ErrnoException).errno ?? '';

      // Check original CWD (not effectiveCwd) so the diagnostic reveals
      // whether the fallback was triggered. existsSync doesn't throw for
      // valid string args, so no try/catch needed.
      const cwdExists = fs.existsSync(input.cwd);
      const shellExists = fs.existsSync(shellExe);

      console.error(`[PTY] spawn failed session=${id.slice(0, 8)} task=${input.taskId.slice(0, 8)} shell=${shellExe} error=${spawnError} errno=${errnoCode || errnoNumber} cwdExists=${cwdExists} shellExists=${shellExists}`);

      trackEvent('app_error', {
        source: 'pty_spawn',
        message: sanitizeErrorMessage(spawnError),
        shell: shellExe,
        shellArgs: shellArgs.join(' '),
        cwdExists: String(cwdExists),
        shellExists: String(shellExists),
        errno: errnoCode || String(errnoNumber),
        platform: process.platform,
        arch: process.arch,
      });

      // Write a diagnostic message into the scrollback so the user sees
      // actionable guidance in the terminal panel instead of a blank screen.
      let diagnosticScrollback = previousScrollback;
      if (spawnError.includes('posix_spawnp')) {
        const isPackaged = shellExe.includes('app.asar') || effectiveCwd.includes('app.asar');
        const fixInstructions = isPackaged
          ? '  Reinstalling the app should resolve this.'
          : '  find node_modules/node-pty -name spawn-helper -exec chmod +x {} \\;';
        const diagnostic = [
          '',
          '\x1b[1;31mError: Failed to spawn shell process (posix_spawnp failed)\x1b[0m',
          '',
          'This is likely caused by node-pty\'s spawn-helper binary missing',
          'execute permissions. To fix:',
          '',
          fixInstructions,
          '',
          'Then restart the app. See https://github.com/Kangentic/kangentic/issues/3',
          '',
        ].join('\r\n');
        diagnosticScrollback += diagnostic;
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
    this.fileWatcher.startAll({
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

    // Arm diagnostic timer: if the agent supports session-ID capture but
    // nothing fires by the timeout, something upstream is broken. Surface
    // it in logs so dogfooding catches regressions early.
    const sessionIdStrategy = input.agentParser?.runtime?.sessionId;
    const hasCapturePath = !!(sessionIdStrategy?.fromHook
      || sessionIdStrategy?.fromOutput
      || sessionIdStrategy?.fromFilesystem);
    if (hasCapturePath) {
      session.sessionIdCaptureTimer = setTimeout(() => {
        session.sessionIdCaptureTimer = undefined;
        if (!this.usageTracker.hasAgentSessionId(id)) {
          console.warn(
            `[session-manager] ${session.agentName} session ID not captured after `
            + `${SessionManager.SESSION_ID_CAPTURE_TIMEOUT_MS / 1000}s for session `
            + `${id.slice(0, 8)} - --resume will not work.`,
          );
        }
      }, SessionManager.SESSION_ID_CAPTURE_TIMEOUT_MS);
      session.sessionIdCaptureTimer.unref();
    }

    // Fire-and-forget filesystem-based session-ID capture. Primary
    // path for Codex 0.118 (PTY output and hooks both unavailable).
    if (sessionIdStrategy?.fromFilesystem) {
      const spawnedAt = new Date();
      sessionIdStrategy.fromFilesystem({ spawnedAt, cwd: effectiveCwd })
        .then((capturedId) => {
          if (!capturedId || this.usageTracker.hasAgentSessionId(id) || !this.sessions.has(id)) return;
          console.log(`[${session.agentName}] Captured session ID from filesystem: ${capturedId.slice(0, 16)}...`);
          this.usageTracker.notifyAgentSessionId(id, capturedId);
        })
        .catch((err) => {
          console.warn(`[session-manager] fromFilesystem capture failed for session=${id.slice(0, 8)}:`, err);
        });
    }

    // Batched data output (~60fps)
    ptyProcess.onData((data: string) => {
      this.bufferManager.onData(id, data);
      // Transient sessions (command terminal) have no DB row - the
      // TranscriptWriter's lazy init will fail silently on first flush
      // (caught by try/catch in flush()), so we skip them entirely.
      if (!session.transient) {
        this.transcriptWriter?.onData(id, data);
      }
      // Per-adapter session ID capture from PTY output. The scanner handles
      // chunk-boundary safety (rolling buffer) and ANSI stripping (Windows
      // ConPTY cursor-positioning that defeats raw regexes).
      const fromOutput = input.agentParser?.runtime?.sessionId?.fromOutput;
      if (fromOutput && !this.usageTracker.hasAgentSessionId(id)) {
        if (!session.sessionIdScanner) {
          session.sessionIdScanner = new SessionIdScanner(SessionManager.SESSION_ID_BUFFER_MAX);
        }
        const capturedId = session.sessionIdScanner.scanChunk(data, fromOutput);
        if (capturedId) {
          session.sessionIdScanner.reset();
          this.usageTracker.notifyAgentSessionId(id, capturedId);
        }
      }
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
          // TUI agents (Codex, Gemini) redraw the screen on resize (panel
          // mount/unmount, project switch). The redraw produces "new" PTY
          // chunks that would otherwise trigger an idle->thinking flicker.
          //
          // Two layers of defense (both agent-agnostic):
          //
          // 1. Resize grace period: if a resize happened within the last
          //    1.5s AND the session is currently idle, treat all incoming
          //    data as redraw noise. Add it to the dedup buffer (so any
          //    future identical chunks are filtered) but do NOT call
          //    notifyPtyData. This prevents the first-encounter flicker.
          //
          // 2. Content dedup ring buffer: even outside the grace period,
          //    if the normalized content matches any of the last N frames
          //    we've seen, treat as a redraw and skip notification. Catches
          //    redraws that fall outside the grace window (e.g. delayed
          //    refreshes) and Codex's rotating placeholder text.
          //
          // Normalization (strip ANSI + collapse whitespace) handles
          // layout differences from cursor positioning and line wrapping.
          const stripped = data.includes('\x1b') ? stripAnsiEscapes(data) : data;
          const normalized = stripped.replace(/\s+/g, ' ').trim();
          if (normalized.length > 0) {
            const history = this.lastPtyContent.get(id) ?? [];
            const isContentNew = !history.includes(normalized);
            if (isContentNew) {
              history.push(normalized);
              if (history.length > SessionManager.PTY_DEDUP_HISTORY_SIZE) {
                history.shift();
              }
              this.lastPtyContent.set(id, history);
            }
            if (isContentNew) {
              const lastResize = this.lastResizeTime.get(id) ?? 0;
              const inResizeGrace = (Date.now() - lastResize) < SessionManager.RESIZE_GRACE_PERIOD_MS;
              const currentActivity = this.usageTracker.getSessionActivity(id);
              const hasBeenWoken = this.sessionsEverWoken.has(id);
              // Only suppress if the session was already settled-idle.
              // Brand new sessions (never woken) need their first output
              // to wake them, regardless of resize timing.
              const suppressForResize = inResizeGrace && currentActivity === 'idle' && hasBeenWoken;
              if (!suppressForResize) {
                this.sessionsEverWoken.add(id);
                this.usageTracker.notifyPtyData(id);
              }
            }
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
      if (session.sessionIdCaptureTimer) {
        clearTimeout(session.sessionIdCaptureTimer);
        session.sessionIdCaptureTimer = undefined;
      }

      // Flush transcript to DB before closing out the session
      this.transcriptWriter?.finalize(id);

      // Final flush: process any unread events written before PTY exited.
      // Catches the common race where the agent writes ToolEnd just before
      // the PTY exits, but fs.watch hasn't fired the callback yet.
      this.flushPendingEvents(id);

      // Strip agent hooks from the project's settings file so they don't
      // accumulate across sessions. Gemini writes hooks to <cwd>/.gemini/
      // settings.json (shared project-level, no --settings flag), so each
      // session must clean up its own hooks on exit. Without this, hooks
      // pile up and Gemini executes N copies per event. The adapter uses
      // taskId as a reference key so double-calls (suspend + onExit) for
      // the same task are idempotent and concurrent sessions in the same
      // cwd do not clobber each other's hooks.
      if (session.agentParser?.removeHooks) {
        session.agentParser.removeHooks(session.cwd, session.taskId);
      }

      // Close watchers but preserve session files on disk - they are needed
      // for crash recovery (the status-file reader reads status.json on
      // resume). Files are cleaned up by pruneStaleResources(), remove(),
      // or killAll().
      this.fileWatcher.stopAll(id);
      this.statusFileReader.detachWithoutCleanup(id);

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
    this.lastResizeTime.set(sessionId, Date.now());
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
    if (session?.sessionIdCaptureTimer) {
      clearTimeout(session.sessionIdCaptureTimer);
      session.sessionIdCaptureTimer = undefined;
    }
    this.sessionHistoryReader.detach(sessionId);
    this.statusFileReader.detach(sessionId);
    this.kill(sessionId);
    this.fileWatcher.cleanupAndRemove(sessionId);
    this.sessions.delete(sessionId);
    this.bufferManager.removeSession(sessionId);
    this.transcriptWriter?.remove(sessionId);
    this.usageTracker.removeSession(sessionId);
    this.firstOutputEmitted.delete(sessionId);
    this.lastPtyContent.delete(sessionId);
    this.lastResizeTime.delete(sessionId);
    this.sessionsEverWoken.delete(sessionId);
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
    // closing down. Prevents hook accumulation across sessions. This
    // path and the PTY onExit handler both call removeHooks; adapters
    // key on taskId so the second call is idempotent for shared-file
    // agents (Codex, Gemini).
    if (session.agentParser?.removeHooks) {
      session.agentParser.removeHooks(session.cwd, session.taskId);
    }

    // Close watchers - no longer need real-time updates
    this.fileWatcher.stopAll(sessionId);
    // Detach telemetry readers WITHOUT deleting files - they persist
    // for resume (the next spawn reads them back).
    this.sessionHistoryReader.detach(sessionId);
    this.statusFileReader.detachWithoutCleanup(sessionId);

    // Null out merged-settings path BEFORE killing so the onExit
    // handler's cleanup skips settings.json deletion - it persists for
    // resume. Status/events path races are handled by the telemetry
    // reader detach calls above.
    this.fileWatcher.nullifyPaths(sessionId);

    // Flush transcript to DB before killing PTY
    this.transcriptWriter?.finalize(sessionId);

    // Synthetic session_end before we kill - Claude Code's hook won't fire
    this.usageTracker.emitSessionEnd(sessionId);

    // Clear subagent depth - session is no longer active
    this.usageTracker.clearSessionTracking(sessionId);

    // Mark suspended BEFORE killing so the async onExit handler preserves it
    session.status = 'suspended';

    if (session.pty) {
      // Send graceful exit sequence (e.g. Ctrl+C + /exit for Claude Code).
      // This gives the agent time to flush its conversation JSONL to disk.
      for (const command of session.exitSequence) {
        try { session.pty.write(command); } catch { /* PTY may already be dead */ }
      }

      // Wait for the process to exit naturally, up to 1500ms.
      // Claude Code typically exits within 200-500ms after /exit.
      const exitedNaturally = await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          this.removeListener('exit', onExit);
          resolve(false);
        }, 1500);

        const onExit = (exitedId: string) => {
          if (exitedId === sessionId) {
            clearTimeout(timeout);
            this.removeListener('exit', onExit);
            resolve(true);
          }
        };
        this.on('exit', onExit);

        // Check if it already exited between sending /exit and registering listener
        if (!session.pty) {
          clearTimeout(timeout);
          this.removeListener('exit', onExit);
          resolve(true);
        }
      });

      // Force-kill if still alive after timeout
      if (!exitedNaturally && session.pty) {
        const ptyRef = session.pty;
        session.pty = null; // prevent double-kill (conpty heap corruption on Windows)
        const killLanded = safeKillPty(ptyRef);

        // Wait for the kill to propagate into an 'exit' event before returning.
        // Otherwise callers that immediately delete the session's CWD (worktree
        // removal on move-to-Done) race against conhost still holding CWD
        // handles on Windows. Bounded at 1500ms so a hung exit never blocks
        // shutdown; removeWorktree's own retry handles the remaining cases.
        //
        // Skip the wait entirely if kill reported EACCES/ESRCH (already dead):
        // the 'exit' event already fired before we got here, so awaiting it
        // would just burn the full 1500ms timeout.
        if (killLanded) {
          await new Promise<void>((resolve) => {
            const timeout = setTimeout(() => {
              this.removeListener('exit', onExit);
              resolve();
            }, 1500);
            const onExit = (exitedSessionId: string) => {
              if (exitedSessionId === sessionId) {
                clearTimeout(timeout);
                this.removeListener('exit', onExit);
                resolve();
              }
            };
            this.on('exit', onExit);
          });
        }
      }
    }

    // Last-resort: scan full scrollback for agent session ID if not yet
    // captured. Handles Gemini printing session ID at shutdown, Codex
    // startup header missed by streaming handler, etc.
    const scrollbackFromOutput = session.agentParser?.runtime?.sessionId?.fromOutput;
    if (!this.usageTracker.hasAgentSessionId(sessionId) && scrollbackFromOutput) {
      // Use getRawScrollback() (not getScrollback()) so pre-TUI content like
      // Codex's startup header "session id: <uuid>" remains in scope.
      const rawScrollback = this.bufferManager.getRawScrollback(sessionId);
      const scanner = session.sessionIdScanner ?? new SessionIdScanner();
      const capturedId = scanner.scanScrollback(rawScrollback, scrollbackFromOutput);
      if (capturedId) {
        this.usageTracker.notifyAgentSessionId(sessionId, capturedId);
      }
    }

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
    const taskIds: string[] = [];
    const ptysToKill: pty.IPty[] = [];
    const freshSessionThresholdMs = 10_000;
    const now = Date.now();
    let hasLongRunningSession = false;

    for (const session of this.sessions.values()) {
      if (session.pty && session.status === 'running') {
        taskIds.push(session.taskId);

        // Check if this session has been running long enough to have
        // meaningful conversation state worth waiting for
        const sessionAge = now - new Date(session.startedAt).getTime();
        if (sessionAge >= freshSessionThresholdMs) {
          hasLongRunningSession = true;
        }

        // Send agent-specific exit sequence (e.g. Ctrl+C + /exit for Claude,
        // Ctrl+C + /quit for Gemini) to trigger a clean shutdown that flushes
        // the conversation transcript to disk.
        for (const command of session.exitSequence) {
          try { session.pty.write(command); } catch { /* PTY may already be dead */ }
        }
        ptysToKill.push(session.pty);
        session.status = 'exited';
      }
    }

    // Also count queued sessions as suspended
    for (const session of this.sessions.values()) {
      if (session.status === 'queued') {
        taskIds.push(session.taskId);
        session.status = 'exited';
      }
    }
    this.sessionQueue.clear();

    // Wait for graceful exit, then force-kill any remaining.
    // Use a short timeout for freshly spawned sessions (e.g. recovery just started)
    // since they have minimal conversation state to save.
    if (ptysToKill.length > 0) {
      const effectiveTimeout = hasLongRunningSession ? timeoutMs : 200;
      await new Promise((resolve) => setTimeout(resolve, effectiveTimeout));
    }
    for (const session of this.sessions.values()) {
      // Close watchers but preserve session files -
      // sessions will be resumed on next app launch via session recovery
      this.fileWatcher.stopAll(session.id);
      this.sessionHistoryReader.detach(session.id);
      this.statusFileReader.detachWithoutCleanup(session.id);

      if (session.pty) {
        const ptyRef = session.pty;
        session.pty = null;
        // Null file paths before kill so onExit doesn't clean them up
        this.fileWatcher.nullifyPaths(session.id);
        safeKillPty(ptyRef);
      }
    }

    return taskIds;
  }

  killAll(): void {
    for (const session of this.sessions.values()) {
      if (session.pty) {
        // Best-effort graceful exit: send exit sequence before killing.
        // No wait - shutdown must stay synchronous. The write buffer may
        // flush before kill() lands, giving the agent a few ms to start
        // saving conversation state.
        for (const command of session.exitSequence) {
          try { session.pty.write(command); } catch { /* already dead */ }
        }
        const ptyRef = session.pty;
        session.pty = null; // prevent double-kill (conpty heap corruption on Windows)
        safeKillPty(ptyRef);
      }
      // Clean up watchers and files
      this.fileWatcher.cleanupAndRemove(session.id);
      this.sessionHistoryReader.detach(session.id);
      this.statusFileReader.detach(session.id);
    }
    this.sessions.clear();
    this.sessionQueue.clear();
    this.firstOutputEmitted.clear();
  }
}
