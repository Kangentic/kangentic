/**
 * The mobile bridge's board-tool-read/board-tool-write allowlist
 * hand-classifies every `commandHandlers` key (see board-tool-allowlist.ts's
 * doc comment for why it cannot be derived automatically: annotations live
 * on the public kangentic_* MCP tool registrations, not on the internal
 * command-registry keys this module routes into directly - and this path
 * is not MCP at all). This is the mechanical guard against that
 * classification drifting from the registry - a new commandHandlers entry
 * added without a classification (or exclusion) here would otherwise
 * silently fall out of the mobile surface (deny-by-default fails safe, but
 * silently) instead of forcing a deliberate decision.
 */
import { describe, it, expect } from 'vitest';
import { commandHandlers } from '../../../src/main/agent/commands';
import {
  MOBILE_BOARD_TOOL_ACCESS,
  MOBILE_EXCLUDED_BOARD_TOOLS,
  isKnownMobileBoardTool,
  isBoardToolAllowedForVerb,
} from '../../../src/main/mobile-bridge/handlers/board-tool-allowlist';

describe('mobile board tool allowlist parity', () => {
  it('classifies every commandHandlers key except the deliberately excluded ones', () => {
    const registryKeys = Object.keys(commandHandlers).filter((key) => !MOBILE_EXCLUDED_BOARD_TOOLS.has(key));
    const classifiedKeys = Object.keys(MOBILE_BOARD_TOOL_ACCESS);
    expect(new Set(classifiedKeys)).toEqual(new Set(registryKeys));
  });

  it('excludes query_db from both read and write access', () => {
    expect(isBoardToolAllowedForVerb('query_db', 'board-tool-read')).toBe(false);
    expect(isBoardToolAllowedForVerb('query_db', 'board-tool-write')).toBe(false);
  });

  it('excludes move_task, list_tasks, list_columns, and list_backlog even though they are real commandHandlers entries - duplicates of the dedicated move-task/read-board verbs', () => {
    for (const tool of ['move_task', 'list_tasks', 'list_columns', 'list_backlog']) {
      expect(isKnownMobileBoardTool(tool)).toBe(false);
      expect(isBoardToolAllowedForVerb(tool, 'board-tool-read')).toBe(false);
      expect(isBoardToolAllowedForVerb(tool, 'board-tool-write')).toBe(false);
    }
  });

  it('a read-only tool is reachable only via board-tool-read', () => {
    expect(isBoardToolAllowedForVerb('search_tasks', 'board-tool-read')).toBe(true);
    expect(isBoardToolAllowedForVerb('search_tasks', 'board-tool-write')).toBe(false);
  });

  it('a mutating tool is reachable only via board-tool-write', () => {
    expect(isBoardToolAllowedForVerb('update_task', 'board-tool-write')).toBe(true);
    expect(isBoardToolAllowedForVerb('update_task', 'board-tool-read')).toBe(false);
  });

  it('an unrecognized tool name is denied for both verbs (fail closed)', () => {
    expect(isKnownMobileBoardTool('delete_everything')).toBe(false);
    expect(isBoardToolAllowedForVerb('delete_everything', 'board-tool-read')).toBe(false);
    expect(isBoardToolAllowedForVerb('delete_everything', 'board-tool-write')).toBe(false);
  });

  it('excludes tools reachable only through registries other than commandHandlers (browser, devtools, diagnostics, cross-project)', () => {
    for (const tool of ['browser_eval', 'devtools_run_command', 'tail_logs', 'list_projects', 'search', 'move_task_to_project']) {
      expect(isKnownMobileBoardTool(tool)).toBe(false);
    }
  });
});
