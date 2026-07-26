import { useBoardStore } from '../../stores/board-store';
import { useProjectStore } from '../../stores/project-store';
import { agentDisplayName } from '../../utils/agent-display-name';
import { DEFAULT_AGENT } from '../../../shared/types';
import { ModelEffortPicker } from './ModelEffortPicker';
import { ProfilePicker } from './ProfilePicker';

const pill = 'px-2 py-0.5 rounded bg-surface-raised whitespace-nowrap select-none';
const containerClass = 'min-h-8 bg-surface/80 border-t border-edge flex flex-wrap items-center px-3 py-1.5 gap-x-2 gap-y-2 text-xs flex-shrink-0';

interface PreSpawnContextBarProps {
  taskId: string;
}

/**
 * Slim context bar shown when a task is open but no agent is running yet.
 * Lets the user pick a per-task model/effort override before first spawn,
 * eliminating the spawn -> cancel -> restart loop tracked in issue #24.
 *
 * Resolution order matches the live ContextBar / spawn-engine contract:
 *   task override > swimlane override > project default agent.
 *
 * The override is persisted via the same `setTaskRuntimeOverride` action.
 * The IPC handler short-circuits to `mode: 'persisted'` when there's no
 * live session, so prepare-spawn picks it up on the next spawn naturally.
 */
export function PreSpawnContextBar({ taskId }: PreSpawnContextBarProps) {
  const task = useBoardStore((s) => s.tasks.find((t) => t.id === taskId));
  const currentProject = useProjectStore((s) => s.currentProject);

  if (!task) return null;

  // Resolve the agent for capability lookup. Once a task has spawned at least
  // once, `task.agent` is set; before the first spawn it's null and we fall
  // through to the project default. This mirrors what the spawn engine will
  // actually use.
  const resolvedAgent = task.agent ?? currentProject?.default_agent ?? DEFAULT_AGENT;

  return (
    <div className={containerClass} data-testid="prespawn-context-bar">
      {/* First in the row: the profile determines the agent/model/effort shown
          to its right. This is where a task is usually tiered - open in To Do,
          nothing running yet, before the first auto-spawn column. */}
      <ProfilePicker taskId={task.id} />
      <span className={`${pill} text-fg-muted`}>{agentDisplayName(resolvedAgent)}</span>
      <ModelEffortPicker
        target={{ kind: 'task', taskId: task.id }}
        agent={resolvedAgent}
        mode="prespawn"
      />
    </div>
  );
}
