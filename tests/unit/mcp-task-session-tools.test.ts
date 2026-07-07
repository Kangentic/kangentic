import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for cross-cutting concerns in mcp-http/task-tools.ts and
 * mcp-http/session-tools.ts. These focus on wiring behaviour that is NOT
 * already covered by the mcp-project-resolver.test.ts suite:
 *
 *  1. create_task: rate-limit check (tryReserve) happens AFTER project
 *     resolution so a bad project selector does NOT burn a quota slot.
 *  2. get_current_task: uses resolver.defaultContextResolved().context
 *     directly - it intentionally does NOT go through withProject because
 *     the tool is always scoped to the URL-path project.
 *  3. list_sessions: representative session tool that routes the optional
 *     `project` param through withProject. A bad selector must return an
 *     error result without calling the inner handler.
 *
 * Strategy: mock handler-helpers (callHandler, runHandler, withProject) and
 * capture their call patterns. Use a fake McpServer that stores handlers by
 * name so we can invoke them directly without spinning up the real SDK
 * transport machinery.
 */

// vi.hoisted lifts these initializers above the vi.mock calls so the factory
// closures can reference the spy instances without a TDZ error.
const { mockCallHandler, mockRunHandler, mockWithProject, mockDetectCrossProjectMention } = vi.hoisted(() => {
  const mockCallHandler = vi.fn(() =>
    Promise.resolve({ content: [{ type: 'text' as const, text: 'ok' }] }),
  );
  const mockRunHandler = vi.fn(() =>
    Promise.resolve({ success: true, data: [], message: 'ok' }),
  );
  // create_task's routing guardrail calls this; default to "no other
  // project mentioned" so existing wiring tests are unaffected. Tests
  // that exercise the guardrail override the return value.
  const mockDetectCrossProjectMention = vi.fn((): string[] => []);
  const mockWithProject = vi.fn(
    async (
      _resolver: unknown,
      selector: unknown,
      run: (ctx: unknown, resolved: unknown) => Promise<unknown>,
      _options?: { alwaysAnnotate?: boolean },
    ) => {
      if (selector === 'INVALID_PROJECT') {
        return {
          content: [{ type: 'text' as const, text: 'No project matching "INVALID_PROJECT".' }],
          isError: true,
        };
      }
      // Approximate the real resolver: an omitted selector resolves to the
      // URL-path default project (isDefault true); an explicit selector is a
      // deliberate cross-project choice (isDefault false).
      const isDefault = selector === undefined || selector === null || selector === '';
      const resolved = {
        context: { getProjectPath: () => '/projects/default' },
        projectId: '11111111-1111-4111-8111-111111111111',
        projectName: 'Active',
        isDefault,
      };
      return run(resolved.context, resolved);
    },
  );
  return { mockCallHandler, mockRunHandler, mockWithProject, mockDetectCrossProjectMention };
});

// Mock handler-helpers BEFORE importing task-tools/session-tools, which
// pull in commandHandlers -> better-sqlite3. Stubbing the module keeps the
// unit scope pure (no native modules, no Electron process).
vi.mock('../../src/main/agent/mcp-http/handler-helpers', () => ({
  callHandler: mockCallHandler,
  runHandler: mockRunHandler,
  withProject: mockWithProject,
  detectCrossProjectMention: mockDetectCrossProjectMention,
  // Identity stub: the real sanitizer is unit-tested elsewhere; here we
  // only need the routing-check message to embed names verbatim.
  sanitizeProjectName: (name: string) => name,
  makeTaskCounter: () => {
    let count = 0;
    // Arbitrary high ceiling so the routing tests' creations are never throttled.
    // It mirrors MAX_TASK_CREATE_PER_LAUNCH in handler-helpers.ts but need not stay
    // in lockstep: the exhaustion tests below use their own decoupled counters, and
    // the real ceiling is verified in mcp-task-counter.test.ts.
    const ceiling = 500;
    return {
      tryReserve: vi.fn(() => {
        if (count >= ceiling) return false;
        count++;
        return true;
      }),
      limit: () => ceiling,
    };
  },
  PROJECT_SELECTOR_DESCRIPTION: 'optional project selector',
}));

import { registerTaskTools } from '../../src/main/agent/mcp-http/task-tools';
import { registerSessionTools } from '../../src/main/agent/mcp-http/session-tools';
import type { RequestResolver } from '../../src/main/agent/mcp-http/project-resolver';
import type { TaskCounter } from '../../src/main/agent/mcp-http/handler-helpers';

// Fake McpServer that captures registered handlers by tool name so tests can
// invoke them directly without the real SDK transport machinery.
type AnyToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

// Full config shape captured from registerTool's second argument.
// `inputSchema` is a Zod object whose `.shape` property maps field names to
// Zod schemas; each schema exposes a `.description` string set by `.describe()`.
interface ToolConfig {
  description?: string;
  inputSchema?: {
    shape: Record<string, { description: string | undefined }>;
  };
}

function makeFakeServer() {
  const handlers: Record<string, AnyToolHandler> = {};
  const configs: Record<string, ToolConfig> = {};
  return {
    registerTool: vi.fn((name: string, config: ToolConfig, handler: AnyToolHandler) => {
      handlers[name] = handler;
      configs[name] = config;
    }),
    getHandler(name: string): AnyToolHandler {
      const handler = handlers[name];
      if (!handler) throw new Error(`Tool "${name}" was not registered`);
      return handler;
    },
    getConfig(name: string): ToolConfig {
      const config = configs[name];
      if (!config) throw new Error(`Tool "${name}" was not registered`);
      return config;
    },
  };
}

function makeDefaultContextResolved() {
  return {
    context: { getProjectPath: () => '/projects/default' },
    projectId: '11111111-1111-4111-8111-111111111111',
    projectName: 'Active',
    isDefault: true,
  };
}

function makeResolver(): RequestResolver {
  return {
    resolveProject: vi.fn((selector: string | null | undefined) => {
      if (!selector) return makeDefaultContextResolved();
      return { error: `No project matching "${selector}"` };
    }),
    listProjects: vi.fn(() => []),
    defaultContextResolved: vi.fn(() => makeDefaultContextResolved()),
  } as unknown as RequestResolver;
}

// ---------------------------------------------------------------------------
// create_task - rate-limit wiring
// ---------------------------------------------------------------------------

describe('create_task rate-limit wiring', () => {
  let server: ReturnType<typeof makeFakeServer>;
  let resolver: RequestResolver;
  let taskCounter: TaskCounter;
  const MAX_TASKS = 5;

  beforeEach(() => {
    vi.clearAllMocks();
    server = makeFakeServer();
    resolver = makeResolver();
    let count = 0;
    taskCounter = {
      tryReserve: vi.fn(() => {
        if (count >= MAX_TASKS) return false;
        count++;
        return true;
      }),
      limit: () => MAX_TASKS,
    };
    registerTaskTools(server as never, resolver, taskCounter);
  });

  it('does NOT call tryReserve when the project selector is invalid', async () => {
    // withProject is mocked to return an error when selector === 'INVALID_PROJECT'.
    // tryReserve must stay uncalled - a failed resolution must NOT burn a quota slot.
    const result = await server.getHandler('kangentic_create_task')({
      title: 'My task',
      project: 'INVALID_PROJECT',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No project matching "INVALID_PROJECT"');
    expect(taskCounter.tryReserve).not.toHaveBeenCalled();
  });

  it('calls tryReserve exactly once when the project resolves successfully', async () => {
    await server.getHandler('kangentic_create_task')({ title: 'Valid task' });

    expect(taskCounter.tryReserve).toHaveBeenCalledOnce();
  });

  it('returns a rate-limit error and does NOT call callHandler when the counter is exhausted', async () => {
    // Drain the counter.
    for (let i = 0; i < MAX_TASKS; i++) {
      await server.getHandler('kangentic_create_task')({ title: `Task ${i}` });
    }
    mockCallHandler.mockClear();

    const result = await server.getHandler('kangentic_create_task')({ title: 'One too many' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Task-creation limit reached');
    expect(result.content[0].text).toContain(String(MAX_TASKS));
    // callHandler must NOT be called after a failed tryReserve.
    expect(mockCallHandler).not.toHaveBeenCalled();
  });

  it('rate-limit error message sources from taskCounter.limit(), not the count at exhaustion', async () => {
    // The counter exhausts after EXHAUST_AT=3 reservations but limit() returns
    // REPORTED_LIMIT=7 - deliberately mismatched values. If task-tools.ts were
    // changed to interpolate a captured constant (e.g. the accumulated count at
    // exhaustion time, or any frozen number) instead of calling taskCounter.limit()
    // live, the error text would say "maximum of 3 tasks" and the
    // toContain('7') assertion below would fail.
    //
    // Red-green: temporarily change the rate-limit error string in task-tools.ts
    // from `taskCounter.limit()` to `3` (or capture the count variable) - observe
    // red (toContain('7') fails), restore `taskCounter.limit()` - observe green.
    const EXHAUST_AT = 3;
    const REPORTED_LIMIT = 7;
    let decoupledCount = 0;
    const decoupledCounter: TaskCounter = {
      tryReserve: vi.fn(() => {
        if (decoupledCount >= EXHAUST_AT) return false;
        decoupledCount++;
        return true;
      }),
      limit: () => REPORTED_LIMIT,
    };
    const decoupledServer = makeFakeServer();
    registerTaskTools(decoupledServer as never, makeResolver(), decoupledCounter);

    // Exhaust the counter at EXHAUST_AT reservations.
    for (let index = 0; index < EXHAUST_AT; index++) {
      await decoupledServer.getHandler('kangentic_create_task')({ title: `Task ${index}` });
    }

    const result = await decoupledServer.getHandler('kangentic_create_task')({ title: 'Overflow' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Task-creation limit reached');
    // Must contain the live limit() value ('7'), not the exhaustion count ('3').
    expect(result.content[0].text).toContain(String(REPORTED_LIMIT));
    // Defensive: '3' must NOT appear; if it does, the code read the count at
    // exhaustion instead of calling limit() live. (Message is
    // "...maximum of 7 tasks since the app launched..." which contains no '3'.)
    expect(result.content[0].text).not.toContain(String(EXHAUST_AT));
  });
});

// ---------------------------------------------------------------------------
// create_task - cross-project routing guardrail
// ---------------------------------------------------------------------------

describe('create_task routing guardrail', () => {
  let server: ReturnType<typeof makeFakeServer>;
  let taskCounter: TaskCounter;

  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks does not reset return values; re-pin the default so a
    // prior test's mockReturnValue cannot leak into the next one.
    mockDetectCrossProjectMention.mockReturnValue([]);
    server = makeFakeServer();
    const resolver = makeResolver();
    taskCounter = { tryReserve: vi.fn(() => true), limit: () => 50 };
    registerTaskTools(server as never, resolver, taskCounter);
  });

  it('blocks and creates nothing when defaulting to active but the text names another project', async () => {
    mockDetectCrossProjectMention.mockReturnValue(['Kangentic']);

    const result = await server.getHandler('kangentic_create_task')({
      title: 'Fix the cross-project routing bug',
      description: 'Filed about kangentic from another board.',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Routing check');
    // Names a concrete re-run for both the target and the active project.
    expect(result.content[0].text).toContain('project: "Kangentic"');
    expect(result.content[0].text).toContain('project: "Active"');
    // No quota slot burned and no task created.
    expect(taskCounter.tryReserve).not.toHaveBeenCalled();
    expect(mockCallHandler).not.toHaveBeenCalled();
  });

  it('does NOT run the guardrail when an explicit project selector is passed', async () => {
    // Even if a name would match, an explicit selector is a deliberate
    // choice (isDefault false) and must be honored without a routing check.
    mockDetectCrossProjectMention.mockReturnValue(['Kangentic']);

    const result = await server.getHandler('kangentic_create_task')({
      title: 'Fix the kangentic bug',
      project: 'Kangentic',
    });

    expect(result.isError).toBeUndefined();
    expect(mockDetectCrossProjectMention).not.toHaveBeenCalled();
    expect(taskCounter.tryReserve).toHaveBeenCalledOnce();
    expect(mockCallHandler).toHaveBeenCalledOnce();
  });

  it('does NOT block when no other project is mentioned in the text', async () => {
    // Default return ([]) means nothing matched.
    const result = await server.getHandler('kangentic_create_task')({ title: 'Plain task' });

    expect(result.isError).toBeUndefined();
    expect(mockDetectCrossProjectMention).toHaveBeenCalledOnce();
    expect(taskCounter.tryReserve).toHaveBeenCalledOnce();
    expect(mockCallHandler).toHaveBeenCalledOnce();
  });

  it('uses the plural branch of the routing-check message when multiple projects are mentioned', async () => {
    // Simulates: title/description names two separate registered projects.
    // buildRoutingCheckMessage is not exported; exercise it through the handler.
    mockDetectCrossProjectMention.mockReturnValue(['Kangentic', 'TWC-Website']);

    const result = await server.getHandler('kangentic_create_task')({
      title: 'Update the kangentic and TWC-Website landing pages',
    });

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    // Plural branch: "these other registered projects" (not the singular form).
    expect(text).toContain('these other registered projects');
    // Both names embedded joined by ", ".
    expect(text).toContain('"Kangentic", "TWC-Website"');
    // Re-run hint names the first mentioned project.
    expect(text).toContain('e.g. project: "Kangentic"');
    // Re-run hint also names the active project so the agent can confirm it.
    expect(text).toContain('project: "Active"');
    // Guardrail fires before quota - no slot burned, no task created.
    expect(taskCounter.tryReserve).not.toHaveBeenCalled();
    expect(mockCallHandler).not.toHaveBeenCalled();
  });

  it('fires the guardrail for Backlog creates (no column carve-out)', async () => {
    // Guards against a future regression that might add a `column === 'Backlog'`
    // carve-out exempting Backlog creates from the routing check.
    mockDetectCrossProjectMention.mockReturnValue(['kangentic.com']);

    const result = await server.getHandler('kangentic_create_task')({
      title: 'Add foo to kangentic.com',
      column: 'Backlog',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Routing check');
    // No quota slot burned and no task created even for a Backlog column.
    expect(taskCounter.tryReserve).not.toHaveBeenCalled();
    expect(mockCallHandler).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// get_current_task - uses defaultContextResolved, NOT withProject
// ---------------------------------------------------------------------------

describe('get_current_task uses defaultContextResolved, not withProject', () => {
  let server: ReturnType<typeof makeFakeServer>;
  let resolver: RequestResolver;

  beforeEach(() => {
    vi.clearAllMocks();
    server = makeFakeServer();
    resolver = makeResolver();
    const taskCounter: TaskCounter = { tryReserve: vi.fn(() => true), limit: () => 50 };
    registerTaskTools(server as never, resolver, taskCounter);
  });

  it('calls resolver.defaultContextResolved() instead of withProject when cwd is supplied', async () => {
    await server.getHandler('kangentic_get_current_task')({ cwd: '/some/project/worktrees/task-slug' });

    expect(resolver.defaultContextResolved).toHaveBeenCalledOnce();
    // withProject must NOT be called - this tool is always scoped to the
    // URL-path project, not a caller-supplied project selector.
    expect(mockWithProject).not.toHaveBeenCalled();
  });

  it('calls resolver.defaultContextResolved() instead of withProject when branch is supplied', async () => {
    await server.getHandler('kangentic_get_current_task')({ branch: 'feature/my-task' });

    expect(resolver.defaultContextResolved).toHaveBeenCalledOnce();
    expect(mockWithProject).not.toHaveBeenCalled();
  });

  it('returns an error when neither cwd nor branch is provided', async () => {
    const result = await server.getHandler('kangentic_get_current_task')({});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Provide at least one of');
    // No context resolution should happen when the inputs are invalid.
    expect(resolver.defaultContextResolved).not.toHaveBeenCalled();
    expect(mockWithProject).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// list_sessions - representative session tool that routes through withProject
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Routing-cue hints in tool descriptions - regression guard against accidental
// revert of the prompt-routing guidance text (see server-instructions.ts for
// the top-level version of the same rule).
// ---------------------------------------------------------------------------

describe('routing-cue hints in tool descriptions', () => {
  let server: ReturnType<typeof makeFakeServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = makeFakeServer();
    const resolver = makeResolver();
    const taskCounter: TaskCounter = { tryReserve: vi.fn(() => true), limit: () => 50 };
    registerTaskTools(server as never, resolver, taskCounter);
  });

  it('kangentic_create_task description nudges the model to route by prompt cues', () => {
    const { description } = server.getConfig('kangentic_create_task');
    expect(description).toBeDefined();
    expect(description).toMatch(/names a different Kangentic project/i);
    expect(description).toContain('`project`');
    // Phrase-embedded selectors, not just the explicit "create a task in X"
    // form, must be covered (the cross-project-misroute fix).
    expect(description).toMatch(/however it is phrased/i);
    expect(description).toMatch(/board/i);
  });

  it('kangentic_move_task description nudges the model to route by prompt cues', () => {
    const { description } = server.getConfig('kangentic_move_task');
    expect(description).toBeDefined();
    expect(description).toMatch(/names a different Kangentic project/i);
    expect(description).toContain('`project`');
  });

  // Regression guard for the ATTACHMENTS RULE clause added to the
  // kangentic_create_task description. Without these assertions a simple
  // description revert would silently drop the auto-attach guidance.
  it('kangentic_create_task description contains the ATTACHMENTS RULE clause', () => {
    const { description } = server.getConfig('kangentic_create_task');
    expect(description).toBeDefined();
    expect(description).toContain('attachments');
    expect(description).toContain('absolute path');
    expect(description).toMatch(/default to attaching/i);
  });

  // Regression guard for the attachments Zod field description. The field-level
  // description is what MCP clients surface as parameter documentation, so it
  // must carry the "always include local files" directive independently of the
  // top-level tool description.
  //
  // Zod v4 exposes `.description` directly on each schema node in the shape.
  it('kangentic_create_task attachments field description carries the auto-attach directive', () => {
    const { inputSchema } = server.getConfig('kangentic_create_task');
    expect(inputSchema).toBeDefined();
    const attachmentsField = inputSchema?.shape['attachments'];
    expect(attachmentsField).toBeDefined();
    const fieldDescription = attachmentsField?.description;
    expect(fieldDescription).toBeDefined();
    expect(fieldDescription).toMatch(/any local files the user referenced/i);
    expect(fieldDescription).toContain('absolute path');
  });
});

describe('list_sessions project routing via withProject', () => {
  let server: ReturnType<typeof makeFakeServer>;
  let resolver: RequestResolver;

  beforeEach(() => {
    vi.clearAllMocks();
    server = makeFakeServer();
    resolver = makeResolver();
    registerSessionTools(server as never, resolver);
  });

  it('calls withProject with the resolver and the supplied project selector', async () => {
    await server.getHandler('kangentic_list_sessions')({ taskId: 'task-uuid', project: 'Beta' });

    expect(mockWithProject).toHaveBeenCalledOnce();
    const [passedResolver, passedSelector] = mockWithProject.mock.calls[0];
    expect(passedResolver).toBe(resolver);
    expect(passedSelector).toBe('Beta');
  });

  it('returns an error result when the project selector is invalid (no inner handler called)', async () => {
    mockCallHandler.mockClear();

    const result = await server.getHandler('kangentic_list_sessions')({
      taskId: 'task-uuid',
      project: 'INVALID_PROJECT',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No project matching "INVALID_PROJECT"');
    // callHandler must not have been invoked - resolution failed before
    // the inner tool body could run.
    expect(mockCallHandler).not.toHaveBeenCalled();
  });

  it('calls callHandler with "list_sessions" when the project resolves successfully', async () => {
    await server.getHandler('kangentic_list_sessions')({ taskId: 'task-uuid' });

    expect(mockCallHandler).toHaveBeenCalledOnce();
    const [handlerName, params] = mockCallHandler.mock.calls[0];
    expect(handlerName).toBe('list_sessions');
    expect((params as Record<string, unknown>).taskId).toBe('task-uuid');
  });
});

// ---------------------------------------------------------------------------
// kangentic_update_task - "at least one field" guard must accept an
// attachments-only call (the guard is evaluated at the Zod-validated tool
// handler in task-tools.ts, BEFORE callHandler/handleUpdateTask ever run -
// mcp-attachment-handlers.test.ts only covers the command-handler layer
// underneath, so this closes the tool-layer gap).
// ---------------------------------------------------------------------------

describe('kangentic_update_task "at least one field" guard - attachments wiring', () => {
  let server: ReturnType<typeof makeFakeServer>;
  let resolver: RequestResolver;
  let taskCounter: TaskCounter;

  beforeEach(() => {
    vi.clearAllMocks();
    server = makeFakeServer();
    resolver = makeResolver();
    taskCounter = { tryReserve: vi.fn(() => true), limit: () => 50 };
    registerTaskTools(server as never, resolver, taskCounter);
  });

  it('accepts an attachments-only call through the guard and forwards attachments to callHandler', async () => {
    const result = await server.getHandler('kangentic_update_task')({
      taskId: 'task-1',
      attachments: [{ filePath: '/mock/screenshot.png' }],
    });

    expect(result.isError).toBeUndefined();
    expect(mockCallHandler).toHaveBeenCalledOnce();
    const [handlerName, params] = mockCallHandler.mock.calls[0];
    expect(handlerName).toBe('update_task');
    const typedParams = params as Record<string, unknown>;
    expect(typedParams.attachments).toEqual([{ filePath: '/mock/screenshot.png' }]);
    // Every other field forwards as null, matching the "omitted -> null" contract
    // handleUpdateTask's `field !== null` checks depend on.
    expect(typedParams.title).toBeNull();
    expect(typedParams.description).toBeNull();
  });

  it('still rejects when taskId is the only field (attachments and everything else omitted)', async () => {
    const result = await server.getHandler('kangentic_update_task')({ taskId: 'task-1' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Provide at least one field to update.');
    expect(mockCallHandler).not.toHaveBeenCalled();
  });

  it('forwards attachments: null when attachments is omitted but another field is present', async () => {
    await server.getHandler('kangentic_update_task')({ taskId: 'task-1', title: 'New title' });

    expect(mockCallHandler).toHaveBeenCalledOnce();
    const [, params] = mockCallHandler.mock.calls[0];
    expect((params as Record<string, unknown>).attachments).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// kangentic_update_task descriptionEdits / appendDescription - tool-layer
// wiring: the "at least one field" guard, the description mutual-exclusivity
// guard, and forwarding to callHandler. handleUpdateTask's own apply/atomicity
// logic is covered in mcp-update-task-description-edits.test.ts.
// ---------------------------------------------------------------------------

describe('kangentic_update_task descriptionEdits / appendDescription wiring', () => {
  let server: ReturnType<typeof makeFakeServer>;
  let resolver: RequestResolver;
  let taskCounter: TaskCounter;

  beforeEach(() => {
    vi.clearAllMocks();
    server = makeFakeServer();
    resolver = makeResolver();
    taskCounter = { tryReserve: vi.fn(() => true), limit: () => 50 };
    registerTaskTools(server as never, resolver, taskCounter);
  });

  it('accepts a descriptionEdits-only call through the guard and forwards it to callHandler', async () => {
    const result = await server.getHandler('kangentic_update_task')({
      taskId: 'task-1',
      descriptionEdits: [{ find: 'old text', replace: 'new text' }],
    });

    expect(result.isError).toBeUndefined();
    expect(mockCallHandler).toHaveBeenCalledOnce();
    const [handlerName, params] = mockCallHandler.mock.calls[0];
    expect(handlerName).toBe('update_task');
    const typedParams = params as Record<string, unknown>;
    expect(typedParams.descriptionEdits).toEqual([{ find: 'old text', replace: 'new text' }]);
    expect(typedParams.description).toBeNull();
    expect(typedParams.appendDescription).toBeNull();
  });

  it('accepts an appendDescription-only call through the guard and forwards it to callHandler', async () => {
    const result = await server.getHandler('kangentic_update_task')({
      taskId: 'task-1',
      appendDescription: '\n\nmore text',
    });

    expect(result.isError).toBeUndefined();
    expect(mockCallHandler).toHaveBeenCalledOnce();
    const [, params] = mockCallHandler.mock.calls[0];
    const typedParams = params as Record<string, unknown>;
    expect(typedParams.appendDescription).toBe('\n\nmore text');
    expect(typedParams.description).toBeNull();
    expect(typedParams.descriptionEdits).toBeNull();
  });

  it('rejects description + descriptionEdits together without calling callHandler', async () => {
    const result = await server.getHandler('kangentic_update_task')({
      taskId: 'task-1',
      description: 'full replacement',
      descriptionEdits: [{ find: 'old text', replace: 'new text' }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not both');
    expect(mockCallHandler).not.toHaveBeenCalled();
  });

  it('rejects description + appendDescription together without calling callHandler', async () => {
    const result = await server.getHandler('kangentic_update_task')({
      taskId: 'task-1',
      description: 'full replacement',
      appendDescription: '\n\nmore text',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not both');
    expect(mockCallHandler).not.toHaveBeenCalled();
  });

  it('allows descriptionEdits and appendDescription together (compose mode)', async () => {
    const result = await server.getHandler('kangentic_update_task')({
      taskId: 'task-1',
      descriptionEdits: [{ find: 'old text', replace: 'new text' }],
      appendDescription: '\n\nmore text',
    });

    expect(result.isError).toBeUndefined();
    expect(mockCallHandler).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// kangentic_update_task descriptionEdits - Zod schema-level validation.
//
// The fake server harness above stubs `registerTool` itself, but the
// `inputSchema` it captures is the REAL z.object(...) built by task-tools.ts -
// only the SDK's server/transport is faked, not zod. In the real MCP server,
// the SDK validates incoming args against this schema BEFORE the registered
// handler ever runs; every wiring test above invokes the handler directly
// with already-valid args, so none of them would catch a broken or dropped
// Zod constraint (e.g. `.min(1)` silently removed from the array or the
// `find` field). Exercise the schema directly via `.safeParse` to close that
// protocol-level gap.
// ---------------------------------------------------------------------------

describe('kangentic_update_task descriptionEdits - Zod schema validation', () => {
  let server: ReturnType<typeof makeFakeServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = makeFakeServer();
    const resolver = makeResolver();
    const taskCounter: TaskCounter = { tryReserve: vi.fn(() => true), limit: () => 50 };
    registerTaskTools(server as never, resolver, taskCounter);
  });

  function updateTaskSchema(): { safeParse: (data: unknown) => { success: boolean } } {
    const { inputSchema } = server.getConfig('kangentic_update_task');
    return inputSchema as unknown as { safeParse: (data: unknown) => { success: boolean } };
  }

  it('rejects an empty descriptionEdits array (schema .min(1))', () => {
    const result = updateTaskSchema().safeParse({ taskId: 'task-1', descriptionEdits: [] });

    expect(result.success).toBe(false);
  });

  it('rejects a descriptionEdits array beyond the 100-edit cap (schema .max(100))', () => {
    const tooManyEdits = Array.from({ length: 101 }, (_, index) => ({
      find: `find-${index}`,
      replace: `replace-${index}`,
    }));

    const result = updateTaskSchema().safeParse({ taskId: 'task-1', descriptionEdits: tooManyEdits });

    expect(result.success).toBe(false);
  });

  it('accepts a descriptionEdits array at exactly the 100-edit cap boundary', () => {
    const maxEdits = Array.from({ length: 100 }, (_, index) => ({
      find: `find-${index}`,
      replace: `replace-${index}`,
    }));

    const result = updateTaskSchema().safeParse({ taskId: 'task-1', descriptionEdits: maxEdits });

    expect(result.success).toBe(true);
  });

  it('rejects an empty-string find (schema .min(1) on the find field)', () => {
    const result = updateTaskSchema().safeParse({
      taskId: 'task-1',
      descriptionEdits: [{ find: '', replace: 'anything' }],
    });

    expect(result.success).toBe(false);
  });

  it('accepts an empty-string replace (deletion is valid at the schema level)', () => {
    const result = updateTaskSchema().safeParse({
      taskId: 'task-1',
      descriptionEdits: [{ find: 'something', replace: '' }],
    });

    expect(result.success).toBe(true);
  });

  it('accepts a well-formed single-entry descriptionEdits array', () => {
    const result = updateTaskSchema().safeParse({
      taskId: 'task-1',
      descriptionEdits: [{ find: 'old', replace: 'new' }],
    });

    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// kangentic_remove_task_attachment - tool registration and wiring at the
// mcp-http layer (as opposed to handleRemoveAttachment's command-handler
// logic, already covered in mcp-attachment-handlers.test.ts).
// ---------------------------------------------------------------------------

describe('kangentic_remove_task_attachment wiring', () => {
  let server: ReturnType<typeof makeFakeServer>;
  let resolver: RequestResolver;

  beforeEach(() => {
    vi.clearAllMocks();
    server = makeFakeServer();
    resolver = makeResolver();
    const taskCounter: TaskCounter = { tryReserve: vi.fn(() => true), limit: () => 50 };
    registerTaskTools(server as never, resolver, taskCounter);
  });

  it('is registered on the server', () => {
    expect(() => server.getHandler('kangentic_remove_task_attachment')).not.toThrow();
  });

  it('routes attachmentId and the project selector through withProject to callHandler("remove_attachment", ...)', async () => {
    await server.getHandler('kangentic_remove_task_attachment')({ attachmentId: 'att-1', project: 'Beta' });

    expect(mockWithProject).toHaveBeenCalledOnce();
    const [passedResolver, passedSelector] = mockWithProject.mock.calls[0];
    expect(passedResolver).toBe(resolver);
    expect(passedSelector).toBe('Beta');

    expect(mockCallHandler).toHaveBeenCalledOnce();
    const [handlerName, params] = mockCallHandler.mock.calls[0];
    expect(handlerName).toBe('remove_attachment');
    expect(params).toEqual({ attachmentId: 'att-1' });
  });

  it('returns an error result and does not call callHandler when the project selector is invalid', async () => {
    mockCallHandler.mockClear();

    const result = await server.getHandler('kangentic_remove_task_attachment')({
      attachmentId: 'att-1',
      project: 'INVALID_PROJECT',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No project matching "INVALID_PROJECT"');
    expect(mockCallHandler).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// kangentic_update_backlog_item - attachments wiring at the mcp-http layer
// (session-tools.ts). backlog-update-delete-handlers.test.ts already covers
// the command-handler behavior underneath; this closes the tool-layer gap.
// ---------------------------------------------------------------------------

describe('kangentic_update_backlog_item attachments wiring', () => {
  let server: ReturnType<typeof makeFakeServer>;
  let resolver: RequestResolver;

  beforeEach(() => {
    vi.clearAllMocks();
    server = makeFakeServer();
    resolver = makeResolver();
    registerSessionTools(server as never, resolver);
  });

  it('forwards the attachments array through to callHandler when provided', async () => {
    await server.getHandler('kangentic_update_backlog_item')({
      itemId: 'item-001',
      attachments: [{ filePath: '/mock/notes.txt' }],
    });

    expect(mockCallHandler).toHaveBeenCalledOnce();
    const [handlerName, params] = mockCallHandler.mock.calls[0];
    expect(handlerName).toBe('update_backlog_item');
    expect((params as Record<string, unknown>).attachments).toEqual([{ filePath: '/mock/notes.txt' }]);
  });

  it('forwards attachments: null when the attachments field is omitted', async () => {
    await server.getHandler('kangentic_update_backlog_item')({ itemId: 'item-001', title: 'New title' });

    expect(mockCallHandler).toHaveBeenCalledOnce();
    const [, params] = mockCallHandler.mock.calls[0];
    expect((params as Record<string, unknown>).attachments).toBeNull();
  });

  it('routes the project selector through withProject alongside attachments', async () => {
    await server.getHandler('kangentic_update_backlog_item')({
      itemId: 'item-001',
      attachments: [{ filePath: '/mock/notes.txt' }],
      project: 'Beta',
    });

    expect(mockWithProject).toHaveBeenCalledOnce();
    const [, passedSelector] = mockWithProject.mock.calls[0];
    expect(passedSelector).toBe('Beta');
  });
});
