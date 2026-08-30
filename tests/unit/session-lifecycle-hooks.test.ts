/**
 * The project-store -> session-store lifecycle bridge is actually WIRED.
 *
 * `project-store` used to call `useSessionStore.getState()` directly. That closed
 * an import cycle whose circular-import invalidate full-reloaded the dev page and
 * destroyed live Browser pane guests (see `.claude/rules/hmr-patterns.md`), so the
 * two calls now go through `stores/session-lifecycle-hooks.ts`, which `session-store`
 * fills in at module init.
 *
 * That indirection is the ONE production behavior change in that fix, and it fails
 * SILENTLY: the forwarders use `registeredHooks?.`, so if the registration is ever
 * dropped (a refactor, a re-order, a tree-shake) deleting a project would quietly
 * stop reaping its Command Terminal PTYs and nothing would throw.
 *
 * Every pre-existing test calls the session-store ACTIONS directly, so all of them
 * would still pass with the registration gone. This file is the only thing that
 * exercises the indirection end to end.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/shared/types';
import type { Session } from '../../src/shared/types';

const killedSessionIds: string[] = [];

(globalThis as Record<string, unknown>).window = {
  electronAPI: {
    config: {
      set: vi.fn(),
      get: async () => DEFAULT_CONFIG,
      getGlobal: async () => DEFAULT_CONFIG,
      getProjectOverrides: async () => null,
    },
    projects: { list: async () => [] },
    sessions: {
      list: async () => [],
      spawn: async () => ({}),
      kill: async (sessionId: string) => { killedSessionIds.push(sessionId); },
      reset: async () => {},
      suspend: async () => {},
      resume: async () => ({}),
      killTransient: async (sessionId: string) => { killedSessionIds.push(sessionId); },
    },
  },
};

// Imported AFTER the stub: session-store reads window.electronAPI at module load,
// and importing it is also what performs the registration under test.
const { useSessionStore } = await import('../../src/renderer/stores/session-store');
const hooks = await import('../../src/renderer/stores/session-lifecycle-hooks');

function runningSession(id: string, projectId: string): Session {
  return {
    id,
    taskId: `task-${id}`,
    projectId,
    pid: 1234,
    status: 'running',
    shell: 'bash',
    cwd: '/mock',
    startedAt: new Date().toISOString(),
    exitCode: null,
  } as Session;
}

describe('session lifecycle hooks are registered by session-store', () => {
  beforeEach(() => {
    killedSessionIds.length = 0;
    useSessionStore.setState({ sessions: [], sessionActivity: {}, seenIdleSessions: {} });
  });

  it('markIdleSessionsSeen reaches the store through the hooks module', () => {
    useSessionStore.setState({
      sessions: [runningSession('sess-idle', 'proj-a')],
      sessionActivity: { 'sess-idle': 'idle' },
      seenIdleSessions: {},
    });

    // The forwarder, NOT the store action - this is the path project-store takes.
    hooks.markIdleSessionsSeen('proj-a');

    expect(
      useSessionStore.getState().seenIdleSessions['sess-idle'],
      'the hooks module no-opped, so session-store never registered its handlers',
    ).toBe(true);
  });

  it('killTransientSessionForProject reaches the store through the hooks module', async () => {
    useSessionStore.setState({
      transientSessions: {
        'proj-a::slot-1': { sessionId: 'sess-transient', projectId: 'proj-a', slot: 'slot-1' },
      },
    } as Partial<ReturnType<typeof useSessionStore.getState>>);

    hooks.killTransientSessionForProject('proj-a');
    // The forwarder is fire-and-forget; let its promise settle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      killedSessionIds,
      'the hooks module no-opped, so deleting a project would not reap its PTYs',
    ).toContain('sess-transient');
  });
});
