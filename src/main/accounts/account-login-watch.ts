import { FileWatcher } from '../pty/readers/file-watcher';

/** How long a home's login file must stay still before its home is compared with its row. */
export const LOGIN_FILE_SETTLE_MS = 2_000;
/** The fallback poll when the OS watch goes quiet: a login changes rarely. */
const LOGIN_FILE_POLL_MS = 10_000;

/** One watched login file and the account whose home holds it. */
export interface WatchedLoginFile {
  accountId: string;
  filePath: string;
}

/** What a watch needs, so tests can drive it without the disk. */
export interface LoginFileWatcherFactory {
  (filePath: string, onChange: () => void): { close(): void };
}

const defaultFactory: LoginFileWatcherFactory = (filePath, onChange) =>
  new FileWatcher({ filePath, onChange, debounceMs: LOGIN_FILE_SETTLE_MS, pollIntervalMs: LOGIN_FILE_POLL_MS });

/**
 * Watches the file each account's home keeps its login in (task #1113), so a login replaced
 * outside a Kangentic sign-in (a `/login` in any session on that home, `claude auth login` in a
 * terminal) is noticed without waiting for a turn end or a scheduled pass. The file is rewritten
 * on every token refresh too, so a change only asks for the cheap comparison of the home's own
 * record with the row (`onChange`), which runs the CLI only when they differ.
 */
export class AccountLoginWatch {
  private readonly watchers = new Map<string, { accountId: string; watcher: { close(): void } }>();

  constructor(
    private readonly onChange: (accountId: string) => void,
    private readonly factory: LoginFileWatcherFactory = defaultFactory,
  ) {}

  /** Watches exactly `files`: new ones start, ones no longer listed stop. */
  sync(files: readonly WatchedLoginFile[]): void {
    const wanted = new Map(files.map((file) => [file.filePath, file.accountId]));
    for (const [filePath, entry] of this.watchers) {
      if (wanted.get(filePath) === entry.accountId) continue;
      entry.watcher.close();
      this.watchers.delete(filePath);
    }
    for (const [filePath, accountId] of wanted) {
      if (this.watchers.has(filePath)) continue;
      try {
        const watcher = this.factory(filePath, () => this.onChange(accountId));
        this.watchers.set(filePath, { accountId, watcher });
      } catch (error) {
        // report-ok: a home that cannot be watched is still compared at each turn end and on
        // every scheduled pass, so a missed watch only delays noticing a replaced login.
        console.warn('[ACCOUNTS] Could not watch an account\'s login file:', error instanceof Error ? error.name : 'unknown');
      }
    }
  }

  /** The files being watched, for tests. */
  watchedFiles(): string[] {
    return [...this.watchers.keys()];
  }

  dispose(): void {
    for (const entry of this.watchers.values()) entry.watcher.close();
    this.watchers.clear();
  }
}
