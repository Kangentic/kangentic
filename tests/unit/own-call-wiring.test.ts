/**
 * Wiring of the "own call" guards, the links the per-module tests cannot see.
 *
 * A task's own agent that moves its task, or pauses its workflow, ends its own
 * session once its turn ends (`own-call-turn-wait.ts`). Each consumer of that
 * mark is tested in isolation with the dependency handed in directly, so a call
 * site that stops handing it over breaks nothing they can see:
 *
 *   1. `register-all.ts` hands the real `isSessionInOwnCall` to the desktop
 *      notifier. The notifier calls it as an OPTIONAL option (`?.`), so dropping
 *      the line, or passing a stub, silently turns the guard off and every
 *      own-call idle raises a desktop notification for a session that is about
 *      to end. `registerAllIpc` needs a live Electron main process, so this is a
 *      source-parity check on the real file's syntax tree.
 *   2. `buildConfiguredMcpServer` hands the request's caller session to
 *      `registerTaskTools` (the sixth argument) and to `registerWorkflowTools`
 *      (`{ taskId, sessionId }`). A request from a caller with a session must
 *      reach the `move_task` and `pause_workflow` handlers with
 *      `callerSessionId` on the command context, or the handler never learns
 *      which session to wait for and ends it before its turn does. Driven
 *      through the REAL builder and the REAL tool registrations; only the
 *      command handlers are spies.
 *   3. The same builder hands the caller's task to `registerSessionTools`, which
 *      puts it on the context of the two dev port tools (task #952). Their
 *      handlers default to "your own task" from `callerTaskId` alone, so a
 *      request that arrives without it makes every call without a `taskId`
 *      refuse as coming from no task.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';

vi.mock('electron', () => ({
  webContents: { fromId: () => null },
  app: { getPath: () => '/tmp', isPackaged: false },
}));
// The command handlers are the spies; `withProject` and `callHandler` between
// the tool and the handler are the real ones.
const { moveTaskHandler, pauseWorkflowHandler, reserveDevPortsHandler, checkDevPortsHandler } = vi.hoisted(() => ({
  moveTaskHandler: vi.fn(),
  pauseWorkflowHandler: vi.fn(),
  reserveDevPortsHandler: vi.fn(),
  checkDevPortsHandler: vi.fn(),
}));
vi.mock('../../src/main/agent/commands', () => ({
  commandHandlers: {
    move_task: moveTaskHandler,
    pause_workflow: pauseWorkflowHandler,
    reserve_dev_ports: reserveDevPortsHandler,
    check_dev_ports: checkDevPortsHandler,
  },
}));
vi.mock('../../src/main/agent/mcp-project-context', () => ({
  buildCommandContextForProject: vi.fn(() => null),
}));
vi.mock('../../src/main/search/search-core', () => ({ runSearchEverything: vi.fn() }));
vi.mock('../../src/main/diagnostics/process-metrics', () => ({ getProcessMetrics: vi.fn() }));
vi.mock('../../src/main/git/worktree-list', () => ({ enumerateWorktrees: vi.fn() }));
vi.mock('../../src/devtools/mcp/register', () => ({ registerDevtoolsMcpTools: vi.fn() }));
// Browser automation is off in every case here, so the family is never
// registered; the module is stubbed so its CDP import cone is not loaded.
vi.mock('../../src/main/agent/mcp-http/browser-tools', () => ({ registerBrowserTools: vi.fn() }));

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildConfiguredMcpServer } from '../../src/main/agent/mcp-http-server';
import { isSessionInOwnCall, markOwnCallSession } from '../../src/main/ipc/handlers/own-call-turn-wait';
import type { TaskCounter } from '../../src/main/agent/mcp-http/handler-helpers';
import type { BrowserToolDependencies } from '../../src/main/agent/mcp-http/browser-tools';
import type { RequestResolver } from '../../src/main/agent/mcp-http/project-resolver';
import type { CommandContext } from '../../src/main/agent/commands/types';
import type { ResolvedBrowserAutomationConfig } from '../../src/main/browser/browser-automation-config';

describe('register-all.ts hands the real isSessionInOwnCall to the desktop notifier', () => {
  const REGISTER_ALL_PATH = path.resolve(__dirname, '../../src/main/ipc/register-all.ts');
  const OWN_CALL_MODULE = './handlers/own-call-turn-wait';
  const sourceFile = ts.createSourceFile(
    REGISTER_ALL_PATH,
    fs.readFileSync(REGISTER_ALL_PATH, 'utf-8'),
    ts.ScriptTarget.Latest,
    true,
  );

  function collect<T extends ts.Node>(is: (node: ts.Node) => node is T): T[] {
    const found: T[] = [];
    const visit = (node: ts.Node): void => {
      if (is(node)) found.push(node);
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return found;
  }

  /** The local name `isSessionInOwnCall` is imported under, from the own-call module, or null. */
  function localNameOfOwnCallImport(): string | null {
    for (const declaration of collect(ts.isImportDeclaration)) {
      if (!ts.isStringLiteral(declaration.moduleSpecifier) || declaration.moduleSpecifier.text !== OWN_CALL_MODULE) continue;
      const bindings = declaration.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      for (const specifier of bindings.elements) {
        if ((specifier.propertyName ?? specifier.name).text === 'isSessionInOwnCall') return specifier.name.text;
      }
    }
    return null;
  }

  it('imports isSessionInOwnCall from the own-call module', () => {
    expect(localNameOfOwnCallImport()).not.toBeNull();
  });

  it('passes exactly that import as the notifier\'s isSessionInOwnCall option, not a stub', () => {
    const constructions = collect(
      (node): node is ts.NewExpression =>
        ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'DesktopNotifier',
    );
    // Exactly one, so a rename of the class cannot leave this scan empty.
    expect(constructions).toHaveLength(1);

    const options = constructions[0].arguments?.[0];
    expect(options && ts.isObjectLiteralExpression(options)).toBe(true);
    const properties = (options as ts.ObjectLiteralExpression).properties;
    const option = properties.find(
      (property): property is ts.PropertyAssignment | ts.ShorthandPropertyAssignment =>
        (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))
        && property.name.getText(sourceFile) === 'isSessionInOwnCall',
    );
    expect(option, 'the DesktopNotifier options carry no isSessionInOwnCall').toBeDefined();

    const importedAs = localNameOfOwnCallImport();
    const handedOver = ts.isShorthandPropertyAssignment(option!)
      ? option.name.text
      : ts.isIdentifier(option!.initializer) ? option!.initializer.text : null;
    expect(handedOver).toBe(importedAs);
  });

  it('the function it hands over reads the mark an own call sets, and drops it on release', () => {
    const sessionId = 'session-own-call-wiring';
    expect(isSessionInOwnCall(sessionId)).toBe(false);

    const release = markOwnCallSession(sessionId);
    expect(isSessionInOwnCall(sessionId)).toBe(true);

    release();
    expect(isSessionInOwnCall(sessionId)).toBe(false);
  });
});

describe('buildConfiguredMcpServer carries the request\'s caller session to the move and pause tools', () => {
  const CALLER_SESSION_ID = 'session-caller';
  const CALLER_TASK_ID = 'task-caller';
  const handlerContext = { projectId: 'p1' } as unknown as CommandContext;
  const taskCounter: TaskCounter = { tryReserve: () => true, limit: () => 100 };
  const browserAutomationOff = (): ResolvedBrowserAutomationConfig => ({
    enabled: false,
    allowInteraction: false,
    allowNavigation: false,
    allowEval: false,
    restrictNavigationToLocalhost: false,
  });

  /** Resolves every `project` selector to the one default project, with the spy-bearing context. */
  function makeResolver(): RequestResolver {
    return {
      listProjects: () => [
        { id: 'p1', name: 'Alpha', path: '/p1', lastOpened: '2026-01-01T00:00:00.000Z', isActive: true },
      ],
      resolveProject: () => ({ context: handlerContext, projectId: 'p1', projectName: 'Alpha', isDefault: true }),
    } as unknown as RequestResolver;
  }

  /** What `resolveBrowser` builds for a request to `/mcp/p1/<callerSessionId>`. */
  function browserFor(callerSessionId?: string): BrowserToolDependencies {
    return {
      projectId: 'p1',
      callerSessionId,
      sessions: { getSessionTaskId: (sessionId) => (sessionId === CALLER_SESSION_ID ? CALLER_TASK_ID : undefined) },
    };
  }

  const open: Array<{ client: Client; server: McpServer }> = [];

  async function connect(browser: BrowserToolDependencies): Promise<Client> {
    const server = buildConfiguredMcpServer(makeResolver(), taskCounter, browserAutomationOff, undefined, browser);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'own-call-wiring', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    open.push({ client, server });
    return client;
  }

  afterEach(async () => {
    for (const { client, server } of open.splice(0)) {
      await client.close();
      await server.close();
    }
    moveTaskHandler.mockReset();
    pauseWorkflowHandler.mockReset();
    reserveDevPortsHandler.mockReset();
    checkDevPortsHandler.mockReset();
  });

  function lastCall(handler: typeof moveTaskHandler): { params: Record<string, unknown>; context: Record<string, unknown> } {
    const call = handler.mock.calls.at(-1);
    if (!call) throw new Error('the command handler was never reached');
    return { params: call[0], context: call[1] };
  }

  it('reaches move_task with the caller\'s session and task on the context, and neither in the params', async () => {
    moveTaskHandler.mockReturnValue({ success: true, message: 'Moving.' });
    const client = await connect(browserFor(CALLER_SESSION_ID));

    await client.callTool({ name: 'kangentic_move_task', arguments: { taskId: 'task-1', column: 'Done' } });

    expect(moveTaskHandler).toHaveBeenCalledTimes(1);
    const { params, context } = lastCall(moveTaskHandler);
    expect(context).toMatchObject({ callerTaskId: CALLER_TASK_ID, callerSessionId: CALLER_SESSION_ID });
    expect(params).toEqual({ taskId: 'task-1', column: 'Done', position: null, message: null });
  });

  it('reaches pause_workflow with the caller\'s session and task on the context, and neither in the params', async () => {
    pauseWorkflowHandler.mockReturnValue({ success: true, message: 'Paused.' });
    const client = await connect(browserFor(CALLER_SESSION_ID));

    await client.callTool({ name: 'kangentic_pause_workflow', arguments: { workflow: 'Usage budgets' } });

    expect(pauseWorkflowHandler).toHaveBeenCalledTimes(1);
    const { params, context } = lastCall(pauseWorkflowHandler);
    expect(context).toMatchObject({ callerTaskId: CALLER_TASK_ID, callerSessionId: CALLER_SESSION_ID });
    expect(params).toEqual({ workflow: 'Usage budgets' });
  });

  it('names no session on either context for a request with no caller segment', async () => {
    moveTaskHandler.mockReturnValue({ success: true, message: 'Moving.' });
    pauseWorkflowHandler.mockReturnValue({ success: true, message: 'Paused.' });
    const client = await connect(browserFor(undefined));

    await client.callTool({ name: 'kangentic_move_task', arguments: { taskId: 'task-1', column: 'Done' } });
    await client.callTool({ name: 'kangentic_pause_workflow', arguments: { workflow: 'Usage budgets' } });

    // Absent or null both mean "no session"; the shape of the empty value is not the contract.
    for (const handler of [moveTaskHandler, pauseWorkflowHandler]) {
      const { context } = lastCall(handler);
      expect(context.callerTaskId ?? null).toBeNull();
      expect(context.callerSessionId ?? null).toBeNull();
    }
  });

  // Red-green: drop `callerTaskId` from the context a dev port tool builds in
  // session-tools.ts and its test fails; hand `registerSessionTools` no caller
  // in `buildConfiguredMcpServer` and both tools' caller tests fail.
  describe.each([
    { tool: 'kangentic_reserve_dev_ports', handler: reserveDevPortsHandler, ownArguments: { count: 2 } },
    { tool: 'kangentic_check_dev_ports', handler: checkDevPortsHandler, ownArguments: { ports: [4200] } },
  ])('$tool carries the caller\'s task to the handler', ({ tool, handler, ownArguments }) => {
    it('puts the caller\'s task on the context, so a call with no taskId is about its own task', async () => {
      handler.mockReturnValue({ success: true, message: 'ok' });
      const client = await connect(browserFor(CALLER_SESSION_ID));

      await client.callTool({ name: tool, arguments: ownArguments });

      expect(handler).toHaveBeenCalledTimes(1);
      const { params, context } = lastCall(handler);
      expect(context).toMatchObject({ callerTaskId: CALLER_TASK_ID });
      // The caller rides the context, never the params: an unnamed task stays
      // unnamed and the handler falls back to the context.
      expect(params.taskId).toBeUndefined();
    });

    it('keeps the caller on the context when the call names another task', async () => {
      handler.mockReturnValue({ success: true, message: 'ok' });
      const client = await connect(browserFor(CALLER_SESSION_ID));

      await client.callTool({ name: tool, arguments: { taskId: 'task-other', ...ownArguments } });

      const { params, context } = lastCall(handler);
      expect(params.taskId).toBe('task-other');
      expect(context).toMatchObject({ callerTaskId: CALLER_TASK_ID });
    });

    it('names no task on the context for a request with no caller segment', async () => {
      handler.mockReturnValue({ success: true, message: 'ok' });
      const client = await connect(browserFor(undefined));

      await client.callTool({ name: tool, arguments: ownArguments });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(lastCall(handler).context.callerTaskId ?? null).toBeNull();
    });
  });
});
