/**
 * board-tool-read/board-tool-write route straight into the real
 * commandHandlers registry (see board-tool-allowlist.ts's doc comment for
 * why - this is NOT the MCP protocol, no agent/LLM/JSON-RPC round-trip is
 * involved), gated by the allowlist and read/mutate classification tested
 * separately in board-tool-allowlist.test.ts. These tests cover the
 * handler's own responsibilities: refusing an excluded/unknown tool before
 * ever calling a handler, refusing a verb/access mismatch (board-tool-read
 * reaching a mutating tool or vice versa), resolving the project, and
 * mapping a CommandResponse into a capability response.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const searchTasksHandler = vi.fn();
const updateTaskHandler = vi.fn();
const queryDbHandler = vi.fn();
const moveTaskHandler = vi.fn();

vi.mock('../../../src/main/agent/commands', () => ({
  commandHandlers: {
    search_tasks: (...args: unknown[]) => searchTasksHandler(...args),
    update_task: (...args: unknown[]) => updateTaskHandler(...args),
    query_db: (...args: unknown[]) => queryDbHandler(...args),
    // Present in commandHandlers but deliberately excluded from the mobile
    // surface - covered by the dedicated move-task verb instead.
    move_task: (...args: unknown[]) => moveTaskHandler(...args),
  },
}));

const buildCommandContextForProjectMock = vi.fn();
vi.mock('../../../src/main/agent/mcp-project-context', () => ({
  buildCommandContextForProject: (...args: unknown[]) => buildCommandContextForProjectMock(...args),
}));

import type { CapabilityRequestMessage } from '@kangentic/protocol';
import { handleBoardTool } from '../../../src/main/mobile-bridge/handlers/board-tool';
import type { IpcContext } from '../../../src/main/ipc/ipc-context';

function fakeRequest(verb: 'board-tool-read' | 'board-tool-write', payload: Record<string, unknown>): CapabilityRequestMessage {
  return { type: 'capability-request', requestId: 'req-1', verb, payload };
}

function fakeContext(currentProjectId: string | null = 'proj-1'): IpcContext {
  return { currentProjectId } as unknown as IpcContext;
}

describe('handleBoardTool', () => {
  beforeEach(() => {
    searchTasksHandler.mockReset();
    updateTaskHandler.mockReset();
    queryDbHandler.mockReset();
    moveTaskHandler.mockReset();
    buildCommandContextForProjectMock.mockReset();
    buildCommandContextForProjectMock.mockReturnValue({ getProjectPath: () => '/projects/proj-1' });
  });

  it('rejects query_db outright, before ever building a project context', async () => {
    const response = await handleBoardTool(fakeRequest('board-tool-read', { tool: 'query_db', params: {} }), fakeContext());
    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/not allowed/i);
    expect(queryDbHandler).not.toHaveBeenCalled();
    expect(buildCommandContextForProjectMock).not.toHaveBeenCalled();
  });

  it('rejects move_task even though it is a real commandHandlers entry - covered by the dedicated move-task verb instead', async () => {
    const readResponse = await handleBoardTool(fakeRequest('board-tool-read', { tool: 'move_task', params: {} }), fakeContext());
    const writeResponse = await handleBoardTool(fakeRequest('board-tool-write', { tool: 'move_task', params: {} }), fakeContext());
    expect(readResponse.ok).toBe(false);
    expect(writeResponse.ok).toBe(false);
    expect(moveTaskHandler).not.toHaveBeenCalled();
  });

  it('rejects an unrecognized tool name (not in commandHandlers)', async () => {
    const response = await handleBoardTool(fakeRequest('board-tool-read', { tool: 'browser_eval', params: {} }), fakeContext());
    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/not allowed/i);
  });

  it('rejects a mutating tool reached via board-tool-read', async () => {
    const response = await handleBoardTool(fakeRequest('board-tool-read', { tool: 'update_task', params: {} }), fakeContext());
    expect(response.ok).toBe(false);
    expect(updateTaskHandler).not.toHaveBeenCalled();
  });

  it('rejects a read-only tool reached via board-tool-write', async () => {
    const response = await handleBoardTool(fakeRequest('board-tool-write', { tool: 'search_tasks', params: {} }), fakeContext());
    expect(response.ok).toBe(false);
    expect(searchTasksHandler).not.toHaveBeenCalled();
  });

  it('resolves the ambient current project when params.project is omitted', async () => {
    searchTasksHandler.mockReturnValue({ success: true, data: { tasks: [] } });
    const response = await handleBoardTool(fakeRequest('board-tool-read', { tool: 'search_tasks', params: {} }), fakeContext('proj-1'));

    expect(response.ok).toBe(true);
    expect(buildCommandContextForProjectMock).toHaveBeenCalledWith(expect.anything(), 'proj-1');
  });

  it('prefers an explicit params.project over the ambient current project', async () => {
    searchTasksHandler.mockReturnValue({ success: true, data: { tasks: [] } });
    await handleBoardTool(fakeRequest('board-tool-read', { tool: 'search_tasks', params: { project: 'proj-other' } }), fakeContext('proj-1'));

    expect(buildCommandContextForProjectMock).toHaveBeenCalledWith(expect.anything(), 'proj-other');
  });

  it('rejects when no project can be resolved at all', async () => {
    const response = await handleBoardTool(fakeRequest('board-tool-read', { tool: 'search_tasks', params: {} }), fakeContext(null));
    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/no project/i);
  });

  it('rejects when the resolved project is unknown', async () => {
    buildCommandContextForProjectMock.mockReturnValue(null);
    const response = await handleBoardTool(fakeRequest('board-tool-read', { tool: 'search_tasks', params: {} }), fakeContext('ghost'));
    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/no such project/i);
  });

  it('maps a successful CommandResponse.data into the board-tool result payload', async () => {
    searchTasksHandler.mockReturnValue({ success: true, data: { tasks: [{ id: 't-1' }] } });
    const response = await handleBoardTool(fakeRequest('board-tool-read', { tool: 'search_tasks', params: {} }), fakeContext('proj-1'));

    expect(response.ok).toBe(true);
    expect(response.payload).toEqual({ result: { tasks: [{ id: 't-1' }] } });
  });

  it('maps a failed CommandResponse into a capability-response error', async () => {
    updateTaskHandler.mockReturnValue({ success: false, error: 'task not found' });
    const response = await handleBoardTool(fakeRequest('board-tool-write', { tool: 'update_task', params: {} }), fakeContext('proj-1'));

    expect(response.ok).toBe(false);
    expect(response.error).toBe('task not found');
  });

  it('rejects a non-object params field', async () => {
    const response = await handleBoardTool(fakeRequest('board-tool-read', { tool: 'search_tasks', params: 'nope' }), fakeContext('proj-1'));
    expect(response.ok).toBe(false);
  });
});
