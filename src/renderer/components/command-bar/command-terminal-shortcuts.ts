/**
 * The board's shortcuts as a Command Terminal runs them, shared by the
 * terminal's header (its pills and its ... menu) and its row menu in the rail.
 */

import { resolveShortcutCommand } from '../../../shared/template-vars';
import type { ShortcutConfig } from '../../../shared/types';

/** A shortcut runs in the project root, on the branch the terminals share. */
export function runCommandTerminalShortcut(action: { command: string }, projectPath: string | null, branch: string | null): void {
  const cwd = projectPath ?? '';
  const resolved = resolveShortcutCommand(action.command, {
    cwd,
    branchName: branch ?? '',
    taskTitle: '',
    projectPath: cwd,
  });
  window.electronAPI.shell.exec(resolved, cwd);
}

/**
 * Every shortcut a hidden terminal's row menu lists: the menu's own, then the
 * header-only ones, since none of that terminal's header pills are on screen.
 */
export function rowMenuShortcuts(shortcuts: ShortcutConfig[]): ShortcutConfig[] {
  const runnable = shortcuts.filter((action) => action.command);
  const inMenu = runnable.filter((action) => !action.display || action.display === 'menu' || action.display === 'both');
  const headerOnly = runnable.filter((action) => action.display === 'header');
  return [...inMenu, ...headerOnly];
}
