import { describe, it, expect, vi, beforeEach } from 'vitest';

const tasksList = vi.fn();
const swimlanesList = vi.fn();
const backlogList = vi.fn();

vi.mock('../../../src/main/ipc/helpers/project-repos', () => ({
  getProjectRepos: vi.fn(() => ({ tasks: { list: tasksList }, swimlanes: { list: swimlanesList } })),
}));
vi.mock('../../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => ({})),
}));
vi.mock('../../../src/main/db/repositories/backlog-repository', () => ({
  BacklogRepository: class {
    list(): unknown {
      return backlogList();
    }
  },
}));

import type { CapabilityRequestMessage } from '@kangentic/protocol';
import { handleReadBoard } from '../../../src/main/mobile-bridge/handlers/read-board';
import type { IpcContext } from '../../../src/main/ipc/ipc-context';
import type { BridgeSession } from '../../../src/main/mobile-bridge/session/bridge-session';
import { SubscriptionRegistry } from '../../../src/main/mobile-bridge/session/subscription-registry';

function fakeRequest(payload: Record<string, unknown>): CapabilityRequestMessage {
  return { type: 'capability-request', requestId: 'req-1', verb: 'read-board', payload };
}

function fakeSession(): BridgeSession {
  return { deviceId: 'device-1', isEstablished: true, sendMessage: vi.fn() } as unknown as BridgeSession;
}

describe('handleReadBoard', () => {
  beforeEach(() => {
    tasksList.mockReset().mockReturnValue([{ id: 't-1' }]);
    swimlanesList.mockReset().mockReturnValue([{ id: 'lane-1' }]);
    backlogList.mockReset().mockReturnValue([{ id: 'b-1' }]);
  });

  it('with no projectId, returns the project bootstrap list and never touches repos', async () => {
    const projectRepoList = vi.fn(() => [{ id: 'proj-1', name: 'Alpha' }]);
    const context = { projectRepo: { list: projectRepoList, getById: vi.fn() } } as unknown as IpcContext;
    const subscriptions = new SubscriptionRegistry();

    const response = await handleReadBoard(fakeRequest({}), fakeSession(), context, subscriptions);

    expect(response.ok).toBe(true);
    expect(response.payload).toEqual({ projects: [{ id: 'proj-1', name: 'Alpha' }] });
    expect(tasksList).not.toHaveBeenCalled();
  });

  it('rejects an unsubscribe with no projectId as a no-op success (nothing to tear down)', async () => {
    // action alone with no projectId falls through to the project-list branch
    // since there is no per-project subscription to identify.
    const context = { projectRepo: { list: vi.fn(() => []), getById: vi.fn() } } as unknown as IpcContext;
    const response = await handleReadBoard(fakeRequest({ action: 'unsubscribe' }), fakeSession(), context, new SubscriptionRegistry());
    expect(response.ok).toBe(true);
  });

  it('rejects an unknown project id', async () => {
    const context = { projectRepo: { getById: vi.fn(() => undefined) } } as unknown as IpcContext;
    const response = await handleReadBoard(fakeRequest({ projectId: 'ghost' }), fakeSession(), context, new SubscriptionRegistry());
    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/no such project/i);
  });

  it('returns a full board snapshot and subscribes to board-changed events filtered by projectId', async () => {
    let capturedListener: ((event: unknown) => void) | undefined;
    const onBoardChanged = vi.fn((listener: (event: unknown) => void) => {
      capturedListener = listener;
      return vi.fn();
    });
    const context = {
      projectRepo: { getById: vi.fn(() => ({ id: 'proj-1', name: 'Alpha' })) },
      boardEvents: { onBoardChanged },
    } as unknown as IpcContext;
    const subscriptions = new SubscriptionRegistry();
    const session = fakeSession();

    const response = await handleReadBoard(fakeRequest({ projectId: 'proj-1' }), session, context, subscriptions);

    expect(response.ok).toBe(true);
    expect(response.payload).toEqual({
      projectId: 'proj-1',
      columns: [{ id: 'lane-1' }],
      tasks: [{ id: 't-1' }],
      backlog: [{ id: 'b-1' }],
    });
    expect(subscriptions.has('board:proj-1')).toBe(true);

    // A board-changed event for a DIFFERENT project must not push.
    capturedListener?.({ projectId: 'proj-OTHER', change: 'task-updated', ids: ['x'] });
    expect(session.sendMessage).not.toHaveBeenCalled();

    // The same project's event pushes a BoardEvent.
    capturedListener?.({ projectId: 'proj-1', change: 'task-updated', ids: ['t-9'] });
    expect(session.sendMessage).toHaveBeenCalledWith({
      type: 'event',
      event: { kind: 'board', projectId: 'proj-1', taskId: 't-9', payload: { change: 'task-updated', ids: ['t-9'] } },
    });
  });

  it('unsubscribe tears down the board subscription', async () => {
    const unsubscribe = vi.fn();
    const context = {
      projectRepo: { getById: vi.fn(() => ({ id: 'proj-1', name: 'Alpha' })) },
      boardEvents: { onBoardChanged: vi.fn(() => unsubscribe) },
    } as unknown as IpcContext;
    const subscriptions = new SubscriptionRegistry();
    const session = fakeSession();

    await handleReadBoard(fakeRequest({ projectId: 'proj-1' }), session, context, subscriptions);
    expect(subscriptions.has('board:proj-1')).toBe(true);

    const response = await handleReadBoard(fakeRequest({ projectId: 'proj-1', action: 'unsubscribe' }), session, context, subscriptions);
    expect(response.ok).toBe(true);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscriptions.has('board:proj-1')).toBe(false);
  });
});
