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

/** A runnable shortcut the ... menu lists (`display` unset, `menu` or `both`). */
export function isMenuShortcut(action: ShortcutConfig): boolean {
  return !!action.command && (!action.display || action.display === 'menu' || action.display === 'both');
}

/** A runnable shortcut the header shows as a pill (`display` unset, `header` or `both`). */
export function isHeaderShortcut(action: ShortcutConfig): boolean {
  return !!action.command && (!action.display || action.display === 'header' || action.display === 'both');
}

/**
 * Every shortcut a hidden terminal's row menu lists: the menu's own, then the
 * header-only ones, since none of that terminal's header pills are on screen.
 */
export function rowMenuShortcuts(shortcuts: ShortcutConfig[]): ShortcutConfig[] {
  const inMenu = shortcuts.filter(isMenuShortcut);
  const headerOnly = shortcuts.filter((action) => isHeaderShortcut(action) && !isMenuShortcut(action));
  return [...inMenu, ...headerOnly];
}
