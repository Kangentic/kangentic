/**
 * A Command Terminal's menu items, in ONE list: the terminal's ... menu in its
 * header and the right-click menu on its Running row (or its chip in the
 * collapsed rail) both render this, so the two can never offer different
 * things. Each host supplies what an item does, because a hidden terminal's row
 * has to bring the terminal up before it can open its Commands palette, its
 * branch picker or its Changes (`CommandTerminalRowMenu`).
 */

import { CircleStop, FolderOpen, GitBranch, GitCompare, Pencil, SquareChevronRight } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import { KebabMenuItem, KebabMenuDivider } from '../KebabMenu';
import { ShortcutGlyph } from '../../utils/swimlane-icons';
import type { ShortcutConfig } from '../../../shared/types';

export interface CommandTerminalMenuActions {
  onRename: () => void;
  /** Why Rename is off (the terminal is still starting), or null when it is on. */
  renameDisabledReason: string | null;
  /** The project root Open folder opens; no Open folder or Changes item without one. */
  projectPath: string | null;
  onOpenFolder: () => void;
  onCommands: () => void;
  onSwitchBranch: () => void;
  changesOpen: boolean;
  onToggleChanges: () => void;
  /** The board's shortcuts the menu lists, in order. */
  shortcuts: ShortcutConfig[];
  onShortcut: (action: ShortcutConfig) => void;
  stopping: boolean;
  onStop: () => void;
}

interface CommandTerminalMenuItemsProps extends CommandTerminalMenuActions {
  /** Close the menu before an item acts. */
  close: () => void;
  /** Prefix for each item's test id, so the header and the row menus stay apart. */
  testIdPrefix: string;
}

export function CommandTerminalMenuItems({
  close,
  testIdPrefix,
  onRename,
  renameDisabledReason,
  projectPath,
  onOpenFolder,
  onCommands,
  onSwitchBranch,
  changesOpen,
  onToggleChanges,
  shortcuts,
  onShortcut,
  stopping,
  onStop,
}: CommandTerminalMenuItemsProps) {
  const { t } = useLingui();
  return (
    <>
      {/* First: it is about this terminal itself. */}
      <KebabMenuItem
        icon={<Pencil size={14} />}
        label={t`Rename`}
        onClick={() => { close(); onRename(); }}
        disabled={renameDisabledReason !== null}
        disabledReason={renameDisabledReason}
        data-testid={`${testIdPrefix}-rename`}
      />
      {projectPath && (
        <KebabMenuItem
          icon={<FolderOpen size={14} />}
          label={t`Open folder`}
          onClick={() => { close(); onOpenFolder(); }}
          data-testid={`${testIdPrefix}-open-folder`}
        />
      )}
      <KebabMenuItem
        icon={<SquareChevronRight size={14} />}
        label={t`Commands`}
        onClick={() => { close(); onCommands(); }}
        data-testid={`${testIdPrefix}-commands`}
      />
      <KebabMenuItem
        icon={<GitBranch size={14} />}
        label={t`Switch branch`}
        onClick={() => { close(); onSwitchBranch(); }}
        data-testid={`${testIdPrefix}-switch-branch`}
      />
      {projectPath && (
        <KebabMenuItem
          icon={<GitCompare size={14} />}
          label={changesOpen ? t`Hide changes` : t`Show changes`}
          onClick={() => { close(); onToggleChanges(); }}
          data-testid={`${testIdPrefix}-toggle-changes`}
        />
      )}
      {shortcuts.length > 0 && (
        <>
          <KebabMenuDivider />
          {shortcuts.map((action) => (
            <KebabMenuItem
              key={action.id ?? action.label}
              icon={<ShortcutGlyph name={action.icon} size={14} />}
              label={action.label}
              onClick={() => { close(); onShortcut(action); }}
              data-testid={`${testIdPrefix}-${action.label.toLowerCase().replace(/\s+/g, '-')}`}
            />
          ))}
        </>
      )}
      <KebabMenuDivider />
      <KebabMenuItem
        icon={<CircleStop size={14} />}
        label={stopping ? t`Stopping...` : t`Stop terminal`}
        onClick={() => { close(); onStop(); }}
        disabled={stopping}
        destructive
        data-testid={`${testIdPrefix}-stop`}
      />
    </>
  );
}
