/**
 * Which ports main asks the pty host to forward (#913), worked out from the dev-port ledger and the
 * project rows. What a user loses if it is wrong: a deleted task's port stays forwarded (an `ssh` left
 * running), a new reservation is never forwarded, or a local project's port is sent to a host.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PortForwardPlan } from '../../src/main/remote/port-forward-plan';
import type { RemoteHostRequest } from '../../src/main/remote/protocol/messages';

interface Rig {
  plan: PortForwardPlan;
  sent: RemoteHostRequest[];
  leases: Array<{ port: number; projectId: string }>;
  projects: Array<{ id: string; remote?: { hostId: string; path: string } | null }>;
  failNext: { value: boolean };
}

function makeRig(): Rig {
  const rig = {
    sent: [] as RemoteHostRequest[],
    leases: [{ port: 7300, projectId: 'remote-1' }, { port: 7301, projectId: 'remote-1' }, { port: 7302, projectId: 'local-1' }],
    projects: [
      { id: 'remote-1', remote: { hostId: 'host-a', path: '/home/dev/app' } },
      { id: 'local-1', remote: null },
    ],
    failNext: { value: false },
    plan: undefined as unknown as PortForwardPlan,
  };
  rig.plan = new PortForwardPlan({
    leases: () => rig.leases,
    projects: () => rig.projects,
    send: async (request) => {
      if (rig.failNext.value) {
        rig.failNext.value = false;
        throw new Error('the pty host is restarting');
      }
      rig.sent.push(request);
      return [];
    },
    debounceMs: 50,
  });
  return rig;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the ports wanted for a host', () => {
  it('are the leases of the projects that run on it, and never a local project\'s', async () => {
    const rig = makeRig();
    await rig.plan.syncNow();
    expect(rig.sent).toEqual([{ op: 'setForwards', hostId: 'host-a', ports: [7300, 7301] }]);
  });

  it('are not sent again while unchanged', async () => {
    const rig = makeRig();
    await rig.plan.syncNow();
    await rig.plan.syncNow();
    expect(rig.sent).toHaveLength(1);
  });

  it('follow a released lease, and a host left with none is told so once', async () => {
    const rig = makeRig();
    await rig.plan.syncNow();
    rig.leases = [{ port: 7300, projectId: 'remote-1' }];
    await rig.plan.syncNow();
    rig.leases = [];
    await rig.plan.syncNow();
    await rig.plan.syncNow();

    expect(rig.sent.map((request) => (request as { ports: number[] }).ports)).toEqual([[7300, 7301], [7300], []]);
  });

  it('are sent again after the process holding the links restarts', async () => {
    const rig = makeRig();
    await rig.plan.syncNow();
    rig.plan.resend();
    await vi.advanceTimersByTimeAsync(100);
    expect(rig.sent).toHaveLength(2);
  });

  it('are tried again after a send that failed', async () => {
    const rig = makeRig();
    rig.failNext.value = true;
    await rig.plan.syncNow();
    expect(rig.sent).toEqual([]);
    await rig.plan.syncNow();
    expect(rig.sent).toHaveLength(1);
  });

  it('are sent once for a burst of changes', async () => {
    const rig = makeRig();
    rig.plan.schedule();
    rig.plan.schedule();
    rig.plan.schedule();
    await vi.advanceTimersByTimeAsync(200);
    expect(rig.sent).toHaveLength(1);
  });
});

describe('asking about a project', () => {
  it('names the host a remote project runs on and nothing for a local one', () => {
    const rig = makeRig();
    expect(rig.plan.hostOfProject('remote-1')).toBe('host-a');
    expect(rig.plan.hostOfProject('local-1')).toBeNull();
    expect(rig.plan.hostOfProject('unknown')).toBeNull();
  });
});
