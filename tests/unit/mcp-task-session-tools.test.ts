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
const { mockHandleMoveTaskToProject } = vi.hoisted(() => ({
  mockHandleMoveTaskToProject: vi.fn(() => ({ success: true, message: 'moved', data: {} })),
}));

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

// task-tools.ts imports handleMoveTaskToProject directly from task-commands
// (it is a two-context handler that bypasses the single-context
// commandHandlers registry, so it cannot go through the mocked callHandler
// above). Mock it here to keep this wiring-only suite DB-free; its real
// logic against actual per-project SQLite DBs is covered by
// mcp-move-task-to-project.test.ts.
vi.mock('../../src/main/agent/commands/task-commands', () => ({
  TASK_DESCRIPTION_MAX_LENGTH: 50_000,
  handleMoveTaskToProject: mockHandleMoveTaskToProject,
}));

// These tests are about ARGUMENT WIRING, not override validity, and the real
// validator probes the machine's installed agent CLIs - which would make
// "is claude-opus-4-8 a known model" depend on the developer's machine and
// differ on CI. Validation has its own dedicated unit test
// (mcp-spawn-override-validation.test.ts).
const mockValidateSpawnOverrides = vi.hoisted(() => vi.fn(async (): Promise<string | null> => null));
vi.mock('../../src/main/agent/mcp-http/spawn-override-validation', () => ({
  validateSpawnOverrides: mockValidateSpawnOverrides,
}));

// Only used by the update_task ladder tests below (kangentic_update_task
// validateSpawnOverrides wiring - "agent: '' clears the pin" cases), which
// need agentLadderRungsForTask to resolve a REAL stored agent pin instead of
// hitting its catch-and-return-null fallback. Defaulting resolveTask to
// "not found" keeps every other test's behavior unchanged: agentLadderRungsForTask
// still ends up at { taskAgentOverride: null, laneAgentOverride: null } either
// way (via its `if (!task)` branch here, or its catch branch when the mocked
// withProject's default context has no getProjectDb at all).
const mockResolveTask = vi.hoisted(() => vi.fn(() => undefined));
vi.mock('../../src/main/agent/commands/task-resolver', () => ({
  resolveTask: mockResolveTask,
}));
const mockSwimlaneGetById = vi.hoisted(() => vi.fn((_swimlaneId: string): { agent_override: string | null } | null => null));
// A real class, not `vi.fn().mockImplementation(() => ({...}))`: the latter
// triggers vitest's "did not use 'function' or 'class'" warning when invoked
// with `new` and silently fails to attach `getById`, which made
// agentLadderRungsForTask's try block throw and swallow the fixture - a real
// class has correct `new` semantics.
vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({
  SwimlaneRepository: class {
    getById(swimlaneId: string): { agent_override: string | null } | null {
      return mockSwimlaneGetById(swimlaneId);
    }
  },
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
    getProjectDefaultAgent: vi.fn(() => null),
    getAgentValidationConfig: vi.fn(() => ({ cliPathOverrides: {}, discoveredModelsByAgent: {} })),
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
// kangentic_create_task - agent/model/effort/permissionMode/autoCommand
// override wiring at the tool layer. handleCreateTask's persistence of these
// fields onto taskRepo.create is covered in mcp-create-task-labels.test.ts;
// this closes the tool-layer gap: a friendly model name ("Opus 4.8") must be
// converted via the REAL resolveModelSelector before forwarding to
// callHandler, and effort must be lowercased via the REAL
// resolveEffortSelector (neither is mocked in this file - only
// handler-helpers is mocked - so this exercises the actual conversion
// functions from src/shared/model-id.ts).
// ---------------------------------------------------------------------------

describe('kangentic_create_task agent/model/effort/permissionMode/autoCommand override wiring', () => {
  let server: ReturnType<typeof makeFakeServer>;
  let resolver: RequestResolver;
  let taskCounter: TaskCounter;

  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks clears call history but NOT a prior .mockReturnValue() -
    // re-pin the routing-guardrail default so a previous describe block's
    // mockReturnValue(['...']) (a sibling project name) cannot leak in and
    // trip the guardrail, which would block callHandler and self-mask every
    // assertion below as "not called" instead of testing the override wiring.
    mockDetectCrossProjectMention.mockReturnValue([]);
    server = makeFakeServer();
    resolver = makeResolver();
    taskCounter = { tryReserve: vi.fn(() => true), limit: () => 50 };
    registerTaskTools(server as never, resolver, taskCounter);
  });

  it('validates the NORMALIZED model, not the friendly name the caller typed', async () => {
    // Validating the raw input would reject friendly names the spawn accepts.
    await server.getHandler('kangentic_create_task')({
      title: 'Task with friendly model',
      modelOverride: 'Opus 4.8',
    });

    expect(mockValidateSpawnOverrides).toHaveBeenCalledOnce();
    expect(mockValidateSpawnOverrides.mock.calls[0][0]).toMatchObject({ modelOverride: 'claude-opus-4-8' });
  });

  it('rejects the create when validation fails, creating nothing and burning no quota slot', async () => {
    mockValidateSpawnOverrides.mockResolvedValueOnce('effortOverride "xtreme" is not valid for agent "claude".');

    const result = await server.getHandler('kangentic_create_task')({
      title: 'Task with a bad effort',
      effortOverride: 'xtreme',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('is not valid for agent "claude"');
    expect(result.content[0].text).toContain('No task was created.');
    expect(mockCallHandler).not.toHaveBeenCalled();
    // Ordered before tryReserve for the same reason as the routing guardrail.
    expect(taskCounter.tryReserve).not.toHaveBeenCalled();
  });

  it('skips validation entirely when no agent/model/effort is pinned', async () => {
    // The common create. It must not pay for a capability probe.
    await server.getHandler('kangentic_create_task')({ title: 'Plain task' });

    expect(mockValidateSpawnOverrides).not.toHaveBeenCalled();
    expect(mockCallHandler).toHaveBeenCalledOnce();
  });

  it('skips validation for a Backlog create, which never spawns', async () => {
    await server.getHandler('kangentic_create_task')({
      title: 'Backlog item',
      column: 'backlog',
      modelOverride: 'Opus 4.8',
    });

    expect(mockValidateSpawnOverrides).not.toHaveBeenCalled();
  });

  it('converts a friendly model name to the CLI id via resolveModelSelector before forwarding', async () => {
    await server.getHandler('kangentic_create_task')({
      title: 'Task with friendly model',
      modelOverride: 'Opus 4.8',
    });

    expect(mockCallHandler).toHaveBeenCalledOnce();
    const [handlerName, params] = mockCallHandler.mock.calls[0];
    expect(handlerName).toBe('create_task');
    expect((params as Record<string, unknown>).modelOverride).toBe('claude-opus-4-8');
  });

  it('lowercases effortOverride via resolveEffortSelector before forwarding', async () => {
    await server.getHandler('kangentic_create_task')({
      title: 'Task with cased effort',
      effortOverride: 'XHigh',
    });

    expect(mockCallHandler).toHaveBeenCalledOnce();
    const [, params] = mockCallHandler.mock.calls[0];
    expect((params as Record<string, unknown>).effortOverride).toBe('xhigh');
  });

  it('forwards agentOverride, permissionMode, and autoCommand verbatim (no transformation)', async () => {
    await server.getHandler('kangentic_create_task')({
      title: 'Task with pass-through overrides',
      agentOverride: 'codex',
      permissionMode: 'bypassPermissions',
      autoCommand: '/code-review',
    });

    expect(mockCallHandler).toHaveBeenCalledOnce();
    const [, params] = mockCallHandler.mock.calls[0];
    const typedParams = params as Record<string, unknown>;
    expect(typedParams.agentOverride).toBe('codex');
    expect(typedParams.permissionMode).toBe('bypassPermissions');
    expect(typedParams.autoCommand).toBe('/code-review');
  });

  it('forwards null for every override field when none are provided', async () => {
    await server.getHandler('kangentic_create_task')({ title: 'Plain task' });

    expect(mockCallHandler).toHaveBeenCalledOnce();
    const [, params] = mockCallHandler.mock.calls[0];
    const typedParams = params as Record<string, unknown>;
    expect(typedParams.agentOverride).toBeNull();
    expect(typedParams.modelOverride).toBeNull();
    expect(typedParams.effortOverride).toBeNull();
    expect(typedParams.permissionMode).toBeNull();
    expect(typedParams.autoCommand).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// kangentic_update_task - model/effort/permissionMode TRI-STATE wiring at the
// tool layer: omitted forwards undefined (leave untouched downstream),
// empty-string maps to null (explicit clear), and a concrete value is
// resolved (model via resolveModelSelector, effort via
// resolveEffortSelector) and forwarded. handleUpdateTask's consumption of
// this tri-state (the `!== undefined` guards in task-commands.ts) is covered
// separately in mcp-update-task-description-edits.test.ts.
// ---------------------------------------------------------------------------

describe('kangentic_update_task model/effort/permissionMode tri-state wiring', () => {
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

  it('forwards undefined for model/effort/permissionMode when all three are omitted', async () => {
    await server.getHandler('kangentic_update_task')({ taskId: 'task-1', title: 'New title' });

    expect(mockCallHandler).toHaveBeenCalledOnce();
    const [, params] = mockCallHandler.mock.calls[0];
    const typedParams = params as Record<string, unknown>;
    expect(typedParams.model).toBeUndefined();
    expect(typedParams.effort).toBeUndefined();
    expect(typedParams.permissionMode).toBeUndefined();
  });

  it('maps an empty-string model to null (clear) rather than forwarding the empty string', async () => {
    await server.getHandler('kangentic_update_task')({ taskId: 'task-1', model: '' });

    expect(mockCallHandler).toHaveBeenCalledOnce();
    const [, params] = mockCallHandler.mock.calls[0];
    expect((params as Record<string, unknown>).model).toBeNull();
  });

  it('maps an empty-string effort to null', async () => {
    await server.getHandler('kangentic_update_task')({ taskId: 'task-1', effort: '' });

    expect(mockCallHandler).toHaveBeenCalledOnce();
    const [, params] = mockCallHandler.mock.calls[0];
    expect((params as Record<string, unknown>).effort).toBeNull();
  });

  it('maps an empty-string permissionMode to null', async () => {
    await server.getHandler('kangentic_update_task')({ taskId: 'task-1', permissionMode: '' });

    expect(mockCallHandler).toHaveBeenCalledOnce();
    const [, params] = mockCallHandler.mock.calls[0];
    expect((params as Record<string, unknown>).permissionMode).toBeNull();
  });

  it('resolves a friendly model name via resolveModelSelector for a concrete value', async () => {
    await server.getHandler('kangentic_update_task')({ taskId: 'task-1', model: 'Sonnet 4.5' });

    expect(mockCallHandler).toHaveBeenCalledOnce();
    const [, params] = mockCallHandler.mock.calls[0];
    expect((params as Record<string, unknown>).model).toBe('claude-sonnet-4-5');
  });

  it('lowercases a concrete effort value via resolveEffortSelector', async () => {
    await server.getHandler('kangentic_update_task')({ taskId: 'task-1', effort: 'High' });

    expect(mockCallHandler).toHaveBeenCalledOnce();
    const [, params] = mockCallHandler.mock.calls[0];
    expect((params as Record<string, unknown>).effort).toBe('high');
  });

  it('forwards a concrete permissionMode value verbatim (no transformation, not mapped to null)', async () => {
    await server.getHandler('kangentic_update_task')({ taskId: 'task-1', permissionMode: 'plan' });

    expect(mockCallHandler).toHaveBeenCalledOnce();
    const [, params] = mockCallHandler.mock.calls[0];
    expect((params as Record<string, unknown>).permissionMode).toBe('plan');
  });
});

// ---------------------------------------------------------------------------
// kangentic_update_task - validateSpawnOverrides wiring. create_task's
// validation wiring is covered above; this closes the UPDATE side, which was
// previously untested. The validator's own logic (baseId normalization etc.)
// has its own dedicated suite (mcp-spawn-override-validation.test.ts) - this
// block is purely about whether task-tools.ts calls it, with what, and how it
// handles a rejection.
// ---------------------------------------------------------------------------

describe('kangentic_update_task validateSpawnOverrides wiring', () => {
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

  it('calls validateSpawnOverrides when a model pin is present', async () => {
    await server.getHandler('kangentic_update_task')({ taskId: 'task-1', model: 'opus' });

    expect(mockValidateSpawnOverrides).toHaveBeenCalledOnce();
  });

  it('calls validateSpawnOverrides when an effort pin is present', async () => {
    await server.getHandler('kangentic_update_task')({ taskId: 'task-1', effort: 'high' });

    expect(mockValidateSpawnOverrides).toHaveBeenCalledOnce();
  });

  it('calls validateSpawnOverrides when an agent pin is present', async () => {
    await server.getHandler('kangentic_update_task')({ taskId: 'task-1', agent: 'codex' });

    expect(mockValidateSpawnOverrides).toHaveBeenCalledOnce();
  });

  it('does NOT call validateSpawnOverrides for a labels-only update', async () => {
    await server.getHandler('kangentic_update_task')({ taskId: 'task-1', labels: ['bug'] });

    expect(mockValidateSpawnOverrides).not.toHaveBeenCalled();
    expect(mockCallHandler).toHaveBeenCalledOnce();
  });

  it('does NOT call validateSpawnOverrides when agent is cleared with an empty string', async () => {
    // '' is the documented clear sentinel, not a pin - the source gates on
    // truthy `agent`, so a clear must not pay for a capability probe.
    await server.getHandler('kangentic_update_task')({ taskId: 'task-1', agent: '' });

    expect(mockValidateSpawnOverrides).not.toHaveBeenCalled();
    expect(mockCallHandler).toHaveBeenCalledOnce();
  });

  it('returns isError with the rejection text and "The task was not updated." when validation fails, without calling callHandler', async () => {
    mockValidateSpawnOverrides.mockResolvedValueOnce(
      'modelOverride "claude-opus-4-9" is not a known model for agent "claude".',
    );

    const result = await server.getHandler('kangentic_update_task')({ taskId: 'task-1', model: 'claude-opus-4-9' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('modelOverride "claude-opus-4-9" is not a known model for agent "claude".');
    expect(result.content[0].text).toContain('The task was not updated.');
    expect(mockCallHandler).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // agent: "" clears the task's agent pin, which must NOT anchor the
  // validation ladder - re-checking a model against the OLD agent on a call
  // whose whole point is to move off it is a false rejection. Distinguishing
  // "cleared" from "omitted" requires agentLadderRungsForTask to resolve a
  // REAL stored task, so these two arm a working getProjectDb on the mocked
  // withProject context for one call each (mockImplementationOnce), backed by
  // the mockResolveTask / mockSwimlaneGetById mocks declared at the top of
  // this file.
  // -------------------------------------------------------------------------

  /**
   * Arm the mocked withProject to hand agentLadderRungsForTask a working
   * getProjectDb, and arm resolveTask to report a task whose stored
   * agent_override is `storedTaskAgentOverride`. Both are mockImplementationOnce
   * / mockReturnValueOnce, so this only affects the very next handler call.
   */
  function armLadderFixture(storedTaskAgentOverride: string | null): void {
    mockWithProject.mockImplementationOnce(
      async (
        _resolver: unknown,
        _selector: unknown,
        run: (ctx: unknown, resolved: unknown) => Promise<unknown>,
      ) => {
        const ctx = { getProjectPath: () => '/projects/default', getProjectDb: () => ({}) };
        const resolved = {
          context: ctx,
          projectId: '11111111-1111-4111-8111-111111111111',
          projectName: 'Active',
          isDefault: true,
        };
        return run(ctx, resolved);
      },
    );
    mockResolveTask.mockReturnValueOnce({ agent_override: storedTaskAgentOverride, swimlane_id: 'lane-1' });
    mockSwimlaneGetById.mockReturnValueOnce(null);
  }

  it('forces taskAgentOverride to null when agent: "" clears the pin, even though the task has one stored', async () => {
    armLadderFixture('claude');

    await server.getHandler('kangentic_update_task')({ taskId: 'task-1', agent: '', model: 'gpt-5' });

    expect(mockValidateSpawnOverrides).toHaveBeenCalledOnce();
    expect(mockValidateSpawnOverrides.mock.calls[0][0]).toMatchObject({ taskAgentOverride: null });
  });

  it('forwards the task\'s stored agent pin when agent is omitted entirely (contrast: not blanket-nulled)', async () => {
    armLadderFixture('claude');

    await server.getHandler('kangentic_update_task')({ taskId: 'task-1', model: 'gpt-5' });

    expect(mockValidateSpawnOverrides).toHaveBeenCalledOnce();
    expect(mockValidateSpawnOverrides.mock.calls[0][0]).toMatchObject({ taskAgentOverride: 'claude' });
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

describe('kangentic_move_task_to_project wiring', () => {
  let server: ReturnType<typeof makeFakeServer>;
  let resolver: RequestResolver;

  // Bypasses withProject/makeResolver (which only understand a single default
  // project) since this tool resolves TWO distinct projects at once.
  function makeMultiProjectResolver(): RequestResolver {
    const defaultResolved = makeDefaultContextResolved();
    const targetResolved = {
      context: { getProjectPath: () => '/projects/target' },
      projectId: '22222222-2222-4222-8222-222222222222',
      projectName: 'Target',
      isDefault: false,
    };
    return {
      resolveProject: vi.fn((selector: string | null | undefined) => {
        if (!selector) return defaultResolved;
        if (selector === 'Target') return targetResolved;
        if (selector === 'Active') return defaultResolved;
        return { error: `No project matching "${selector}"` };
      }),
      listProjects: vi.fn(() => []),
      defaultContextResolved: vi.fn(() => defaultResolved),
    } as unknown as RequestResolver;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockHandleMoveTaskToProject.mockReturnValue({ success: true, message: 'moved', data: {} });
    server = makeFakeServer();
    resolver = makeMultiProjectResolver();
    const taskCounter: TaskCounter = { tryReserve: vi.fn(() => true), limit: () => 50 };
    registerTaskTools(server as never, resolver, taskCounter);
  });

  it('declares MUTATING_ANNOTATIONS and the expected input schema keys', () => {
    const config = server.getConfig('kangentic_move_task_to_project');
    expect(config.annotations).toEqual({ readOnlyHint: false, idempotentHint: false });
    expect(Object.keys(config.inputSchema?.shape ?? {})).toEqual(
      expect.arrayContaining(['taskId', 'targetProject', 'column', 'project']),
    );
  });

  it('resolves source and target then delegates to handleMoveTaskToProject', async () => {
    const result = await server.getHandler('kangentic_move_task_to_project')({
      taskId: '42',
      targetProject: 'Target',
    });

    expect(mockHandleMoveTaskToProject).toHaveBeenCalledTimes(1);
    const [params] = mockHandleMoveTaskToProject.mock.calls[0] as [Record<string, unknown>];
    expect(params).toEqual({ taskId: '42', column: undefined });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe('moved');
  });

  it('returns isError without calling the handler when targetProject fails to resolve', async () => {
    const result = await server.getHandler('kangentic_move_task_to_project')({
      taskId: '42',
      targetProject: 'INVALID_PROJECT',
    });

    expect(result.isError).toBe(true);
    expect(mockHandleMoveTaskToProject).not.toHaveBeenCalled();
  });

  it('returns isError without calling the handler when the source project fails to resolve', async () => {
    const result = await server.getHandler('kangentic_move_task_to_project')({
      taskId: '42',
      targetProject: 'Target',
      project: 'INVALID_PROJECT',
    });

    expect(result.isError).toBe(true);
    expect(mockHandleMoveTaskToProject).not.toHaveBeenCalled();
  });

  it('rejects when source and target resolve to the same project', async () => {
    const result = await server.getHandler('kangentic_move_task_to_project')({
      taskId: '42',
      targetProject: 'Active',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/same project/i);
    expect(mockHandleMoveTaskToProject).not.toHaveBeenCalled();
  });

  it('surfaces a failure response from handleMoveTaskToProject as isError', async () => {
    mockHandleMoveTaskToProject.mockReturnValue({
      success: false,
      error: 'Only tasks in a To Do column can be moved to another project.',
    });

    const result = await server.getHandler('kangentic_move_task_to_project')({
      taskId: '42',
      targetProject: 'Target',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('To Do');
  });

  it('surfaces a thrown error from handleMoveTaskToProject as isError, not an unhandled rejection', async () => {
    mockHandleMoveTaskToProject.mockImplementation(() => {
      throw new Error('unexpected FK violation');
    });

    const result = await server.getHandler('kangentic_move_task_to_project')({
      taskId: '42',
      targetProject: 'Target',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('unexpected FK violation');
  });
});

// ---------------------------------------------------------------------------
// kangentic_list_tasks / kangentic_search_tasks - label suffix rendering
// (formatLabelSuffix, task-tools.ts). Neither tool had a test asserting on
// the rendered text before this, so the ` [a, b]` suffix line could be
// deleted entirely with nothing failing.
// ---------------------------------------------------------------------------

describe('kangentic_list_tasks - label suffix rendering', () => {
  let server: ReturnType<typeof makeFakeServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = makeFakeServer();
    const resolver = makeResolver();
    const taskCounter: TaskCounter = { tryReserve: vi.fn(() => true), limit: () => 50 };
    registerTaskTools(server as never, resolver, taskCounter);
  });

  it('renders the " [a, b]" label suffix for a labeled task', async () => {
    mockRunHandler.mockResolvedValueOnce({
      success: true,
      data: [
        { id: 'task-1', displayId: 1, title: 'Fix the bug', description: '', column: 'To Do', position: 0, labels: ['bug', 'urgent'] },
      ],
    });

    const result = await server.getHandler('kangentic_list_tasks')({});

    expect(result.content[0].text).toContain('Fix the bug [bug, urgent] (#1');
  });

  it('renders no bracketed label group for a task with labels: []', async () => {
    mockRunHandler.mockResolvedValueOnce({
      success: true,
      data: [
        { id: 'task-1', displayId: 1, title: 'Fix the bug', description: '', column: 'To Do', position: 0, labels: [] },
      ],
    });

    const result = await server.getHandler('kangentic_list_tasks')({});

    expect(result.content[0].text).toContain('Fix the bug (#1');
    expect(result.content[0].text).not.toContain('Fix the bug [');
  });
});

describe('kangentic_search_tasks - label suffix rendering', () => {
  let server: ReturnType<typeof makeFakeServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = makeFakeServer();
    const resolver = makeResolver();
    const taskCounter: TaskCounter = { tryReserve: vi.fn(() => true), limit: () => 50 };
    registerTaskTools(server as never, resolver, taskCounter);
  });

  it('renders a labeled board hit\'s " [a, b]" suffix distinctly from the "[<column>]" status tag', async () => {
    mockRunHandler.mockResolvedValueOnce({
      success: true,
      data: {
        tasks: [
          { id: 'task-1', displayId: 1, title: 'Fix the bug', description: '', column: 'To Do', status: 'active', labels: ['bug', 'urgent'] },
        ],
        backlog: [],
        totalActive: 1,
        totalCompleted: 0,
        totalBacklog: 0,
        scope: 'both',
      },
    });

    const result = await server.getHandler('kangentic_search_tasks')({ query: 'bug' });

    expect(result.content[0].text).toContain('Fix the bug [To Do] [bug, urgent] (#1');
  });

  it('renders no bracketed label group for a board hit with labels: [], leaving only the status tag bracket', async () => {
    mockRunHandler.mockResolvedValueOnce({
      success: true,
      data: {
        tasks: [
          { id: 'task-1', displayId: 1, title: 'Fix the bug', description: '', column: 'To Do', status: 'active', labels: [] },
        ],
        backlog: [],
        totalActive: 1,
        totalCompleted: 0,
        totalBacklog: 0,
        scope: 'both',
      },
    });

    const result = await server.getHandler('kangentic_search_tasks')({ query: 'bug' });
    const text = result.content[0].text;

    expect(text).toContain('Fix the bug [To Do] (#1');
    // No second bracket group directly after the status tag - a check that
    // merely asserted "no bracket at all" would falsely pass, since the
    // status tag itself is bracketed.
    expect(text).not.toMatch(/\[To Do\] \[/);
  });

  it('renders a labeled backlog hit\'s " [a, b]" suffix', async () => {
    mockRunHandler.mockResolvedValueOnce({
      success: true,
      data: {
        tasks: [],
        backlog: [
          { id: 'item-1', title: 'Draft the spec', description: '', priority: 0, priorityLabel: 'none', labels: ['docs', 'draft'] },
        ],
        totalActive: 0,
        totalCompleted: 0,
        totalBacklog: 1,
        scope: 'both',
      },
    });

    const result = await server.getHandler('kangentic_search_tasks')({ query: 'spec' });

    expect(result.content[0].text).toContain('Draft the spec (none) [docs, draft] (id: item-1)');
  });

  it('renders no bracketed label group for a backlog hit with labels: []', async () => {
    mockRunHandler.mockResolvedValueOnce({
      success: true,
      data: {
        tasks: [],
        backlog: [
          { id: 'item-1', title: 'Draft the spec', description: '', priority: 0, priorityLabel: 'none', labels: [] },
        ],
        totalActive: 0,
        totalCompleted: 0,
        totalBacklog: 1,
        scope: 'both',
      },
    });

    const result = await server.getHandler('kangentic_search_tasks')({ query: 'spec' });
    const text = result.content[0].text;

    expect(text).toContain('Draft the spec (none) (id: item-1)');
    expect(text).not.toContain('Draft the spec (none) [');
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
