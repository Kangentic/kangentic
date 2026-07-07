/**
 * The default value for a developer settings toggle when the user has never
 * touched it (no stored value in `AppConfig.developer`). Extracted as a pure
 * function so this decision logic is unit-testable in isolation: the main
 * process's `safeReadDeveloperFlag` in `src/main/index.ts` cannot itself be
 * imported by a test (it is an Electron entry-point module with top-level
 * `electron` API calls that throw outside a running Electron process), and
 * this module has zero dependencies so it also works from renderer code.
 *
 *   'previewInspectionServer' / 'previewEvalEnabled' -> ON in any dev build.
 *     Anyone running `npm start` / `/preview` is by definition a Kangentic
 *     dev session and almost certainly wants the agent-driven inspection
 *     bridge (including eval, inject-event, raw-PTY) available without
 *     flipping a toggle each launch. Both are localhost-only and dropped
 *     from production builds via `__KANGENTIC_DEV__`.
 *
 *   'persistConsoleLogs' -> ON in any dev build (npm start dogfooding AND
 *     /preview). The write path is already async-queued (queueAppend in
 *     log-mirror.ts defers the actual disk write to the next setImmediate
 *     turn, no per-call blocking appendFileSync/mkdirSync), so this has no
 *     measurable dogfooding performance cost, and having the trace already
 *     captured is far more useful than remembering to flip it before a
 *     debugging session starts.
 *
 *   'recordIpcTraffic' -> ON only for the ephemeral `/preview` instance, in a
 *     dev build. The IPC recorder has a real, documented disk-I/O cost per
 *     call. `/preview`'s entire data dir (including `.kangentic/logs/`) is
 *     wiped on close, bounding the growth. The regular npm start dogfooding
 *     session runs for days, so it stays opt-in there to avoid unbounded
 *     trace accumulation the user did not ask for.
 *
 *   'activityDebugOverlay' -> always OFF by default. It has a visible cost
 *     the user should opt into deliberately.
 *
 * An explicit stored value in config always wins over this default; callers
 * are responsible for checking that first (see `safeReadDeveloperFlag` in
 * `src/main/index.ts` and the `??` fallbacks in `DeveloperTab.tsx`).
 */
export type DeveloperFlagKey =
  | 'activityDebugOverlay'
  | 'persistConsoleLogs'
  | 'recordIpcTraffic'
  | 'previewInspectionServer'
  | 'previewEvalEnabled';

export function defaultDeveloperFlag(
  key: DeveloperFlagKey,
  isDevBuild: boolean,
  isEphemeralPreview: boolean,
): boolean {
  if (key === 'previewInspectionServer' || key === 'previewEvalEnabled') return isDevBuild;
  if (key === 'persistConsoleLogs') return isDevBuild;
  if (key === 'recordIpcTraffic') return isDevBuild && isEphemeralPreview;
  return false;
}
