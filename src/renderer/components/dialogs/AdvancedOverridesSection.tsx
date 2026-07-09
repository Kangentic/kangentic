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
 *   - The inherit option (empty string) defers to the destination column's
 *     overrides and the project default at spawn time. Its label IS the
 *     concrete value that resolves to today (e.g. "Opus 4.8", no "Use
 *     default (...)" framing - the value is self-evident) - leaving it as-is
 *     stores no override, so a later project-default change still applies.
 *   - A concrete pick wins over the column for the task's lifetime;
 *     column moves cannot change it (see `resolveTargetAgent` and the
 *     cross-agent guards in `task-move.ts`).
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
  // spawn with if left on the inherit option. Surfaced directly as that
  // option's label (no "Use default (...)" framing) so the picker just
  // shows the real value that will be used - self-evident, no extra text
  // needed to explain it.
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
                  placeholderVariant={fallbackModelLabel ? 'resolved' : 'muted'}
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
                  placeholderVariant={fallbackEffort ? 'resolved' : 'muted'}
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
