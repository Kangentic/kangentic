/**
 * Writes to the console a ConPTY shell left open when it exited on its own.
 *
 * node-pty's `IPty.write()` drops everything once it has seen the exit
 * (`WindowsTerminal._close()` clears its writable flag), but the console stays
 * open: node-pty never closes the pseudoconsole after a natural exit
 * (microsoft/node-pty#965), so the input pipe its own `_doWrite` writes through
 * (`_agent.inSocket`) still reaches any process attached to that console.
 *
 * Measured with Claude Code 2.1.294 on Windows 11 build 26200, after its shell
 * was killed from outside: Ctrl+C and `/exit` written here made Claude run its
 * SessionEnd hook (reason `prompt_input_exit`) and exit on its own with its
 * transcript whole. The same bytes through `write()` never arrived, and Claude
 * was still running 15 s later.
 *
 * These are private node-pty fields. `tests/unit/exited-console-input.test.ts`
 * pins them against the installed package, so an upgrade that renames them
 * fails there instead of silently writing nowhere.
 */

import type { ExitSequenceStep } from '../../../shared/types';
import { writeExitSteps } from '../shutdown/exit-sequence';

interface ConsoleInput {
  readonly writable?: boolean;
  readonly destroyed?: boolean;
  write(data: string): boolean;
  destroy?(): void;
  listenerCount?(eventName: 'error'): number;
  on?(eventName: 'error', listener: (error: Error) => void): unknown;
}

interface ConptyTerminalInternals {
  _agent?: { inSocket?: ConsoleInput };
}

/**
 * Writes each step in order, its pauses on timers (`exit-sequence.ts`). False
 * when there is no open input to write to (POSIX, or the pipe is gone).
 */
export function writeToExitedConsole(pty: unknown, steps: readonly ExitSequenceStep[]): boolean {
  const input = (pty as ConptyTerminalInternals | null)?._agent?.inSocket;
  if (!input || input.destroyed === true || input.writable === false) return false;
  // A write the console can no longer take fails later, as an 'error' event on
  // this socket, and node-pty attaches no listener to it. Unheard, that event
  // would throw in the pty host and end every PTY it holds.
  if (typeof input.on === 'function' && (input.listenerCount?.('error') ?? 0) === 0) {
    input.on('error', () => {
      // Best-effort ask: the grace and the terminate that follow still run.
    });
  }
  // The first keys go out now, so a pipe that refuses them still reads as not
  // asked; keys after a pause go on a timer and are best effort.
  const firstPause = steps.findIndex((step) => typeof step !== 'string');
  const immediate = (firstPause < 0 ? steps : steps.slice(0, firstPause)) as readonly string[];
  try {
    for (const part of immediate) input.write(part);
  } catch {
    // report-ok: a pipe that refuses the first keys reads as not asked. The orphan
    // cleanup logs that, and its grace and terminate still run.
    return false;
  }
  if (firstPause >= 0) writeExitSteps((data) => input.write(data), steps.slice(firstPause));
  return true;
}

/**
 * Closes a ConPTY's input pipe once nothing will write to it again: after a
 * kill, or after an exit once the orphan cleanup is done with the console.
 *
 * node-pty opens that pipe with `fs.openSync`, which takes a C runtime
 * descriptor, and on its default ConPTY path (`useConptyDll` off) destroys the
 * socket neither in `kill()` nor after the exit (microsoft/node-pty#947). So
 * every PTY kept one descriptor in the process that spawned it for that
 * process's whole life. Measured with node-pty 1.2.0-beta.18 on Windows 11:
 * 20 PTYs that exited and were killed left the lowest free descriptor at 23
 * where it started at 3, and destroying each input after its kill left it at 3.
 * In a preview whose pty host had fallen back into main, main's table grew by
 * about one per agent launch. Running out of that table is Sentry DESKTOP-59's
 * EMFILE. A no-op when the pipe is gone or already destroyed (POSIX, the DLL
 * path, a second call).
 */
export function releaseConsoleInput(pty: unknown): void {
  const input = (pty as ConptyTerminalInternals | null)?._agent?.inSocket;
  if (!input || input.destroyed === true || typeof input.destroy !== 'function') return;
  input.destroy();
}
