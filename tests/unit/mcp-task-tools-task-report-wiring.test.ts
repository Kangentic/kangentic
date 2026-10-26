import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { z } from 'zod/v4';

/**
 * MCP task tools: the registration of kangentic_get_task_report
 * (src/main/agent/mcp-http/task-tools.ts).
 *
 * get-task-report-command.test.ts covers the command handler and
 * protocol/task-report.test.ts covers the phone-side parser. Neither runs the
 * tool registration, which is where four things live that no other test holds:
 *
 *  1. The tool is annotated read-only (so plan mode auto-approves it).
 *  2. It runs the `get_task_report` command handler with exactly `{ taskId }`
 *     against the resolved project's context, and `project` picks that project.
 *  3. The handler returns `{ success: true, data }` with NO `message`, so the
 *     agent only gets the report because `callHandler` falls back to
 *     `JSON.stringify(data)`.
 *  4. A failure comes back as an `isError` result carrying the handler's text.
 *
 * Points 2 to 4 are properties of `withProject` and `callHandler`, so unlike
 * mcp-task-tools-run-mode-wiring.test.ts this file does NOT mock
 * handler-helpers. It follows mcp-labels-absent-notice.test.ts instead: the
 * real helpers run, and only `commandHandlers` is stubbed at the module edge,
 * which keeps the suite free of any database.
 */

const { mockGetTaskReport } = vi.hoisted(() => ({ mockGetTaskReport: vi.fn() }));

vi.mock('../../src/main/agent/commands', () => ({
  commandHandlers: {
    get_task_report: mockGetTaskReport,
  },
}));

// task-tools.ts imports handleMoveTaskToProject directly from task-commands;
// stubbed so this suite stays DB-free. Unused by the tests below.
vi.mock('../../src/main/agent/commands/task-commands', () => ({
  TASK_DESCRIPTION_MAX_LENGTH: 50_000,
  handleMoveTaskToProject: vi.fn(),
}));

// The real override validator probes the machine's installed agent CLIs. This
// suite never passes an override, so it is stubbed to keep it machine-independent.
vi.mock('../../src/main/agent/mcp-http/spawn-override-validation', () => ({
  validateSpawnOverrides: vi.fn(async () => null),
}));

import { registerTaskTools } from '../../src/main/agent/mcp-http/task-tools';
import { READ_ONLY_ANNOTATIONS } from '../../src/main/agent/mcp-http/annotations';
import type { RequestResolver } from '../../src/main/agent/mcp-http/project-resolver';
import type { TaskCounter } from '../../src/main/agent/mcp-http/handler-helpers';

const TOOL_NAME = 'kangentic_get_task_report';

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

interface FakeToolConfig {
  description?: string;
  inputSchema: z.ZodType;
  annotations?: unknown;
}

function makeFakeServer() {
  const handlers: Record<string, ToolHandler> = {};
  const configs: Record<string, FakeToolConfig> = {};
  return {
    registerTool: vi.fn((name: string, config: FakeToolConfig, handler: ToolHandler) => {
      handlers[name] = handler;
      configs[name] = config;
    }),
    getHandler(name: string): ToolHandler {
      const handler = handlers[name];
      if (!handler) throw new Error(`Tool "${name}" was not registered`);
      return handler;
    },
    getConfig(name: string): FakeToolConfig {
      const config = configs[name];
      if (!config) throw new Error(`Tool "${name}" was not registered`);
      return config;
    },
  };
}

// Two distinct context objects, so an assertion by identity proves which
// project the handler ran against.
const defaultProjectContext = { getProjectPath: () => '/projects/default' };
const otherProjectContext = { getProjectPath: () => '/projects/other' };

const defaultProjectResolved = {
  context: defaultProjectContext,
  projectId: '11111111-1111-4111-8111-111111111111',
  projectName: 'Active',
  isDefault: true,
};

const otherProjectResolved = {
  context: otherProjectContext,
  projectId: '22222222-2222-4222-8222-222222222222',
  projectName: 'Other',
  isDefault: false,
};

const UNRESOLVABLE_SELECTOR = 'no-such-project';
const UNRESOLVABLE_SELECTOR_ERROR = `No project matching "${UNRESOLVABLE_SELECTOR}". Available projects: "Active".`;

/** Resolves like the real resolver: no selector is the default project, 'other' is the second one. */
function makeResolveProject() {
  return vi.fn((selector: string | null | undefined) => {
    if (selector === 'other') return otherProjectResolved;
    if (selector === UNRESOLVABLE_SELECTOR) return { error: UNRESOLVABLE_SELECTOR_ERROR };
    return defaultProjectResolved;
  });
}

/** A report body with no `message` beside it, nested enough that a shallow or lossy stringify would show. */
const REPORT_DATA = {
  taskId: '6f1c2a90-0000-4000-8000-000000000001',
  startedAt: '2026-10-20T09:04:00.000Z',
  endedAt: null,
  route: [{
    swimlaneId: 'executing',
    name: 'Executing',
    totalMs: 3_540_000,
    visits: [{ startedAt: '2026-10-20T09:24:00.000Z', durationMs: 3_540_000 }],
  }],
  commits: null,
  commitCount: null,
  summaryState: { kind: 'pending' },
};

describe('kangentic_get_task_report registration', () => {
  let server: ReturnType<typeof makeFakeServer>;
  let resolveProject: ReturnType<typeof makeResolveProject>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = makeFakeServer();
    resolveProject = makeResolveProject();
    const resolver = { resolveProject } as unknown as RequestResolver;
    const taskCounter: TaskCounter = { tryReserve: vi.fn(() => true), limit: () => 50 };
    registerTaskTools(server as never, resolver, taskCounter);
    mockGetTaskReport.mockResolvedValue({ success: true, data: REPORT_DATA });
  });

  it('is annotated read-only, the shared constant and not a copy of it', () => {
    expect(server.getConfig(TOOL_NAME).annotations).toBe(READ_ONLY_ANNOTATIONS);
  });

  it('requires a string taskId and leaves project optional', () => {
    const { inputSchema } = server.getConfig(TOOL_NAME);

    expect(inputSchema.safeParse({ taskId: '42' }).success).toBe(true);
    expect(inputSchema.safeParse({ taskId: '42', project: 'other' }).success).toBe(true);
    expect(inputSchema.safeParse({}).success).toBe(false);
    expect(inputSchema.safeParse({ taskId: 42 }).success).toBe(false);
  });

  describe('which handler runs, with what, against which project', () => {
    it('runs get_task_report with exactly { taskId } against the default project when no project is given', async () => {
      await server.getHandler(TOOL_NAME)({ taskId: '42' });

      expect(resolveProject).toHaveBeenCalledWith(undefined);
      expect(mockGetTaskReport).toHaveBeenCalledOnce();
      const [params, commandContext] = mockGetTaskReport.mock.calls[0];
      expect(params).toStrictEqual({ taskId: '42' });
      expect(commandContext).toBe(defaultProjectContext);
    });

    it('asks the resolver for the named project and runs the handler against that project, without forwarding project as a param', async () => {
      await server.getHandler(TOOL_NAME)({ taskId: '42', project: 'other' });

      expect(resolveProject).toHaveBeenCalledWith('other');
      expect(mockGetTaskReport).toHaveBeenCalledOnce();
      const [params, commandContext] = mockGetTaskReport.mock.calls[0];
      expect(params).toStrictEqual({ taskId: '42' });
      expect(commandContext).toBe(otherProjectContext);
    });

    it('runs nothing and returns the resolver error when the project does not resolve', async () => {
      const result = await server.getHandler(TOOL_NAME)({ taskId: '42', project: UNRESOLVABLE_SELECTOR });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(UNRESOLVABLE_SELECTOR_ERROR);
      expect(mockGetTaskReport).not.toHaveBeenCalled();
    });
  });

  describe('what the agent reads back', () => {
    it('returns the report as JSON text when the handler gives data and no message', async () => {
      const result = await server.getHandler(TOOL_NAME)({ taskId: '42' });

      expect(result.isError).toBeUndefined();
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      // Exact, with no project line: the default project is never annotated.
      expect(result.content[0].text).toBe(JSON.stringify(REPORT_DATA));
    });

    it('puts the project line before the same JSON when the call crossed into another project', async () => {
      const result = await server.getHandler(TOOL_NAME)({ taskId: '42', project: 'other' });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe(`[Project: Other (22222222)]\n${JSON.stringify(REPORT_DATA)}`);
    });
  });

  describe('when the handler fails', () => {
    it('returns an isError result carrying the handler\'s error text', async () => {
      mockGetTaskReport.mockResolvedValue({ success: false, error: 'Task 42 not found' });

      const result = await server.getHandler(TOOL_NAME)({ taskId: '42' });

      expect(result.isError).toBe(true);
      expect(result.content).toStrictEqual([{ type: 'text', text: 'Task 42 not found' }]);
    });

    it('falls back to this tool\'s own failure text when the handler gives no error text', async () => {
      mockGetTaskReport.mockResolvedValue({ success: false });

      const result = await server.getHandler(TOOL_NAME)({ taskId: '42' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('Failed to get task report');
    });

    it('turns a thrown handler error into an isError result with the thrown message', async () => {
      mockGetTaskReport.mockRejectedValue(new Error('git exploded'));

      const result = await server.getHandler(TOOL_NAME)({ taskId: '42' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('git exploded');
    });
  });
});
