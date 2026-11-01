/**
 * The board's shortcuts as a Command Terminal runs them
 * (src/renderer/components/command-bar/command-terminal-shortcuts.ts).
 *
 * Which shortcuts a terminal's ... menu lists, which its header shows as pills,
 * and which a hidden terminal's row menu in the rail lists (every one, since none
 * of that terminal's header pills are on screen). Plus the run itself: a shortcut
 * runs in the project root, on the branch the terminals share.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isHeaderShortcut,
  isMenuShortcut,
  rowMenuShortcuts,
  runCommandTerminalShortcut,
} from '../../src/renderer/components/command-bar/command-terminal-shortcuts';
import type { ShortcutConfig } from '../../src/shared/types';

function shortcut(label: string, display?: ShortcutConfig['display'], command = `run ${label}`): ShortcutConfig {
  return { label, command, display };
}

describe('isMenuShortcut / isHeaderShortcut', () => {
  it('treats an unset display as both menu and header', () => {
    expect(isMenuShortcut(shortcut('a'))).toBe(true);
    expect(isHeaderShortcut(shortcut('a'))).toBe(true);
  });

  it('puts a menu-only shortcut in the menu and not the header', () => {
    expect(isMenuShortcut(shortcut('a', 'menu'))).toBe(true);
    expect(isHeaderShortcut(shortcut('a', 'menu'))).toBe(false);
  });

  it('puts a header-only shortcut in the header and not the menu', () => {
    expect(isMenuShortcut(shortcut('a', 'header'))).toBe(false);
    expect(isHeaderShortcut(shortcut('a', 'header'))).toBe(true);
  });

  it('puts a both shortcut in each', () => {
    expect(isMenuShortcut(shortcut('a', 'both'))).toBe(true);
    expect(isHeaderShortcut(shortcut('a', 'both'))).toBe(true);
  });

  it('lists nothing that has no command to run', () => {
    expect(isMenuShortcut(shortcut('a', 'both', ''))).toBe(false);
    expect(isHeaderShortcut(shortcut('a', 'both', ''))).toBe(false);
    expect(isMenuShortcut(shortcut('a', undefined, ''))).toBe(false);
    expect(isHeaderShortcut(shortcut('a', undefined, ''))).toBe(false);
  });
});

describe('rowMenuShortcuts', () => {
  it('lists the menu shortcuts first, then the header-only ones, each once', () => {
    const result = rowMenuShortcuts([
      shortcut('header-only', 'header'),
      shortcut('menu-only', 'menu'),
      shortcut('both', 'both'),
      shortcut('unset'),
    ]);
    expect(result.map((action) => action.label)).toEqual(['menu-only', 'both', 'unset', 'header-only']);
  });

  it('leaves out a shortcut with no command', () => {
    const result = rowMenuShortcuts([shortcut('empty', 'header', ''), shortcut('kept', 'menu')]);
    expect(result.map((action) => action.label)).toEqual(['kept']);
  });

  it('returns an empty list for no shortcuts', () => {
    expect(rowMenuShortcuts([])).toEqual([]);
  });
});

describe('runCommandTerminalShortcut', () => {
  const exec = vi.fn();
  const globalWithWindow = globalThis as unknown as { window?: unknown };
  let originalWindow: unknown;

  beforeEach(() => {
    exec.mockClear();
    originalWindow = globalWithWindow.window;
    globalWithWindow.window = { electronAPI: { shell: { exec } } };
  });

  afterEach(() => {
    globalWithWindow.window = originalWindow;
  });

  it('runs the command in the project root with the template variables resolved', () => {
    runCommandTerminalShortcut({ command: 'open {{cwd}} on {{branchName}} in {{projectPath}}' }, '/mock/project', 'feature/x');
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith('open /mock/project on feature/x in /mock/project', '/mock/project');
  });

  it('resolves the task title to nothing, since a terminal has no task', () => {
    runCommandTerminalShortcut({ command: 'echo [{{taskTitle}}]' }, '/mock/project', 'main');
    expect(exec).toHaveBeenCalledWith('echo []', '/mock/project');
  });

  it('strips shell metacharacters from the branch name', () => {
    runCommandTerminalShortcut({ command: 'git log {{branchName}}' }, '/mock/project', 'x;touch pwned');
    expect(exec).toHaveBeenCalledWith('git log xtouch pwned', '/mock/project');
  });

  it('runs with an empty directory and branch when the project and branch are unknown', () => {
    runCommandTerminalShortcut({ command: 'at [{{cwd}}] [{{branchName}}]' }, null, null);
    expect(exec).toHaveBeenCalledWith('at [] []', '');
  });
});
