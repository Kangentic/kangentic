import { AUTOMATION_MANIFEST, automationMoveTargetName } from '../../../../shared/automation-manifest';
import type { AutomationConfig } from '../../../../shared/types';
import { describeAutomation } from '../../../../shared/automation-describe';
import { englishI18n } from '../../../../shared/i18n/english';
import type { AutomationAdapter } from '../../shared/automation-adapter';

/**
 * Move to column: move the task when its agent finishes a turn, with a message
 * for the agent where it lands. The Code Review loop is built from two of
 * these, each behind its own Condition: "back for revisions" to Executing with
 * the review's `{{agentReply}}`, and "clean" on to Testing.
 *
 * Offered at a turn end only (`triggers`): on enter or exit the task is already
 * moving, and a move from inside that move's own task lock would abort it. The
 * engine hands it `context.moveTask`, which runs the one move path
 * (`handleTaskMove`), so the source column's exit rows and the destination's
 * enter rows run as they do for a drag. Run again hands it the same move
 * (`moveTaskFromRow`), outside the task lock. A row that runs ends its group
 * (`endsGroup`): the task has left the column.
 */
export const moveToColumnAdapter: AutomationAdapter = {
  id: 'move_to_column',
  manifest: AUTOMATION_MANIFEST.move_to_column,

  describe(config: AutomationConfig): string {
    // The run log's line, which an agent reads: English.
    return describeAutomation('move_to_column', config, englishI18n);
  },

  async execute(config, context) {
    if (!context.moveTask) {
      // Unreachable through the engine: the manifest offers this type at a
      // turn end only, and the turn end and Run again both pass `moveTask`.
      // An enter or exit group passes none, since it runs inside a move.
      throw new Error('Move to column can move a task only at a turn end or from Run again.');
    }
    // Read where the workflow step check reads it too, so the two resolve one target.
    const column = automationMoveTargetName(moveToColumnAdapter.id, config);
    const message = typeof config.message === 'string' && config.message.trim() ? config.message : null;
    const { columnName } = await context.moveTask({ column, message, reason: context.automationName ?? 'Move to column' });
    return { detail: message ? `Moved to ${columnName}, with a message.` : `Moved to ${columnName}.` };
  },
};
