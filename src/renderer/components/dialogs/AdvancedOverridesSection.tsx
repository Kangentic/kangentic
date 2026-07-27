import { useState } from 'react';
import type { ReactNode } from 'react';
import { Pencil } from 'lucide-react';
import { useBoardStore } from '../../stores/board-store';
import { useProjectStore } from '../../stores/project-store';
import { useConfigStore } from '../../stores/config-store';
import { useAgentCapabilityResolution } from '../../hooks/useAgentCapabilityResolution';
import { useModelContextWindows, useModelDisplayNames } from '../../hooks/useKnownModels';
import { DEFAULT_AGENT, DEFAULT_PERMISSIONS, getPermissionLabel } from '../../../shared/types';
import { modelRowLabel } from '../../utils/format-tokens';
import { ModelCombobox } from './ModelCombobox';
import { Combobox } from './Combobox';
import { Select } from '../settings/shared';

/** The two ways a task can get its agent settings. Exactly one is live at a time. */
type RunMode = 'profile' | 'override';

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
  /** Board Profile this task rides, or null for Default (the columns' own settings). */
  profileId: string | null;
  setProfileId: (value: string | null) => void;
}

interface EditPencilButtonProps {
  onClick: () => void;
  /** Used as both the hover tooltip and the accessible name. */
  title: string;
  testId: string;
  disabled?: boolean;
}

/**
 * The bordered pencil that sits to the right of a field and routes to wherever
 * that field's defaults are authored. Both rows of this section carry one, and
 * they must land at IDENTICAL geometry so the column of pencils reads as one
 * affordance rather than two lookalikes. One component is what guarantees that;
 * two copies of the same class string only promise it in a comment.
 */
function EditPencilButton({ onClick, title, testId, disabled = false }: EditPencilButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className="shrink-0 p-1.5 rounded border border-edge-input text-fg-muted hover:text-fg hover:bg-surface-hover transition-colors disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:text-fg-muted disabled:hover:bg-transparent"
      data-testid={testId}
    >
      <Pencil size={14} />
    </button>
  );
}

/**
 * The "how this task runs" section, shared between New Task creation
 * (`NewTaskDialog`) and existing-task edit (`TaskDetailEditForm`).
 *
 * It offers ONE either/or choice, rendered as two selectable cards:
 *   - **Column Settings** - the task's agent, model, and effort come from each
 *     column it moves through. Nothing is pinned. A Profile picker INSIDE this
 *     branch chooses which set of column settings applies: Default (the board as
 *     configured) or a named Board Profile's alternate ladder.
 *   - **Agent Override** - one agent / model / effort / permission pinned for
 *     the task's whole life, ignoring every column.
 *
 * The branch is named for the MECHANISM, not for the picker inside it: the
 * mechanism is the board's column configuration, and a Profile is one variant of
 * it. Labelling the branch "Profile" implied the Default path was a profile too,
 * which it is not.
 *
 * The two were previously stacked as separate controls (a Profile select, then
 * an "Agent Override" disclosure) and read as two independent settings rather
 * than as alternatives. They are mutually exclusive at the storage layer
 * (`applyProfileExclusivity` in `task-repository.ts`), so the affordance has to
 * say so: picking one branch clears the other's fields here, exactly as the
 * repository would on write.
 *
 * The mode is explicit state, NOT derived from "are any fields set". A user who
 * selects Agent Override and has not yet picked a value would otherwise snap
 * straight back to the Column Settings branch.
 *
 * Resolution + locking contract (Agent Override branch):
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
 *     (still-inherited) fields are locked too, to exactly the values this
 *     dialog displayed - resolved against the lane the task was configured
 *     in, never the destination column
 *     (`lockAdvancedOverridesOnFirstSpawn` in `spawn-preamble.ts`). So a
 *     value that already matched its inherited default gets locked, not
 *     silently left dynamic, and the whole Advanced tab is the task's
 *     contract from then on. One exception: a column that forces
 *     `permission_mode: 'plan'` always wins over the task's (picked or
 *     locked) permission while the task is in that column - plan mode is a
 *     genuine safety guarantee, not just an ordinary column default (see
 *     `resolveEffectivePermissionMode` in `spawn-preamble.ts`).
 *
 * Behaviour notes:
 *   - The Agent picker renders DISABLED, not hidden, when only one agent is
 *     `found`. Same reasoning as the Profile select above it: a locked field
 *     still names the agent this task will run on, and it keeps the edit
 *     pencil beside it - the card's only route to Settings > Agent, where all
 *     four of these defaults are set - in one place on every machine.
 *   - Changing the agent resets model + effort because the previous picks
 *     were valid for the previous agent's capability matrix.
 *   - The whole section is hidden when the task has nothing to override at
 *     all: no second agent to pick, no model override support, no effort
 *     levels, and no permission modes. Callers should still render this
 *     component and let it no-op via `null`.
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
  profileId,
  setProfileId,
}: AdvancedOverridesSectionProps) {
  // A lifetime pin already on the task means the task was authored in override
  // mode, so open on that branch. Seeded once: see the "explicit state" note above.
  const hasDirectPin = Boolean(agentOverride || modelOverride || effortOverride || permissionOverride);
  const [runMode, setRunMode] = useState<RunMode>(hasDirectPin ? 'override' : 'profile');
  const currentProject = useProjectStore((state) => state.currentProject);
  const destinationSwimlane = useBoardStore((state) => state.swimlanes.find((lane) => lane.id === swimlaneId));
  const boardProfiles = useBoardStore((state) => state.boardProfiles);
  const openBoardManager = useBoardStore((state) => state.openBoardManager);
  const globalPermissionMode = useConfigStore((state) => state.config.agent.permissionMode);
  // The three-arg PROJECT open, never `openSettingsToTab`: the Agent tab's
  // Project Defaults are `scope: 'project'`, and `updateProjectOverride`
  // returns early when `projectSettingsPath` is null, so the panel would open
  // and silently drop the Permission write (.claude/rules/settings-tab-scope.md).
  const openProjectSettings = useConfigStore((state) => state.openProjectSettings);
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
    canPickAgent,
  } = useAgentCapabilityResolution(effectiveAgent);
  const modelContextWindows = useModelContextWindows(effectiveAgent);
  const modelDisplayNames = useModelDisplayNames(effectiveAgent);
  const showEffortPicker = advancedEffortOptions.length > 0;
  const permissionOptions = effectiveAgentInfo?.permissions ?? DEFAULT_PERMISSIONS;
  const showPermissionPicker = permissionOptions.length > 0;
  // Whether this task has anything to override AT ALL. `canPickAgent` stays a
  // term in this condition even though the Agent row now always renders inside
  // the card: a permanently-locked field is not a reason to put the whole
  // either/or on screen. The condition is inert as things stand - every adapter
  // declares a non-empty `permissions` list and `DEFAULT_PERMISSIONS` backstops
  // an agent missing from the detected list, so `showPermissionPicker` is always
  // true and the `return null` below is unreachable. It holds the line for an
  // adapter that exposes no surfaces at all.
  const showAdvancedSection = canPickAgent || showModelPicker || showEffortPicker || showPermissionPicker;

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
  // Three states, not two: `canPickAgent` is false both when exactly one agent
  // is installed AND when none has been detected at all (`agentList` starts
  // empty and fills in from an async probe, and a machine with no agent CLI
  // never fills it), so one fixed "install another" string is wrong copy in the
  // second case.
  const agentFieldTitle = canPickAgent
    ? 'The agent CLI this task runs on'
    : availableAgents.length === 1
      ? 'Only one agent CLI detected - install another to choose'
      : 'No agent CLI detected yet';
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

  const hasProfiles = boardProfiles.length > 0;

  const selectProfileMode = () => {
    setRunMode('profile');
    // Exclusive with the lifetime pins - clear them here so the dialog shows the
    // same thing the repository will store (`applyProfileExclusivity`).
    setAgentOverride('');
    setModelOverride('');
    setEffortOverride('');
    setPermissionOverride('');
  };

  const selectOverrideMode = () => {
    setRunMode('override');
    setProfileId(null);
  };

  /**
   * One branch of the either/or, as a selectable card: its controls live INSIDE
   * the choice, which is what makes picking one and losing the other legible at
   * a glance. Both descriptions stay visible while unselected - that is what
   * lets a user tell the branches apart without trying them.
   *
   * The header is a `role="radio"` button rather than an `<input type="radio">`
   * so the dot can be styled; the body is a SIBLING of that button, never a
   * child, because the branch's own selects and comboboxes cannot legally nest
   * inside a button.
   */
  const modeCard = (mode: RunMode, label: string, description: string, testId: string, body: ReactNode) => {
    const selected = runMode === mode;
    return (
      // Selection is signalled NEUTRALLY - a raised fill and a slightly brighter
      // edge - with the accent confined to the dot. An accent border round the
      // whole card made this section shout over the fields above it, which it is
      // no more important than.
      //
      // The unselected card carries NO fill, only an outline. `bg-surface` is the
      // token every input above uses (title, priority, branch), so filling it made
      // an unselected option read as one more field to fill in rather than as the
      // road not taken. Fill is what marks the live branch here.
      <div
        className={`rounded border transition-colors ${selected
          ? 'border-edge-input bg-surface-raised'
          : 'border-edge hover:bg-surface-hover/50'}`}
      >
        <button
          type="button"
          role="radio"
          aria-checked={selected}
          onClick={mode === 'profile' ? selectProfileMode : selectOverrideMode}
          data-testid={testId}
          className="w-full flex items-start gap-2.5 px-4 py-2.5 text-left cursor-pointer"
        >
          <span
            className={`mt-px h-3.5 w-3.5 shrink-0 rounded-full border flex items-center justify-center transition-colors ${
              selected ? 'border-accent' : 'border-edge-input'
            }`}
          >
            {selected && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
          </span>
          <span className="min-w-0">
            <span className="block text-xs text-fg">{label}</span>
            <span className="block text-xs text-fg-faint mt-0.5">{description}</span>
          </span>
        </button>
        {/* pl-10 aligns the body with the card's LABEL, not its dot: the header's
            px-4 (16) + dot (14) + gap-2.5 (10).
            The other three sides are the card's frame, and it is deliberately
            looser than the form's own space-y-3 (12) rhythm: a bordered card
            holding bordered controls needs more clearance than a bare labelled
            field does. pt-1.5 (6) against the header's py-2.5 (10) bottom padding
            puts 16px between the description and the first label, so the body
            reads as the branch's contents rather than as part of the header
            block. pr-4 and pb-4 keep the fields off the card's edge - at the
            previous 12px the bottom-right corner was the tightest point on the
            whole card, with the body indented 36px on the left but running to
            within 12px of the border on the right. */}
        {selected && <div className="pl-10 pr-4 pt-1.5 pb-4">{body}</div>}
      </div>
    );
  };

  return (
    <>
      {/* No divider, no heading, and no margin of its own. Everything higher in
          the dialog (priority, labels, branch) is a bare labelled field, so the
          bordered cards already read as a different KIND of control - a rule and
          a heading were two more separators restating what the borders say on
          their own. Spacing likewise comes from the form's `space-y-3`: an extra
          top margin here stacked on top of it and left this the one gap in the
          dialog that did not match the rest. The group's accessible name
          survives as `aria-label`. */}
      <div
        className="space-y-2"
        role="radiogroup"
        aria-label="How this task runs"
        data-testid="task-run-mode"
      >
        {/* Named for the MECHANISM, not for the picker inside it. The mechanism
            is the board's column configuration; a Profile is one variant of those
            settings, so "Profile" belongs on the select, not on the branch. The
            Default path is not a profile at all - it is the columns as they are
            configured - and labelling the branch "Profile" made it read as
            though it were. */}
        {modeCard(
          'profile',
          'Column Settings',
          "Each column applies its own settings as the task moves.",
          'task-run-mode-profile',
          <div className="flex items-center gap-2" data-testid="task-profile-row">
            {/* No visible "Profile" label: inside a card headed "Column Settings"
                the only thing a dropdown could be selecting IS which set of them,
                so the word cost a row (stacked) or a chunk of the field's width
                (inline) to say what the card already said. The accessible name
                still exists via aria-label - this drops the pixels, not the
                semantics.
                With only Default it renders DISABLED rather than hidden: it shows
                the concept exists and that Default is what this task will use. */}
            <Select
              value={profileId ?? ''}
              disabled={!hasProfiles}
              aria-label="Profile"
              title={hasProfiles
                ? 'An alternate set of per-column agent, model, and effort settings'
                : 'No profiles yet - create one in Edit Columns'}
              onChange={(event) => setProfileId(event.target.value || null)}
              className="appearance-none bg-surface border border-edge-input rounded pl-3 pr-10 py-1.5 text-sm text-fg w-full focus:outline-none focus:border-accent disabled:cursor-not-allowed"
              wrapperClassName="relative flex-1 min-w-0"
              data-testid="task-profile-select"
            >
              <option value="">Default</option>
              {boardProfiles.map((profile) => (
                <option key={profile.id} value={profile.id}>{profile.name}</option>
              ))}
            </Select>
            {/* An affordance where a line of instructions used to be. It is the
                only route to authoring from here, so it stays visible whether or
                not profiles exist - "create the first one" and "retune an
                existing one" are the same trip. Pencil matches the board's own
                edit-column button. */}
            <EditPencilButton
              onClick={() => openBoardManager()}
              title="Edit profiles in Edit Columns"
              testId="task-profile-edit"
            />
          </div>,
        )}

        {modeCard(
          'override',
          'Agent Override',
            // Declarative like the rest of the dialog, and parallel with the
            // other card on the axis that matters: "as the task moves" against
            // "for the whole task".
            'Pinned for the whole task, ignoring column settings.',
            'task-advanced-toggle',
            // space-y-3 matches the form these cards sit in (NewTaskDialog /
            // TaskDetailEditForm). On space-y-2 the override fields stacked
            // tighter than the plain labelled fields above them, so the card
            // read as denser than the dialog even though it holds more. The
            // radiogroup's own space-y-2 stays tighter on purpose: that gap is
            // what makes the two cards read as one either/or.
            <div className="space-y-3" data-testid="task-advanced-section">
            {/* Disabled rather than hidden with a single agent installed, the
                same call the Profile select makes above: the field still names
                what this task will run on, and the pencil beside it stays put
                on every machine instead of moving row to row. The tooltip sits
                on this wrapper rather than on the Combobox - the pencil's own
                title wins over an ancestor's while hovering the button, so both
                read correctly with no prop added to a shared control. */}
            <div title={agentFieldTitle} data-testid="task-agent-field">
              <label className="text-xs text-fg-muted mb-1 block">Agent</label>
              <div className="flex items-center gap-2">
                <Combobox
                  value={agentOverride}
                  onChange={handleAgentChange}
                  options={availableAgents.map((entry) => ({ value: entry.name, label: entry.displayName ?? entry.name }))}
                  placeholder={agentInheritLabel}
                  placeholderVariant="muted"
                  disabled={!canPickAgent}
                  className="flex-1 min-w-0"
                  testId="task-agent-override"
                />
                {/* The card's only route to where all four of these fields get
                    their defaults, and the same component as the profile pencil
                    opposite it, so the two cannot drift apart. Project-scoped
                    open (see openProjectSettings above). `WindowLayer` mounts
                    OUTSIDE AppLayout's `currentProject` gate, so an edit form can
                    outlive its project; disabling on that rather than no-opping
                    in the handler keeps the button from looking live when the
                    click would do nothing. */}
                <EditPencilButton
                  onClick={() => currentProject && openProjectSettings(currentProject.path, currentProject.name, 'agent')}
                  title="Edit agent defaults in Settings"
                  testId="task-agent-edit"
                  disabled={!currentProject}
                />
              </div>
            </div>
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
          </div>,
        )}
      </div>
    </>
  );
}
