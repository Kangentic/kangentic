import fs from 'node:fs';
import * as pty from 'node-pty';
import { EventEmitter } from 'node:events';
import { v4 as uuidv4 } from 'uuid';
import { ShellResolver } from './shell-resolver';
import { SessionQueue } from './session-queue';
import { FileWatcher } from './file-watcher';
import { ClaudeStatusParser } from '../agent/claude-status-parser';
import { adaptCommandForShell } from '../../shared/paths';
import { EventType, EventTypeActivity, ClaudeTool } from '../../shared/types';
import type { Session, SessionStatus, SessionUsage, ActivityState, SessionEvent, SpawnSessionInput } from '../../shared/types';

const MAX_SCROLLBACK = 512 * 1024; // 512KB per session
const MAX_EVENTS_PER_SESSION = 500; // Cap rendered events in renderer
const STALE_THINKING_THRESHOLD_MS = 45_000;
const STALE_THINKING_CHECK_MS = 15_000;

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
  buffer: string;
  flushScheduled: boolean;
  scrollback: string;
  statusOutputPath: string | null;
  eventsOutputPath: string | null;
  eventsFileOffset: number;
  mergedSettingsPath: string | null;
  statusFileWatcher: FileWatcher | null;
  eventsFileWatcher: FileWatcher | null;
  resuming: boolean;
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, ManagedSession>();
  private sessionQueue: SessionQueue;
  private shellResolver = new ShellResolver();
  private configuredShell: string | null = null;
  private usageCache = new Map<string, SessionUsage>();
  private activityCache = new Map<string, ActivityState>();
  private subagentDepth = new Map<string, number>();
  private pendingToolCount = new Map<string, number>();
  private pendingIdleWhileSubagent = new Map<string, boolean>();
  private permissionIdle = new Map<string, boolean>();
  private idleTimestamp = new Map<string, number>();
  private lastThinkingSignal = new Map<string, number>();

  private eventCache = new Map<string, SessionEvent[]>();
  private idleTimeoutMinutes = 0;
  private idleTimeoutInterval: ReturnType<typeof setInterval> | null = null;
  private staleThinkingInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    super();
    this.sessionQueue = new SessionQueue({
      spawner: (input) => this.doSpawn(input).then(() => {}),
      getActiveCount: () => this.activeCount,
      maxConcurrent: 5,
    });
    this.staleThinkingInterval = setInterval(
      () => this.checkStaleThinking(),
      STALE_THINKING_CHECK_MS,
    );
    this.staleThinkingInterval.unref();
  }

  setMaxConcurrent(max: number): void {
    this.sessionQueue.setMaxConcurrent(max);
  }

  setIdleTimeout(minutes: number): void {
    this.idleTimeoutMinutes = minutes;

    // Clear existing interval
    if (this.idleTimeoutInterval) {
      clearInterval(this.idleTimeoutInterval);
      this.idleTimeoutInterval = null;
    }

    // Start checking every 60s if timeout is enabled.
    // unref() ensures this interval doesn't keep the process alive during shutdown.
    if (minutes > 0) {
      this.idleTimeoutInterval = setInterval(() => this.checkIdleTimeouts(), 60_000);
      this.idleTimeoutInterval.unref();
    }
  }

  private checkIdleTimeouts(): void {
    if (this.idleTimeoutMinutes <= 0) return;

    const timeoutMs = this.idleTimeoutMinutes * 60_000;
    const now = Date.now();

    for (const [sessionId, activity] of this.activityCache) {
      if (activity !== 'idle') continue;
      const session = this.sessions.get(sessionId);
      if (!session || session.status !== 'running') continue;

      const idleStart = this.idleTimestamp.get(sessionId);
      if (idleStart && (now - idleStart) > timeoutMs) {
        this.suspend(sessionId);
        this.emit('idle-timeout', sessionId, session.taskId, this.idleTimeoutMinutes);
      }
    }
  }

  private checkStaleThinking(): void {
    const now = Date.now();
    for (const [sessionId, activity] of this.activityCache) {
      if (activity !== 'thinking') continue;
      const session = this.sessions.get(sessionId);
      if (!session || session.status !== 'running') continue;

      // Skip sessions that haven't received usage data yet (still nucleating).
      // During nucleation, Claude Code reads local context before making API calls.
      // No hooks fire and no status.json exists, so the 45s threshold doesn't apply.
      if (!this.usageCache.has(sessionId)) continue;

      const lastSignal = this.lastThinkingSignal.get(sessionId);
      if (lastSignal && (now - lastSignal) > STALE_THINKING_THRESHOLD_MS) {
        // If tools are in-flight, the agent is busy (not stale). Reset the
        // timer and re-check later instead of transitioning to idle.
        if ((this.pendingToolCount.get(sessionId) || 0) > 0) {
          this.lastThinkingSignal.set(sessionId, now);
          continue;
        }

        this.activityCache.set(sessionId, 'idle');
        this.permissionIdle.set(sessionId, false);
        this.idleTimestamp.set(sessionId, Date.now());
        this.lastThinkingSignal.delete(sessionId);

        // Emit a synthetic idle event so the activity log shows why it went idle
        const timeoutEvent: SessionEvent = { ts: Date.now(), type: EventType.Idle, detail: 'timeout' };
        let events = this.eventCache.get(sessionId);
        if (!events) {
          events = [];
          this.eventCache.set(sessionId, events);
        }
        events.push(timeoutEvent);
        this.emit('event', sessionId, timeoutEvent);

        this.emit('activity', sessionId, 'idle', false);
      }
    }
  }

  dispose(): void {
    if (this.idleTimeoutInterval) {
      clearInterval(this.idleTimeoutInterval);
      this.idleTimeoutInterval = null;
    }
    if (this.staleThinkingInterval) {
      clearInterval(this.staleThinkingInterval);
      this.staleThinkingInterval = null;
    }
  }

  setShell(shell: string | null): void {
    this.configuredShell = shell;
  }

  /** Return the resolved shell name (configured or system default). */
  async getShell(): Promise<string> {
    return this.configuredShell || await this.shellResolver.getDefaultShell();
  }

  private get activeCount(): number {
    let count = 0;
    for (const s of this.sessions.values()) {
      if (s.status === 'running') count++;
    }
    return count;
  }

  get queuedCount(): number {
    return this.sessionQueue.length;
  }

  async spawn(input: SpawnSessionInput): Promise<Session> {
    if (this.sessionQueue.shouldQueue()) {
      // Return a queued placeholder immediately (don't block the caller).
      // SessionQueue will promote it to a running PTY when a slot opens.
      const id = uuidv4();
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
        buffer: '',
        flushScheduled: false,
        scrollback: '',
        statusOutputPath: input.statusOutputPath || null,
        eventsOutputPath: input.eventsOutputPath || null,
        eventsFileOffset: 0,
        mergedSettingsPath: null,
        statusFileWatcher: null,
        eventsFileWatcher: null,
        resuming: false,
      };
      this.sessions.set(id, session);
      this.sessionQueue.enqueue(input, id);
      this.emit('status', id, 'queued');
      return this.toSession(session);
    }

    return this.doSpawn(input);
  }

  private async doSpawn(input: SpawnSessionInput): Promise<Session> {
    const shell = await this.getShell();
    const existing = input.taskId ? this.findByTaskId(input.taskId) : null;

    // Always use a fresh UUID so the renderer treats respawns as new
    // sessions (TerminalTab is keyed by session ID -- a new ID forces a
    // clean remount with the loading overlay and data suppression).
    const id = uuidv4();

    // Kill any existing PTY for this task to prevent orphaned processes
    // that would emit data with the same session ID (double output).
    if (existing?.pty) {
      const ptyRef = existing.pty;
      existing.pty = null;
      ptyRef.kill();
    }

    // Stop any existing watchers for this task
    if (existing) {
      existing.statusFileWatcher?.close();
      existing.statusFileWatcher = null;
      existing.eventsFileWatcher?.close();
      existing.eventsFileWatcher = null;
    }

    // Null out file paths on the old session object to prevent its
    // onExit callback (which runs asynchronously after ptyRef.kill())
    // from deleting files that the new session will create at the same
    // paths. This race occurs when resuming a session: the old and new
    // sessions share the same claudeSessionId, so the merged settings,
    // status, and events files all resolve to the same path.
    if (existing) {
      existing.mergedSettingsPath = null;
      existing.statusOutputPath = null;
      existing.eventsOutputPath = null;
    }

    // Remove old session from map and caches so findByTaskId returns
    // the new session, and stale usage/activity data doesn't persist.
    if (existing) {
      this.sessions.delete(existing.id);
      this.usageCache.delete(existing.id);
      this.activityCache.delete(existing.id);
      this.subagentDepth.delete(existing.id);
      this.pendingToolCount.delete(existing.id);
      this.pendingIdleWhileSubagent.delete(existing.id);
      this.permissionIdle.delete(existing.id);
      this.idleTimestamp.delete(existing.id);
    }

    // Carry over scrollback from the previous session so the terminal
    // shows the full conversation history when a session is resumed.
    const previousScrollback = existing?.scrollback || '';

    // Determine shell args and actual executable based on shell type
    const shellName = shell.toLowerCase();
    let shellExe = shell;
    let shellArgs: string[];

    if (shellName.startsWith('wsl ')) {
      // WSL: e.g. "wsl -d Ubuntu" -- split into exe + args
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

    let ptyProcess: pty.IPty;
    try {
      ptyProcess = pty.spawn(shellExe, shellArgs, {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: input.cwd,
        env: cleanEnv as Record<string, string>,
      });
    } catch (err) {
      // PTY spawn failed -- return a dead session so the renderer sees
      // a failed session instead of crashing the main process
      const failedSession: ManagedSession = {
        id,
        taskId: input.taskId,
        projectId: input.projectId,
        pty: null,
        status: 'exited',
        shell,
        cwd: input.cwd,
        startedAt: new Date().toISOString(),
        exitCode: -1,
        buffer: '',
        flushScheduled: false,
        scrollback: previousScrollback,
        statusOutputPath: input.statusOutputPath || null,
        eventsOutputPath: input.eventsOutputPath || null,
        eventsFileOffset: 0,
        mergedSettingsPath: null,
        statusFileWatcher: null,
        eventsFileWatcher: null,
        resuming: input.resuming ?? false,
      };
      this.sessions.set(id, failedSession);
      this.emit('exit', id, -1);
      return this.toSession(failedSession);
    }

    // Derive merged settings path from statusOutputPath pattern
    // statusOutputPath = <project>/.kangentic/sessions/<sessionId>/status.json
    // mergedSettingsPath = <project>/.kangentic/sessions/<sessionId>/settings.json
    let mergedSettingsPath: string | null = null;
    if (input.statusOutputPath) {
      const sessionDir = input.statusOutputPath.replace(/[/\\][^/\\]+$/, '');
      mergedSettingsPath = sessionDir + '/settings.json';
    }

    const session: ManagedSession = {
      id,
      taskId: input.taskId,
      projectId: existing?.projectId || input.projectId,
      pty: ptyProcess,
      status: 'running',
      shell,
      cwd: input.cwd,
      startedAt: new Date().toISOString(),
      exitCode: null,
      buffer: '',
      flushScheduled: false,
      scrollback: previousScrollback,
      statusOutputPath: input.statusOutputPath || null,
      eventsOutputPath: input.eventsOutputPath || null,
      eventsFileOffset: 0,
      mergedSettingsPath,
      statusFileWatcher: null,
      eventsFileWatcher: null,
      resuming: input.resuming ?? false,
    };

    this.sessions.set(id, session);

    // Delete stale status.json so the usage watcher doesn't emit
    // cached data from the previous session run. Claude CLI will
    // write fresh usage data when it's ready.
    if (input.statusOutputPath) {
      try { fs.unlinkSync(input.statusOutputPath); } catch { /* may not exist yet */ }
    }

    // Start watching the status output file for usage data
    if (input.statusOutputPath) {
      this.startUsageWatcher(session);
    }

    // Start watching the events JSONL file for activity log
    if (input.eventsOutputPath) {
      this.startEventWatcher(session);
    }

    // Default activity to 'idle'. The 'thinking' state is only set when
    // a Claude Code hook (UserPromptSubmit) explicitly fires. This avoids
    // perpetual spinners when hooks don't work in a given environment.
    // The "Initializing..." bar on the task card handles the visual
    // feedback during startup (before usage data arrives).
    this.activityCache.set(id, 'idle');
    this.subagentDepth.delete(id);
    this.pendingToolCount.delete(id);
    this.pendingIdleWhileSubagent.delete(id);
    this.permissionIdle.delete(id);
    this.idleTimestamp.set(id, Date.now());
    this.lastThinkingSignal.delete(id);

    this.emit('activity', id, 'idle', false);

    // Batched data output (~60fps)
    ptyProcess.onData((data: string) => {
      session.buffer += data;
      // Accumulate scrollback for late-connecting terminals
      session.scrollback += data;
      if (session.scrollback.length > MAX_SCROLLBACK) {
        session.scrollback = session.scrollback.slice(-MAX_SCROLLBACK);
      }
      if (!session.flushScheduled) {
        session.flushScheduled = true;
        setTimeout(() => {
          // Guard: session may have been removed from the map during the 16ms window
          const current = this.sessions.get(id);
          if (current && current.buffer) {
            this.emit('data', id, current.buffer);
            current.buffer = '';
          }
          if (current) current.flushScheduled = false;
        }, 16);
      }
    });

    ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
      // Don't overwrite 'suspended' -- suspend() sets that before killing PTY
      if (session.status !== 'suspended') {
        session.status = 'exited';
        // Synthetic session_end -- Claude Code's hook won't fire on kill
        this.emitSessionEnd(id);
      }
      session.exitCode = exitCode;
      session.pty = null;

      // Close watchers but preserve session files on disk -- they are needed
      // for crash recovery (startUsageWatcher reads status.json on resume).
      // Files are cleaned up by pruneStaleResources(), remove(), or killAll().
      session.statusFileWatcher?.close();
      session.statusFileWatcher = null;
      session.eventsFileWatcher?.close();
      session.eventsFileWatcher = null;

      this.emit('exit', id, exitCode);
      this.sessionQueue.notifySlotFreed();
    });

    this.emit('status', id, 'running');

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
    if (session?.pty) {
      session.pty.write(data);
    }
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId);
    if (session?.pty) {
      session.pty.resize(cols, rows);
    }
  }

  /**
   * Fully remove a session from all internal maps: kill the PTY, clean up
   * session files, and delete from sessions/usage/activity caches.
   * Used during project deletion to prevent cross-project bleed.
   */
  remove(sessionId: string): void {
    this.kill(sessionId);
    const session = this.sessions.get(sessionId);
    if (session) {
      this.cleanupSessionFiles(session);
    }
    this.sessions.delete(sessionId);
    this.usageCache.delete(sessionId);
    this.activityCache.delete(sessionId);
    this.subagentDepth.delete(sessionId);
    this.pendingToolCount.delete(sessionId);
    this.pendingIdleWhileSubagent.delete(sessionId);
    this.permissionIdle.delete(sessionId);
    this.idleTimestamp.delete(sessionId);
    this.lastThinkingSignal.delete(sessionId);

    this.eventCache.delete(sessionId);
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
    // A slot may have opened -- let the queue promote
    this.sessionQueue.notifySlotFreed();
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

    // Close watchers -- no longer need real-time updates
    session.statusFileWatcher?.close();
    session.statusFileWatcher = null;
    session.eventsFileWatcher?.close();
    session.eventsFileWatcher = null;

    // Null out file paths BEFORE killing so the onExit handler's
    // cleanupSessionFiles() skips file deletion -- files persist for resume
    session.statusOutputPath = null;
    session.eventsOutputPath = null;
    session.mergedSettingsPath = null;

    // Synthetic session_end before we kill -- Claude Code's hook won't fire
    this.emitSessionEnd(sessionId);

    // Clear subagent depth -- session is no longer active
    this.subagentDepth.delete(sessionId);
    this.pendingToolCount.delete(sessionId);
    this.pendingIdleWhileSubagent.delete(sessionId);
    this.permissionIdle.delete(sessionId);
    this.idleTimestamp.delete(sessionId);
    this.lastThinkingSignal.delete(sessionId);


    // Mark suspended BEFORE killing so the async onExit handler preserves it
    session.status = 'suspended';

    if (session.pty) {
      const ptyRef = session.pty;
      session.pty = null; // prevent double-kill (conpty heap corruption on Windows)
      ptyRef.kill();
    }

    this.emit('status', sessionId, 'suspended');

    // Remove from queue (queued sessions have no PTY yet) and promote
    this.sessionQueue.remove(sessionId);
    this.sessionQueue.notifySlotFreed();
  }

  getScrollback(sessionId: string): string {
    const session = this.sessions.get(sessionId);
    return session?.scrollback || '';
  }

  getSession(sessionId: string): Session | undefined {
    const s = this.sessions.get(sessionId);
    return s ? this.toSession(s) : undefined;
  }

  listSessions(): Session[] {
    return Array.from(this.sessions.values()).map(s => this.toSession(s));
  }

  /** Return cached usage data for all sessions (survives renderer reloads). */
  getUsageCache(): Record<string, SessionUsage> {
    const result: Record<string, SessionUsage> = {};
    for (const [id, usage] of this.usageCache) {
      result[id] = usage;
    }
    return result;
  }

  /** Return cached activity state for all sessions (survives renderer reloads). */
  getActivityCache(): Record<string, ActivityState> {
    const result: Record<string, ActivityState> = {};
    for (const [id, state] of this.activityCache) {
      result[id] = state;
    }
    return result;
  }

  /** Return cached events for a specific session (survives renderer reloads). */
  getEventsForSession(sessionId: string): SessionEvent[] {
    return this.eventCache.get(sessionId) || [];
  }

  /** Return cached events for all sessions (survives renderer reloads). */
  getEventsCache(): Record<string, SessionEvent[]> {
    const result: Record<string, SessionEvent[]> = {};
    for (const [id, events] of this.eventCache) {
      result[id] = events;
    }
    return result;
  }

  /** Return cached usage data filtered to a specific project. */
  getUsageCacheForProject(projectId: string): Record<string, SessionUsage> {
    const result: Record<string, SessionUsage> = {};
    for (const [id, usage] of this.usageCache) {
      const session = this.sessions.get(id);
      if (session?.projectId === projectId) {
        result[id] = usage;
      }
    }
    return result;
  }

  /** Return cached activity state filtered to a specific project. */
  getActivityCacheForProject(projectId: string): Record<string, ActivityState> {
    const result: Record<string, ActivityState> = {};
    for (const [id, state] of this.activityCache) {
      const session = this.sessions.get(id);
      if (session?.projectId === projectId) {
        result[id] = state;
      }
    }
    return result;
  }

  /** Return cached events filtered to a specific project. */
  getEventsCacheForProject(projectId: string): Record<string, SessionEvent[]> {
    const result: Record<string, SessionEvent[]> = {};
    for (const [id, events] of this.eventCache) {
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
   * Inject a synthetic session_end event into the event cache and emit it.
   * Claude Code's SessionEnd hook won't fire when we kill the PTY, so we
   * synthesize one ourselves so the activity log always shows session end.
   */
  private emitSessionEnd(sessionId: string): void {
    let events = this.eventCache.get(sessionId);
    // Skip if the last event is already session_end (Claude Code may have fired it)
    if (events && events.length > 0 && events[events.length - 1].type === EventType.SessionEnd) {
      return;
    }
    const event: SessionEvent = { ts: Date.now(), type: EventType.SessionEnd };
    if (!events) {
      events = [];
      this.eventCache.set(sessionId, events);
    }
    events.push(event);
    this.emit('event', sessionId, event);
  }

  private findByTaskId(taskId: string): ManagedSession | undefined {
    for (const s of this.sessions.values()) {
      if (s.taskId === taskId) return s;
    }
    return undefined;
  }

  private toSession(s: ManagedSession): Session {
    return {
      id: s.id,
      taskId: s.taskId,
      projectId: s.projectId,
      pid: s.pty?.pid ?? null,
      status: s.status,
      shell: s.shell,
      cwd: s.cwd,
      startedAt: s.startedAt,
      exitCode: s.exitCode,
      resuming: s.resuming,
    };
  }

  // ---------------------------------------------------------------------------
  // Status file watching (Claude Code usage data)
  // ---------------------------------------------------------------------------

  /**
   * Read and emit usage data from a session's status output file.
   * Shared by both the fs.watch callback and polling fallback.
   */
  private readAndEmitUsage(session: ManagedSession): void {
    if (!session.statusOutputPath) return;
    try {
      const raw = fs.readFileSync(session.statusOutputPath, 'utf-8');
      const usage = ClaudeStatusParser.parseStatus(raw);
      if (!usage) return;

      const previousUsage = this.usageCache.get(session.id);

      this.usageCache.set(session.id, usage);
      this.emit('usage', session.id, usage);

      // Usage update proves the agent is working. Reset stale thinking timer.
      if (this.activityCache.get(session.id) === 'thinking') {
        this.lastThinkingSignal.set(session.id, Date.now());
      }

      // Heartbeat recovery: if tokens increased while idle for >1s, agent resumed work.
      // During any true idle, the model is blocked and token counts are frozen.
      // Only when work genuinely resumes do tokens climb. The 1-second grace period
      // prevents race conditions from status updates arriving slightly after an idle event.
      if (previousUsage && this.activityCache.get(session.id) === 'idle') {
        const previousTokens = previousUsage.contextWindow.totalInputTokens
                             + previousUsage.contextWindow.totalOutputTokens;
        const currentTokens = usage.contextWindow.totalInputTokens
                            + usage.contextWindow.totalOutputTokens;
        const idleStart = this.idleTimestamp.get(session.id);
        if (currentTokens > previousTokens && idleStart && (Date.now() - idleStart) > 1000) {
          this.activityCache.set(session.id, 'thinking');
          this.lastThinkingSignal.set(session.id, Date.now());
          this.idleTimestamp.delete(session.id);
          this.permissionIdle.delete(session.id);
          this.emit('activity', session.id, 'thinking', false);
        }
      }
    } catch {
      // File may not exist yet -- ignore
    }
  }

  private startUsageWatcher(session: ManagedSession): void {
    if (!session.statusOutputPath) return;
    session.statusFileWatcher = new FileWatcher({
      filePath: session.statusOutputPath,
      onChange: () => this.readAndEmitUsage(session),
      label: `Usage:${session.id.slice(0, 8)}`,
      debounceMs: 100,
      initialGracePeriodMs: 15_000,
    });

    // Immediately read any existing status.json (e.g. resumed sessions after restart).
    // For fresh sessions the file won't exist yet -- readAndEmitUsage handles that gracefully.
    this.readAndEmitUsage(session);
  }

  /**
   * Read new lines from a session's events JSONL file and process them.
   * Shared by both the fs.watch callback and polling fallback.
   * Uses eventsFileOffset as cursor -- safe to call from multiple triggers.
   */
  private readAndProcessEvents(session: ManagedSession): void {
    if (!session.eventsOutputPath) return;
    try {
      const stat = fs.statSync(session.eventsOutputPath);
      if (stat.size <= session.eventsFileOffset) return;

      const fd = fs.openSync(session.eventsOutputPath, 'r');
      const buf = Buffer.alloc(stat.size - session.eventsFileOffset);
      fs.readSync(fd, buf, 0, buf.length, session.eventsFileOffset);
      fs.closeSync(fd);
      session.eventsFileOffset = stat.size;

      const chunk = buf.toString('utf-8');
      const lines = chunk.split('\n').filter(Boolean);

      // Get or create event cache for this session
      let events = this.eventCache.get(session.id);
      if (!events) {
        events = [];
        this.eventCache.set(session.id, events);
      }

      for (const line of lines) {
        const event = ClaudeStatusParser.parseEvent(line);
        if (event) {
          // Any event proves the agent is alive. Reset stale thinking timer.
          if (this.activityCache.get(session.id) === 'thinking') {
            this.lastThinkingSignal.set(session.id, Date.now());
          }

          events.push(event);
          this.emit('event', session.id, event);

          // Track pending tool count so checkStaleThinking() knows when
          // a long-running tool (e.g. npm run build) is legitimately active.
          if (event.type === EventType.ToolStart) {
            const currentCount = this.pendingToolCount.get(session.id) || 0;
            this.pendingToolCount.set(session.id, currentCount + 1);
          } else if (event.type === EventType.ToolEnd || event.type === EventType.Interrupted) {
            const currentCount = this.pendingToolCount.get(session.id) || 0;
            this.pendingToolCount.set(session.id, Math.max(0, currentCount - 1));
          }

          // Detect ExitPlanMode → emit plan-exit
          // Uses ToolStart (PreToolUse) because ExitPlanMode is a mode-transition
          // tool that may not fire PostToolUse (ToolEnd).
          if (event.type === EventType.ToolStart && event.tool === ClaudeTool.ExitPlanMode) {
            this.emit('plan-exit', session.id);
          }

          // Track subagent nesting depth so we can distinguish main-agent
          // tool events from subagent tool events during idle state.
          if (event.type === EventType.SubagentStart) {
            const currentDepth = this.subagentDepth.get(session.id) || 0;
            this.subagentDepth.set(session.id, currentDepth + 1);
          } else if (event.type === EventType.SubagentStop) {
            const currentDepth = this.subagentDepth.get(session.id) || 0;
            const newDepth = Math.max(0, currentDepth - 1);
            this.subagentDepth.set(session.id, newDepth);

            // Emit deferred idle when the last subagent finishes
            if (newDepth === 0 && this.pendingIdleWhileSubagent.get(session.id)) {
              this.pendingIdleWhileSubagent.delete(session.id);
              if (this.activityCache.get(session.id) !== 'idle') {
                this.activityCache.set(session.id, 'idle');
                this.emit('activity', session.id, 'idle', false);
              }
            }


          }

          // Derive activity state from events via declarative lookup.
          // Only emit when state actually changes (dedup defense-in-depth
          // against multiple hooks firing the same state, e.g. Stop +
          // PermissionRequest both emitting idle).
          const newActivity = EventTypeActivity[event.type];

          // Clear pending idle flag when the main agent resumes thinking
          // (prompt or subagent_start), even if deduped. This prevents a
          // stale deferred idle from firing when subagents finish.
          // Only prompt/subagent_start are reliable main-agent signals;
          // tool_start at depth > 0 could be from a subagent.
          if (newActivity === 'thinking'
              && (event.type === EventType.Prompt
                  || event.type === EventType.SubagentStart
                  || (this.subagentDepth.get(session.id) || 0) === 0)) {
            this.pendingIdleWhileSubagent.delete(session.id);
          }

          if (newActivity && this.activityCache.get(session.id) !== newActivity) {
            // Subagent-aware transition guard: when transitioning from
            // idle → thinking, suppress the transition if it's caused by
            // a subagent's tool event (not the main agent resuming).
            // - `prompt` always transitions (user responded)
            // - `subagent_start` always transitions (main agent spawning)
            // - depth 0 means no subagents, so the tool_start is from the
            //   main agent resuming after permission approval
            // - depth > 0 means subagents are running and this tool_start
            //   is likely from a subagent, not the main agent
            // Permission idle is also suppressed at depth > 0 -- recovery
            // happens naturally when depth returns to 0 (SubagentStop).
            const currentActivity = this.activityCache.get(session.id);
            const depth = this.subagentDepth.get(session.id) || 0;
            if (currentActivity === 'idle' && newActivity === 'thinking'
                && event.type !== EventType.Prompt
                && event.type !== EventType.SubagentStart
                && depth > 0) {
              // Suppress: subagent tool event while main agent is idle
              continue;
            }

            // Guard 2: thinking → idle suppression while subagents are active.
            // When the main agent fires Stop (idle) while subagents are running,
            // defer the idle transition until the last subagent finishes.
            if (currentActivity === 'thinking' && newActivity === 'idle'
                && event.type !== EventType.Interrupted
                && event.detail !== 'permission'
                && depth > 0) {
              this.pendingIdleWhileSubagent.set(session.id, true);
              continue;
            }

            // Clear stale pending idle when permission idle bypasses Guard 2
            if (newActivity === 'idle' && event.detail === 'permission') {
              this.pendingIdleWhileSubagent.delete(session.id);
            }

            this.activityCache.set(session.id, newActivity);

            // Track permission-idle flag and idle timestamp for recovery
            if (newActivity === 'idle') {
              this.lastThinkingSignal.delete(session.id);
              this.permissionIdle.set(session.id, event.detail === 'permission');
              this.idleTimestamp.set(session.id, Date.now());
            } else if (newActivity === 'thinking') {
              this.lastThinkingSignal.set(session.id, Date.now());
              this.permissionIdle.delete(session.id);
              this.idleTimestamp.delete(session.id);
            }

            this.emit('activity', session.id, newActivity, newActivity === 'idle' && event.detail === 'permission');
          }
        }
      }

      // Cap cached events per session
      if (events.length > MAX_EVENTS_PER_SESSION) {
        const trimmed = events.slice(-MAX_EVENTS_PER_SESSION);
        this.eventCache.set(session.id, trimmed);
      }
    } catch {
      // File may not exist yet, or be partially written -- ignore
    }
  }

  /**
   * Start watching a session's events JSONL file for activity log events.
   * Claude Code hooks write JSON lines to this file via our event bridge script.
   * Only reads new bytes appended since the last read (offset tracking).
   */
  private startEventWatcher(session: ManagedSession): void {
    if (!session.eventsOutputPath) return;

    // Truncate existing file on resume -- historical events aren't needed
    try {
      fs.writeFileSync(session.eventsOutputPath, '');
    } catch {
      // File may not exist yet -- that's OK, bridge will create it
    }

    const eventsPath = session.eventsOutputPath;
    session.eventsFileWatcher = new FileWatcher({
      filePath: eventsPath,
      onChange: () => this.readAndProcessEvents(session),
      label: `Event:${session.id.slice(0, 8)}`,
      debounceMs: 50,
      initialGracePeriodMs: 15_000,
      isStale: () => {
        try {
          const stat = fs.statSync(eventsPath);
          return stat.size > session.eventsFileOffset;
        } catch {
          return false;
        }
      },
    });
  }

  /**
   * Stop watchers and clean up status + events + merged settings files.
   */
  private cleanupSessionFiles(session: ManagedSession): void {
    session.statusFileWatcher?.close();
    session.statusFileWatcher = null;
    session.eventsFileWatcher?.close();
    session.eventsFileWatcher = null;
    // Clean up status JSON file
    if (session.statusOutputPath) {
      try { fs.unlinkSync(session.statusOutputPath); } catch { /* may not exist */ }
    }

    // Clean up events JSONL file
    if (session.eventsOutputPath) {
      try { fs.unlinkSync(session.eventsOutputPath); } catch { /* may not exist */ }
    }

    // Clean up merged settings file
    if (session.mergedSettingsPath) {
      try { fs.unlinkSync(session.mergedSettingsPath); } catch { /* may not exist */ }
    }

    // Try to remove the now-empty session directory
    if (session.statusOutputPath) {
      const sessionDir = session.statusOutputPath.replace(/[/\\][^/\\]+$/, '');
      try { fs.rmdirSync(sessionDir); } catch { /* dir may not be empty or already gone */ }
    }
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
      // Close watchers but preserve session files --
      // sessions will be resumed on next app launch via session recovery
      session.statusFileWatcher?.close();
      session.statusFileWatcher = null;
      session.eventsFileWatcher?.close();
      session.eventsFileWatcher = null;

      if (session.pty) {
        const ptyRef = session.pty;
        session.pty = null;
        // Null file paths before kill so onExit doesn't clean them up
        session.statusOutputPath = null;
        session.eventsOutputPath = null;
        session.mergedSettingsPath = null;
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
      this.cleanupSessionFiles(session);
    }
    this.sessions.clear();
    this.sessionQueue.clear();
  }
}
