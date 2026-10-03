/**
 * What a platform reader reports about one process, and what it can do to one.
 *
 * Privacy: a reader sees every same-user process's environment block, and those
 * blocks hold other applications' credentials. A reader matches the task tag
 * inside the raw buffer and returns only the tag's value. No environment
 * contents leave a reader: they are never returned, logged, or retained. A
 * command line can carry a token too, so `describe` parses it in place and
 * returns only the short label `process-label.ts` derives from it.
 */

export interface ScannedProcess {
  pid: number;
  ppid: number;
  /**
   * The process's creation time in the platform's own unit, as an opaque
   * identity key: FILETIME on Windows, `/proc/<pid>/stat` starttime ticks on
   * Linux, libproc's start seconds and microseconds on macOS. A pid whose key
   * changed between two scans is a different process. Empty where the reader
   * cannot read it (another Windows session, another macOS user), and a kill
   * never takes an empty key.
   */
  startKey: string;
  /**
   * Creation time in ms since the epoch, where the platform gives a precise
   * one (Windows). Orders parent and child on Windows, where a dead parent's
   * pid stays in its children's ppid and can be reused. Null on POSIX, where
   * an orphan is reparented and its ppid is always a live parent.
   */
  startedAtMs: number | null;
  /** The value of `KANGENTIC_TASK_ID` in the process's environment, or null. */
  tagValue: string | null;
  /**
   * macOS only: the caller's own process, read with no environment at all.
   * That is what XNU returns for a `CS_RESTRICT` target (Apple's `/bin` and
   * `/usr/bin` tools) while System Integrity Protection is on, and also what a
   * process started with an empty environment (`env -i`) looks like. Its tag,
   * if any, cannot be seen.
   */
  environmentWithheld?: boolean;
  /**
   * The process's current working directory, for every process the reap
   * could kill (a same-user process the reader could open; on macOS, every
   * tagged or withheld process and its descendants). Null or absent where it
   * could not be read, and such a process is never killed: the reap kills
   * only processes working inside the task's own directories.
   */
  workingDirectory?: string | null;
  /** The environment could not be read at all (elevated, non-dumpable). */
  environmentUnreadable?: boolean;
  /**
   * What the process is, where that changes how the reap treats it:
   * - `visible-app`: it shows UI (a visible top-level window on Windows, a
   *   UI app registered with LaunchServices on macOS, a GUI toolkit mapped on
   *   Linux). Never killed, nor anything under it.
   * - `multiplexer`: a tmux server. tmux copies the environment it started
   *   with into every later session, so under it the tag stops naming a task.
   *   Never killed, nor anything under it.
   * - `console-host`: Windows' `conhost.exe` / `OpenConsole.exe`, which every
   *   console process gets as a child, working in the Windows directory. It
   *   is no evidence that its parent is shared.
   */
  role?: 'visible-app' | 'multiplexer' | 'console-host';
}

export interface ProcessScan {
  processes: ScannedProcess[];
  /** Same-user processes whose environment could not be read. A count only. */
  unreadableCount: number;
}

/** `graceful` asks a process to exit (SIGTERM; a hard terminate on Windows,
 *  which has no polite signal for a windowless process). `force` cannot be
 *  refused (SIGKILL, TerminateProcess). */
export type KillStrength = 'graceful' | 'force';

export interface TaggedProcessReader {
  /**
   * Load what the reader calls into (koffi and the OS libraries), rejecting
   * when it cannot. Separate from `scan` so a reap can say which failed: a
   * load failure is a packaging or platform fault, a scan failure is not.
   * Absent where there is nothing to load (Linux reads `/proc`).
   */
  ready?(): Promise<void>;
  scan(): Promise<ProcessScan>;
  /**
   * Kill `target` if it is still the process the scan saw. Returns true when a
   * signal or terminate was issued. Never throws.
   */
  kill(target: ScannedProcess, strength: KillStrength): Promise<boolean>;
  /**
   * The short name each process is shown under ("node (vite)"), by pid, for
   * the few processes a reap reports. The reader reads the command line in
   * place and returns only `labelProcess`'s result (`process-label.ts`); a
   * process it cannot read is absent from the map. Never throws.
   */
  describe(targets: readonly ScannedProcess[]): Promise<Map<number, string>>;
}
