import { Copy, Pencil, Plus, Trash2 } from 'lucide-react';
import type { BoardProfile } from '../../../../shared/types';
import { Select } from '../../settings/shared';

/**
 * Board Profile switcher, hosted in the Column Manager's left rail.
 *
 * A Board Profile is a named alternate ladder of the per-column STRATEGY
 * settings, so one task can run Planning in Opus xhigh and Merge in Sonnet high
 * while another rides a cheaper ladder over the same board.
 *
 * It lives in the RAIL rather than the detail pane because a profile is not a
 * property of the selected column - it re-points every column. Sitting inside
 * the Planning pane it read as belonging to Planning; beside the column list it
 * reads as the lens over that list, which is what it is. It also keeps the
 * detail pane to a single scrolling form instead of a form plus a toolbar band.
 *
 * Actions are contextual: Default offers only "New", and duplicate/rename/delete
 * appear once a profile is selected. A permanently-disabled row of controls
 * reads as broken, and "Delete profile" is spelled out rather than left as a
 * bare trash glyph so it can never be mistaken for deleting the column.
 */
export function ProfileBar({
  profiles,
  activeProfileId,
  onSelect,
  onNew,
  onDuplicate,
  onRename,
  onDelete,
}: {
  profiles: BoardProfile[];
  activeProfileId: string | null;
  onSelect: (profileId: string | null) => void;
  onNew: () => void;
  onDuplicate: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  // Both action rows are pinned to ACTION_ROW_HEIGHT rather than sized by their
  // content, so switching Default <-> a profile cannot move the sections below.
  // Left to intrinsic sizing they differ: the Default button carries a border
  // (2px) and a 16px text line-height, while an icon cell has no border and a
  // 14px glyph. Tailwind's border-box sizing means the pinned height absorbs the
  // border, so the two boxes land on exactly the same pixel.
  // Shared by "New profile", the segmented action row, and "Add column" in
  // ColumnRail. Keep the three in step: they are peer affordances and any drift
  // between them reads as a misalignment down the rail.
  const ACTION_ROW_HEIGHT = 'h-8';
  const action = `flex-1 flex items-center justify-center rounded text-fg-muted
    hover:text-fg hover:bg-surface-hover/60 transition-colors
    focus-visible:outline focus-visible:outline-2 focus-visible:outline-fg-faint focus-visible:-outline-offset-2`;

  return (
    <div
      className="flex-shrink-0 border-b border-edge/50 px-2 pt-3 pb-2"
      data-testid="board-manager-profile-bar"
    >
      <div className="px-2 pb-1.5 text-[11px] uppercase tracking-wide text-fg-faint">Profile</div>

      <div className="px-1">
        {/* Flat like the rows below rather than a heavy form input: the rail is
            a list, and a bordered control read as a foreign element in it. */}
        <Select
          value={activeProfileId ?? ''}
          onChange={(event) => onSelect(event.target.value || null)}
          wrapperClassName="relative"
          chevronSize={14}
          chevronClassName="right-2"
          className="appearance-none w-full bg-transparent hover:bg-surface-hover/60 border border-edge/40
            rounded pl-2 pr-8 py-1.5 text-sm text-fg focus:outline-none focus:border-accent transition-colors"
          data-testid="board-manager-profile-select"
        >
          <option value="">Default</option>
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>{profile.name}</option>
          ))}
        </Select>
      </div>

      {/* Under Default there is exactly one action, so it gets the same labelled
          dashed treatment as "Add column" - a lone icon read as orphaned. With a
          profile selected there are four, which need the compact icon row. Both
          rows are the same height, so switching never shifts the sections below. */}
      <div className="px-1 pt-1">
        {activeProfileId === null ? (
          <button
            type="button"
            onClick={onNew}
            data-testid="board-manager-profile-new"
            className={`flex items-center gap-2 w-full ${ACTION_ROW_HEIGHT} px-2 rounded border border-dashed border-edge/70
              text-xs text-fg-faint hover:text-fg-secondary hover:border-edge hover:bg-surface-hover/40 transition-colors`}
          >
            <Plus size={13} className="flex-shrink-0" />
            New profile
          </button>
        ) : (
          <div className={`flex items-stretch ${ACTION_ROW_HEIGHT} rounded border border-edge/40 divide-x divide-edge/40 overflow-hidden`}>
            <button
              type="button"
              onClick={onNew}
              className={action}
              title="New profile"
              aria-label="New profile"
              data-testid="board-manager-profile-new"
            >
              <Plus size={14} />
            </button>
            <button
              type="button"
              onClick={onDuplicate}
              className={action}
              title="Duplicate this profile"
              aria-label="Duplicate this profile"
              data-testid="board-manager-profile-duplicate"
            >
              <Copy size={14} />
            </button>
            <button
              type="button"
              onClick={onRename}
              className={action}
              title="Rename this profile"
              aria-label="Rename this profile"
              data-testid="board-manager-profile-rename"
            >
              <Pencil size={14} />
            </button>
            <button
              type="button"
              onClick={onDelete}
              className={`${action} hover:text-red-400 hover:bg-red-500/10`}
              title="Delete this profile"
              aria-label="Delete this profile"
              data-testid="board-manager-profile-delete"
            >
              <Trash2 size={14} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
