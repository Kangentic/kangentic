/**
 * Unit tests for src/main/workflows/workflow-changed.ts: the coalesced push that
 * tells an open Workflows view a workflow changed, and the main-side listeners
 * (the Agent Monitor's push) that hear the same changes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IPC } from '../../src/shared/ipc-channels';

const { mockSendToRenderer } = vi.hoisted(() => ({ mockSendToRenderer: vi.fn() }));
vi.mock('../../src/main/ipc/send-to-renderer', () => ({ sendToRenderer: mockSendToRenderer }));

import { notifyWorkflowChanged, onWorkflowChanged, setWorkflowChangedWindow } from '../../src/main/workflows/workflow-changed';

const COALESCE_MS = 30;
const fakeWindow = {} as Parameters<NonNullable<Parameters<typeof setWorkflowChangedWindow>[0]>>[0];

describe('workflow-changed', () => {
  const releases: Array<() => void> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    mockSendToRenderer.mockClear();
    setWorkflowChangedWindow(null);
  });

  afterEach(() => {
    for (const release of releases.splice(0)) release();
    setWorkflowChangedWindow(null);
    vi.useRealTimers();
  });

  it('tells a main listener once per coalesced burst, with no window registered', async () => {
    const listener = vi.fn();
    releases.push(onWorkflowChanged(listener));

    notifyWorkflowChanged('project-home', 'workflow-1');
    notifyWorkflowChanged('project-home', 'workflow-1');
    notifyWorkflowChanged('project-home', 'workflow-2');
    await vi.advanceTimersByTimeAsync(COALESCE_MS + 5);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(mockSendToRenderer).not.toHaveBeenCalled();
  });

  it('still pushes each workflow to the view when a main listener throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    releases.push(onWorkflowChanged(() => { throw new Error('[test] listener failure'); }));
    setWorkflowChangedWindow(() => fakeWindow);

    notifyWorkflowChanged('project-home', 'workflow-1');
    notifyWorkflowChanged('project-home', 'workflow-2');
    await vi.advanceTimersByTimeAsync(COALESCE_MS + 5);

    expect(mockSendToRenderer.mock.calls.map((call) => [call[1], call[2]])).toEqual([
      [IPC.WORKFLOW_CHANGED, { projectId: 'project-home', workflowId: 'workflow-1' }],
      [IPC.WORKFLOW_CHANGED, { projectId: 'project-home', workflowId: 'workflow-2' }],
    ]);
  });

  it('stops telling a listener once it unsubscribes', async () => {
    const listener = vi.fn();
    const release = onWorkflowChanged(listener);
    release();

    notifyWorkflowChanged('project-home', 'workflow-1');
    await vi.advanceTimersByTimeAsync(COALESCE_MS + 5);

    expect(listener).not.toHaveBeenCalled();
  });
});
