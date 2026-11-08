/**
 * SessionManager.openHistoryView / closeHistoryView, the find bar's history view from
 * main's side: it asks the host only for a session that is running with a live PTY,
 * reports an unrecognized view (the agent's footer changed) once and only then, and
 * passes the host's answer through. The host and registry are stand-ins; the host's
 * own key logic is pinned in history-view.test.ts and pty-host-core.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HistoryViewOpenResult } from '../../src/shared/types';

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

vi.mock('../../src/main/pty/spawn/shell-resolver', () => {
  class MockShellResolver {
    async getDefaultShell() { return '/bin/bash'; }
  }
  return { ShellResolver: MockShellResolver };
});

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
}));

vi.mock('../../src/main/pty/history-view-report', () => ({
  reportUnrecognizedHistoryView: vi.fn(),
}));

import { SessionManager } from '../../src/main/pty/session-manager';
import { reportUnrecognizedHistoryView } from '../../src/main/pty/history-view-report';

interface StubRow {
  status: string;
  pty: object | null;
  agentName?: string | null;
}

function managerWith(row: StubRow | undefined, hostAnswer: HistoryViewOpenResult = 'opened') {
  const manager = new SessionManager();
  const host = {
    openHistoryView: vi.fn(() => Promise.resolve(hostAnswer)),
    post: vi.fn(),
  };
  Object.assign(manager as unknown as { host: unknown; registry: unknown }, {
    host,
    registry: { get: (sessionId: string) => (sessionId === 'session-1' ? row : undefined) },
  });
  return { manager, host };
}

beforeEach(() => vi.clearAllMocks());

describe('SessionManager.openHistoryView', () => {
  it('answers not-running without asking the host for a session with no registry row', async () => {
    const { manager, host } = managerWith(undefined);
    await expect(manager.openHistoryView('session-1')).resolves.toBe('not-running');
    expect(host.openHistoryView).not.toHaveBeenCalled();
  });

  it('answers not-running without asking the host for a session that is not running', async () => {
    const { manager, host } = managerWith({ status: 'suspended', pty: {} });
    await expect(manager.openHistoryView('session-1')).resolves.toBe('not-running');
    expect(host.openHistoryView).not.toHaveBeenCalled();
  });

  it('answers not-running without asking the host for a running session with no PTY', async () => {
    const { manager, host } = managerWith({ status: 'running', pty: null });
    await expect(manager.openHistoryView('session-1')).resolves.toBe('not-running');
    expect(host.openHistoryView).not.toHaveBeenCalled();
  });

  it.each<HistoryViewOpenResult>(['opened', 'did-not-open', 'not-fullscreen', 'unsupported', 'not-running'])(
    'passes the host\'s %s through and reports nothing',
    async (answer) => {
      const { manager, host } = managerWith({ status: 'running', pty: {}, agentName: 'claude' }, answer);
      await expect(manager.openHistoryView('session-1')).resolves.toBe(answer);
      expect(host.openHistoryView).toHaveBeenCalledWith('session-1');
      expect(reportUnrecognizedHistoryView).not.toHaveBeenCalled();
    },
  );

  it('reports an unrecognized view once, with the agent\'s name, and still passes the answer through', async () => {
    const { manager } = managerWith({ status: 'running', pty: {}, agentName: 'claude' }, 'unrecognized-view');
    await expect(manager.openHistoryView('session-1')).resolves.toBe('unrecognized-view');
    expect(reportUnrecognizedHistoryView).toHaveBeenCalledTimes(1);
    expect(reportUnrecognizedHistoryView).toHaveBeenCalledWith('claude');
  });

  it('reports a null agent name for a session with none', async () => {
    const { manager } = managerWith({ status: 'running', pty: {} }, 'unrecognized-view');
    await manager.openHistoryView('session-1');
    expect(reportUnrecognizedHistoryView).toHaveBeenCalledWith(null);
  });
});

describe('SessionManager.closeHistoryView', () => {
  it('posts the close to the host when the session has a PTY', () => {
    const { manager, host } = managerWith({ status: 'running', pty: {} });
    manager.closeHistoryView('session-1');
    expect(host.post).toHaveBeenCalledWith({ type: 'closeHistoryView', sessionId: 'session-1' });
  });

  it('posts nothing for a session with a null PTY or no row', () => {
    const noPty = managerWith({ status: 'running', pty: null });
    noPty.manager.closeHistoryView('session-1');
    expect(noPty.host.post).not.toHaveBeenCalled();

    const noRow = managerWith(undefined);
    noRow.manager.closeHistoryView('session-1');
    expect(noRow.host.post).not.toHaveBeenCalled();
  });
});
