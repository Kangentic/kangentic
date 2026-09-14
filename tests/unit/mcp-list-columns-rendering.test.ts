/**
 * What `kangentic_list_columns` actually PRINTS.
 *
 * The handler's `data` is pinned by inventory-commands-list-columns.test.ts, but
 * an agent never sees `data` - it reads the text this registration renders, and
 * that rendering lives above the command layer where a handler test cannot
 * reach. The Done column is the whole reason: its live count is structurally
 * zero, so a uniform `0 task(s)` row reads as an empty column and sends finished
 * work to the last column that looks alive (Merge, which auto-spawns
 * /merge-pull-request - task #642).
 *
 * `handler-helpers` is mocked before importing task-tools.ts because it pulls in
 * `../commands` -> better-sqlite3, which will not load under vitest's Node ABI.
 * Same fake-McpServer capture pattern as mcp-task-placement-schema.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { z } from 'zod/v4';

const { mockRunHandler } = vi.hoisted(() => ({
  mockRunHandler: vi.fn(),
}));

vi.mock('../../src/main/agent/mcp-http/handler-helpers', () => ({
  callHandler: vi.fn(),
  runHandler: mockRunHandler,
  withProject: vi.fn((_resolver: unknown, _selector: unknown, run: (context: never) => unknown) => run({} as never)),
  detectCrossProjectMention: vi.fn(() => []),
  sanitizeProjectName: vi.fn((name: string) => name),
  PROJECT_SELECTOR_DESCRIPTION: 'optional project selector',
}));

import { registerTaskTools } from '../../src/main/agent/mcp-http/task-tools';

interface FakeToolConfig {
  description?: string;
  inputSchema: z.ZodType;
}

type FakeToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

function captureTools() {
  const configs = new Map<string, FakeToolConfig>();
  const handlers = new Map<string, FakeToolHandler>();
  const server = {
    registerTool: vi.fn((toolName: string, toolConfig: FakeToolConfig, handler: FakeToolHandler) => {
      configs.set(toolName, toolConfig);
      handlers.set(toolName, handler);
    }),
  };
  const taskCounter = { tryReserve: () => true, limit: () => 100 };
  registerTaskTools(server as never, {} as never, taskCounter as never);
  return {
    config: configs.get('kangentic_list_columns')!,
    handler: handlers.get('kangentic_list_columns')!,
  };
}

/** The shape the default board produces once the fix is in. */
const DEFAULT_BOARD = [
  { name: 'To Do', role: 'todo', taskCount: 7 },
  { name: 'Merge', role: null, taskCount: 0 },
  { name: 'Done', role: 'done', taskCount: 0, completedCount: 584 },
];

async function render(columns: unknown[]): Promise<string> {
  mockRunHandler.mockResolvedValue({ success: true, data: columns });
  const { handler } = captureTools();
  const result = await handler({});
  return result.content[0].text;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('kangentic_list_columns rendering', () => {
  it('prints the done column with its role tag and completed count', async () => {
    const text = await render(DEFAULT_BOARD);

    expect(text).toBe([
      '- To Do (todo): 7 task(s)',
      '- Merge: 0 task(s)',
      '- Done (done): 584 completed',
    ].join('\n'));
  });

  it('never prints a bare "0 task(s)" for the done column', async () => {
    const text = await render(DEFAULT_BOARD);
    const doneLine = text.split('\n').find((line) => line.startsWith('- Done'));

    // This is the row that made the board look like it ends at Merge.
    expect(doneLine).not.toContain('task(s)');
  });

  it('falls back to the task count for a board whose done column reports none', async () => {
    // A column with no completedCount renders like any other, so a board with no
    // done lane (or an older handler) degrades to the previous output.
    const text = await render([{ name: 'To Do', role: 'todo', taskCount: 2 }]);

    expect(text).toBe('- To Do (todo): 2 task(s)');
  });

  it('tells an agent in its description that the done column is in the list', async () => {
    mockRunHandler.mockResolvedValue({ success: true, data: [] });
    const { config } = captureTools();

    // Deliberately loose. The point is that the description says something about
    // the done role at all, not that it keeps any particular wording.
    expect(config.description).toMatch(/\bdone\b/i);
  });
});
