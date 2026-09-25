import { AUTOMATION_MANIFEST } from '../../../../shared/automation-manifest';
import type { AutomationConfig } from '../../../../shared/types';
import { describeAutomation } from '../../../../shared/automation-describe';
import type { AutomationAdapter } from '../../shared/automation-adapter';
import { AutomationPermanentError } from '../../shared/automation-errors';

/**
 * Start agent. The ONE legacy adapter, and the only action type the migration
 * carries forward rather than dropping.
 *
 * The other three retired types (`kill_session`, `create_worktree`,
 * `cleanup_worktree`) are gone entirely, because each was already a no-op or a
 * duplicate of the move path: the seeded Kill Session on Planning did nothing
 * at all, since at Priority 4 the task has no active session. A `spawn_agent`
 * row is different only when it carries a CUSTOM `promptTemplate`, which has no
 * other home, so the migration keeps exactly those and drops the seeded
 * default-prompt one.
 *
 * It is never offered for a new automation. A column that still has one shows
 * it with a lint pointing at the column's own Start an agent here setting.
 */
export const legacySpawnAgentAdapter: AutomationAdapter = {
  id: 'spawn_agent',
  manifest: AUTOMATION_MANIFEST.spawn_agent,

  // Delegated so the row sentence has ONE definition: the renderer draws it
  // on every row in Board setup and cannot import this file.
  describe(config: AutomationConfig): string {
    return describeAutomation('spawn_agent', config);
  },

  async execute(config, context) {
    // Only ever populated on enter. An exit row cannot start an agent for a
    // column the task is leaving, and the runner skips it with that reason
    // before reaching here; this is the guard for a future caller that forgets.
    if (!context.legacySpawnAgent) {
      throw new AutomationPermanentError('Start agent only runs when a task enters a column.');
    }
    await context.legacySpawnAgent(config);
    return { detail: 'Agent started' };
  },
};
