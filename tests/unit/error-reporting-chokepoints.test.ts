/**
 * Each dispatcher chokepoint reaches Sentry through its own latched reporter
 * (`handled-report.ts`). The MCP tool proxy and the phone's capability router run
 * for real here: a defect reports once and a refusal does not. Every other
 * chokepoint is driven the same way in its own file:
 * error-reporting-mcp-browser-behavior.test.ts (the MCP command, request and
 * dispatch catches, the three server builders, the browser driver),
 * error-reporting-turn-end-workflow-behavior.test.ts, pr-report-behavior.test.ts
 * and automation-runner-report-behavior.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const reportHandledError = vi.fn();
vi.mock('../../src/main/analytics/error-reporting', () => ({ reportHandledError }));

const { withToolReporting, mcpToolReporter } = await import('../../src/main/agent/mcp-http/tool-reporting');
const { CapabilityRouter, mobileVerbReporter } = await import('../../src/main/mobile-bridge/capability-router');
const { RefusalError } = await import('../../src/shared/refusal');

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
