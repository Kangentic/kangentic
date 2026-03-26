import fs from 'node:fs';
import os from 'node:os';
import * as pty from 'node-pty';
import { EventEmitter } from 'node:events';
import { v4 as uuidv4 } from 'uuid';
import { ShellResolver } from './shell-resolver';
import { SessionQueue } from './session-queue';
import { PtyBufferManager } from './pty-buffer-manager';
import { SessionFileWatcher } from './session-file-watcher';
import { UsageTracker } from './usage-tracker';
import { detectPR } from './pr-connectors';
import { adaptCommandForShell } from '../../shared/paths';
import { trackEvent, sanitizeErrorMessage } from '../analytics/analytics';
import { isShuttingDown } from '../shutdown-state';
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
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, ManagedSession>();
  private sessionQueue: SessionQueue;
  private shellResolver = new ShellResolver();
  private configuredShell: string | null = null;
  private bufferManager: PtyBufferManager;
  private fileWatcher: SessionFileWatcher;
  private usageTracker: UsageTracker;
  private firstOutputEmitted = new Set<string>();

  constructor() {
    super();
    this.sessionQueue = new SessionQueue({
      spawner: (input) => this.doSpawn(input).then(() => {}),
      getActiveCount: () => this.activeCount,
      maxConcurrent: 5,
    });

    this.bufferManager = new PtyBufferManager({
      onFlush: (sessionId, data) => {
        // Detect alternate screen buffer activation (Claude Code's TUI entering
        // full-screen mode) and emit a one-time event per session. This fires
        // ~500ms-1.5s after spawn, much earlier than the status.json hook (~2-5s).
        if (!this.firstOutputEmitted.has(sessionId) && data.includes('\x1b[?1049h')) {
          this.firstOutputEmitted.add(sessionId);
          this.emit('first-output', sessionId);
        }
        this.emit('data', sessionId, data);
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
      requestSuspend: (sessionId) => this.suspend(sessionId),
      isSessionRunning: (sessionId) => this.sessions.get(sessionId)?.status === 'running',
    });

    this.fileWatcher = new SessionFileWatcher({
      onUsageFileChanged: (sessionId, statusPath) => this.usageTracker.readAndEmitUsage(sessionId, statusPath),
      onEventsFileChanged: (sessionId, eventsPath) => {
        const offset = this.fileWatcher.getEventsFileOffset(sessionId);
        const newOffset = this.usageTracker.readAndProcessEvents(sessionId, eventsPath, offset);
        this.fileWatcher.setEventsFileOffset(sessionId, newOffset);
      },
      onTaskCreated: (sessionId, task, columnName, swimlaneId) => this.emit('task-created', sessionId, task, columnName, swimlaneId),
      onTaskUpdated: (sessionId, task) => this.emit('task-updated', sessionId, task),
      onBacklogChanged: (sessionId) => this.emit('backlog-changed', sessionId),
      onLabelColorsChanged: (sessionId, colors) => this.emit('label-colors-changed', sessionId, colors),
    });
  }

  setMaxConcurrent(max: number): void {
    this.sessionQueue.setMaxConcurrent(max);
  }

  setIdleTimeout(minutes: number): void {
    this.usageTracker.setIdleTimeout(minutes);
  }

  dispose(): void {
    this.usageTracker.dispose();
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
      ptyRef.kill();
    }

    // Stop any existing watchers for this task
    if (existing) {
      this.fileWatcher.stopAll(existing.id);
    }

    // Null out file paths on the old session object to prevent its
    // onExit callback (which runs asynchronously after ptyRef.kill())
    // from deleting files that the new session will create at the same
    // paths. This race occurs when resuming a session: the old and new
    // sessions share the same claudeSessionId, so the merged settings,
    // status, and events files all resolve to the same path.
    if (existing) {
      this.fileWatcher.nullifyPaths(existing.id);
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
    };

    this.sessions.set(id, session);

    // Initialize extracted modules for this session
    this.bufferManager.initSession(id, previousScrollback, 120);
    this.fileWatcher.startAll({
      sessionId: id,
      projectId: session.projectId,
      cwd: effectiveCwd,
      statusOutputPath: input.statusOutputPath || null,
      eventsOutputPath: input.eventsOutputPath || null,
    });
    this.usageTracker.initSession(id);

    // Batched data output (~60fps)
    ptyProcess.onData((data: string) => {
      this.bufferManager.onData(id, data);
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

      // Close watchers but preserve session files on disk - they are needed
      // for crash recovery (startUsageWatcher reads status.json on resume).
      // Files are cleaned up by pruneStaleResources(), remove(), or killAll().
      this.fileWatcher.stopAll(id);

      this.emit('exit', id, exitCode);
      this.sessionQueue.notifySlotFreed();
    });

    this.emit('session-changed', id, this.toSession(session));

    // If there's a command to run, send it after a brief delay
    if (input.command) {
      setTimeout(() => {
        const cmd = adaptCommandForShell(input.command!, shellName);
        ptyProcess.write(cmd + '\r');
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

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId);
    if (!session?.pty) return;

    // Guard against NaN/Infinity from layout edge cases (e.g. getComputedStyle
    // returning "" during unmount, yielding parseInt -> NaN)
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;

    // Clamp to valid dimensions (node-pty throws on 0 or negative)
    const clampedCols = Math.max(2, Math.floor(cols));
    const clampedRows = Math.max(1, Math.floor(rows));

    this.bufferManager.onResize(sessionId, clampedCols);
    session.pty.resize(clampedCols, clampedRows);
  }

  /**
   * Fully remove a session from all internal maps: kill the PTY, clean up
   * session files, and delete from sessions/usage/activity caches.
   * Used during project deletion to prevent cross-project bleed.
   */
  remove(sessionId: string): void {
    this.kill(sessionId);
    this.fileWatcher.cleanupAndRemove(sessionId);
    this.sessions.delete(sessionId);
    this.bufferManager.removeSession(sessionId);
    this.usageTracker.removeSession(sessionId);
    this.firstOutputEmitted.delete(sessionId);
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
      ptyRef.kill();
    }
    // Remove from queue if queued, and mark as exited
    if (this.sessionQueue.remove(sessionId) && session) {
      session.status = 'exited';
      session.exitCode = -1;
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
    // Already dead or never spawned - resolve immediately
    if (!session?.pty) return Promise.resolve();

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
      if (!this.sessions.get(sessionId)?.pty) {
        clearTimeout(safetyTimeout);
        this.removeListener('exit', onExit);
        resolve();
      }
    });
  }

  /**
   * Suspend a session: kill the PTY but preserve session files on disk
   * so the session can be resumed later (e.g. from archived/backlog state).
   *
   * Unlike kill(), the onExit handler will NOT clean up files because
   * file paths are nulled before the PTY is destroyed.
   */
  suspend(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Close watchers - no longer need real-time updates
    this.fileWatcher.stopAll(sessionId);

    // Null out file paths BEFORE killing so the onExit handler's
    // cleanup skips file deletion - files persist for resume
    this.fileWatcher.nullifyPaths(sessionId);

    // Synthetic session_end before we kill - Claude Code's hook won't fire
    this.usageTracker.emitSessionEnd(sessionId);

    // Clear subagent depth - session is no longer active
    this.usageTracker.clearSessionTracking(sessionId);

    // Mark suspended BEFORE killing so the async onExit handler preserves it
    session.status = 'suspended';

    if (session.pty) {
      const ptyRef = session.pty;
      session.pty = null; // prevent double-kill (conpty heap corruption on Windows)
      ptyRef.kill();
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

  /** Return cached activity state for all sessions (survives renderer reloads). */
  getActivityCache(): Record<string, ActivityState> {
    return this.usageTracker.getActivityCache();
  }

  /** Return cached events for a specific session (survives renderer reloads). */
  getEventsForSession(sessionId: string): SessionEvent[] {
    return this.usageTracker.getEventsForSession(sessionId);
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

        // Ask Claude Code to exit gracefully: Ctrl+C interrupts any
        // in-progress operation, then /exit triggers a clean shutdown
        // that flushes the JSONL conversation file.
        try {
          session.pty.write('\x03');
          session.pty.write('/exit\r');
        } catch {
          // PTY may already be dead
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

      if (session.pty) {
        const ptyRef = session.pty;
        session.pty = null;
        // Null file paths before kill so onExit doesn't clean them up
        this.fileWatcher.nullifyPaths(session.id);
        try { ptyRef.kill(); } catch { /* already dead */ }
      }
    }

    return taskIds;
  }

  killAll(): void {
    for (const session of this.sessions.values()) {
      if (session.pty) {
        const ptyRef = session.pty;
        session.pty = null; // prevent double-kill (conpty heap corruption on Windows)
        ptyRef.kill();
      }
      // Clean up watchers and files
      this.fileWatcher.cleanupAndRemove(session.id);
    }
    this.sessions.clear();
    this.sessionQueue.clear();
    this.firstOutputEmitted.clear();
  }
}
