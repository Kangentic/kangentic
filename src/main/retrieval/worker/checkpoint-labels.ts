/**
 * The `timeSyncWork` labels a WAL checkpoint runs under when it runs on the
 * retrieval worker's own loop, and the test main uses to tell a worker held in
 * one from a worker that is stuck.
 *
 * Two sites ask for a checkpoint: main's 5 s request (`db.checkpoint`, see
 * `checkpoint-driver.ts`) and the pacer after the worker's own commits
 * (`checkpoint-pacing.ts`). They shared `db:checkpoint`, so a watchdog line
 * could not say which one held the loop (Sentry DESKTOP-4P). Each now has its
 * own. A checkpoint normally runs on the checkpoint thread
 * (`checkpoint-runner.ts`) and holds no label at all; these name the in-loop
 * fallback, which runs when the thread cannot.
 *
 * Pure: main imports it, so it may import nothing native and nothing from
 * Electron.
 */

/** Main's 5 s checkpoint request, run on the worker's loop. */
export const CHECKPOINT_TICK_LABEL = 'db:checkpoint-tick';
/** The pacer's checkpoint after the worker's own commit, run on the worker's loop. */
export const CHECKPOINT_AFTER_WRITE_LABEL = 'db:checkpoint-after-write';

const CHECKPOINT_LABELS: readonly string[] = [CHECKPOINT_TICK_LABEL, CHECKPOINT_AFTER_WRITE_LABEL];

/** Whether a watchdog line (`... event loop held 5 s in <label>`) names a checkpoint. */
export function isCheckpointHoldLine(line: string): boolean {
  const trimmed = line.trimEnd();
  return CHECKPOINT_LABELS.some((label) => trimmed.endsWith(` in ${label}`));
}
