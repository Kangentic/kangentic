/**
 * What a terminal's menu items do from the rail: its Running row and its mark
 * in the collapsed strip (`CommandTerminalRowMenu`).
 *
 * Commands, Switch branch and Show changes open something inside the terminal,
 * so they bring it to the front first (expanded over the others when one is
 * expanded, focused when they tile) and leave the slot's window a request to
 * open it there (`requestCommandTerminalWindowAction`). Open folder, the
 * shortcuts and Stop act where the terminal is. Rename is the caller's: a row
 * edits its name in place, and a strip mark, which has no room for a field,
 * asks the window.
 */

import { useMemo } from 'react';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';
import { useBoardStore } from '../../stores/board-store';
import { useProjectStore } from '../../stores/project-store';
import { useSessionStore } from '../../stores/session-store';
import { transientKey, type CommandTerminalWindowAction } from '../../stores/session-store/transient-session-slice';
import { commandTerminalChangesEntityId } from '../../stores/session-store/task-changes-panel-slice';
import { resolveProjectRoot } from '../../../shared/git-utils';
import type { CommandTerminalMenuActions } from './CommandTerminalMenuItems';
import { rowMenuShortcuts, runCommandTerminalShortcut } from './command-terminal-shortcuts';

/** A terminal as the rail lists it. */
export interface RailCommandTerminal {
  windowId: string;
  slot: string;
}

export function useRailTerminalMenuActions(
  projectId: string | null,
  terminal: RailCommandTerminal,
  sessionId: string | null,
  handlers: {
    onBringToFront: (windowId: string) => void;
    onStop: () => void;
    stopping: boolean;
    onRename: () => void;
  },
): CommandTerminalMenuActions {
  const rawProjectPath = useProjectStore((state) => state.currentProject?.path ?? null);
  const projectPath = useMemo(() => (rawProjectPath ? resolveProjectRoot(rawProjectPath) : null), [rawProjectPath]);
  const shortcuts = useBoardStore((state) => state.shortcuts);
  const menuShortcuts = useMemo(() => rowMenuShortcuts(shortcuts), [shortcuts]);
  const changesOpen = useSessionStore((state) => state.changesOpenTasks.has(commandTerminalChangesEntityId(terminal.slot)));
  const branch = useSessionStore((state) =>
    projectId ? state.transientSessions[transientKey(projectId, terminal.slot)]?.branch ?? null : null);
  const { onBringToFront, onStop, stopping, onRename } = handlers;

  const bringUpAnd = (action: CommandTerminalWindowAction): void => {
    if (!projectId) return;
    onBringToFront(terminal.windowId);
    useSessionStore.getState().requestCommandTerminalWindowAction(projectId, terminal.slot, action);
  };

  return {
    onRename,
    renameDisabledReason: sessionId ? null : i18n._(msg`Available once the terminal starts`),
    projectPath,
    onOpenFolder: () => { if (projectPath) window.electronAPI.shell.openPath(projectPath); },
    onCommands: () => bringUpAnd('commands'),
    onSwitchBranch: () => bringUpAnd('switch-branch'),
    changesOpen,
    onToggleChanges: () => bringUpAnd('toggle-changes'),
    shortcuts: menuShortcuts,
    onShortcut: (action) => runCommandTerminalShortcut(action, projectPath, branch),
    stopping,
    onStop,
  };
}
