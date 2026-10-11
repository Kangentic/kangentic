import React from 'react';
import { Link2, Workflow as WorkflowIcon } from 'lucide-react';
import { workflowColor } from '../workflows/workflow-graph';
import type { BoardWorkflow } from '../../utils/board-workflow';

/**
 * The workflow items a task's menu leads with, in `TaskContextMenu`'s
 * `leading` slot, so a task has one menu wherever it is right-clicked. Open
 * workflow takes the workflow's icon in its color, as the picker and the card
 * strip draw it.
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

/** A row that cannot act: in place, dimmed, its reason as the tooltip, as the menu's own disabled rows. */
const DISABLED_ROW_CLASS = 'w-full px-3 py-1.5 text-sm text-fg-secondary text-left flex items-center gap-2 opacity-40 cursor-not-allowed';

export function ShowWorkflowLinksMenuItem({ refusal, onShow, onClose }: {
  /** Why it cannot show them (the card has no links yet), or null. */
  refusal: string | null;
  onShow: () => void;
  onClose: () => void;
}) {
  return (
    <button
      type="button"
      onClick={() => { if (refusal) return; onShow(); onClose(); }}
      aria-disabled={refusal ? true : undefined}
      title={refusal ?? undefined}
      className={refusal ? DISABLED_ROW_CLASS : ROW_CLASS}
      data-testid="context-show-workflow-links"
    >
      <Link2 size={14} className="text-fg-faint" />
      Show workflow links
    </button>
  );
}
