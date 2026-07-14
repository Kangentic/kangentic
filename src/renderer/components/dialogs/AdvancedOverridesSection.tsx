import { useState } from 'react';
import { Info } from 'lucide-react';
import { useBoardStore } from '../../stores/board-store';
import { useProjectStore } from '../../stores/project-store';
import { useConfigStore } from '../../stores/config-store';
import { useAgentCapabilityResolution } from '../../hooks/useAgentCapabilityResolution';
import { useModelContextWindows, useModelDisplayNames } from '../../hooks/useKnownModels';
import { DEFAULT_AGENT, DEFAULT_PERMISSIONS, getPermissionLabel } from '../../../shared/types';
import { modelRowLabel } from '../../utils/format-tokens';
import { ModelCombobox } from './ModelCombobox';
import { Combobox } from './Combobox';
import { DisclosureSection } from '../DisclosureSection';

interface AdvancedOverridesSectionProps {
  /** Destination/current swimlane ID. Used to resolve the fallback agent (column.agent_override > project default) for capability lookup. */
  swimlaneId: string;
  agentOverride: string;
  setAgentOverride: (value: string) => void;
  modelOverride: string;
  setModelOverride: (value: string) => void;
  effortOverride: string;
  setEffortOverride: (value: string) => void;
  permissionOverride: string;
  setPermissionOverride: (value: string) => void;
  /** Initial open state for the disclosure. Used by edit-mode to expand
   *  when the task already has overrides so they're visible at a glance. */
  defaultOpen?: boolean;
}

/**
 * The Advanced (Agent / Model / Effort) override section, shared between
 * New Task creation (`NewTaskDialog`) and existing-task edit
 * (`TaskDetailEditForm`).
 *
 * Resolution + locking contract:
 *   - The inherit state (empty string) shows the concrete value it resolves
 *     to today as a MUTED placeholder (the bare value, no "Inherit (...)"
 *     framing, no clear-X) - the muted weight alone signals "inherited, not
 *     pinned". A concrete pick renders at full weight with a clear-X.
 *     Leaving a field on inherit stores no override, so a later
 *     column/project-default change still applies - until first spawn (see
 *     below). Applies to all four fields (Agent/Model/Effort/Permission).
 *   - A concrete pick wins over the column for the task's lifetime; column
 *     moves cannot change it (see `resolveTargetAgent` and the cross-agent
 *     guards in `task-move.ts`). If the task has ANY of the four fields set
 *     when it spawns for the very first time ever, the other
 *     (still-inherited) fields are frozen too, to exactly the values this
 *     dialog displayed - resolved against the lane the task was configured
 *     in, never the destination column
 *     (`freezeAdvancedOverridesOnFirstSpawn` in `agent-spawn.ts`). So a
 *     value that already matched its inherited default gets locked, not
 *     silently left dynamic, and the whole Advanced tab is the task's
 *     contract from then on. One exception: a column that forces
 *     `permission_mode: 'plan'` always wins over the task's (picked or
 *     frozen) permission while the task is in that column - plan mode is a
 *     genuine safety guarantee, not just an ordinary column default (see
 *     `transition-engine.ts` / `prepare-spawn.ts`).
 *
 * Behaviour notes:
 *   - The Agent picker is hidden when only one agent is `found` (nothing
 *     meaningful to choose between).
 *   - Changing the agent resets model + effort because the previous picks
 *     were valid for the previous agent's capability matrix.
 *   - The whole disclosure is hidden when no capability surfaces are
 *     applicable (no agent picker, no model override support, no effort
 *     levels). Callers should still render this component and let it
 *     no-op via `null`.
 */
export function AdvancedOverridesSection({
  swimlaneId,
  agentOverride,
  setAgentOverride,
  modelOverride,
  setModelOverride,
  effortOverride,
  setEffortOverride,
  permissionOverride,
  setPermissionOverride,
  defaultOpen = false,
}: AdvancedOverridesSectionProps) {
  const [advancedOpen, setAdvancedOpen] = useState(defaultOpen);
  const currentProject = useProjectStore((state) => state.currentProject);
  const destinationSwimlane = useBoardStore((state) => state.swimlanes.find((lane) => lane.id === swimlaneId));
  const globalPermissionMode = useConfigStore((state) => state.config.agent.permissionMode);
  // Effective-agent resolution for the New Task / Edit dialog: user pick
  // wins over the destination column's override, then the project default,
  // then the global default. This is the same chain `resolveTargetAgent`
  // uses in the main process - keeping them aligned avoids surprises where
  // the dialog shows one agent's capabilities and the spawn uses another.
  const fallbackAgent = destinationSwimlane?.agent_override ?? currentProject?.default_agent ?? DEFAULT_AGENT;
  const effectiveAgent = agentOverride || fallbackAgent;

  const {
    info: effectiveAgentInfo,
    models: advancedModelOptions,
    effortLevels: advancedEffortOptions,
    supportsModelOverride: showModelPicker,
    availableAgents,
    showAgentPicker,
  } = useAgentCapabilityResolution(effectiveAgent);
  const modelContextWindows = useModelContextWindows(effectiveAgent);
  const modelDisplayNames = useModelDisplayNames(effectiveAgent);
  const showEffortPicker = advancedEffortOptions.length > 0;
  const permissionOptions = effectiveAgentInfo?.permissions ?? DEFAULT_PERMISSIONS;
  const showPermissionPicker = permissionOptions.length > 0;
  const showAdvancedSection = showAgentPicker || showModelPicker || showEffortPicker || showPermissionPicker;

  // Resolved values below the task tier - what each field would actually
  // spawn with if left on the inherit state. Shown as the BARE value in the
  // muted placeholder weight (see placeholderVariant below): the muted
  // rendering plus the absent clear-X is what distinguishes "inherited" from
  // a concrete pick, with no "Inherit (...)" text framing.
  const fallbackAgentDisplayName = availableAgents.find((entry) => entry.name === fallbackAgent)?.displayName ?? fallbackAgent;
  const fallbackModel = destinationSwimlane?.model_override ?? currentProject?.default_model ?? null;
  const fallbackModelLabel = fallbackModel ? modelRowLabel(fallbackModel, modelDisplayNames) : null;
  const fallbackEffort = destinationSwimlane?.effort_override ?? currentProject?.default_effort ?? null;
  const fallbackPermission = destinationSwimlane?.permission_mode ?? globalPermissionMode;
  const fallbackPermissionLabel = getPermissionLabel(permissionOptions, fallbackPermission);

  const agentInheritLabel = fallbackAgentDisplayName;
  const modelInheritLabel = fallbackModelLabel ?? 'Agent default';
  const effortInheritLabel = fallbackEffort ?? 'Agent default';
  const permissionInheritLabel = fallbackPermissionLabel;

  const handleAgentChange = (nextAgent: string) => {
    setAgentOverride(nextAgent);
    // Previous model/effort/permission picks were valid for the previous
    // agent's capability matrix; clear so the user re-picks from the new agent.
    setModelOverride('');
    setEffortOverride('');
    setPermissionOverride('');
  };

  if (!showAdvancedSection) return null;

  return (
    <DisclosureSection
      title="Advanced"
      open={advancedOpen}
      onOpenChange={setAdvancedOpen}
      testId="task-advanced-toggle"
    >
      <div className="space-y-2" data-testid="task-advanced-section">
        {showAgentPicker && (
          <div>
            <label className="text-xs text-fg-muted mb-1 block">Agent</label>
            <Combobox
              value={agentOverride}
              onChange={handleAgentChange}
              options={availableAgents.map((entry) => ({ value: entry.name, label: entry.displayName ?? entry.name }))}
              placeholder={agentInheritLabel}
              placeholderVariant="muted"
              testId="task-agent-override"
            />
          </div>
        )}
        {(showModelPicker || showEffortPicker) && (
          <div className="flex gap-3">
            {showModelPicker && (
              <div className="flex-1">
                <label className="text-xs text-fg-muted mb-1 block">Model</label>
                <ModelCombobox
                  value={modelOverride}
                  onChange={setModelOverride}
                  availableModels={advancedModelOptions}
                  placeholder={modelInheritLabel}
                  placeholderVariant="muted"
                  testId="task-model-override"
                  onOpen={() => useConfigStore.getState().rescanModels()}
                  contextWindows={modelContextWindows}
                  modelDisplayNames={modelDisplayNames}
                />
              </div>
            )}
            {showEffortPicker && (
              <div className="flex-1">
                <label className="text-xs text-fg-muted mb-1 block">Effort</label>
                <Combobox
                  value={effortOverride}
                  onChange={setEffortOverride}
                  options={advancedEffortOptions.map((level) => ({ value: level, label: level }))}
                  placeholder={effortInheritLabel}
                  placeholderVariant="muted"
                  testId="task-effort-override"
                />
              </div>
            )}
          </div>
        )}
        {showPermissionPicker && (
          <div>
            <label className="text-xs text-fg-muted mb-1 block">Permission</label>
            <Combobox
              value={permissionOverride}
              onChange={setPermissionOverride}
              options={permissionOptions.map((entry) => ({ value: entry.mode, label: entry.label }))}
              placeholder={permissionInheritLabel}
              placeholderVariant="muted"
              testId="task-permission-override"
            />
          </div>
        )}
        <div
          className="flex items-center gap-1.5 text-xs text-fg-muted"
          data-testid="task-advanced-help"
        >
          <Info size={12} className="shrink-0" />
          <span>Stays with this task across all column moves - column settings are ignored</span>
        </div>
      </div>
    </DisclosureSection>
  );
}
