/**
 * The MCP connection check an agent session's start runs (`McpConnectionWatch`):
 * at a session's first output, once per place (this machine, or a distro)
 * until it answers, and a single notice per app run at the first failure.
 */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { McpConnectionWatch } from '../../src/main/ipc/helpers/mcp-connection-watch';
import type { McpConnectionCheck, StoredCliTarget } from '../../src/shared/types';

interface FakeSession {
  agentName?: string;
  projectId: string;
  cliTarget?: StoredCliTarget | null;
}

function harness(answer: (projectId: string, distros: readonly string[]) => McpConnectionCheck, enabled = true) {
  const emitter = new EventEmitter();
  const sessions = new Map<string, FakeSession>();
  const check = vi.fn(async (projectId: string, distros: readonly string[]) => answer(projectId, distros));
  const notify = vi.fn();
  const watch = new McpConnectionWatch({
    sessions: {
      on: (event, listener) => emitter.on(event, listener),
      off: (event, listener) => emitter.off(event, listener),
      getSessionAgentName: (sessionId) => sessions.get(sessionId)?.agentName,
      getSessionCliTarget: (sessionId) => sessions.get(sessionId)?.cliTarget ?? null,
      getSession: (sessionId) => sessions.get(sessionId),
    },
    isEnabled: () => enabled,
    check,
    notify,
  });
  watch.start();
  const start = async (sessionId: string, session: FakeSession): Promise<void> => {
    sessions.set(sessionId, session);
    emitter.emit('first-output', sessionId);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { watch, check, notify, start };
}

const UBUNTU: StoredCliTarget = { kind: 'wsl', distro: 'Ubuntu' };

describe('McpConnectionWatch', () => {
  it('checks the session\'s project and distro at its first output, each place until it answers once', async () => {
    const { check, notify, start } = harness(() => ({ connected: true }));

    await start('local-1', { agentName: 'claude', projectId: 'project-1' });
    await start('local-2', { agentName: 'codex', projectId: 'project-1' });
    await start('wsl-1', { agentName: 'claude', projectId: 'project-2', cliTarget: UBUNTU });

    expect(check.mock.calls).toEqual([['project-1', []], ['project-2', ['Ubuntu']]]);
    expect(notify).not.toHaveBeenCalled();
  });

  // Red-green: notifying on every failed check raises a toast per session.
  it('tells the renderer once per run, with the error the check hit, and checks nothing after', async () => {
    const { check, notify, start } = harness(() => ({ connected: false, error: 'fetch failed: connect ECONNREFUSED 127.0.0.1:4100' }));

    await start('first', { agentName: 'claude', projectId: 'project-1' });
    await start('second', { agentName: 'claude', projectId: 'project-1', cliTarget: UBUNTU });

    expect(notify.mock.calls).toEqual([['fetch failed: connect ECONNREFUSED 127.0.0.1:4100']]);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('checks no raw shell, and nothing while the server is off', async () => {
    const off = harness(() => ({ connected: true }), false);
    await off.start('agent', { agentName: 'claude', projectId: 'project-1' });
    expect(off.check).not.toHaveBeenCalled();

    const shell = harness(() => ({ connected: true }));
    await shell.start('raw', { projectId: 'project-1' });
    expect(shell.check).not.toHaveBeenCalled();
  });

  it('stops listening once disposed', async () => {
    const { watch, check, start } = harness(() => ({ connected: true }));
    watch.dispose();
    await start('late', { agentName: 'claude', projectId: 'project-1' });
    expect(check).not.toHaveBeenCalled();
  });
});
