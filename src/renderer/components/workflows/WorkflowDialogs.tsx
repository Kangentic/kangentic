import React, { useEffect, useRef, useState } from 'react';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { Pencil, Play, Workflow as WorkflowIcon } from 'lucide-react';
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

function TintedWorkflowIcon({ summary }: { summary: WorkflowSummary }) {
  return <WorkflowIcon size={16} style={{ color: workflowColor(summary.workflow.color_slot) }} />;
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
  const { t } = useLingui();
  const workflowTitle = summary.workflow.title;
  const taskCount = summary.taskCount;
  return (
    <ConfirmDialog
      title={t`Start ${workflowTitle}?`}
      icon={<TintedWorkflowIcon summary={summary} />}
      message={(
        <>
          <p>
            <Plural
              value={taskCount}
              one="Creates # task. It starts automatically."
              other="Creates # tasks. They start automatically in the order this workflow sets."
            />
          </p>
          {sourceTaskLabel && <p className="mt-2.5"><Trans>Task {sourceTaskLabel} moves to Done.</Trans></p>}
        </>
      )}
      confirmLabel={t`Start workflow`}
      confirmIcon={<Play size={12} className="shrink-0" data-testid="workflow-start-confirm-icon" />}
      testId="workflow-start-confirm"
      onConfirm={() => onConfirm()}
      onCancel={onCancel}
    />
  );
}

/**
 * Delete, in every state. Before Start it takes the planned tasks with it;
 * after, they stay as ordinary tasks. A started workflow with tasks that never
 * started offers to delete those too, off by default, and the first line then
 * counts only the tasks that stay.
 */
export function DeleteWorkflowDialog({ summary, onConfirm, onCancel }: {
  summary: WorkflowSummary;
  onConfirm: (deleteNeverStarted: boolean) => void;
  onCancel: () => void;
}) {
  const { t } = useLingui();
  const [deleteNeverStarted, setDeleteNeverStarted] = useState(false);
  const state = summary.workflow.state;
  const workflowTitle = summary.workflow.title;
  const taskCount = summary.taskCount;
  const neverStarted = state === 'draft' ? 0 : summary.neverStartedCount;
  const deletesNeverStarted = deleteNeverStarted && neverStarted > 0;
  let message: React.ReactNode;
  if (state === 'draft') {
    message = taskCount > 0
      ? (
        <p>
          <Plural
            value={taskCount}
            one="Deletes its # planned task and the agent conversation. Nothing else changes."
            other="Deletes its # planned tasks and the agent conversation. Nothing else changes."
          />
        </p>
      )
      : <p><Trans>Deletes the agent conversation. Nothing else changes.</Trans></p>;
  } else {
    // The unfinished tasks that stay: with the box ticked, the ones that never
    // started go. Named `unfinished` in every message, so the catalog's
    // existing translations still match.
    const unfinished = summary.taskCount - summary.doneCount - (deletesNeverStarted ? neverStarted : 0);
    message = (
      <>
        <p>
          {deletesNeverStarted
            ? (
              <Plural
                value={unfinished}
                _0="The agent conversation is deleted."
                one="Its # other unfinished task stays where it is, as an ordinary task. The agent conversation is deleted."
                other="Its # other unfinished tasks stay where they are, as ordinary tasks. The agent conversation is deleted."
              />
            )
            : (
              <Plural
                value={unfinished}
                _0="Its tasks are done and stay where they are. The agent conversation is deleted."
                one="Its # unfinished task stays where it is, as an ordinary task. The agent conversation is deleted."
                other="Its # unfinished tasks stay where they are, as ordinary tasks. The agent conversation is deleted."
              />
            )}
        </p>
        {state === 'paused' && unfinished > 0 && (
          <p className="mt-2.5">
            <Plural value={unfinished} one="It stays paused until you resume it." other="They stay paused until you resume them." />
          </p>
        )}
        {neverStarted > 0 && (
          <label className="mt-2.5 flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={deleteNeverStarted}
              onChange={(event) => setDeleteNeverStarted(event.target.checked)}
              className="accent-accent rounded border-edge-input bg-surface"
              data-testid="workflow-delete-never-started"
            />
            <span>
              <Plural
                value={neverStarted}
                one="Also delete its # task that never started"
                other="Also delete its # tasks that never started"
              />
            </span>
          </label>
        )}
      </>
    );
  }
  return (
    <ConfirmDialog
      title={t`Delete ${workflowTitle}?`}
      message={message}
      confirmLabel={t`Delete`}
      variant="danger"
      testId="workflow-delete-confirm"
      onConfirm={() => onConfirm(deletesNeverStarted)}
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
  const { t } = useLingui();
  const planned = task.place === 'planned';
  const label = taskLabel(task);
  const workflowTitle = workflow.title;
  return (
    <ConfirmDialog
      title={t`Remove ${label} from ${workflowTitle}?`}
      icon={<WorkflowIcon size={16} style={{ color: workflowColor(workflow.color_slot) }} />}
      message={<p>{planned ? t`It exists only in this workflow, so it is gone for good.` : t`It stays where it is, as an ordinary task.`}</p>}
      confirmLabel={t`Remove`}
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
  const { t } = useLingui();
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
      title={t`Rename workflow`}
      // The header's Rename button's pencil, before the title as the other titled dialogs have one.
      icon={<Pencil size={16} className="text-fg-muted" data-testid="workflow-rename-icon" />}
      onClose={onCancel}
      testId="workflow-rename-dialog"
      save={{ onSave: submit, disabled: !canRename }}
      footer={(
        // The confirms' own footer pair (ConfirmDialog), so Rename reads as one of them.
        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-1.5 text-xs text-fg-muted hover:text-fg-secondary border border-edge-input hover:border-fg-faint rounded transition-colors"
            data-testid="workflow-rename-cancel"
          >
            <Trans>Cancel</Trans>
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canRename}
            className="px-4 py-1.5 text-xs rounded transition-colors bg-accent-emphasis enabled:hover:bg-accent text-accent-on disabled:opacity-40 disabled:cursor-not-allowed"
            data-testid="workflow-rename-confirm"
          >
            <Trans>Rename</Trans>
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
        aria-label={t`Workflow name`}
        className="w-full px-3 py-2 bg-surface-control border border-edge-input rounded text-sm text-fg-tertiary placeholder-fg-muted focus:outline-none focus:border-accent"
        data-testid="workflow-rename-input"
      />
    </BaseDialog>
  );
}
