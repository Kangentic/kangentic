/**
 * Each dispatcher chokepoint reaches Sentry through its own latched reporter
 * (`handled-report.ts`). The MCP tool proxy and the phone's capability router run
 * for real here: a defect reports once and a refusal does not. The rest are pinned
 * statically: the catch that used to only log must still call its reporter, so a
 * refactor that drops the call fails here rather than going quiet in production.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const reportHandledError = vi.fn();
vi.mock('../../src/main/analytics/error-reporting', () => ({ reportHandledError }));

const { withToolReporting, mcpToolReporter } = await import('../../src/main/agent/mcp-http/tool-reporting');
const { CapabilityRouter, mobileVerbReporter } = await import('../../src/main/mobile-bridge/capability-router');
const { RefusalError } = await import('../../src/shared/refusal');

const repoRoot = path.join(__dirname, '../..');
function source(relative: string): string {
  return fs.readFileSync(path.join(repoRoot, relative), 'utf8');
}

describe('the MCP registerTool proxy', () => {
  beforeEach(() => {
    reportHandledError.mockReset();
    mcpToolReporter.reset();
  });

  function fakeServer(): { registerTool: (name: string, config: unknown, callback: (...args: unknown[]) => unknown) => void; callbacks: Map<string, (...args: unknown[]) => unknown> } {
    const callbacks = new Map<string, (...args: unknown[]) => unknown>();
    return { registerTool: (name, _config, callback) => { callbacks.set(name, callback); }, callbacks };
  }

  it('reports a defect from a tool, tagged with the tool, and rethrows for the SDK', async () => {
    const server = fakeServer();
    withToolReporting(server as never).registerTool('kangentic_move_task', {} as never, (() => { throw new TypeError('x is undefined'); }) as never);
    await expect(server.callbacks.get('kangentic_move_task')?.({ taskId: 't' }, {})).rejects.toThrow('x is undefined');
    expect(reportHandledError).toHaveBeenCalledTimes(1);
    expect(reportHandledError.mock.calls[0][1]).toMatchObject({ source: 'mcp_tool', tool: 'kangentic_move_task' });
  });

  it('skips a refusal and a workflow refusal, and passes a result through', async () => {
    const server = fakeServer();
    const proxied = withToolReporting(server as never);
    const workflowRefusal = Object.assign(new Error('Remove #12 from Ship it first.'), { name: 'WorkflowRequestError' });
    proxied.registerTool('kangentic_a', {} as never, (() => { throw new RefusalError('No project is currently open'); }) as never);
    proxied.registerTool('kangentic_b', {} as never, (() => { throw workflowRefusal; }) as never);
    proxied.registerTool('kangentic_c', {} as never, (async () => ({ content: [] })) as never);
    await expect(server.callbacks.get('kangentic_a')?.({}, {})).rejects.toBeInstanceOf(RefusalError);
    await expect(server.callbacks.get('kangentic_b')?.({}, {})).rejects.toBe(workflowRefusal);
    await expect(server.callbacks.get('kangentic_c')?.({}, {})).resolves.toEqual({ content: [] });
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('wraps all three server builders', () => {
    const serverSource = source('src/main/agent/mcp-http-server.ts');
    expect(serverSource).toContain('const mcpServer = withToolReporting(createdServer);');
    expect(serverSource).toContain('registerSearchTools(withToolReporting(mcpServer), resolver, callerSessionId);');
    expect(serverSource).toContain('scopeServerToWorkflowAgent(withToolReporting(mcpServer), workflowId)');
  });
});

describe('the phone capability router', () => {
  beforeEach(() => {
    reportHandledError.mockReset();
    mobileVerbReporter.reset();
  });

  const session = { capabilities: new Set(['read-board', 'pause-session']) };

  it('reports a verb handler defect, tagged with the verb, and answers the phone', async () => {
    const router = new CapabilityRouter();
    router.register('read-board' as never, () => { throw new RangeError('Invalid array length'); });
    const response = await router.dispatch({ type: 'capability-request', requestId: 'r1', verb: 'read-board' } as never, session as never);
    expect(response).toMatchObject({ ok: false, error: 'Invalid array length' });
    expect(reportHandledError).toHaveBeenCalledTimes(1);
    expect(reportHandledError.mock.calls[0][1]).toMatchObject({ source: 'mobile_verb', verb: 'read-board' });
  });

  it('does not report a refusal', async () => {
    const router = new CapabilityRouter();
    router.register('pause-session' as never, () => { throw new RefusalError('The session is not live'); });
    await router.dispatch({ type: 'capability-request', requestId: 'r2', verb: 'pause-session' } as never, session as never);
    expect(reportHandledError).not.toHaveBeenCalled();
  });
});

describe('each remaining chokepoint calls its reporter in the catch that used to only log', () => {
  it.each([
    ['src/main/agent/mcp-http/handler-helpers.ts', "mcpCommandReporter.report(error, { tags: { command: String(handlerName) } });"],
    ['src/main/agent/mcp-http-server.ts', "mcpRequestReporter.report(error, { tags: { stage: 'request' } });"],
    ['src/main/agent/mcp-http-server.ts', "mcpRequestReporter.report(error, { tags: { stage: 'dispatch' } });"],
    ['src/main/automations/automation-runner.ts', 'automationRunReporter.report(lastError, { tags: { automation_type: automation.type } });'],
    ['src/main/automations/turn-end/turn-end-runner.ts', 'turnEndReporter.report(error, { tags: { stage: kind } });'],
    ['src/main/automations/turn-end/turn-end-runner.ts', "turnEndReporter.report(error, { tags: { stage: 'reclaim' } });"],
    ['src/main/workflows/workflow-engine-host.ts', "workflowEngineReporter.report(error, { tags: { stage: 'evaluate' } });"],
    ['src/main/workflows/workflow-engine-host.ts', "workflowEngineReporter.report(error, { tags: { stage: 'start' } });"],
    ['src/main/workflows/workflow-engine-host.ts', "workflowEngineReporter.report(error, { tags: { stage: 'drop_links' } });"],
    ['src/main/workflows/workflow-engine-host.ts', "workflowEngineReporter.report(error, { tags: { stage: 'end_agent' } });"],
    ['src/main/workflows/workflow-engine-host.ts', "workflowEngineReporter.report(error, { tags: { stage: 'complete' } });"],
    ['src/main/pr/pr-linking.ts', "prReporter.report(error, { tags: { stage: 'resolve' } });"],
    ['src/main/pr/pr-refresh-scheduler.ts', "prReporter.report(error, { tags: { stage: 'tick' } });"],
    ['src/main/pr/pr-refresh-scheduler.ts', "prReporter.report(error, { tags: { stage: 'check' } });"],
    ['src/main/pr/pr-refresh-scheduler.ts', "prReporter.report(error, { tags: { stage: 'sweep' } });"],
    ['src/main/browser/browser-pane-driver.ts', "browserDriverReporter.report(error, { tags: { capability: options.capability, kind: 'driver-error' } });"],
    ['src/main/browser/browser-pane-driver.ts', "browserDriverReporter.report(error, { tags: { capability: options.capability, kind: 'acquire-error' } });"],
    ['src/main/browser/browser-pane-driver.ts', "browserDriverReporter.report(cdpAttachFailure(), { tags: { capability: options.capability, kind: 'cdp-attach-failed' } });"],
  ])('%s: %s', (file, call) => {
    expect(source(file)).toContain(call);
  });
});
