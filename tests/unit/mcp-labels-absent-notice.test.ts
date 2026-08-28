/**
 * The labels-drop signal reaching the CALLING AGENT, which is the whole point
 * of item 4: the condition was already detected per-request and logged at warn
 * level to a console no agent can see, so compliance depended entirely on the
 * agent having read and remembered the server instructions.
 *
 * mcp-tool-call-logging.test.ts covers the detection and the notices record.
 * This file covers the other half - that the record actually reaches the tool
 * response, as an advisory line and never as an error.
 *
 * Deliberately does NOT mock handler-helpers: `callHandler`, `withProject` and
 * `appendNoticeLine` are the code under test here. Only the command handlers
 * are stubbed, so nothing touches a DB.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreateTask = vi.fn();
const mockUpdateTask = vi.fn();

vi.mock('../../src/main/agent/commands', () => ({
  commandHandlers: {
    create_task: (...args: unknown[]) => mockCreateTask(...args),
    update_task: (...args: unknown[]) => mockUpdateTask(...args),
  },
}));

vi.mock('../../src/main/agent/commands/task-commands', () => ({
  TASK_DESCRIPTION_MAX_LENGTH: 50_000,
  handleMoveTaskToProject: vi.fn(),
}));

import { registerTaskTools } from '../../src/main/agent/mcp-http/task-tools';
import { createToolArgumentNotices } from '../../src/main/agent/mcp-http/tool-call-logging';
import { appendNoticeLine } from '../../src/main/agent/mcp-http/handler-helpers';
import type { RequestResolver } from '../../src/main/agent/mcp-http/project-resolver';
import type { TaskCounter, McpToolResult } from '../../src/main/agent/mcp-http/handler-helpers';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface CapturedResult { content: Array<{ type: string; text: string }>; isError?: boolean }

function makeFakeServer() {
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<CapturedResult>>();
  return {
    registerTool: (name: string, _config: unknown, handler: (args: Record<string, unknown>) => Promise<CapturedResult>) => {
      handlers.set(name, handler);
    },
    getHandler: (name: string) => {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`No handler registered for ${name}`);
      return handler;
    },
  };
}

function makeResolver(): RequestResolver {
  return {
    resolveProject: vi.fn(() => ({
      context: { getProjectDb: vi.fn(), getProjectPath: vi.fn(() => '/mock/project') },
      projectId: 'project-1',
      projectName: 'Mock',
      isDefault: true,
    })),
    listProjects: vi.fn(() => []),
    // No overrides are passed by any test below, so the validator's call site
    // is never reached and these are not needed.
  } as unknown as RequestResolver;
}

const TASK_COUNTER: TaskCounter = { tryReserve: () => true, limit: () => 500 };

/** Flatten a tool result's text blocks for substring assertions. */
function textOf(result: CapturedResult): string {
  return result.content.map((block) => block.text).join('\n');
}

let server: ReturnType<typeof makeFakeServer>;

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateTask.mockResolvedValue({
    success: true,
    data: { taskId: 'uuid-1', displayId: 42, title: 'T', column: 'To Do' },
    message: 'Created task "T" in To Do column (#42, id: uuid-1)',
  });
  mockUpdateTask.mockReturnValue({ success: true, message: 'Updated task #42' });
  server = makeFakeServer();
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// appendNoticeLine's own fallback branches, pinned directly (not driven
// through a tool handler): every real call site today produces a well-formed
// `{ content: [{ type: 'text', ... }, ...] }` result, so the "content is
// empty" and "first block is not type text" branches are reached by no
// current caller. Pin them here so a future caller that DOES hit them keeps
// the documented contract instead of silently regressing.
// ---------------------------------------------------------------------------

describe('appendNoticeLine - fallback branches', () => {
  it('leaves an isError result completely untouched - the notice must NOT be appended', () => {
    const result: McpToolResult = {
      content: [{ type: 'text', text: 'refused: bad input' }],
      isError: true,
    };

    const output = appendNoticeLine(result, 'some advisory notice');

    // Pass-through-untouched is the actual contract, not merely "no notice
    // text" - assert identity, not just an absence.
    expect(output).toBe(result);
  });

  it('pushes the notice as a new trailing text block when content is empty', () => {
    const result: McpToolResult = { content: [] };

    const output = appendNoticeLine(result, 'some advisory notice');

    expect(output.content).toEqual([{ type: 'text', text: 'some advisory notice' }]);
  });

  it('appends the notice as a trailing block when the first block is not type text, leaving it in place', () => {
    // The real SDK tool-result type permits non-text blocks (images, etc.);
    // McpToolResult's own declared shape is narrower than what a result
    // could structurally carry at runtime, which is exactly why this branch
    // exists. Cast through unknown, never `any`, to construct that shape.
    const firstBlock = { type: 'image', data: 'base64-image-data' };
    const result = { content: [firstBlock] } as unknown as McpToolResult;

    const output = appendNoticeLine(result, 'some advisory notice');

    expect(output.content).toEqual([firstBlock, { type: 'text', text: 'some advisory notice' }]);
  });
});

describe('kangentic_create_task - labels-absent notice', () => {
  it('appends the advisory when this request tripped the signature', async () => {
    const notices = createToolArgumentNotices();
    notices.labelsAbsentWithLargeDescription.kangentic_create_task = 1234;
    registerTaskTools(server as never, makeResolver(), TASK_COUNTER, notices);

    const result = await server.getHandler('kangentic_create_task')({ title: 'T', description: 'x'.repeat(1234) });

    const text = textOf(result);
    expect(text).toContain('[Labels not received]');
    expect(text).toContain('1234-char description');
    expect(text).toContain('labels-only kangentic_update_task');
  });

  it('keeps the handler message, so the task id stays available for the follow-up call', async () => {
    // The notice points at "the task id shown above" rather than repeating it,
    // so that line has to survive.
    const notices = createToolArgumentNotices();
    notices.labelsAbsentWithLargeDescription.kangentic_create_task = 1234;
    registerTaskTools(server as never, makeResolver(), TASK_COUNTER, notices);

    const text = textOf(await server.getHandler('kangentic_create_task')({ title: 'T', description: 'x' }));

    expect(text).toContain('id: uuid-1');
    expect(text.indexOf('id: uuid-1')).toBeLessThan(text.indexOf('[Labels not received]'));
  });

  it('is advisory, never an error - the task was created correctly', async () => {
    const notices = createToolArgumentNotices();
    notices.labelsAbsentWithLargeDescription.kangentic_create_task = 2048;
    registerTaskTools(server as never, makeResolver(), TASK_COUNTER, notices);

    const result = await server.getHandler('kangentic_create_task')({ title: 'T', description: 'x' });

    expect(result.isError).toBeUndefined();
    expect(mockCreateTask).toHaveBeenCalledOnce();
  });

  it('appends nothing when this request did not trip the signature', async () => {
    registerTaskTools(server as never, makeResolver(), TASK_COUNTER, createToolArgumentNotices());

    const text = textOf(await server.getHandler('kangentic_create_task')({ title: 'T', description: 'x' }));

    expect(text).not.toContain('[Labels not received]');
  });

  it('appends nothing when no notices record is wired at all', async () => {
    registerTaskTools(server as never, makeResolver(), TASK_COUNTER);

    const text = textOf(await server.getHandler('kangentic_create_task')({ title: 'T', description: 'x' }));

    expect(text).not.toContain('[Labels not received]');
  });

  it('does not append an update-keyed notice to a create', async () => {
    // A batch body carrying both calls must not cross-report.
    const notices = createToolArgumentNotices();
    notices.labelsAbsentWithLargeDescription.kangentic_update_task = 1500;
    registerTaskTools(server as never, makeResolver(), TASK_COUNTER, notices);

    const text = textOf(await server.getHandler('kangentic_create_task')({ title: 'T', description: 'x' }));

    expect(text).not.toContain('[Labels not received]');
  });

  it('leaves a failed create undiluted by the advisory', async () => {
    // An advisory about labels on a write that did not happen would be noise
    // competing with the actual refusal.
    mockCreateTask.mockResolvedValue({ success: false, error: 'Column "Nope" not found' });
    const notices = createToolArgumentNotices();
    notices.labelsAbsentWithLargeDescription.kangentic_create_task = 1500;
    registerTaskTools(server as never, makeResolver(), TASK_COUNTER, notices);

    const result = await server.getHandler('kangentic_create_task')({ title: 'T', description: 'x', column: 'Nope' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toContain('[Labels not received]');
  });

  // -------------------------------------------------------------------------
  // The follow-up tool named in the advisory must match the surface the new
  // row actually lives on: kangentic_update_task resolves only against the
  // tasks table, so handing it a backlog id answers `Task "<uuid>" not found`
  // and sends the agent in a circle. isBacklogColumn(column) is what decides.
  // -------------------------------------------------------------------------

  it('a board create (explicit normal column) names kangentic_update_task, not kangentic_update_backlog_item', async () => {
    const notices = createToolArgumentNotices();
    notices.labelsAbsentWithLargeDescription.kangentic_create_task = 1500;
    registerTaskTools(server as never, makeResolver(), TASK_COUNTER, notices);

    const text = textOf(await server.getHandler('kangentic_create_task')({ title: 'T', description: 'x', column: 'Planning' }));

    expect(text).toContain('labels-only kangentic_update_task');
    expect(text).not.toContain('kangentic_update_backlog_item');
  });

  it('a Backlog create names kangentic_update_backlog_item, not kangentic_update_task', async () => {
    const notices = createToolArgumentNotices();
    notices.labelsAbsentWithLargeDescription.kangentic_create_task = 1500;
    registerTaskTools(server as never, makeResolver(), TASK_COUNTER, notices);

    const text = textOf(await server.getHandler('kangentic_create_task')({ title: 'T', description: 'x', column: 'Backlog' }));

    expect(text).toContain('labels-only kangentic_update_backlog_item');
    expect(text).not.toContain('kangentic_update_task');
  });

  it('a lowercase "backlog" column names kangentic_update_backlog_item the same as "Backlog" (case-insensitive)', async () => {
    const notices = createToolArgumentNotices();
    notices.labelsAbsentWithLargeDescription.kangentic_create_task = 1500;
    registerTaskTools(server as never, makeResolver(), TASK_COUNTER, notices);

    const text = textOf(await server.getHandler('kangentic_create_task')({ title: 'T', description: 'x', column: 'backlog' }));

    expect(text).toContain('labels-only kangentic_update_backlog_item');
    expect(text).not.toContain('kangentic_update_task');
  });
});

describe('kangentic_update_task - labels-absent notice', () => {
  it('appends the advisory naming the taskId the caller passed', async () => {
    const notices = createToolArgumentNotices();
    notices.labelsAbsentWithLargeDescription.kangentic_update_task = 1500;
    registerTaskTools(server as never, makeResolver(), TASK_COUNTER, notices);

    const text = textOf(await server.getHandler('kangentic_update_task')({ taskId: '42', description: 'x' }));

    expect(text).toContain('[Labels not received]');
    expect(text).toContain('taskId "42"');
  });

  it('appends nothing when the record is empty', async () => {
    registerTaskTools(server as never, makeResolver(), TASK_COUNTER, createToolArgumentNotices());

    const text = textOf(await server.getHandler('kangentic_update_task')({ taskId: '42', description: 'x' }));

    expect(text).not.toContain('[Labels not received]');
  });
});
