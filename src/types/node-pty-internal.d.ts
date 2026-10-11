/**
 * Minimal typings for node-pty's internal Windows agent. node-pty ships types
 * for its public API only; `conpty-console-list.ts` reaches this module to stop
 * the kill path from forking a helper process.
 */
declare module 'node-pty/lib/windowsPtyAgent' {
  export class WindowsPtyAgent {
    /** The shell's pid, assigned once at construction. */
    _innerPid: number;
    /** Set by the native exit callback once the shell has exited; undefined while it runs. */
    _exitCode: number | undefined;
    /** Lists the processes attached to the PTY's console, for `kill()`. */
    _getConsoleProcessList(): Promise<number[]>;
  }
}
