import { useMemo } from 'react';
import { useConfigStore } from '../stores/config-store';
import type { AgentDetectionInfo } from '../../shared/types';
import { useKnownModels } from './useKnownModels';

export interface AgentCapabilityResolution {
  /** Full detection info entry for the effective agent (capabilities,
   *  permissions, displayName, found, version, etc.). Undefined when the
   *  agent name isn't in the detected list. */
  info: AgentDetectionInfo | undefined;
  /** Sorted union of `capabilities.models` and the persisted
   *  `discoveredModelsByAgent` cache. The single source of truth that backs
   *  every model dropdown in the app. */
  models: string[];
  /** Convenience: `capabilities.effortLevels ?? []`. */
  effortLevels: string[];
  /** Convenience: `capabilities.supportsModelOverride ?? false`. */
  supportsModelOverride: boolean;
  /** All detected (`found: true`) agents - the options for an agent
   *  dropdown. Stable reference across renders only when `agentList`
   *  itself is unchanged; callers that depend on identity should memoize. */
  availableAgents: AgentDetectionInfo[];
  /** True when there's more than one detected agent to pick between. The
   *  Agent dropdown in the New Task / Edit dialogs always RENDERS; this
   *  says whether it is interactive, so a single-agent machine shows the
   *  field locked on the one agent it has rather than dropping the row. */
  canPickAgent: boolean;
}

/**
 * Resolves "given an agent name, what does the UI need to know about its
 * capabilities". Shared between the New Task / Edit dialog Advanced section
 * (`AdvancedOverridesSection`) and the column manager's Agent tab
 * (`BoardManagerDialog`).
 *
 * Effective-agent resolution stays at the call site because the rules
 * differ:
 *   - Task dialog: `task.agent_override > swimlane.agent_override >
 *     project.default_agent > DEFAULT_AGENT`.
 *   - Column manager: `lane.agent_override > project.default_agent`.
 *
 * Pass `null` to opt out of capability lookup entirely (returns empty /
 * undefined fields but still surfaces `availableAgents` and
 * `canPickAgent` for the dropdown).
 */
export function useAgentCapabilityResolution(effectiveAgent: string | null): AgentCapabilityResolution {
  const agentList = useConfigStore((state) => state.agentList);
  const models = useKnownModels(effectiveAgent);
  // Memoize the derived shape so consumers see stable identity when the
  // upstream `agentList` and `effectiveAgent` haven't changed. Cheap
  // (~one shallow compare per render); the win is that downstream
  // identity-sensitive code (memoized children, useEffect dep arrays) does
  // not see spurious changes from a recomputed object literal.
  return useMemo(() => {
    const info = effectiveAgent
      ? agentList.find((entry) => entry.name === effectiveAgent)
      : undefined;
    const effortLevels = info?.capabilities?.effortLevels ?? [];
    const supportsModelOverride = !!info?.capabilities?.supportsModelOverride;
    const availableAgents = agentList.filter((entry) => entry.found);
    const canPickAgent = availableAgents.length > 1;
    return { info, models, effortLevels, supportsModelOverride, availableAgents, canPickAgent };
  }, [agentList, effectiveAgent, models]);
}
