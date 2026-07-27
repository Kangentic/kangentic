import { useRef, useState } from 'react';
import { ChevronDown, Layers } from 'lucide-react';
import { useBoardStore } from '../../stores/board-store';
import { ContextBarPopover } from './ContextBarPopover';

const pill = 'px-2 py-0.5 rounded bg-surface-raised whitespace-nowrap select-none';

/** Sentinel for the synthetic "Default" profile - the columns' own settings, never stored. */
const DEFAULT_PROFILE_VALUE = '__default__';

/**
 * Board Profile picker: the first control in the ContextBar, ahead of
 * agent / model / effort.
 *
 * The bar already IS the agent-and-strategy strip, so the profile belongs at its
 * head - reading left to right the row becomes Profile > Agent > Model > Effort,
 * which is the resolution order. Picking a profile changes which per-column
 * ladder the task rides (Planning in Opus xhigh, Executing in Opus high, Merge
 * in Sonnet high, and so on).
 *
 * Hidden entirely when the board has no user-defined profiles: it would always
 * read "Default" with nothing to pick. Note that gate is on PROFILES EXISTING,
 * not on this task having one, so "Default" is a visible, selectable state
 * rather than an absence.
 *
 * Changing the profile never touches the running session - a profile is a set of
 * SPAWN settings, so it takes effect from the next column. That is stated in the
 * popover rather than left to be discovered.
 */
export function ProfilePicker({ taskId }: { taskId: string }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  const boardProfiles = useBoardStore((state) => state.boardProfiles);
  const task = useBoardStore((state) => state.tasks.find((candidate) => candidate.id === taskId));
  const updateTask = useBoardStore((state) => state.updateTask);

  if (!task || boardProfiles.length === 0) return null;

  const activeProfile = task.profile_id
    ? boardProfiles.find((profile) => profile.id === task.profile_id) ?? null
    : null;

  // A task in Agent Override mode is in a different mode entirely: its
  // agent/model/effort are fixed for its whole life, so no ladder applies. Read
  // the stored mode rather than "is any field pinned" - a task can be in
  // override mode with all four still on inherit until its first spawn locks
  // them, and that task is Custom, not Default.
  const isOverrideMode = task.run_mode === 'agent_override';

  let label: string;
  if (task.profile_id && !activeProfile) label = 'Profile unavailable';
  else if (activeProfile) label = activeProfile.name;
  else if (isOverrideMode) label = 'Custom';
  else label = 'Default';

  const options = [
    {
      value: DEFAULT_PROFILE_VALUE,
      label: 'Default',
      description: 'Each column\'s own settings',
    },
    ...boardProfiles.map((profile) => ({
      value: profile.id,
      label: profile.name,
      description: profile.description,
    })),
  ];

  const handleSelect = (value: string | null) => {
    setOpen(false);
    const nextProfileId = value === null || value === DEFAULT_PROFILE_VALUE ? null : value;
    if (nextProfileId === (task.profile_id ?? null)) return;
    // Selecting a profile clears any direct override (the two are mutually
    // exclusive, enforced again in TaskRepository) - which is exactly how a
    // "Custom" task is switched onto a ladder.
    void updateTask({ id: task.id, profile_id: nextProfileId });
  };

  return (
    <span className="relative inline-flex">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        className={`${pill} text-fg-muted inline-flex items-center gap-1 cursor-pointer hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-fg-faint`}
        data-testid="context-bar-profile-trigger"
        title="Board Profile - the per-column agent, model, and effort this task follows"
      >
        <Layers size={11} className="text-fg-faint flex-shrink-0" />
        {label}
        <ChevronDown size={11} className="text-fg-faint flex-shrink-0" />
      </button>
      {open && (
        <ContextBarPopover
          triggerRef={triggerRef}
          title="Profile - applies from the next column"
          options={options}
          currentValue={task.profile_id ?? DEFAULT_PROFILE_VALUE}
          swimlaneDefault={null}
          onSelect={handleSelect}
          onClose={() => setOpen(false)}
          testId="context-bar-profile-popover"
        />
      )}
    </span>
  );
}
