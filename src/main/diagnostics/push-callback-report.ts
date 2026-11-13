import type { CrashRecord } from '../../shared/types';
import { createChokepointReporter } from '../analytics/handled-report';

/**
 * A renderer callback the preload called on a push threw. The preload's guard
 * (`src/preload/push-callback-guard.ts`) sends it as a crash record with
 * `source: 'preload'` and a `pushCallback` context, because the renderer's SDK
 * cannot see an error of the preload's world. The local record keeps what it
 * always kept; Sentry gets no message, tagged with the API method it was
 * registered through.
 *
 * The context bridge rethrows a renderer callback's throw in the preload's world
 * as a new `Error` (measured in Electron 45): the message survives, the class
 * and the renderer's frames do not, and the stack is the preload's own call
 * site, the same for every push. So the frames cannot split one broken listener
 * from another, and the issue is grouped by method instead.
 */
export const pushCallbackReporter = createChokepointReporter('preload_callback');

/** `config.onChanged`: a namespace and an `on*` method, nothing else. */
const API_METHOD = /^(?:[A-Za-z]+\.)?on[A-Z][A-Za-z]*$/;
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9]*$/;

/** Report a guarded push callback's failure; anything else the record carries is ignored. */
export function reportPushCallbackRecord(record: CrashRecord): boolean {
  if (record.source !== 'preload') return false;
  const context = record.context ?? {};
  const method = typeof context.pushCallback === 'string' ? context.pushCallback : null;
  if (!method) return false;
  const errorName = typeof context.errorName === 'string' && ERROR_NAME.test(context.errorName) ? context.errorName : 'Error';
  // A copy built from the record: the name and the frames, no message, so the
  // reporter's diagnostic context has nothing of the renderer's text to carry.
  const error = new Error('');
  error.name = errorName;
  if (record.stack) error.stack = record.stack;
  const methodTag = API_METHOD.test(method) ? method : 'unknown';
  return pushCallbackReporter.report(error, { tags: { method: methodTag }, fingerprint: ['preload-callback', methodTag] });
}
