/**
 * The pairing rule between a column's session TRACK and what it does with that
 * track on entry.
 *
 * `session_target` and `session_spawn_strategy` are orthogonal columns in the
 * schema, but two of their four combinations are the ones anyone means: an
 * isolated column runs an independent pass each entry (the reviewer archetype),
 * and a main column continues the task's own conversation. `resolveForceFresh`
 * (`src/main/transition-engine/session-isolation.ts`) documents that default,
 * but it cannot be the one that applies it: both DB columns are NOT NULL with a
 * literal DEFAULT, so a stored lane always carries a concrete strategy and the
 * resolver's `??` fallback never evaluates. The default is enforced by the
 * WRITERS, and this is the single copy of it they share.
 *
 * It lives in `src/shared/` because those writers sit on opposite sides of the
 * process boundary: the Column Manager (renderer) and the MCP column handlers
 * (main). Before this existed the renderer held the only copy, and the MCP
 * tools had none - an agent asked for an isolated review column got
 * `isolated` + `create_or_resume`, which resumes the previous review instead of
 * starting a fresh one.
 */

import type { SessionSpawnStrategy, SessionTarget } from './types';

/**
 * The spawn strategy to persist alongside a column's new session target.
 *
 * Snaps to the incoming track's default only when the strategy still sits at
 * the OTHER track's default, so an explicit non-default pairing survives: a
 * persistent isolated track (isolated + create_or_resume) is one deliberate
 * setting, not a value to be helpfully corrected.
 *
 * `previousTarget` is what makes this safe to call from a writer that cannot
 * tell a change from a restatement. The renderer's `<select>` only fires on a
 * real change, but an MCP caller can pass `sessionTarget: "isolated"` for a
 * column that is already isolated; without the guard that no-op call would
 * clobber a deliberate `create_or_resume` back to `always_spawn_new`.
 */
export function snapSpawnStrategyToTarget(
  previousTarget: SessionTarget,
  nextTarget: SessionTarget,
  currentStrategy: SessionSpawnStrategy,
): SessionSpawnStrategy {
  if (nextTarget === previousTarget) return currentStrategy;
  if (nextTarget === 'isolated' && currentStrategy === 'create_or_resume') return 'always_spawn_new';
  if (nextTarget === 'main' && currentStrategy === 'always_spawn_new') return 'create_or_resume';
  return currentStrategy;
}
