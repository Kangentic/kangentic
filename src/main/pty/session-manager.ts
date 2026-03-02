import fs from 'node:fs';
import * as pty from 'node-pty';
import { EventEmitter } from 'node:events';
import { v4 as uuidv4 } from 'uuid';
import { ShellResolver } from './shell-resolver';
import { SessionQueue } from './session-queue';
import { ClaudeStatusParser } from '../agent/claude-status-parser';
import { adaptCommandForShell } from '../../shared/paths';
import type { Session, SessionStatus, SessionUsage, ActivityState, SessionEvent, SpawnSessionInput } from '../../shared/types';

const MAX_SCROLLBACK = 512 * 1024; // 512KB per session
const MAX_EVENTS_PER_SESSION = 500; // Cap rendered events in renderer

interface ManagedSession {
  id: string;
  taskId: string;
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
  statusWatcher: fs.FSWatcher | null;
  eventsOutputPath: string | null;
  eventsWatcher: fs.FSWatcher | null;
  eventsFileOffset: number;
  mergedSettingsPath: string | null;
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, ManagedSession>();
  private sessionQueue: SessionQueue;
  private shellResolver = new ShellResolver();
  private configuredShell: string | null = null;
  private usageCache = new Map<string, SessionUsage>();
  private activityCache = new Map<string, ActivityState>();
  private eventCache = new Map<string, SessionEvent[]>();

  constructor() {
    super();
    this.sessionQueue = new SessionQueue({
      spawner: (input) => this.doSpawn(input).then(() => {}),
      getActiveCount: () => this.activeCount,
      maxConcurrent: 5,
    });
  }

  setMaxConcurrent(max: number): void {
    this.sessionQueue.setMaxConcurrent(max);
  }

  setShell(shell: string | null): void {
    this.configuredShell = shell;
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
        statusWatcher: null,
        eventsOutputPath: input.eventsOutputPath || null,
        eventsWatcher: null,
        eventsFileOffset: 0,
        mergedSettingsPath: null,
      };
      this.sessions.set(id, session);
      this.sessionQueue.enqueue(input, id);
      this.emit('status', id, 'queued');
      return this.toSession(session);
    }

    return this.doSpawn(input);
  }

  private async doSpawn(input: SpawnSessionInput): Promise<Session> {
    const shell = this.configuredShell || await this.shellResolver.getDefaultShell();
    const existing = input.taskId ? this.findByTaskId(input.taskId) : null;
    const id = existing?.id || uuidv4();

    // Kill any existing PTY for this task to prevent orphaned processes
    // that would emit data with the same session ID (double output).
    if (existing?.pty) {
      const ptyRef = existing.pty;
      existing.pty = null;
      ptyRef.kill();
    }

    // Stop any existing watchers for this task
    if (existing?.statusWatcher) {
      existing.statusWatcher.close();
      existing.statusWatcher = null;
    }
    if (existing?.eventsWatcher) {
      existing.eventsWatcher.close();
      existing.eventsWatcher = null;
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

    // Carry over scrollback from the previous session so the terminal
    // shows the full conversation history when a session is resumed.
    const previousScrollback = existing?.scrollback || '';

    // Determine shell args and actual executable based on shell type
    const shellName = shell.toLowerCase();
    let shellExe = shell;
    let shellArgs: string[];

    if (shellName.startsWith('wsl ')) {
      // WSL: e.g. "wsl -d Ubuntu" — split into exe + args
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
      // PTY spawn failed — return a dead session so the renderer sees
      // a failed session instead of crashing the main process
      const failedSession: ManagedSession = {
        id,
        taskId: input.taskId,
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
        statusWatcher: null,
        eventsOutputPath: input.eventsOutputPath || null,
        eventsWatcher: null,
        eventsFileOffset: 0,
        mergedSettingsPath: null,
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
      statusWatcher: null,
      eventsOutputPath: input.eventsOutputPath || null,
      eventsWatcher: null,
      eventsFileOffset: 0,
      mergedSettingsPath,
    };

    this.sessions.set(id, session);

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
    this.emit('activity', id, 'idle');

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
      // Don't overwrite 'suspended' — suspend() sets that before killing PTY
      if (session.status !== 'suspended') {
        session.status = 'exited';
      }
      session.exitCode = exitCode;
      session.pty = null;

      // Stop the usage watcher and clean up status/settings files
      this.cleanupSessionFiles(session);

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
    // A slot may have opened — let the queue promote
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

    // Close watchers — no longer need real-time updates
    if (session.statusWatcher) {
      session.statusWatcher.close();
      session.statusWatcher = null;
    }
    if (session.eventsWatcher) {
      session.eventsWatcher.close();
      session.eventsWatcher = null;
    }

    // Null out file paths BEFORE killing so the onExit handler's
    // cleanupSessionFiles() skips file deletion — files persist for resume
    session.statusOutputPath = null;
    session.eventsOutputPath = null;
    session.mergedSettingsPath = null;

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
      pid: s.pty?.pid ?? null,
      status: s.status,
      shell: s.shell,
      cwd: s.cwd,
      startedAt: s.startedAt,
      exitCode: s.exitCode,
    };
  }

  // ---------------------------------------------------------------------------
  // Status file watching (Claude Code usage data)
  // ---------------------------------------------------------------------------

  /**
   * Start watching a session's status output file for usage data updates.
   * Claude Code writes JSON to this file via our bridge script on each
   * status line update.
   */
  private startUsageWatcher(session: ManagedSession): void {
    if (!session.statusOutputPath) return;

    // Debounce: fs.watch can fire multiple events for a single write
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const readAndEmit = () => {
      try {
        const raw = fs.readFileSync(session.statusOutputPath!, 'utf-8');
        const usage = ClaudeStatusParser.parseStatus(raw);
        if (!usage) return;

        this.usageCache.set(session.id, usage);
        this.emit('usage', session.id, usage);
      } catch {
        // File may not exist yet — ignore
      }
    };

    try {
      const watcher = fs.watch(session.statusOutputPath, () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(readAndEmit, 100);
      });

      watcher.on('error', () => {
        // Watcher may fail if file is deleted — that's OK
      });

      session.statusWatcher = watcher;
    } catch {
      // File may not exist yet; try polling on the directory instead
      const dir = session.statusOutputPath.replace(/[/\\][^/\\]+$/, '');
      try {
        const watcher = fs.watch(dir, (eventType, filename) => {
          if (!filename) return;
          const expected = session.statusOutputPath!.replace(/^.*[/\\]/, '');
          if (filename === expected) {
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(readAndEmit, 100);
          }
        });

        watcher.on('error', () => {
          // ignore
        });

        session.statusWatcher = watcher;
      } catch {
        // Can't watch — no usage data for this session
      }
    }
  }

  /**
   * Start watching a session's events JSONL file for activity log events.
   * Claude Code hooks write JSON lines to this file via our event bridge script.
   * Only reads new bytes appended since the last read (offset tracking).
   */
  private startEventWatcher(session: ManagedSession): void {
    if (!session.eventsOutputPath) return;

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    // Truncate existing file on resume — historical events aren't needed
    try {
      fs.writeFileSync(session.eventsOutputPath, '');
    } catch {
      // File may not exist yet — that's OK, bridge will create it
    }

    const readNewLines = () => {
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
            events.push(event);
            this.emit('event', session.id, event);

            // Derive activity state from events — the event-bridge
            // fires for ALL tools via blank PreToolUse matcher.
            // Only emit when state actually changes (dedup defense-in-depth
            // against multiple hooks firing the same state, e.g. Stop +
            // PermissionRequest both emitting idle).
            if (event.type === 'tool_start' || event.type === 'prompt') {
              if (this.activityCache.get(session.id) !== 'thinking') {
                this.activityCache.set(session.id, 'thinking');
                this.emit('activity', session.id, 'thinking');
              }
            } else if (event.type === 'idle' || event.type === 'interrupted') {
              if (this.activityCache.get(session.id) !== 'idle') {
                this.activityCache.set(session.id, 'idle');
                this.emit('activity', session.id, 'idle');
              }
            }
          }
        }

        // Cap cached events per session
        if (events.length > MAX_EVENTS_PER_SESSION) {
          const trimmed = events.slice(-MAX_EVENTS_PER_SESSION);
          this.eventCache.set(session.id, trimmed);
        }
      } catch {
        // File may not exist yet, or be partially written — ignore
      }
    };

    try {
      const watcher = fs.watch(session.eventsOutputPath, () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(readNewLines, 50);
      });

      watcher.on('error', () => {});
      session.eventsWatcher = watcher;
    } catch {
      // File may not exist yet; try polling on the directory instead
      const dir = session.eventsOutputPath.replace(/[/\\][^/\\]+$/, '');
      try {
        const watcher = fs.watch(dir, (eventType, filename) => {
          if (!filename) return;
          const expected = session.eventsOutputPath!.replace(/^.*[/\\]/, '');
          if (filename === expected) {
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(readNewLines, 50);
          }
        });

        watcher.on('error', () => {});
        session.eventsWatcher = watcher;
      } catch {
        // Can't watch — no events data for this session
      }
    }
  }

  /**
   * Stop watchers and clean up status + events + merged settings files.
   */
  private cleanupSessionFiles(session: ManagedSession): void {
    if (session.statusWatcher) {
      session.statusWatcher.close();
      session.statusWatcher = null;
    }
    if (session.eventsWatcher) {
      session.eventsWatcher.close();
      session.eventsWatcher = null;
    }
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

    for (const session of this.sessions.values()) {
      if (session.pty && session.status === 'running') {
        taskIds.push(session.taskId);

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

    // Wait for graceful exit, then force-kill any remaining
    if (ptysToKill.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, timeoutMs));
    }
    for (const session of this.sessions.values()) {
      // Close watchers but preserve session files — sessions will be
      // resumed on next app launch via session recovery
      if (session.statusWatcher) {
        session.statusWatcher.close();
        session.statusWatcher = null;
      }
      if (session.eventsWatcher) {
        session.eventsWatcher.close();
        session.eventsWatcher = null;
      }

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
