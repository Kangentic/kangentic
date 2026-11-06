import { useLingui } from '@lingui/react/macro';
import { DEFAULT_AGENT, type Task } from '../../../shared/types';
import { useBoardStore } from '../../stores/board-store';
import { useProjectStore } from '../../stores/project-store';
import { useModelDisplayNames } from '../../hooks/useKnownModels';
import { agentDisplayName } from '../../utils/agent-display-name';
import { modelRowLabel } from '../../utils/format-tokens';
import { resolveEffortDisplay, resolveModelDisplay } from '../../utils/pill-provenance';
import { useTaskDetailHost } from '../dialogs/task-detail/task-detail-host';
import { Tooltip } from '../Tooltip';
import { pill, plainContextBarClass } from './context-bar-pill';

/**
 * The bottom bar of a queued task's window: what the task will run with, read
 * only. Pausing the task brings the pickers back. A change made some other way
 * reaches the waiting command (`applyTaskSettingsToQueuedStart`), so this stays true.
 *
 * `task` comes in as a prop and the lane from the host, because this window can
 * be hosted by the Agent Monitor for a task the open board does not hold. A value
 * that does not resolve draws no pill: with nothing to pick, "Default" says nothing.
 */
export function QueuedContextBar({ task }: { task: Task }) {
  const { t } = useLingui();
  const { projectId, defaultAgent, swimlanes } = useTaskDetailHost();
  const agent = task.agent ?? defaultAgent ?? DEFAULT_AGENT;
  const lane = swimlanes.find((candidate) => candidate.id === task.swimlane_id);
  // Only the open project's defaults are known here, so another project's task
  // shows what the task and its column set.
  const project = useProjectStore((state) => (state.currentProject?.id === projectId ? state.currentProject : null));
  const profileName = useBoardStore((state) => (
    state.boardProfiles.find((profile) => profile.id === task.profile_id)?.name ?? null
  ));
  const modelDisplayNames = useModelDisplayNames(agent);

  const { value: modelId } = resolveModelDisplay({
    liveModelName: null,
    telemetryLanded: false,
    taskModelOverride: task.model_override ?? null,
    swimlaneModelOverride: lane?.model_override ?? null,
    projectDefaultModel: project?.default_model ?? null,
  });
  const { value: effort } = resolveEffortDisplay({
    liveEffort: null,
    taskEffortOverride: task.effort_override ?? null,
    swimlaneEffortOverride: lane?.effort_override ?? null,
    projectDefaultEffort: project?.default_effort ?? null,
  });
  const changeTip = t`Pause this task to change it`;

  return (
    <div className={plainContextBarClass} data-testid="queued-context-bar">
      {profileName && <span className={`${pill} text-fg-muted`}>{profileName}</span>}
      <span className={`${pill} text-fg-muted`}>{agentDisplayName(agent)}</span>
      {modelId && (
        <Tooltip label={changeTip}>
          <span className={`${pill} text-fg-muted`} data-testid="queued-context-bar-model">
            {modelRowLabel(modelId, modelDisplayNames)}
          </span>
        </Tooltip>
      )}
      {effort && (
        <Tooltip label={changeTip}>
          <span className={`${pill} text-fg-faint`} data-testid="queued-context-bar-effort">{effort}</span>
        </Tooltip>
      )}
    </div>
  );
}
