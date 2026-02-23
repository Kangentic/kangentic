import fs from 'node:fs';
import * as pty from 'node-pty';
import { EventEmitter } from 'node:events';
import { v4 as uuidv4 } from 'uuid';
import { ShellResolver } from './shell-resolver';
import { adaptCommandForShell } from '../../shared/paths';
import type { Session, SessionStatus, SessionUsage, SpawnSessionInput } from '../../shared/types';

const MAX_SCROLLBACK = 512 * 1024; // 512KB per session

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
  mergedSettingsPath: string | null;
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, ManagedSession>();
  private queue: Array<{ input: SpawnSessionInput; sessionId: string }> = [];
  private maxConcurrent = 5;
  private shellResolver = new ShellResolver();
  private configuredShell: string | null = null;
  private usageCache = new Map<string, SessionUsage>();

  setMaxConcurrent(max: number): void {
    this.maxConcurrent = max;
    this.processQueue();
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
    return this.queue.length;
  }

  async spawn(input: SpawnSessionInput): Promise<Session> {
    if (this.activeCount >= this.maxConcurrent) {
      // Return a queued placeholder immediately (don't block the caller).
      // processQueue() will upgrade it to a running PTY when a slot opens.
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
        mergedSettingsPath: null,
      };
      this.sessions.set(id, session);
      this.queue.push({ input, sessionId: id });
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

    // Stop any existing status watcher for this task
    if (existing?.statusWatcher) {
      existing.statusWatcher.close();
      existing.statusWatcher = null;
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

    const ptyProcess = pty.spawn(shellExe, shellArgs, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: input.cwd,
      env: { ...process.env, ...input.env } as Record<string, string>,
    });

    // Derive merged settings path from statusOutputPath pattern
    // statusOutputPath = <project>/.kangentic/status/<sessionId>.json
    // mergedSettingsPath = <project>/.kangentic/claude-settings-<sessionId>.json
    let mergedSettingsPath: string | null = null;
    if (input.statusOutputPath) {
      const statusDir = input.statusOutputPath.replace(/[/\\][^/\\]+$/, '');
      const kangenticDir = statusDir.replace(/[/\\]status$/, '');
      const basename = input.statusOutputPath.replace(/^.*[/\\]/, '').replace(/\.json$/, '');
      mergedSettingsPath = kangenticDir + '/claude-settings-' + basename + '.json';
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
      mergedSettingsPath,
    };

    this.sessions.set(id, session);

    // Start watching the status output file for usage data
    if (input.statusOutputPath) {
      this.startUsageWatcher(session);
    }

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
      session.status = 'exited';
      session.exitCode = exitCode;
      session.pty = null;

      // Stop the usage watcher and clean up status/settings files
      this.cleanupSessionFiles(session);

      this.emit('exit', id, exitCode);
      this.processQueue();
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

  kill(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.pty) {
      const ptyRef = session.pty;
      session.pty = null; // prevent double-kill (conpty heap corruption on Windows)
      ptyRef.kill();
    }
    // Also remove from queue
    const queueIdx = this.queue.findIndex(q => {
      const s = this.findByTaskId(q.input.taskId);
      return s?.id === sessionId;
    });
    if (queueIdx >= 0) {
      this.queue.splice(queueIdx, 1);
      if (session) {
        session.status = 'exited';
        session.exitCode = -1;
      }
    }
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

  private findByTaskId(taskId: string): ManagedSession | undefined {
    for (const s of this.sessions.values()) {
      if (s.taskId === taskId) return s;
    }
    return undefined;
  }

  private async processQueue(): Promise<void> {
    while (this.queue.length > 0 && this.activeCount < this.maxConcurrent) {
      const next = this.queue.shift();
      if (next) {
        // doSpawn will find the placeholder by taskId and upgrade it in-place
        await this.doSpawn(next.input);
      }
    }
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
        const data = JSON.parse(raw);
        const usage: SessionUsage = {
          contextWindow: {
            usedPercentage: data.context_window?.used_percentage ?? 0,
            totalInputTokens: data.context_window?.total_input_tokens ?? 0,
            totalOutputTokens: data.context_window?.total_output_tokens ?? 0,
            contextWindowSize: data.context_window?.context_window_size ?? 0,
          },
          cost: {
            totalCostUsd: data.cost?.total_cost_usd ?? 0,
            totalDurationMs: data.cost?.total_duration_ms ?? 0,
          },
          model: {
            id: data.model?.id ?? '',
            displayName: data.model?.display_name ?? '',
          },
        };
        this.usageCache.set(session.id, usage);
        this.emit('usage', session.id, usage);
      } catch {
        // File may not exist yet, or be partially written — ignore
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
   * Stop the status watcher and clean up status + merged settings files.
   */
  private cleanupSessionFiles(session: ManagedSession): void {
    if (session.statusWatcher) {
      session.statusWatcher.close();
      session.statusWatcher = null;
    }

    // Clean up status JSON file
    if (session.statusOutputPath) {
      try { fs.unlinkSync(session.statusOutputPath); } catch { /* may not exist */ }
    }

    // Clean up merged settings file
    if (session.mergedSettingsPath) {
      try { fs.unlinkSync(session.mergedSettingsPath); } catch { /* may not exist */ }
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
    this.queue.length = 0;

    // Wait for graceful exit, then force-kill any remaining
    if (ptysToKill.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, timeoutMs));
    }
    for (const session of this.sessions.values()) {
      if (session.pty) {
        const ptyRef = session.pty;
        session.pty = null;
        try { ptyRef.kill(); } catch { /* already dead */ }
      }
      // Clean up watchers and files
      this.cleanupSessionFiles(session);
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
    this.queue.length = 0;
  }
}
