/**
 * Per-column session resolution: which track a task runs on, and what to do with
 * it on entry.
 *
 * A task can run on multiple parallel, independently-resumable sessions. Normal
 * columns share the task's main session (resumed as the task moves between them).
 * A column with session_target='isolated' runs the task on its own separate,
 * context-isolated session, keyed by the swimlane id, so re-entering that column
 * resumes its own conversation while leaving it for a main-target column resumes
 * the main session.
 *
 * The discriminator on each session record is `isolated_swimlane_id`: null for the
 * main session, or the swimlane id of the isolated column. These are pure
 * functions with no side effects - easy to unit test. They are the single source
 * of truth for the target/spawn rules, so every spawn / recovery site stays
 * consistent and a future change touches one place.
 */

import type { Swimlane, SessionTarget } from '../../shared/types';

/**
 * The effective session target for a column. Null/undefined (legacy rows, or a
 * column created before this feature) resolves to 'main', reproducing today's
 * behavior exactly.
 */
export function resolveSessionTarget(
  lane: Pick<Swimlane, 'session_target'> | null | undefined,
): SessionTarget {
  return lane?.session_target ?? 'main';
}

/**
 * The swimlane a task's session is isolated to while it sits in this column: the
 * swimlane id for an 'isolated'-target column, or null (the main session) for
 * every other column.
 */
export function resolveIsolatedSwimlaneId(
  lane: Pick<Swimlane, 'id' | 'session_target'> | null | undefined,
): string | null {
  if (lane && resolveSessionTarget(lane) === 'isolated') return lane.id;
  return null;
}

/**
 * Whether entering this column should spawn a FRESH session on its target track
 * (retiring any prior session for that (task, target)) rather than resuming.
 *
 * The default is context-aware and lives here as the single source of truth:
 * an isolated column defaults to 'always_spawn_new' (an independent pass each
 * entry - the point of isolation), while a main column defaults to
 * 'create_or_resume' (continuity). An explicit `session_spawn_strategy` always
 * wins, so a persistent isolated track (isolated + create_or_resume) is one
 * setting away. The renderer mirrors this default; it does not re-derive it.
 *
 * Note: this governs column ENTRY only. App-restart / pause-resume of an
 * in-progress session resumes it (handled by the recovery path), so a crash
 * never discards active work.
 */
export function resolveForceFresh(
  lane: Pick<Swimlane, 'session_target' | 'session_spawn_strategy'> | null | undefined,
): boolean {
  const spawnStrategy = lane?.session_spawn_strategy
    ?? (resolveSessionTarget(lane) === 'isolated' ? 'always_spawn_new' : 'create_or_resume');
  return spawnStrategy === 'always_spawn_new';
}
