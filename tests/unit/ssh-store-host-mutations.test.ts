/**
 * ssh-store mutations (#913) and what each one refreshes. Adding a removed host's address again brings its
 * hidden projects back, so addHost reloads projects too. Removing a host or clearing its data can take the
 * open project away, so those reload hosts and projects and THEN settle the open project (settling on a
 * stale list would keep a board whose project is gone). What a user loses if it breaks: a stale sidebar, or
 * a board left open on a hidden project.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: string[] = [];
const loadProjects = vi.fn(async () => { calls.push('loadProjects'); });
const settleOpenProject = vi.fn(async () => { calls.push('settleOpenProject'); });

vi.mock('../../src/renderer/stores/project-store', () => ({
  useProjectStore: { getState: () => ({ loadProjects, settleOpenProject }) },
}));

const ssh = {
  listHosts: vi.fn(async () => { calls.push('listHosts'); return []; }),
  addHost: vi.fn(async () => { calls.push('addHost'); return { host: { id: 'h1' } }; }),
  removeHost: vi.fn(async () => { calls.push('removeHost'); }),
  clearHostData: vi.fn(async () => { calls.push('clearHostData'); }),
  updateHost: vi.fn(async () => { calls.push('updateHost'); return { host: { id: 'h1' } }; }),
};

(globalThis as Record<string, unknown>).window = { electronAPI: { ssh } };

import { useSshStore } from '../../src/renderer/stores/ssh-store';

beforeEach(() => {
  calls.length = 0;
  vi.clearAllMocks();
});

describe('ssh-store host mutations', () => {
  it('addHost reloads hosts and projects after the add, and returns the status', async () => {
    const status = await useSshStore.getState().addHost({ name: 'Lab', destination: 'lab', signIn: { method: 'config' }, expectedFingerprint: 'SHA256:x' });
    expect(status).toEqual({ host: { id: 'h1' } });
    expect(calls[0]).toBe('addHost');
    expect(calls.slice(1).sort()).toEqual(['listHosts', 'loadProjects']);
    expect(settleOpenProject).not.toHaveBeenCalled();
  });

  it.each([['removeHost'], ['clearHostData']] as const)('%s reloads hosts and projects, then settles the open project', async (method) => {
    await useSshStore.getState()[method]('h1');
    expect(calls[0]).toBe(method);
    expect(calls.slice(1, 3).sort()).toEqual(['listHosts', 'loadProjects']);
    expect(calls[3]).toBe('settleOpenProject');
    expect(calls).toHaveLength(4);
  });

  it('updateHost reloads hosts only and returns the status', async () => {
    const status = await useSshStore.getState().updateHost('h1', { name: 'Renamed' });
    expect(status).toEqual({ host: { id: 'h1' } });
    expect(calls).toEqual(['updateHost', 'listHosts']);
    expect(loadProjects).not.toHaveBeenCalled();
    expect(settleOpenProject).not.toHaveBeenCalled();
  });
});
