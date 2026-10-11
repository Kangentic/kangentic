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

interface ConsoleInput {
  readonly writable?: boolean;
  readonly destroyed?: boolean;
  write(data: string): boolean;
  listenerCount?(eventName: 'error'): number;
  on?(eventName: 'error', listener: (error: Error) => void): unknown;
}

interface ConptyTerminalInternals {
  _agent?: { inSocket?: ConsoleInput };
}

/** Writes each part in order. False when there is no open input to write to (POSIX, or the pipe is gone). */
export function writeToExitedConsole(pty: unknown, parts: readonly string[]): boolean {
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
  try {
    for (const part of parts) input.write(part);
    return true;
  } catch {
    return false;
  }
}
