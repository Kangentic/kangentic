/**
 * Unit tests for derivePanelSessions, the single derivation behind the bottom
 * panel's tab set. Three consumers read it (TerminalPanel: what to render;
 * AppLayout: whether to collapse; useFocusedSessionsSync: which sessions main
 * streams PTY bytes for), so its two halves are what keep them in agreement:
 *
 *   active  - running / current-project / non-transient
 *   owned   - a task-detail window already hosts this terminal, from EITHER
 *             source (this renderer's windows by session id, the detached Agent
 *             Monitor's by task id)
 *   visible - active minus owned: the tabs
 */
import { describe, it, expect } from 'vitest';
import { derivePanelSessions } from '../../src/renderer/utils/panel-sessions';
import type { Session } from '../../src/shared/types';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-default',
    taskId: 'task-default',
    projectId: 'proj-a',
    pid: 1000,
    status: 'running',
    shell: 'bash',
    cwd: '/tmp',
    startedAt: new Date().toISOString(),
    exitCode: null,
    resuming: false,
    transient: false,
    ...overrides,
  };
}

function derive(sessions: Session[], overrides: Partial<{
  currentProjectId: string | null;
  dialogSessionIds: string[];
  remoteDetailTaskIds: string[];
  mobileTerminalStreamedSessionIds: string[];
}> = {}) {
  return derivePanelSessions({
    sessions,
    currentProjectId: 'proj-a',
    dialogSessionIds: [],
    remoteDetailTaskIds: [],
    ...overrides,
  });
}

const ids = (sessions: Session[]): string[] => sessions.map((session) => session.id);

describe('derivePanelSessions', () => {
  // ── the `active` pool ──
  describe('active', () => {
    it('keeps running, non-transient sessions for the current project', () => {
      const result = derive([
        makeSession({ id: 'sess-a', taskId: 'task-a' }),
        makeSession({ id: 'sess-b', taskId: 'task-b' }),
      ]);
      expect(ids(result.active)).toEqual(['sess-a', 'sess-b']);
      expect(ids(result.visible)).toEqual(['sess-a', 'sess-b']);
    });

    it('drops sessions that are not running', () => {
      const result = derive([
        makeSession({ id: 'sess-running' }),
        makeSession({ id: 'sess-exited', status: 'exited' }),
        makeSession({ id: 'sess-suspended', status: 'suspended' }),
        makeSession({ id: 'sess-queued', status: 'queued' }),
      ]);
      expect(ids(result.active)).toEqual(['sess-running']);
    });

    it('drops sessions belonging to another project', () => {
      const result = derive([
        makeSession({ id: 'sess-a' }),
        makeSession({ id: 'sess-other', projectId: 'proj-b' }),
      ]);
      expect(ids(result.active)).toEqual(['sess-a']);
    });

    it('drops transient (Command Terminal) sessions - they never get a panel tab', () => {
      const result = derive([
        makeSession({ id: 'sess-a' }),
        makeSession({ id: 'sess-transient', transient: true }),
      ]);
      expect(ids(result.active)).toEqual(['sess-a']);
    });

    it('is empty when no project is open', () => {
      const result = derive([makeSession({ id: 'sess-a' })], { currentProjectId: null });
      expect(result.active).toEqual([]);
      expect(result.visible).toEqual([]);
    });
  });

  // ── the `owned` set: a detail window hosts the terminal ──
  describe('owned', () => {
    it('takes a window in THIS renderer by session id', () => {
      const result = derive(
        [makeSession({ id: 'sess-a', taskId: 'task-a' }), makeSession({ id: 'sess-b', taskId: 'task-b' })],
        { dialogSessionIds: ['sess-a'] },
      );
      expect(result.owned.has('sess-a')).toBe(true);
      expect(ids(result.visible)).toEqual(['sess-b']);
    });

    it('resolves a detached-monitor owner from its TASK id to the session id', () => {
      // Main can only name a remote owner by task id: session ids are resolved per
      // renderer from its own session list. Getting this mapping wrong is what
      // leaves a tab whose pane renders nothing.
      const result = derive(
        [makeSession({ id: 'sess-a', taskId: 'task-a' }), makeSession({ id: 'sess-b', taskId: 'task-b' })],
        { remoteDetailTaskIds: ['task-b'] },
      );
      expect(result.owned.has('sess-b')).toBe(true);
      expect(ids(result.visible)).toEqual(['sess-a']);
    });

    it('unions both sources', () => {
      const result = derive(
        [
          makeSession({ id: 'sess-a', taskId: 'task-a' }),
          makeSession({ id: 'sess-b', taskId: 'task-b' }),
          makeSession({ id: 'sess-c', taskId: 'task-c' }),
        ],
        { dialogSessionIds: ['sess-a'], remoteDetailTaskIds: ['task-c'] },
      );
      expect([...result.owned].sort()).toEqual(['sess-a', 'sess-c']);
      expect(ids(result.visible)).toEqual(['sess-b']);
    });

    it('ignores a remote task id that matches no session here', () => {
      const result = derive([makeSession({ id: 'sess-a', taskId: 'task-a' })], {
        remoteDetailTaskIds: ['task-nowhere'],
      });
      expect(result.owned.size).toBe(0);
      expect(ids(result.visible)).toEqual(['sess-a']);
    });

    it('resolves remote owners across projects, so a background project cannot double-mount', () => {
      // `owned` is derived from ALL sessions, not just the current project's: the
      // detached monitor hosts details for any project, and the guard that matters
      // is "no second xterm on this PTY", which is project-blind.
      const result = derive(
        [makeSession({ id: 'sess-a', taskId: 'task-a' }), makeSession({ id: 'sess-far', taskId: 'task-far', projectId: 'proj-b' })],
        { remoteDetailTaskIds: ['task-far'] },
      );
      expect(result.owned.has('sess-far')).toBe(true);
      expect(ids(result.visible)).toEqual(['sess-a']);
    });

    it('drops the tab of a phone-streamed session - its terminal lives on the phone', () => {
      // The resting park owns the PTY grid while a phone streams it; a panel
      // tab would either fit the strip out from under the phone or render a
      // frame laid out for a grid it does not have. Same no-tab treatment as
      // a detail window, and the tab returns when the phone lets go (user
      // decision 2026-08-02: no placeholder - the user is on their phone).
      const result = derive(
        [makeSession({ id: 'sess-a', taskId: 'task-a' }), makeSession({ id: 'sess-b', taskId: 'task-b' })],
        { mobileTerminalStreamedSessionIds: ['sess-b'] },
      );
      expect(result.owned.has('sess-b')).toBe(true);
      expect(ids(result.visible)).toEqual(['sess-a']);
    });

    it('unions phone-streamed sessions with both detail-window sources', () => {
      const result = derive(
        [
          makeSession({ id: 'sess-a', taskId: 'task-a' }),
          makeSession({ id: 'sess-b', taskId: 'task-b' }),
          makeSession({ id: 'sess-c', taskId: 'task-c' }),
        ],
        { dialogSessionIds: ['sess-a'], mobileTerminalStreamedSessionIds: ['sess-c'] },
      );
      expect([...result.owned].sort()).toEqual(['sess-a', 'sess-c']);
      expect(ids(result.visible)).toEqual(['sess-b']);
    });
  });

  // ── the state the collapse rule keys off ──
  describe('every tab detached', () => {
    it('leaves active populated and visible empty', () => {
      // This is the shape shouldForceCollapseTerminal reads: sessions exist, none
      // has a tab, so the panel collapses rather than showing an empty body.
      const result = derive([makeSession({ id: 'sess-a', taskId: 'task-a' })], {
        dialogSessionIds: ['sess-a'],
      });
      expect(ids(result.active)).toEqual(['sess-a']);
      expect(result.visible).toEqual([]);
    });

    it('is distinguishable from having no sessions at all', () => {
      const none = derive([]);
      expect(none.active).toEqual([]);
      expect(none.visible).toEqual([]);
    });
  });
});
