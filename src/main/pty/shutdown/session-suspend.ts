import type { EventEmitter } from 'node:events';
import type * as pty from 'node-pty';
import { writeExitSequence } from './session-shutdown';

/**
 * Wait for `emitter` to fire an 'exit' event for `sessionId`, or for
 * `timeoutMs` to elapse. Returns true if the exit event arrived in time,
 * false on timeout.
 *
 * Always cleans up its own listener so repeated calls don't leak.
 *
 * Used by the suspend flow to wait for both (a) natural exit after the
 * agent processes its exit sequence and (b) kill propagation after a
 * force-kill lands, so callers that immediately manipulate the CWD
 * (worktree removal, file cleanup) don't race Windows ConPTY still
 * holding handles.
 */
export function awaitSessionExit(
  emitter: EventEmitter,
  sessionId: string,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      emitter.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = (exitedSessionId: string): void => {
      if (exitedSessionId === sessionId) {
        clearTimeout(timeout);
        emitter.removeListener('exit', onExit);
        resolve(true);
      }
    };
    emitter.on('exit', onExit);
  });
}

/**
 * Orchestrate graceful PTY shutdown for a suspend operation.
 *
 *   1. Write the adapter's exit sequence (e.g. Ctrl+C + `/exit` for
 *      Claude Code) into the PTY. This gives the agent ~200-500ms to
 *      flush its conversation transcript (JSONL) to disk so `--resume`
 *      works. Silent catches are intentional - the PTY may already be
 *      dead by the time we write.
 *   2. Wait up to `gracePeriodMs` for the process to exit naturally.
 *   3. If still alive, force-kill via `killPty` and wait up to
 *      `killPropagationMs` for the kill to propagate as an 'exit'
 *      event. Skip the wait if `killPty` reports the PTY was already
 *      dead (EACCES/ESRCH return false) - the event already fired.
 *
 * The `clearPty` callback lets the caller null its PTY reference
 * between the graceful wait and the force-kill (prevents double-kill +
 * Windows ConPTY heap corruption).
 *
 * Pure in the sense that it owns no per-session state; all mutation is
 * delegated to the callbacks.
 */
export async function gracefulPtyShutdown(input: {
  ptyRef: pty.IPty;
  exitSequence: string[];
  emitter: EventEmitter;
  sessionId: string;
  /** Null the caller's reference to the PTY before we force-kill. */
  clearPty: () => void;
  /** Invoke the caller's safeKillPty and return whether kill landed. */
  killPty: (ptyRef: pty.IPty) => boolean;
  gracePeriodMs?: number;
  killPropagationMs?: number;
}): Promise<void> {
  const gracePeriodMs = input.gracePeriodMs ?? 1500;
  const killPropagationMs = input.killPropagationMs ?? 1500;

  writeExitSequence(input.ptyRef, input.exitSequence);

  const exitedNaturally = await awaitSessionExit(input.emitter, input.sessionId, gracePeriodMs);
  if (exitedNaturally) return;

  const ptyRef = input.ptyRef;
  input.clearPty();
  const killLanded = input.killPty(ptyRef);
  if (!killLanded) return; // already dead, exit event fired before we got here

  await awaitSessionExit(input.emitter, input.sessionId, killPropagationMs);
}
