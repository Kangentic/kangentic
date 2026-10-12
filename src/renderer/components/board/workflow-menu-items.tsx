import React from 'react';
import { Workflow as WorkflowIcon } from 'lucide-react';
import { workflowColor } from '../workflows/workflow-graph';
import type { BoardWorkflow } from '../../utils/board-workflow';

/**
 * The workflow item a task's menu leads with, in `TaskContextMenu`'s
 * `leading` slot, so a task has one menu wherever it is right-clicked. Open
 * workflow takes the workflow's icon in its color, as the picker and the card
 * strip draw it. A card's links show by resting on it (`card-links-preview.ts`),
 * so the menu offers nothing for them.
 */

const ROW_CLASS = 'w-full px-3 py-1.5 text-sm text-fg-secondary text-left hover:bg-surface-hover/40 flex items-center gap-2 cursor-pointer';

export function OpenWorkflowMenuItem({ workflow, onOpen, onClose }: { workflow: BoardWorkflow; onOpen: () => void; onClose: () => void }) {
  return (
    <button
      type="button"
      onClick={() => { onOpen(); onClose(); }}
      className={ROW_CLASS}
      data-testid="context-open-workflow"
    >
      <WorkflowIcon size={14} style={{ color: workflowColor(workflow.colorSlot) }} />
      Open workflow
    </button>
  );
}
