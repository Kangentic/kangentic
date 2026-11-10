import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { quoteCmdExecutable } from '../../shared/shell-quote';
import { cliRunsThroughShell, quoteForCmdShell } from '../agent/shared/cli-print';
import { childProcessEnv } from '../shared/child-env';
import { spawnOffMainPty, type OffMainPty } from '../utility-process/off-main-pty';
import type { AccountLoginCommand } from './account-service';

/** The grid a sign-in starts at, until its terminal reports its own. */
const LOGIN_COLS = 100;
const LOGIN_ROWS = 28;
/** A sign-in nobody finishes is ended, so a forgotten dialog never leaves a CLI running. */
export const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
/** How much of a sign-in's screen is kept for a terminal that mounts after the first bytes. */
const BACKLOG_LIMIT_CHARS = 64 * 1024;

export interface AccountLoginListeners {
  /** The sign-in's terminal output. Carries the provider's sign-in address, so it is never logged. */
  onOutput(loginId: string, data: string): void;
  /** The CLI exited or the sign-in was cancelled. Called once. */
  onEnded(loginId: string, accountId: string, cancelled: boolean): void;
}

interface RunningLogin {
  accountId: string;
  pty: OffMainPty;
  backlog: string;
  timeout: ReturnType<typeof setTimeout>;
  cancelled: boolean;
  ended: boolean;
}

/**
 * Runs an agent CLI's own sign-in (`claude auth login`, `codex login`, ...) in a terminal of its
 * own, pointed at one account's home (task #1057). It is not an agent session: a raw PTY in the
 * pty host with no registry row, no hooks and no task tag, so the board, the Monitor and the
 * activity engine never see it. The CLI does the whole sign-in, in the user's browser, and Kangentic
 * reads nothing from the screen: who signed in is asked of the CLI afterwards.
 */
export class AccountLoginRunner {
  private readonly logins = new Map<string, RunningLogin>();
  /** Sign-ins whose terminal is still being started, by account. */
  private readonly starting = new Map<string, Promise<string>>();

  constructor(private readonly listeners: AccountLoginListeners) {}

  /** The sign-in running for an account, if any, so a second click joins it. */
  loginIdFor(accountId: string): string | null {
    for (const [loginId, login] of this.logins) if (login.accountId === accountId && !login.ended) return loginId;
    return null;
  }

  /** Starts an account's sign-in, or joins the one already running or starting for it. */
  start(accountId: string, command: AccountLoginCommand): Promise<string> {
    const existing = this.loginIdFor(accountId);
    if (existing) return Promise.resolve(existing);
    // A second call while the first is still asking the pty host for its terminal joins that
    // start, so one account never gets two CLIs signing in to one home.
    const starting = this.starting.get(accountId);
    if (starting) return starting;
    const started = this.spawnLogin(accountId, command).finally(() => this.starting.delete(accountId));
    this.starting.set(accountId, started);
    return started;
  }

  private async spawnLogin(accountId: string, command: AccountLoginCommand): Promise<string> {
    const options = {
      name: 'xterm-256color',
      cols: LOGIN_COLS,
      rows: LOGIN_ROWS,
      // The home folder: a sign-in belongs to no project, and reads no project settings. A CLI
      // that signs in inside its own screen starts in the account folder instead (`cwd`).
      cwd: command.cwd ?? os.homedir(),
      env: childProcessEnv({ ...command.env, TERM: 'xterm-256color' }),
    };
    // A Windows npm install resolves to a `.cmd` shim, which needs cmd to run. The line is handed
    // over whole (`/s` strips only its outer quotes), so cmd reads the path as one quoted word
    // whatever it holds: an argument list would leave a path with `&` or `(` unquoted, and cmd
    // drops the quotes of one that has both a space and such a character. An `.exe` starts directly.
    const pty = cliRunsThroughShell(command.cliPath)
      ? await spawnOffMainPty(
          'cmd.exe',
          `/d /s /c "${quoteCmdExecutable(command.cliPath)} ${command.args.map(quoteForCmdShell).join(' ')}"`,
          options,
        )
      : await spawnOffMainPty(command.cliPath, [...command.args], options);
    const loginId = randomUUID();
    const login: RunningLogin = {
      accountId,
      pty,
      backlog: '',
      cancelled: false,
      ended: false,
      timeout: setTimeout(() => this.cancel(loginId), LOGIN_TIMEOUT_MS),
    };
    login.timeout.unref?.();
    this.logins.set(loginId, login);
    pty.onData((data) => {
      login.backlog = (login.backlog + data).slice(-BACKLOG_LIMIT_CHARS);
      this.listeners.onOutput(loginId, data);
    });
    pty.onExit(() => this.finish(loginId));
    return loginId;
  }

  /** What the sign-in has printed so far, for a terminal that mounted after it started. */
  backlog(loginId: string): string {
    return this.logins.get(loginId)?.backlog ?? '';
  }

  write(loginId: string, data: string): void {
    const login = this.logins.get(loginId);
    if (login && !login.ended) login.pty.write(data);
  }

  resize(loginId: string, cols: number, rows: number): void {
    const login = this.logins.get(loginId);
    if (!login || login.ended) return;
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 20 || rows < 5 || cols > 500 || rows > 200) return;
    login.pty.resize(cols, rows);
  }

  /** Ends a sign-in the user closed. The CLI has written no login until the browser step ends. */
  cancel(loginId: string): void {
    const login = this.logins.get(loginId);
    if (!login || login.ended) return;
    login.cancelled = true;
    try {
      login.pty.kill();
    } catch {
      // Already exited: its exit event finishes it.
    }
    this.finish(loginId);
  }

  private finish(loginId: string): void {
    const login = this.logins.get(loginId);
    if (!login || login.ended) return;
    login.ended = true;
    clearTimeout(login.timeout);
    this.logins.delete(loginId);
    this.listeners.onEnded(loginId, login.accountId, login.cancelled);
  }

  /** Synchronous: ends every sign-in still running (app quit). */
  dispose(): void {
    for (const loginId of [...this.logins.keys()]) this.cancel(loginId);
  }
}
