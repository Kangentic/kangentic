/**
 * `reportRendererFailure`: how a renderer catch reports a failure it recovered
 * from (a board that did not load, a card that did not open, a terminal replay
 * that failed). Stores, hooks and components import this module, which carries
 * no Sentry import; `error-reporting.ts` registers the sink that sends, at init,
 * and only when error reporting is on. So a unit test that loads a store loads no
 * SDK, and the web demo, which never initializes, sends nothing.
 *
 * `area` and `op` are short fixed words (`board`, `load`), never a title or a
 * path. They are tags and the fingerprint (`['renderer', area, op, <ErrorName>]`),
 * since the renderer's areas are a small known set. The event is a path-free
 * copy (`handled-error-copy.ts`). `contexts` hold fixed facts only.
 *
 * Skipped: aborts, a refusal the renderer raised itself (`RefusalError`), the
 * renderer's own network, and a rejected IPC call main's wrap saw (it reported
 * that one with main's stack). `No handler registered for` and a clone failure
 * never reached a handler, so they still report from here, and so does a lazy
 * chunk that did not load.
 * Each `area:op:name` reports once per run, at most 25 of them. Never throws.
 */

import { errorNameOf, pathFreeCopy, type HandledErrorContexts } from '../../shared/handled-error-copy';
import { isIpcRejectionMainSaw } from '../../shared/ipc-rejection';

export type RendererFailureSink = (
  error: Error,
  tags: Record<string, string>,
  contexts: HandledErrorContexts,
  fingerprint: string[],
) => void;

/** The most distinct `area:op:name` keys the renderer reports in a run. */
const MAX_RENDERER_FAILURE_KEYS = 25;

interface RendererFailureState {
  sink: RendererFailureSink | null;
  reported: Set<string>;
}

// Pattern A (hmr-patterns.md): the sink and the latch survive a Fast Refresh, or
// every dev save would drop the sink and re-arm each failure. The state goes
// into hot.data when it is made, not only in the dispose: this module accepts no
// update, so an edit that re-evaluates it on the way to an importer's boundary
// calls no disposer, and nothing registers the sink a second time.
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
const state: RendererFailureState = import.meta.hot?.data?.rendererFailureState ?? { sink: null, reported: new Set<string>() };
// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  if (import.meta.hot.data) import.meta.hot.data.rendererFailureState = state;
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose((data: Record<string, unknown>) => { data.rendererFailureState = state; });
}

/** Set by `initRendererErrorReporting` once the SDK is up. */
export function setRendererFailureSink(sink: RendererFailureSink | null): void {
  state.sink = sink;
}

function isRendererExpectedFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError') return true;
  // A refusal the renderer raised itself (a project that closed under an action).
  if (error.name === 'RefusalError' || error.name === 'UserConfigurationError') return true;
  if (isIpcRejectionMainSaw(error.message)) return true;
  // The renderer's own network: offline, a server down. A lazy chunk that did not
  // load opens with the same words and is not the network: the app's chunks are
  // files in its own package, so a missing one is a broken build or install.
  if (error instanceof TypeError && /^(Failed to fetch(?! dynamically imported module)|NetworkError|Load failed)/.test(error.message)) return true;
  return false;
}

/**
 * A tag word the compiler can see: a string literal or a union of them. A plain
 * `string` (a title, a path, text built at run time) does not type-check, so an
 * `area` or `op` cannot carry what a user wrote without a cast.
 */
export type FixedWord<Word extends string> = string extends Word ? never : Word;

/** Report one recovered renderer failure. Returns true when it sent a report. */
export function reportRendererFailure<Area extends string, Operation extends string>(
  area: FixedWord<Area>,
  op: FixedWord<Operation>,
  error: unknown,
  contexts: HandledErrorContexts = {},
): boolean {
  try {
    if (!state.sink || isRendererExpectedFailure(error)) return false;
    const name = errorNameOf(error);
    const key = `${area}:${op}:${name}`;
    if (state.reported.has(key) || state.reported.size >= MAX_RENDERER_FAILURE_KEYS) return false;
    state.reported.add(key);
    state.sink(
      pathFreeCopy(`${area}_${op}`, error),
      { source: 'renderer', area, op, error_name: name },
      contexts,
      ['renderer', area, op, name],
    );
    return true;
  } catch {
    // report-ok: this is the reporter; a failed send must never break the path that called it.
    return false;
  }
}

/** Test-only: forget what this run reported. */
export function resetRendererFailureReports(): void {
  state.reported.clear();
}
