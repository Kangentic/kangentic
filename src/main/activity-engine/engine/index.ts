/**
 * Public surface of the activity engine. External consumers (telemetry,
 * tests, IPC handlers) should import from this index, not from internal
 * modules - that keeps the module split flexible without touching
 * call sites.
 *
 * Internals (predicate, event-handlers, watchdog, counter-snapshot,
 * state-factory, snapshot-writer, shapes) are deliberately not
 * re-exported - they are implementation details of the engine.
 */
export { ActivityEngine } from './activity-engine';
export { ActivitySnapshotWriter } from './snapshot-writer';

// Types and configuration constants are part of the public contract -
// callers need them to construct the engine and to type their own
// state observers.
export type {
  ActivityEngineOptions,
  ActivityEngineCallbacks,
  ActivityStatsSnapshot,
  SessionEngineState,
  TransitionRecord,
  TransitionTrigger,
  PendingTool,
  CompensationCounters,
  PtyChunkTick,
} from './shapes';

export {
  DEFAULT_BG_SHELL_ESCAPE_HATCH_MS,
  DEFAULT_STALE_THINKING_TIMEOUT_MS,
  DEFAULT_IDLE_STABILITY_WINDOW_MS,
  PTY_CHUNK_BUCKET_MS,
  PTY_CHUNK_WINDOW_MS,
} from './shapes';
