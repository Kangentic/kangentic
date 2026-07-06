import { useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useBoardStore } from '../../stores/board-store';
import { useConfigStore } from '../../stores/config-store';
import { useKnownModels, useModelContextWindows, useModelDisplayNames } from '../../hooks/useKnownModels';
import { groupModelIds, type ModelDisplayGroup } from '../../../shared/model-id';
import { modelContextBadgeLabel, modelRowLabel } from '../../utils/format-tokens';
import { ContextBarPopover } from './ContextBarPopover';

const pill = 'px-2 py-0.5 rounded bg-surface-raised whitespace-nowrap select-none';

/**
 * Where a model/effort selection is applied:
 * - `task`: persisted per-task override via `setTaskRuntimeOverride` (board
 *   tasks - live, prespawn, and default-agent tasks).
 * - `session`: best-effort live inject into a transient (command-terminal)
 *   session via `onInject`. No task row, no DB persistence, no swimlane
 *   fallback.
 */
export type ModelEffortTarget =
  | { kind: 'task'; taskId: string }
  | {
      kind: 'session';
      sessionId: string;
      onInject: (patch: { model?: string | null; effort?: string | null }) => void;
    };

interface ModelEffortPickerProps {
  target: ModelEffortTarget;
  /** Agent name used to resolve `AgentCapabilities` (models / effortLevels / supportsModelOverride). */
  agent: string | null;
  /** Live model display name when the agent is running. Pre-spawn callers pass null. */
  liveModelName?: string | null;
  /** Live model ID for option matching (the canonical CLI value, e.g. `claude-opus-4-7`). */
  liveModelId?: string | null;
  /** Live effort tier when reported by the agent. Pre-spawn callers pass null. */
  liveEffort?: string | null;
  /**
   * `live`: hide the effort pill when no current value (matches today's
   * ContextBar behaviour - hiding agent state we don't have).
   * `prespawn`: always show pills when their capability is supported, with
   * `Default` placeholders so the user can pick before first spawn.
   */
  mode: 'live' | 'prespawn';
}

/**
 * Capability-gated model + effort pill row used by the ContextBar (live,
 * task + transient session) and PreSpawnContextBar (pre-spawn). All gating is
 * via `AgentCapabilities` flags exposed by the adapter - no agent-name
 * branching in the renderer.
 *
 * Task targets call the existing `setTaskRuntimeOverride` store action (the
 * IPC handler short-circuits to `mode: 'persisted'` when there's no live
 * session, so the same path works for live and pre-spawn writes). Session
 * targets call `onInject`, which best-effort injects the slash command into a
 * transient PTY with no persistence.
 */
export function ModelEffortPicker({
  target,
  agent,
  liveModelName = null,
  liveModelId = null,
  liveEffort = null,
  mode,
}: ModelEffortPickerProps) {
  const taskId = target.kind === 'task' ? target.taskId : null;
  const task = useBoardStore((s) => (taskId ? s.tasks.find((t) => t.id === taskId) ?? null : null));
  const swimlaneModelOverride = useBoardStore((s) =>
    task ? s.swimlanes.find((lane) => lane.id === task.swimlane_id)?.model_override ?? null : null,
  );
  const swimlaneEffortOverride = useBoardStore((s) =>
    task ? s.swimlanes.find((lane) => lane.id === task.swimlane_id)?.effort_override ?? null : null,
  );
  const setTaskRuntimeOverride = useBoardStore((s) => s.setTaskRuntimeOverride);
  const agentCapabilities = useConfigStore(
    (s) => s.agentList.find((a) => a.name === agent)?.capabilities,
  );
  // Pull the model list from the shared cache so the popover stays in sync
  // with the New Task Advanced section + column manager, and learns any model
  // the user invokes live.
  const modelOptions = useKnownModels(agent);
  const modelContextWindows = useModelContextWindows(agent);
  const modelDisplayNames = useModelDisplayNames(agent);
  // Display grouping only: one row per base model, with [1m] variants as a 1M
  // chip, dated pins demoted behind the popover's collapsed section, and a
  // superseded generation (an older Opus/Sonnet/Haiku version whose family
  // has a newer one) demoted alongside them. Every selectable value stays the
  // exact discovered string.
  const modelGroups = useMemo(() => groupModelIds(modelOptions), [modelOptions]);
  const latestModelGroups = useMemo(() => modelGroups.filter((group) => !group.isSuperseded), [modelGroups]);
  const supersededModelGroups = useMemo(() => modelGroups.filter((group) => group.isSuperseded), [modelGroups]);

  // Memoized to match the sibling `*ModelGroups` derivations above (the
  // pre-demotion code memoized the pinned list; keep parity so a later
  // React.memo on ContextBarPopover would see stable option identities).
  const { modelOptionsForPopover, pinnedModelOptions } = useMemo(() => {
    const toOption = (group: ModelDisplayGroup) => ({
      value: group.primaryId,
      label: modelRowLabel(group.primaryId, modelDisplayNames),
      oneMillionValue: group.oneMillionId,
      // Context-size badge (shared rule with ModelCombobox): "1M" for a
      // `[1m]`-only row, suppressed behind a selectable `[1m]` chip, else
      // the telemetry-learned window for the base id.
      contextLabel: modelContextBadgeLabel(group, modelContextWindows),
    });

    const latestOptions = latestModelGroups.map(toOption);
    // Merged "Older versions" list: every superseded generation (as a full row,
    // keeping its 1M chip / context badge) plus every group's dated pins, all
    // sorted together by id so a superseded alias renders directly above its
    // own dated pins and families stay clustered.
    const demotedEntries: Array<{ sortId: string; option: { value: string; label: string; oneMillionValue?: string | null; contextLabel?: string | null } }> = [];
    for (const group of supersededModelGroups) {
      demotedEntries.push({ sortId: group.primaryId, option: toOption(group) });
    }
    for (const group of modelGroups) {
      for (const id of group.pinnedBuildIds) {
        demotedEntries.push({ sortId: id, option: { value: id, label: modelRowLabel(id, modelDisplayNames) } });
      }
    }
    const demotedOptions = demotedEntries
      .sort((first, second) => first.sortId.localeCompare(second.sortId))
      .map((entry) => entry.option);

    return { modelOptionsForPopover: latestOptions, pinnedModelOptions: demotedOptions };
  }, [latestModelGroups, supersededModelGroups, modelGroups, modelDisplayNames, modelContextWindows]);

  const [openPopover, setOpenPopover] = useState<'model' | 'effort' | null>(null);
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const effortTriggerRef = useRef<HTMLButtonElement>(null);

  // Task targets need a resolved task row; session targets never have one.
  if (target.kind === 'task' && !task) return null;

  // Apply a selection to whichever target this picker is bound to. Task targets
  // persist via the runtime-override store action; session targets inject live.
  const applyModel = (value: string | null) => {
    setOpenPopover(null);
    if (target.kind === 'task') {
      setTaskRuntimeOverride(target.taskId, { model: value });
    } else {
      target.onInject({ model: value });
    }
  };
  const applyEffort = (value: string | null) => {
    setOpenPopover(null);
    if (target.kind === 'task') {
      setTaskRuntimeOverride(target.taskId, { effort: value });
    } else {
      target.onInject({ effort: value });
    }
  };

  const effortOptions = agentCapabilities?.effortLevels ?? [];
  const supportsModel = !!agentCapabilities?.supportsModelOverride && modelOptions.length > 0;
  const supportsEffort = effortOptions.length > 0;

  const taskModelOverride = task?.model_override ?? null;
  const taskEffortOverride = task?.effort_override ?? null;
  // Effort fallback chain: live status (truth) -> task override -> swimlane
  // override. Some Claude models (Haiku 4.5) accept --effort but never echo
  // it back in status updates, so without this chain the pill stays blank
  // even though the user explicitly configured an effort tier.
  const effectiveEffort = liveEffort ?? taskEffortOverride ?? swimlaneEffortOverride;

  // Display labels:
  // - live mode: existing behavior (live > overrides; effort pill suppressed when null)
  // - prespawn: show overrides falling through to "Default" so users can click to pick
  // An override is humanized the same way as the popover rows for
  // consistency; the live telemetry name is already human-readable and wins.
  const modelOverrideId = taskModelOverride || swimlaneModelOverride;
  const modelOverrideLabel = modelOverrideId
    ? modelRowLabel(modelOverrideId, modelDisplayNames)
    : null;
  const modelLabel = liveModelName ?? modelOverrideLabel ?? 'Default';
  const showModelTrigger = supportsModel;
  const showEffortTrigger = supportsEffort && (mode === 'prespawn' || effectiveEffort != null);
  const effortLabel = effectiveEffort ?? 'Default';

  // Resolve checkmark target: live ID match > task override.
  const currentModelValue = (liveModelId ? modelOptions.find((id) => id === liveModelId) : undefined)
    ?? taskModelOverride
    ?? null;
  const currentEffortValue = effectiveEffort ?? null;

  const triggerBase = `${pill} text-fg-muted inline-flex items-center gap-1`;
  const interactiveBase = 'cursor-pointer hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-fg-faint';

  return (
    <>
      {showModelTrigger ? (
        <span className="relative inline-flex">
          <button
            ref={modelTriggerRef}
            type="button"
            onClick={() => {
              const opening = openPopover !== 'model';
              setOpenPopover(opening ? 'model' : null);
              // Opening: kick off an on-demand rescan so a newly shipped model
              // appears without a restart (non-blocking, throttled in the store).
              if (opening) useConfigStore.getState().rescanModels();
            }}
            className={`${triggerBase} ${interactiveBase}`}
            data-testid="context-bar-model-trigger"
            title="Click to change model"
          >
            {modelLabel}
            <ChevronDown size={11} className="text-fg-faint flex-shrink-0" />
          </button>
          {openPopover === 'model' && (
            <ContextBarPopover
              triggerRef={modelTriggerRef}
              title="Model"
              options={modelOptionsForPopover}
              pinnedOptions={pinnedModelOptions}
              currentValue={currentModelValue}
              swimlaneDefault={swimlaneModelOverride}
              onSelect={applyModel}
              onClose={() => setOpenPopover(null)}
              testId="context-bar-model-popover"
            />
          )}
        </span>
      ) : (
        liveModelName && (
          <span
            className={`${pill} text-fg-muted`}
            title="This agent does not support changing the model from Kangentic"
          >
            {liveModelName}
          </span>
        )
      )}
      {showEffortTrigger ? (
        <span className="relative inline-flex">
          <button
            ref={effortTriggerRef}
            type="button"
            onClick={() => setOpenPopover((previous) => (previous === 'effort' ? null : 'effort'))}
            className={`${triggerBase} ${interactiveBase} text-fg-faint`}
            data-testid="context-bar-effort-trigger"
            title="Click to change effort"
          >
            {effortLabel}
            <ChevronDown size={11} className="flex-shrink-0" />
          </button>
          {openPopover === 'effort' && (
            <ContextBarPopover
              triggerRef={effortTriggerRef}
              title="Effort"
              options={effortOptions.map((value) => ({ value, label: value }))}
              currentValue={currentEffortValue}
              swimlaneDefault={swimlaneEffortOverride}
              onSelect={applyEffort}
              onClose={() => setOpenPopover(null)}
              testId="context-bar-effort-popover"
            />
          )}
        </span>
      ) : (
        effectiveEffort && (
          <span
            className={`${pill} text-fg-faint`}
            title="This agent does not support changing the effort level from Kangentic"
          >
            {effectiveEffort}
          </span>
        )
      )}
    </>
  );
}
