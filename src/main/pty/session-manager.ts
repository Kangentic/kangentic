import * as pty from 'node-pty';
import { EventEmitter } from 'node:events';
import { v4 as uuidv4 } from 'uuid';
import { ShellResolver } from './shell-resolver';
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
    const id = input.taskId ? (this.findByTaskId(input.taskId)?.id || uuidv4()) : uuidv4();

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
      scrollback: '',
    };

    // Remove any queued placeholder
    const existing = this.sessions.get(id);
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
        const cmd = this.adaptCommandForShell(input.command!, shellName);
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
      session.pty.kill();
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

  /**
   * Adapt a command string for the target shell.
   * On Windows, converts executable paths and syntax for cross-shell compatibility.
   */
  private adaptCommandForShell(cmd: string, shellName: string): string {
    if (process.platform !== 'win32') return cmd;

    // PowerShell needs the & call operator for quoted/path commands
    if (shellName.includes('powershell') || shellName.includes('pwsh')) {
      return '& ' + cmd;
    }

    // Unix-like shells on Windows (Git Bash, WSL, fish, etc.):
    // Convert the Windows executable path to POSIX format
    if (this.isUnixLikeShell(shellName)) {
      const isWsl = shellName.startsWith('wsl');
      return this.convertWindowsExePath(cmd, isWsl);
    }

    return cmd;
  }

  private isUnixLikeShell(shellName: string): boolean {
    // cmd.exe is the only Windows-native shell that doesn't need path conversion
    // (PowerShell is handled separately above)
    return !shellName.includes('cmd');
  }

  /**
   * Convert a Windows-style executable path at the start of a command to POSIX format.
   * Git Bash: C:\Users\... → /c/Users/...
   * WSL:      C:\Users\... → /mnt/c/Users/...
   */
  private convertWindowsExePath(cmd: string, isWsl: boolean): string {
    const prefix = isWsl ? '/mnt/' : '/';

    // Quoted Windows path at start: "C:\path with spaces\exe" ...rest
    if (cmd.startsWith('"')) {
      return cmd.replace(
        /^"([A-Za-z]):((?:\\[^"]+)+)"/,
        (_m, drive: string, rest: string) => {
          const posix = `${prefix}${drive.toLowerCase()}${rest.replace(/\\/g, '/')}`;
          return posix.includes(' ') ? `"${posix}"` : posix;
        },
      );
    }

    // Unquoted Windows path at start: C:\path\to\exe ...rest
    return cmd.replace(
      /^([A-Za-z]):((?:\\[^\s]+)+)/,
      (_m, drive: string, rest: string) => {
        return `${prefix}${drive.toLowerCase()}${rest.replace(/\\/g, '/')}`;
      },
    );
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
   * Kill all running PTY processes but return their session IDs
   * so they can be marked as 'suspended' in the DB for later resume.
   */
  suspendAll(): string[] {
    const suspendedIds: string[] = [];
    for (const session of this.sessions.values()) {
      if (session.pty && session.status === 'running') {
        suspendedIds.push(session.id);
        session.pty.kill();
        session.status = 'exited';
        session.pty = null;
      }
    }
    // Also count queued sessions as suspended
    for (const session of this.sessions.values()) {
      if (session.status === 'queued') {
        suspendedIds.push(session.id);
        session.status = 'exited';
      }
    }
    this.queue.length = 0;
    return suspendedIds;
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
