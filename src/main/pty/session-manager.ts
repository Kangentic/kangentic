import * as pty from 'node-pty';
import { EventEmitter } from 'node:events';
import { v4 as uuidv4 } from 'uuid';
import { ShellResolver } from './shell-resolver';
import { adaptCommandForShell } from '../../shared/paths';
import type { Session, SessionStatus, SpawnSessionInput } from '../../shared/types';

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
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, ManagedSession>();
  private queue: Array<{ input: SpawnSessionInput; resolve: (session: Session) => void }> = [];
  private maxConcurrent = 5;
  private shellResolver = new ShellResolver();
  private configuredShell: string | null = null;

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
      // Queue it
      return new Promise((resolve) => {
        this.queue.push({ input, resolve });
        // Create a placeholder session
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
        };
        this.sessions.set(id, session);
        this.emit('status', id, 'queued');
      });
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
    };

    this.sessions.set(id, session);

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
          if (session.buffer) {
            this.emit('data', id, session.buffer);
            session.buffer = '';
          }
          session.flushScheduled = false;
        }, 16);
      }
    });

    ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
      session.status = 'exited';
      session.exitCode = exitCode;
      session.pty = null;
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
        const session = await this.doSpawn(next.input);
        next.resolve(session);
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
    }

    return taskIds;
  }

  killAll(): void {
    for (const session of this.sessions.values()) {
      if (session.pty) {
        session.pty.kill();
      }
    }
    this.sessions.clear();
    this.queue.length = 0;
  }
}
