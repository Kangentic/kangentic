/**
 * How the renderer sees a rejected `ipcRenderer.invoke`: Electron rewrites the
 * error to `Error invoking remote method '<channel>': <Name>: <message>`, and
 * main's stack is gone.
 *
 * Main's IPC wrap (`src/main/analytics/ipc-handler-report.ts`) reports every
 * defect a handler throws, with main's stack, and skips refusals on purpose. So
 * the renderer's copy of such a rejection is a duplicate or a refusal, and is
 * dropped. Two rejections never reach a handler, so main never saw them, and they
 * stay reported:
 *
 * - `No handler registered for '<channel>'`: the preload and main are out of step.
 * - `An object could not be cloned`: the handler returned something IPC cannot carry.
 */

/** A rejection main's wrap already saw. Matches the start of the message. */
export const IPC_REJECTION_DUPLICATE_PATTERN =
  /^Error invoking remote method '[^']*': (?!Error: (?:No handler registered for |An object could not be cloned))/;

/** True for a rejection main's wrap already saw: its report, if any, came from main. */
export function isIpcRejectionMainSaw(message: string): boolean {
  return IPC_REJECTION_DUPLICATE_PATTERN.test(message);
}
