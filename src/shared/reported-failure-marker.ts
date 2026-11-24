/**
 * The fixed text that ends the message of the copy main's IPC handler wrap
 * rethrows when a failure's report reached Sentry in this run
 * (`src/main/analytics/ipc-handler-report.ts`). An IPC rejection reaches the
 * renderer as message text only, so the fact rides in the text, and
 * `describeIpcError` (`src/renderer/lib/ipc-error.ts`) strips it before any
 * reason is shown. A failure toast then draws its "This issue has been
 * automatically reported to Kangentic" line (`ToastItem.tsx`).
 *
 * It is a suffix, so `isIpcRejectionMainSaw` (`ipc-rejection.ts`), which reads the
 * start of the text, is unaffected.
 */
export const REPORTED_FAILURE_MARKER = ' (kangentic:reported)';

/** True when `text` ends with the whole marker, leading space included, before any trailing whitespace. */
export function hasReportedFailureMarker(text: string): boolean {
  return text.trimEnd().endsWith(REPORTED_FAILURE_MARKER);
}

/** `text` with a trailing marker removed; any other text comes back unchanged. */
export function withoutReportedFailureMarker(text: string): string {
  if (!hasReportedFailureMarker(text)) return text;
  return text.trimEnd().slice(0, -REPORTED_FAILURE_MARKER.length);
}
