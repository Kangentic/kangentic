import { useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useBoardStore } from '../../stores/board-store';
import { useConfigStore } from '../../stores/config-store';
import { useProjectStore } from '../../stores/project-store';
import { useKnownModels, useModelContextWindows, useModelDisplayNames } from '../../hooks/useKnownModels';
import { groupModelIds, type ModelDisplayGroup } from '../../../shared/model-id';
import { modelContextBadgeLabel, modelRowLabel } from '../../utils/format-tokens';
import { resolveEffortDisplay, resolveModelDisplay } from '../../utils/pill-provenance';
import { ContextBarPopover } from './ContextBarPopover';
import { pillForProvenance } from './context-bar-pill';

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
   * True once a live telemetry snapshot has been parsed for this session. A
   * spawn seeds `liveModelName` from the `--model` flag before any telemetry
   * arrives, so this is what separates a confirmed model from a configured one.
   * Pre-spawn callers leave it false: nothing is running, so nothing is live.
   */
  telemetryLanded?: boolean;
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
  telemetryLanded = false,
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
  // Project-level default: the tier below the swimlane and above the CLI
  // default. Falls through into the pill display and the popover's
  // clear-to-default row so the picker never shows the generic "Default"
  // placeholder when the project actually has a preferred model/effort.
  const currentProject = useProjectStore((s) => s.currentProject);
  const projectDefaultModel = currentProject?.default_model ?? null;
  const projectDefaultEffort = currentProject?.default_effort ?? null;
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
  // override -> project default. It covers the window before the agent's first
  // status write, where a configured tier is the best answer available. What it
  // lacked was any way to say WHICH tier answered, so a configured value
  // rendered as confidently as telemetry. `isLive` below carries that and drives
  // the pill styling. (A model with no effort levels is handled separately, by
  // hiding the pill outright - see `agentReportsNoEffort`.)
  const effortDisplay = resolveEffortDisplay({
    liveEffort,
    taskEffortOverride,
    swimlaneEffortOverride,
    projectDefaultEffort,
  });
  const effectiveEffort = effortDisplay.value;

  // Display labels:
  // - live mode: existing behavior (live > overrides; effort pill suppressed when null)
  // - prespawn: show overrides falling through to "Default" so users can click to pick
  // An override is humanized the same way as the popover rows for
  // consistency; the live telemetry name is already human-readable and wins.
  const modelDisplay = resolveModelDisplay({
    liveModelName,
    telemetryLanded,
    taskModelOverride,
    swimlaneModelOverride,
    projectDefaultModel,
  });
  const modelLabel = modelDisplay.value === null
    ? 'Default'
    : liveModelName != null
      ? modelDisplay.value
      : modelRowLabel(modelDisplay.value, modelDisplayNames);
  // A snapshot arrived and carried no effort: this model has no effort levels at
  // all (Claude Code omits the field per-model), so there is nothing to report
  // and nothing the picker could apply to THIS session. Hide it rather than
  // offer a control that cannot act, or print a configured tier that has no
  // meaning here. Derived from telemetry, never from a model list of our own.
  const agentReportsNoEffort = mode === 'live' && telemetryLanded && liveEffort == null;
  const showModelTrigger = supportsModel;
  const showEffortTrigger = supportsEffort && !agentReportsNoEffort
    && (mode === 'prespawn' || effectiveEffort != null);
  const effortLabel = effectiveEffort ?? 'Default';

  // Marking provenance is a LIVE-bar concern: the defect is a running agent's
  // bar reading as telemetry when it is not. PreSpawnContextBar has no session,
  // no cost, no tokens and no context meter, so nothing there can be mistaken
  // for telemetry - marking its pills would be noise on a surface with no bug
  // (and would sit oddly beside its solid agent and profile pills). In prespawn
  // both pills render exactly as they always have.
  const markProvenance = mode === 'live';
  const modelConfirmed = !markProvenance || modelDisplay.isLive;
  const effortConfirmed = !markProvenance || effortDisplay.isLive;
  const modelSource = markProvenance ? (modelDisplay.isLive ? 'live' : 'configured') : undefined;
  const effortSource = markProvenance ? (effortDisplay.isLive ? 'live' : 'configured') : undefined;

  // Copy for an unconfirmed value. Only one case reaches here now: no snapshot
  // has arrived yet, which is transient and resolves on its own. A model with no
  // effort levels hides the pill entirely (`agentReportsNoEffort`) rather than
  // explaining a value that does not apply.
  const effortProvisionalTitle = 'Waiting for the agent to report. Showing your configured default.';
  const modelProvisionalTitle = 'Waiting for the agent to report. Showing the model this session was started with.';

  // The column/project default the "Use column default" row reverts to, in the
  // same humanized form the option rows use.
  const swimlaneDefaultModelId = swimlaneModelOverride ?? projectDefaultModel;
  const swimlaneDefaultModelLabel = swimlaneDefaultModelId
    ? modelRowLabel(swimlaneDefaultModelId, modelDisplayNames)
    : null;

  // Resolve checkmark target: live ID match > task override.
  const currentModelValue = (liveModelId ? modelOptions.find((id) => id === liveModelId) : undefined)
    ?? taskModelOverride
    ?? null;
  const currentEffortValue = effectiveEffort ?? null;

  // Pill variant is chosen per-trigger from provenance, so `triggerBase` no
  // longer carries it. Both variants have a border (transparent when live), so
  // a pill flipping provisional -> live on a status update only repaints.
  const triggerBase = 'text-fg-muted inline-flex items-center gap-1';
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
            className={`${pillForProvenance(modelConfirmed)} ${triggerBase} ${interactiveBase}`}
            data-testid="context-bar-model-trigger"
            data-model-source={modelSource}
            title={modelConfirmed ? 'Click to change model' : `${modelProvisionalTitle} Click to change.`}
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
              swimlaneDefault={swimlaneModelOverride ?? projectDefaultModel}
              // Humanized the same way as the rows above, so the footer reads
              // "Use column default (Sonnet 5)" rather than the raw CLI id.
              swimlaneDefaultLabel={swimlaneDefaultModelLabel}
              onSelect={applyModel}
              onClose={() => setOpenPopover(null)}
              testId="context-bar-model-popover"
            />
          )}
        </span>
      ) : (
        liveModelName && (
          <span
            className={`${pillForProvenance(modelConfirmed)} text-fg-muted`}
            data-testid="context-bar-model-static"
            data-model-source={modelSource}
            title={modelConfirmed
              ? 'This agent does not support changing the model from Kangentic'
              : `${modelProvisionalTitle} This agent does not support changing it from Kangentic.`}
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
            className={`${pillForProvenance(effortConfirmed)} ${triggerBase} ${interactiveBase} text-fg-faint`}
            data-testid="context-bar-effort-trigger"
            data-effort-source={effortSource}
            title={effortConfirmed ? 'Click to change effort' : `${effortProvisionalTitle} Click to change.`}
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
              swimlaneDefault={swimlaneEffortOverride ?? projectDefaultEffort}
              onSelect={applyEffort}
              onClose={() => setOpenPopover(null)}
              testId="context-bar-effort-popover"
            />
          )}
        </span>
      ) : (
        !agentReportsNoEffort && effectiveEffort && (
          <span
            className={`${pillForProvenance(effortConfirmed)} text-fg-faint`}
            data-testid="context-bar-effort-static"
            data-effort-source={effortSource}
            title={effortConfirmed
              ? 'This agent does not support changing the effort level from Kangentic'
              : `${effortProvisionalTitle} This agent does not support changing it from Kangentic.`}
          >
            {effectiveEffort}
          </span>
        )
      )}
    </>
  );
}
