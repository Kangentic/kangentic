import React, { useCallback, useMemo, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { AppConfig, Task } from '../../../shared/types';
import { boardEnds, routeSteps, taskPlace } from '../../../shared/workflow-route';
import { useBoardStore } from '../../stores/board-store';
import { useProjectStore } from '../../stores/project-store';
import { useWorkflowStore } from '../../stores/workflow-store';
import { boardWaiting, boardWorkflowSource, toBoardWorkflow, type BoardWorkflow } from '../../utils/board-workflow';
import { WorkflowCardStrip, WorkflowGlyph, WorkflowStripLabel } from '../workflows/WorkflowStrip';
import { TaskCardBody, WorkflowWaitingBar, type TaskCardViewModel } from './task-card-view';
import { useCardLinksPreview } from './card-links-preview';
import { cardStripBleedClass } from './CardStrip';
import { AutomationsDisabledCardStrip } from './AutomationsDisabledStrip';
import { canTaskRunAutomations } from '../../../shared/automation-manifest';

/**
 * A workflow task's card content on the board: the workflow strip on top
 * (its workflow's icon in the workflow's color, the name, the step track),
 * under the "Automations paused" strip while the task is held, then the
 * board's own card, whose footer says what a task in To Do waits for.
 *
 * The track's current step is a bar here, not the column's marker the
 * Workflows canvas draws: the lane the card sits in already names it.
 *
 * Mounted only for a task in a workflow, so an ordinary card pays for none of
 * these subscriptions.
 *
 * The strip and the footer are memoized on the task row: dnd-kit re-renders
 * every card when a drag starts, and they skip that pass. Measured with
 * `scripts/drag-perf-rig.mjs` (W100 board drag against the same cards with no
 * workflow).
 */

/** The card's workflow, as its summary describes it; null until the summary is loaded. */
export function useBoardWorkflow(task: Task): BoardWorkflow | null {
  const boardProjectId = useProjectStore((state) => state.currentProject?.id ?? null);
  // The workflow row and this task's own facts, each kept by reference across a
  // reload that did not change them (`shareSummaries`), so a move elsewhere in
  // the workflow re-renders only the cards it changed.
  const { workflow, facts, homeProjectId } = useWorkflowStore(useShallow(useCallback(
    (state: ReturnType<typeof useWorkflowStore.getState>) => {
      const source = boardWorkflowSource(state.summaries, state.homeSummaries, task, boardProjectId);
      return { workflow: source?.workflow ?? null, facts: source?.facts ?? null, homeProjectId: source?.homeProjectId ?? null };
    },
    [task, boardProjectId],
  )));
  return useMemo(
    () => (workflow && homeProjectId ? toBoardWorkflow({ workflow, facts, homeProjectId }) : null),
    [workflow, facts, homeProjectId],
  );
}

const BoardWorkflowStrip = React.memo(function BoardWorkflowStrip({ task, density, interactive }: {
  task: Task;
  density: AppConfig['cardDensity'];
  interactive: boolean;
}) {
  const workflow = useBoardWorkflow(task);
  // Resting on the card shows its workflow links; the strip anchors the card it is in.
  const stripRef = useRef<HTMLDivElement>(null);
  useCardLinksPreview(stripRef, task.id, workflow, interactive);
  const swimlanes = useBoardStore((state) => state.swimlanes);
  // The board store keeps an unchanged task's object across reloads, so this
  // recomputes on a real change to the row or the board's columns only.
  const steps = useMemo(() => routeSteps(swimlanes, task), [swimlanes, task]);
  const ends = useMemo(() => boardEnds(swimlanes), [swimlanes]);
  const place = useMemo(() => taskPlace(swimlanes, task), [swimlanes, task]);
  const held = !canTaskRunAutomations(task).ok;
  if (!workflow && !held) return null;
  return (
    // One bleed wrapper around both strips, so they stack flush and the pair
    // still meets the card's rounded top corners, as the Agent Monitor's card.
    <div
      className={cardStripBleedClass(density)}
      data-workflow-id={workflow?.workflowId}
      ref={stripRef}
    >
      {held && <AutomationsDisabledCardStrip testId="task-card-automations-disabled" inWorkflow />}
      {workflow && (
        <WorkflowCardStrip
          // No pause glyph for a paused workflow (2026-10-21): at 11px it read as
          // stray bars, and the Agent Monitor's strip draws none. A paused task in
          // To Do still says "Paused" in its footer.
          leading={(
            <WorkflowStripLabel
              icon={<WorkflowGlyph colorSlot={workflow.colorSlot} />}
              label={workflow.title}
              className="gap-[5px] text-fg-muted"
            />
          )}
          steps={steps}
          ends={ends}
          place={place}
          // The lane the card sits in names its column, so the board keeps the bar.
          currentStep="bar"
          stallReason={workflow.state === 'running' ? workflow.stallReason : null}
        />
      )}
    </div>
  );
});

/** What a To Do card waits for ("Blocked by #413...", "Queued...", "Paused"). */
const BoardWorkflowFooter = React.memo(function BoardWorkflowFooter({ task }: { task: Task }) {
  const waiting = boardWaiting(useBoardWorkflow(task), task);
  return waiting ? <WorkflowWaitingBar label={waiting.label} paused={waiting.paused} /> : null;
});

interface WorkflowTaskCardBodyProps {
  task: Task;
  view: TaskCardViewModel;
  density: AppConfig['cardDensity'];
  /** False on the drag overlay's and the flying card's copies: drawn, but a hover on them shows nothing. */
  interactive: boolean;
}

export function WorkflowTaskCardBody({ task, view, density, interactive }: WorkflowTaskCardBodyProps) {
  const inToDo = useBoardStore((state) => state.swimlanes.find((lane) => lane.id === task.swimlane_id)?.role === 'todo');
  return (
    <>
      <BoardWorkflowStrip task={task} density={density} interactive={interactive} />
      <TaskCardBody
        task={task}
        view={view}
        density={density}
        idleFooter={inToDo ? <BoardWorkflowFooter task={task} /> : undefined}
        hostDrawsAutomationsStrip
      />
    </>
  );
}
