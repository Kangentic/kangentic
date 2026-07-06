import React, { useState } from 'react';
import { Info } from 'lucide-react';
import { useBoardStore } from '../../stores/board-store';
import { useProjectStore } from '../../stores/project-store';
import { useConfigStore } from '../../stores/config-store';
import { useAgentCapabilityResolution } from '../../hooks/useAgentCapabilityResolution';
import { useModelContextWindows } from '../../hooks/useKnownModels';
import { DEFAULT_AGENT } from '../../../shared/types';
import { ModelCombobox } from './ModelCombobox';
import { DisclosureSection } from '../DisclosureSection';
import { Select } from '../settings/shared';

interface AdvancedOverridesSectionProps {
  /** Destination/current swimlane ID. Used to resolve the fallback agent (column.agent_override > project default) for capability lookup. */
  swimlaneId: string;
  agentOverride: string;
  setAgentOverride: (value: string) => void;
  modelOverride: string;
  setModelOverride: (value: string) => void;
  effortOverride: string;
  setEffortOverride: (value: string) => void;
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
 *   - "Use column default" (empty string) defers to the destination
 *     column's overrides and the project default at spawn time.
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
  defaultOpen = false,
}: AdvancedOverridesSectionProps) {
  const [advancedOpen, setAdvancedOpen] = useState(defaultOpen);
  const currentProject = useProjectStore((state) => state.currentProject);
  const destinationSwimlane = useBoardStore((state) => state.swimlanes.find((lane) => lane.id === swimlaneId));
  // Effective-agent resolution for the New Task / Edit dialog: user pick
  // wins over the destination column's override, then the project default,
  // then the global default. This is the same chain `resolveTargetAgent`
  // uses in the main process - keeping them aligned avoids surprises where
  // the dialog shows one agent's capabilities and the spawn uses another.
  const fallbackAgent = destinationSwimlane?.agent_override ?? currentProject?.default_agent ?? DEFAULT_AGENT;
  const effectiveAgent = agentOverride || fallbackAgent;

  const {
    models: advancedModelOptions,
    effortLevels: advancedEffortOptions,
    supportsModelOverride: showModelPicker,
    availableAgents,
    showAgentPicker,
  } = useAgentCapabilityResolution(effectiveAgent);
  const modelContextWindows = useModelContextWindows(effectiveAgent);
  const showEffortPicker = advancedEffortOptions.length > 0;
  const showAdvancedSection = showAgentPicker || showModelPicker || showEffortPicker;

  const handleAgentChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    setAgentOverride(event.target.value);
    // Previous model/effort picks were valid for the previous agent's
    // capability matrix; clear so the user re-picks from the new agent.
    setModelOverride('');
    setEffortOverride('');
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
            <Select
              value={agentOverride}
              onChange={handleAgentChange}
              className="appearance-none bg-surface border border-edge-input rounded pl-3 pr-10 py-1.5 text-sm text-fg w-full focus:outline-none focus:border-accent"
              data-testid="task-agent-override"
            >
              <option value="">Use column default</option>
              {availableAgents.map((entry) => (
                <option key={entry.name} value={entry.name}>{entry.displayName ?? entry.name}</option>
              ))}
            </Select>
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
                  placeholder="Use column default"
                  testId="task-model-override"
                  onOpen={() => useConfigStore.getState().rescanModels()}
                  contextWindows={modelContextWindows}
                />
              </div>
            )}
            {showEffortPicker && (
              <div className="flex-1">
                <label className="text-xs text-fg-muted mb-1 block">Effort</label>
                <Select
                  value={effortOverride}
                  onChange={(event) => setEffortOverride((event.target as HTMLSelectElement).value)}
                  className="appearance-none bg-surface border border-edge-input rounded pl-3 pr-10 py-1.5 text-sm text-fg w-full focus:outline-none focus:border-accent"
                  data-testid="task-effort-override"
                >
                  <option value="">Use column default</option>
                  {advancedEffortOptions.map((value) => (
                    <option key={value} value={value}>{value}</option>
                  ))}
                </Select>
              </div>
            )}
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
