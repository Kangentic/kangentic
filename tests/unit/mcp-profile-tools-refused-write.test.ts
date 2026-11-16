/**
 * What an agent hears when the board file refuses a profile write.
 *
 * `setBoardProfiles` throws `BoardConfigUnreadableError` when kangentic.json is
 * in a newer format, or cannot be read. The three profile tools that write
 * (create, update, delete) do not catch it, so `runHandler` is the layer that
 * must turn it into an error result the agent can read back to the user: not a
 * thrown exception through the MCP server, and not a success that claims a
 * profile was saved. It is a refusal, so it must not reach Sentry either.
 *
 * Runs the real command handlers and the real `runHandler`. Only the manager's
 * refusal is armed, because the manager's own throw is pinned by
 * board-config-write-refusal-edges.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { reportHandledError } = vi.hoisted(() => ({ reportHandledError: vi.fn() }));

vi.mock('../../src/main/analytics/error-reporting', () => ({ reportHandledError }));
vi.mock('electron', () => ({
  webContents: { fromId: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn(() => null) },
  app: { getPath: () => '/tmp', isPackaged: false },
}));

import { runHandler } from '../../src/main/agent/mcp-http/handler-helpers';
import { mcpCommandReporter } from '../../src/main/agent/mcp-http/tool-reporting';
import { BoardConfigUnreadableError } from '../../src/main/config/board-config/config-helpers';
import type { CommandContext } from '../../src/main/agent/commands/types';
import type { BoardProfile } from '../../src/shared/types';

const EXISTING_PROFILE: BoardProfile = { id: 'p1', name: 'Heavy', columns: {} };

/** Minimal db double: the profile handlers read only the swimlane list and a riding-task count. */
function createMockDatabase() {
  return {
    prepare: vi.fn((sql: string) => {
      if (sql.includes('FROM tasks')) {
        return { get: vi.fn(() => ({ count: 0 })), all: vi.fn(() => []), run: vi.fn() };
      }
      return { all: vi.fn(() => []), get: vi.fn(() => undefined), run: vi.fn() };
    }),
  };
}

function contextWhoseProfileWriteIsRefused(refusal: Error): CommandContext {
  return {
    getProjectDb: () => createMockDatabase() as never,
    getProjectPath: () => '/projects/example',
    getBoardProfiles: () => [EXISTING_PROFILE],
    setBoardProfiles: () => {
      throw refusal;
    },
  } as unknown as CommandContext;
}

describe('a refused profile write reaches the agent as an error result', () => {
  beforeEach(() => {
    reportHandledError.mockClear();
    mcpCommandReporter.reset();
  });

  const cases: Array<[string, Record<string, unknown>]> = [
    ['create_board_profile', { name: 'Light', columns: {} }],
    ['update_board_profile', { profile: 'Heavy', description: 'changed' }],
    ['delete_board_profile', { profile: 'Heavy' }],
  ];

  it.each(cases)('%s returns the newer-format message and reports nothing', async (handlerName, params) => {
    const refusal = new BoardConfigUnreadableError('kangentic.json', 'unused', { newerFormat: true });

    const response = await runHandler(handlerName, params, contextWhoseProfileWriteIsRefused(refusal));

    expect(response.success).toBe(false);
    expect(response.error).toBe(refusal.message);
    expect(response.error).toContain('saved by a newer version of Kangentic');
    expect(response.message).toBeUndefined();
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('returns the unreadable-file message, with the reason to fix, for an unreadable file', async () => {
    const refusal = new BoardConfigUnreadableError('kangentic.json', 'Unexpected token < in JSON at position 0.');

    const response = await runHandler('create_board_profile', { name: 'Light', columns: {} }, contextWhoseProfileWriteIsRefused(refusal));

    expect(response.success).toBe(false);
    expect(response.error).toContain('could not be read');
    expect(response.error).toContain('Unexpected token < in JSON at position 0.');
    expect(reportHandledError).not.toHaveBeenCalled();
  });
});
