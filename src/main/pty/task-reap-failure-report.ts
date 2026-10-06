/**
 * Tells Sentry when the task leftover reap stops working on a machine, once
 * per stage and code per launch. Every reap failure errs toward killing
 * nothing, which is safe and silent: without a report, a platform whose reader
 * stopped loading (a packaging fault) or whose scan stopped listing processes
 * would simply stop cleaning up, and nobody would know.
 *
 * The event carries a fixed message and code, never the failure's own text,
 * which can come from a process scan (`task-process-tag.md`: nothing a reader
 * sees leaves it). The one exception is a reader that would not load: that
 * text is a koffi or dlopen error about this install, and it goes into a
 * context block with paths stripped, so the issue still groups by code. A
 * reap that failed in a scan pass also carries that pass as a `pass` tag,
 * which says whether anything had been signalled. It stays out of the
 * message and the once-per-launch key, so the issue never splits by pass.
 *
 * Main-only: the pty host never imports analytics or Sentry
 * (`pty-host-out-of-process.md`), so the host carries the code back in the
 * reap's result and main reports it here.
 */

import { reportHandledError, type ErrorReportContexts } from '../analytics/error-reporting';
import { sanitizeErrorMessage } from '../analytics/analytics';
import { redactPaths } from '../../shared/sentry-breadcrumbs';
import type { ReapFailureCode, ReapPass } from './process-tag/tagged-reap';

/**
 * A reap's own codes, plus two main sees itself. `host_error`: the pty host
 * request failed or timed out. `wsl_error`: the in-distro reap for a WSL shell
 * failed (`wsl-reap.ts`).
 */
export type TaskReapFailure = ReapFailureCode | 'host_error' | 'wsl_error';

/** `reap`: a terminal transition or the startup sweep. `stop`: the user's Stop on one listed process. */
export type TaskReapStage = 'reap' | 'stop';

const reported = new Set<string>();

export function reportTaskReapFailure(
  stage: TaskReapStage,
  code: TaskReapFailure,
  loadError: string | null = null,
  pass: ReapPass | null = null,
): void {
  const key = `${stage}:${code}`;
  if (reported.has(key)) return;
  reported.add(key);
  const contexts: ErrorReportContexts = code === 'reader_load' && loadError
    // redactPaths first: sanitizeErrorMessage stops a path at its first space,
    // which leaves the rest of a profile folder like `C:\Users\First Last\...`.
    ? { task_reap: { loadError: sanitizeErrorMessage(redactPaths(loadError)) } }
    : {};
  const tags: Record<string, string> = { source: 'task_reap', stage, code };
  if (pass) tags.pass = pass;
  reportHandledError(new Error(`Task leftover ${stage} failed: ${code}`), tags, contexts);
}

/** Forget what this launch reported. Tests only. */
export function resetTaskReapFailureReports(): void {
  reported.clear();
}
