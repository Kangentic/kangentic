/**
 * Reports a defect thrown by any `ipcMain.handle` handler, from one wrap. Before
 * it, a rejected handler reached Sentry only as Electron's
 * `Error occurred in handler for '<channel>'` breadcrumb, or as the renderer's
 * `Error invoking remote method` event with main's stack lost.
 *
 * Only `handle` is wrapped. An `ipcMain.on` listener (a fire-and-forget send:
 * audio chunks, window controls, a diff subscription) has no caller to reject to,
 * so its throw is an uncaught exception, which Sentry's own handler reports.
 *
 * It patches `ipcMain.handle` itself, in its own module, rather than living in the
 * IPC recorder (`diagnostics/ipc-recorder.ts`). The recorder is diagnostics and
 * could be dev-gated one day; this is production reporting and must not go with
 * it. `ipc-handler-report.test.ts` pins the install in `src/main/index.ts`.
 *
 * What it sends follows `handled-report.ts`: the fixed message
 * `Handled ipc_handler failure: <Name>`, the original frames, and the tags
 * `source`, `channel`, `error_name` and `errno`. The channel is a tag and never in a
 * fingerprint: one cause reached from several channels (`handleTaskMove` alone has
 * four entry points) groups on its stack, not on the channel it came through.
 *
 * Skipped: refusals (`RefusalError` and every `UserConfigurationError`), the
 * classes `isExpectedFailure` names, aborts, the network, a quit, and an error a
 * reporter already sent (`markReported`). The error is always rethrown. When its
 * report reached Sentry in this run (this send, an inner reporter's, or an
 * earlier send of the same key), the wrap rethrows a copy whose message ends in
 * `REPORTED_FAILURE_MARKER`, so the renderer's failure toast can say the issue
 * was reported. `describeIpcError` strips the marker, so every reason reads as before.
 */

import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { createChokepointReporter, wasSentToErrorReporting, type ChokepointReporter } from './handled-report';
import { REPORTED_FAILURE_MARKER, hasReportedFailureMarker } from '../../shared/reported-failure-marker';

export const IPC_HANDLER_REPORT_SOURCE = 'ipc_handler';

/**
 * The most distinct keys the wrap reports in a run. Higher than other chokepoints'
 * 25 because the renderer drops its own copy of a rejection main saw
 * (`isIpcRejectionMainSaw`), so a defect past this cap reaches Sentry from nowhere.
 */
export const IPC_HANDLER_KEY_CAP = 100;

/** The one reporter for every handler; exported for tests. */
export const ipcHandlerReporter: ChokepointReporter = createChokepointReporter(IPC_HANDLER_REPORT_SOURCE, { cap: IPC_HANDLER_KEY_CAP });

type HandleListener = (event: IpcMainInvokeEvent, ...handlerArguments: unknown[]) => unknown;

/**
 * What the wrap rethrows: `error` itself, or, when its report reached Sentry, a
 * copy whose message carries the reported marker. A copy, never the original
 * changed in place: the same object can be held elsewhere (a memoized promise
 * every caller awaits, a later `message` check in main), and none of those may
 * see the marker. Electron sends the renderer only the error's `name: message`
 * text, so the copy keeps the name and the stack and loses nothing on the way.
 * A thrown string or plain object is rethrown as it is.
 */
export function rejectionToRethrow(error: unknown): unknown {
  if (!(error instanceof Error) || !wasSentToErrorReporting(error)) return error;
  if (hasReportedFailureMarker(error.message)) return error;
  const marked = new Error(`${error.message}${REPORTED_FAILURE_MARKER}`);
  marked.name = error.name;
  if (error.stack) marked.stack = error.stack;
  return marked;
}

/** Run `listener`, report a throw or a rejection, and rethrow it, marked when its report was sent. */
export async function runReportedHandler(
  channel: string,
  listener: HandleListener,
  event: IpcMainInvokeEvent,
  handlerArguments: unknown[],
): Promise<unknown> {
  try {
    return await listener(event, ...handlerArguments);
  } catch (error) {
    ipcHandlerReporter.report(error, { tags: { channel } });
    throw rejectionToRethrow(error);
  }
}

let installed = false;

/**
 * Wrap every handler `ipcMain.handle` registers from here on. Installed once,
 * before any handler registers (`src/main/index.ts`, ahead of `installDiagnostics`
 * and `registerAllIpc`).
 */
export function installIpcHandlerReporting(target: Pick<IpcMain, 'handle'>): void {
  if (installed) return;
  installed = true;
  const originalHandle = target.handle.bind(target);
  (target as { handle: IpcMain['handle'] }).handle = ((channel: string, listener: HandleListener): void => {
    originalHandle(channel, (event, ...handlerArguments) => runReportedHandler(channel, listener, event, handlerArguments));
  }) as IpcMain['handle'];
}

/** Test-only: allow a second install against a new fake. */
export function resetIpcHandlerReportingForTests(): void {
  installed = false;
  ipcHandlerReporter.reset();
}
