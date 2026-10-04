import React, { useEffect, useRef, useState } from 'react';
import { ListTree, Play } from 'lucide-react';
import type { Workflow, WorkflowSummary, WorkflowViewTask } from '../../../shared/types';
import { BaseDialog } from '../dialogs/BaseDialog';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import { taskLabel, workflowColor } from './workflow-graph';

/**
 * The Workflows view's confirms, one plain line each saying what the button
 * does (board 12). A confirm only for what cannot be undone in place: Start,
 * Delete, Remove. Rename is the Board Manager's profile rename: the field
 * leads with the current name selected, and Enter renames.
 */

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function WorkflowIcon({ summary }: { summary: WorkflowSummary }) {
  return <ListTree size={16} style={{ color: workflowColor(summary.workflow.color_slot) }} />;
}

/**
 * Start: what pressing it does, never a recap of the plan on screen. The
 * second line only for a workflow made from a task still in To Do, since it is
 * the one place the user learns a task of theirs is leaving the board.
 */
export function StartWorkflowDialog({ summary, sourceTaskLabel, onConfirm, onCancel }: {
  summary: WorkflowSummary;
  /** "#409" when the workflow was made from a task still in To Do; null otherwise. */
  sourceTaskLabel: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <ConfirmDialog
      title={`Start ${summary.workflow.title}?`}
      icon={<WorkflowIcon summary={summary} />}
      message={(
        <>
          <p>
            {summary.taskCount === 1
              ? 'Creates 1 task. It starts automatically.'
              : `Creates ${plural(summary.taskCount, 'task', 'tasks')}. They start automatically in the order this workflow sets.`}
          </p>
          {sourceTaskLabel && <p className="mt-2.5">Task {sourceTaskLabel} moves to Done.</p>}
        </>
      )}
      confirmLabel="Start workflow"
      confirmIcon={<Play size={12} className="shrink-0" data-testid="workflow-start-confirm-icon" />}
      testId="workflow-start-confirm"
      onConfirm={() => onConfirm()}
      onCancel={onCancel}
    />
  );
}

/** Delete, in every state. Before Start it takes the planned tasks with it; after, they stay as ordinary tasks. */
export function DeleteWorkflowDialog({ summary, onConfirm, onCancel }: {
  summary: WorkflowSummary;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const state = summary.workflow.state;
  let message: React.ReactNode;
  if (state === 'draft') {
    message = summary.taskCount > 0
      ? <p>Deletes its {plural(summary.taskCount, 'planned task', 'planned tasks')} and the agent conversation. Nothing else changes.</p>
      : <p>Deletes the agent conversation. Nothing else changes.</p>;
  } else {
    const unfinished = summary.taskCount - summary.doneCount;
    message = (
      <>
        <p>
          {unfinished === 1
            ? 'Its 1 unfinished task stays where it is, as an ordinary task.'
            : `Its ${unfinished} unfinished tasks stay where they are, as ordinary tasks.`}
          {' '}The agent conversation is deleted.
        </p>
        {state === 'paused' && unfinished > 0 && (
          <p className="mt-2.5">{unfinished === 1 ? 'It stays paused until you resume it.' : 'They stay paused until you resume them.'}</p>
        )}
      </>
    );
  }
  return (
    <ConfirmDialog
      title={`Delete ${summary.workflow.title}?`}
      message={message}
      confirmLabel="Delete"
      variant="danger"
      testId="workflow-delete-confirm"
      onConfirm={() => onConfirm()}
      onCancel={onCancel}
    />
  );
}

/** Remove one task from its workflow. The line says which outcome: gone for good before Start, an ordinary task after. */
export function RemoveTaskDialog({ workflow, task, onConfirm, onCancel }: {
  workflow: Workflow;
  task: WorkflowViewTask;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const planned = task.place === 'planned';
  return (
    <ConfirmDialog
      title={`Remove ${taskLabel(task)} from ${workflow.title}?`}
      icon={<ListTree size={16} style={{ color: workflowColor(workflow.color_slot) }} />}
      message={<p>{planned ? 'It exists only in this workflow, so it is gone for good.' : 'It stays where it is, as an ordinary task.'}</p>}
      confirmLabel="Remove"
      testId="workflow-remove-confirm"
      onConfirm={() => onConfirm()}
      onCancel={onCancel}
    />
  );
}

export function RenameWorkflowDialog({ name, onRename, onCancel }: {
  name: string;
  onRename: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const trimmed = value.trim();
  const canRename = trimmed.length > 0;
  // Rename is enabled from the start, as on board 12. The same name renames
  // nothing: it closes without a write, which would bump the revision and turn
  // the workflow agent's next save stale.
  const submit = () => {
    if (!canRename) return;
    if (trimmed === name) onCancel();
    else onRename(trimmed);
  };

  return (
    <BaseDialog
      title="Rename workflow"
      onClose={onCancel}
      testId="workflow-rename-dialog"
      footer={(
        // The confirms' own footer pair (ConfirmDialog), so Rename reads as one of them.
        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-1.5 text-xs text-fg-muted hover:text-fg-secondary border border-edge-input hover:border-fg-faint rounded transition-colors"
            data-testid="workflow-rename-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canRename}
            className="px-4 py-1.5 text-xs rounded transition-colors bg-accent-emphasis enabled:hover:bg-accent text-accent-on disabled:opacity-40 disabled:cursor-not-allowed"
            data-testid="workflow-rename-confirm"
          >
            Rename
          </button>
        </div>
      )}
    >
      <input
        ref={inputRef}
        type="text"
        value={value}
        maxLength={120}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            submit();
          }
        }}
        aria-label="Workflow name"
        className="w-full px-3 py-2 bg-surface-control border border-edge-input rounded text-sm text-fg-tertiary placeholder-fg-muted focus:outline-none focus:border-accent"
        data-testid="workflow-rename-input"
      />
    </BaseDialog>
  );
}
