/**
 * Unit tests for `respondWorkflowAgentLaunch` in src/devtools/main/workflow-agent-launch-route.ts,
 * the dev-only route the demo capture rig reads a workflow agent's launch from
 * (scripts/lib/demo-mcp-capture.mjs, prepareWorkflowAgentCapture).
 *
 * What the rig relies on: the first message is built by main's own builder over the CONFIGURED
 * template (the user's own when there is one, the default otherwise), the MCP URL carries the
 * workflow's own `workflow-` caller segment on the project's URL, and every request the route can
 * name a fault in answers a status and a kind the bridge reports, never a bare 500.
 *
 * The project database and the prompt builder are mocked: the builder's own variables are pinned in
 * workflow-agent-prompt.test.ts, and this file pins only what the route hands it and returns.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import { DEFAULT_WORKFLOW_AGENT_PROMPT } from '../../src/shared/workflow-agent-prompt';

const { getExistingProjectDb, buildWorkflowAgentFirstMessage } = vi.hoisted(() => ({
  getExistingProjectDb: vi.fn((projectId: string) => (projectId === 'proj-1' ? { name: 'proj-1 database' } : null)),
  buildWorkflowAgentFirstMessage: vi.fn((_context: unknown, projectId: string, workflow: { id: string }, template: string) =>
    `first message for ${workflow.id} on ${projectId}, from a ${template.length}-character template`),
}));

vi.mock('../../src/main/db/database', () => ({ getExistingProjectDb }));
vi.mock('../../src/main/db/repositories/workflow-repository', () => ({
  WorkflowRepository: class {
    getById(id: string) {
      return id === 'wf-1' ? { id: 'wf-1', title: 'Invoice PDF export' } : undefined;
    }
  },
}));
vi.mock('../../src/main/workflows/workflow-agent-prompt', () => ({ buildWorkflowAgentFirstMessage }));

// Import under test (after every vi.mock() call).
import { respondWorkflowAgentLaunch } from '../../src/devtools/main/workflow-agent-launch-route';

const PROJECT_URL_BASE = 'http://127.0.0.1:5555/mcp';
const MCP_TOKEN = 'per-launch-token';

interface Answer {
  status: number;
  body?: unknown;
  kind?: string;
  detail?: string;
}

/** The projects the registry holds: proj-1 with its database, and proj-no-db, whose database is gone. */
const REGISTERED_PROJECTS: Record<string, { id: string; name: string; path: string }> = {
  'proj-1': { id: 'proj-1', name: 'contoso-web', path: '/mock/contoso-web' },
  'proj-no-db': { id: 'proj-no-db', name: 'spring-petclinic', path: '/mock/spring-petclinic' },
};

function makeContext(options: { agentPrompt?: string | null; mcpServerOff?: boolean } = {}): IpcContext {
  return {
    projectRepo: { getById: (id: string) => REGISTERED_PROJECTS[id] },
    mcpServerHandle: options.mcpServerOff ? null : { token: MCP_TOKEN, urlForProject: (id: string) => `${PROJECT_URL_BASE}/${id}` },
    configManager: { load: () => ({ workflows: { agentPrompt: options.agentPrompt ?? null } }) },
  } as unknown as IpcContext;
}

function respond(body: unknown, context: IpcContext | null): Answer {
  let answer: Answer | null = null;
  respondWorkflowAgentLaunch(body, context, {
    json: (status, payload) => { answer = { status, body: payload }; },
    error: (status, kind, detail) => { answer = { status, kind, detail }; },
  });
  if (answer === null) throw new Error('the route answered nothing');
  return answer;
}

describe('respondWorkflowAgentLaunch', () => {
  beforeEach(() => {
    buildWorkflowAgentFirstMessage.mockClear();
    getExistingProjectDb.mockClear();
  });

  it('answers the launch: the checkout, the first message, the workflow\'s own MCP URL, and the token', () => {
    const answer = respond({ projectId: 'proj-1', workflowId: 'wf-1' }, makeContext());

    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      cwd: '/mock/contoso-web',
      prompt: `first message for wf-1 on proj-1, from a ${DEFAULT_WORKFLOW_AGENT_PROMPT.length}-character template`,
      mcpServerUrl: `${PROJECT_URL_BASE}/proj-1/workflow-wf-1`,
      mcpServerToken: MCP_TOKEN,
    });
  });

  it('builds the first message from the default template when the user set none', () => {
    respond({ projectId: 'proj-1', workflowId: 'wf-1' }, makeContext({ agentPrompt: null }));

    expect(buildWorkflowAgentFirstMessage).toHaveBeenCalledTimes(1);
    expect(buildWorkflowAgentFirstMessage.mock.calls[0][3]).toBe(DEFAULT_WORKFLOW_AGENT_PROMPT);
  });

  it('builds it from the user\'s own template when they set one, as a new conversation does', () => {
    respond({ projectId: 'proj-1', workflowId: 'wf-1' }, makeContext({ agentPrompt: 'Plan {{projectName}} briefly.' }));

    expect(buildWorkflowAgentFirstMessage.mock.calls[0][3]).toBe('Plan {{projectName}} briefly.');
  });

  it('answers 503 before the app has an IPC context', () => {
    expect(respond({ projectId: 'proj-1', workflowId: 'wf-1' }, null)).toMatchObject({ status: 503, kind: 'no-ipc-context' });
  });

  it.each([
    [{ workflowId: 'wf-1' }, 'projectId'],
    [{ projectId: 'proj-1' }, 'workflowId'],
    [{ projectId: '', workflowId: 'wf-1' }, 'projectId'],
    [null, 'projectId'],
    ['proj-1', 'projectId'],
  ])('answers 400 naming the field when the body is %j', (body, field) => {
    expect(respond(body, makeContext())).toMatchObject({ status: 400, kind: 'missing-field', detail: `Provide "${field}".` });
  });

  it('answers 404 for a workflow the project does not have, and for a registered project with no database', () => {
    expect(respond({ projectId: 'proj-1', workflowId: 'wf-unknown' }, makeContext())).toMatchObject({ status: 404, kind: 'unknown-workflow' });
    expect(respond({ projectId: 'proj-no-db', workflowId: 'wf-1' }, makeContext())).toMatchObject({ status: 404, kind: 'unknown-workflow' });
  });

  it.each(['proj-gone', '../outside-the-projects-folder'])('answers 404 for project %j the registry does not hold, and opens no database for it', (projectId) => {
    // A project id names its database file, so an id from the request body reaches the disk only
    // once the registry has vouched for it.
    expect(respond({ projectId, workflowId: 'wf-1' }, makeContext())).toMatchObject({ status: 404, kind: 'unknown-project' });
    expect(getExistingProjectDb).not.toHaveBeenCalled();
  });

  it('answers 503 and names the setting when the MCP server is off, since the agent could not save a plan', () => {
    const answer = respond({ projectId: 'proj-1', workflowId: 'wf-1' }, makeContext({ mcpServerOff: true }));

    expect(answer).toMatchObject({ status: 503, kind: 'mcp-server-off' });
    expect(answer.detail).toContain('Settings, MCP Server');
    expect(buildWorkflowAgentFirstMessage).not.toHaveBeenCalled();
  });

  it('lets an error it cannot name reach the server, which answers it as its own', () => {
    buildWorkflowAgentFirstMessage.mockImplementationOnce(() => { throw new Error('database is locked'); });

    expect(() => respond({ projectId: 'proj-1', workflowId: 'wf-1' }, makeContext())).toThrow('database is locked');
  });
});
