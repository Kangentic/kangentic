/**
 * Unit tests for `selectCommandTerminalSummary`, the per-project Command Terminal
 * count + activity tone that drives BOTH the title-bar glyph and the project
 * sidebar's per-row indicator.
 *
 * Two contracts matter here:
 *
 * 1. It reads the SESSIONS list, not the `transientSessions` map. That map is
 *    renderer-owned window pairing whose hard-reload recovery only re-pairs the
 *    current project, so a map-based count reads zero for every background project
 *    after a reload. `session:list` is unscoped and main stamps `projectId` +
 *    `transient` on every row, so this selector stays correct cross-project.
 * 2. Tone precedence is WORKING-wins, bucketed only through the shared
 *    idle-vs-active classifiers, so a `permission`-blocked terminal counts as
 *    needing the user rather than as working.
 */

import { describe, it, expect } from 'vitest';
import { selectCommandTerminalSummary } from '../../src/renderer/stores/session-store/transient-session-slice';
import type { ActivityState, Session } from '../../src/shared/types';

const PROJECT_A = 'proj-a';
const PROJECT_B = 'proj-b';

function makeSession(overrides: Partial<Session> & { id: string }): Session {
  return {
    taskId: `task-${overrides.id}`,
    projectId: PROJECT_A,
    pid: 1234,
    status: 'running',
    shell: 'bash',
    cwd: '/mock/project',
    startedAt: '2026-01-01T00:00:00.000Z',
    exitCode: null,
    resuming: false,
    agentSessionId: null,
    transient: true,
    ...overrides,
  };
}

describe('selectCommandTerminalSummary', () => {
  it('returns an empty summary when there is no project', () => {
    const sessions = [makeSession({ id: 'sess-1' })];
    expect(selectCommandTerminalSummary(sessions, {}, null)).toEqual({ count: 0, tone: 'rest' });
  });

  it('returns an empty summary for an empty session list', () => {
    expect(selectCommandTerminalSummary([], {}, PROJECT_A)).toEqual({ count: 0, tone: 'rest' });
  });

  it('ignores non-transient (task agent) sessions', () => {
    const sessions = [makeSession({ id: 'sess-agent', transient: undefined })];
    expect(selectCommandTerminalSummary(sessions, {}, PROJECT_A)).toEqual({ count: 0, tone: 'rest' });
  });

  it('ignores terminals belonging to another project', () => {
    const sessions = [makeSession({ id: 'sess-other', projectId: PROJECT_B })];
    expect(selectCommandTerminalSummary(sessions, {}, PROJECT_A)).toEqual({ count: 0, tone: 'rest' });
  });

  it('ignores terminals that are no longer running', () => {
    const sessions = [
      makeSession({ id: 'sess-exited', status: 'exited' }),
      makeSession({ id: 'sess-suspended', status: 'suspended' }),
    ];
    expect(selectCommandTerminalSummary(sessions, {}, PROJECT_A)).toEqual({ count: 0, tone: 'rest' });
  });

  it('counts only this project\'s live terminals', () => {
    const sessions = [
      makeSession({ id: 'sess-1' }),
      makeSession({ id: 'sess-2' }),
      makeSession({ id: 'sess-3' }),
      makeSession({ id: 'sess-other-project', projectId: PROJECT_B }),
      makeSession({ id: 'sess-agent', transient: undefined }),
      makeSession({ id: 'sess-dead', status: 'exited' }),
    ];
    expect(selectCommandTerminalSummary(sessions, {}, PROJECT_A).count).toBe(3);
  });

  it('is rest when a live terminal has no activity yet', () => {
    const sessions = [makeSession({ id: 'sess-1' })];
    expect(selectCommandTerminalSummary(sessions, {}, PROJECT_A)).toEqual({ count: 1, tone: 'rest' });
  });

  it('is thinking when a terminal is working', () => {
    const sessions = [makeSession({ id: 'sess-1' })];
    const activity: Record<string, ActivityState> = { 'sess-1': 'thinking' };
    expect(selectCommandTerminalSummary(sessions, activity, PROJECT_A)).toEqual({ count: 1, tone: 'thinking' });
  });

  it('is idle when a terminal is waiting on the user', () => {
    const sessions = [makeSession({ id: 'sess-1' })];
    const activity: Record<string, ActivityState> = { 'sess-1': 'idle' };
    expect(selectCommandTerminalSummary(sessions, activity, PROJECT_A)).toEqual({ count: 1, tone: 'idle' });
  });

  it('treats a permission-blocked terminal as needing the user, not as working', () => {
    // The bug class the shared classifier exists to prevent: `permission` is not
    // 'idle' by string, but it does require user interaction.
    const sessions = [makeSession({ id: 'sess-1' })];
    const activity: Record<string, ActivityState> = { 'sess-1': 'permission' };
    expect(selectCommandTerminalSummary(sessions, activity, PROJECT_A)).toEqual({ count: 1, tone: 'idle' });
  });

  it('lets working win over needs-you when both are present', () => {
    const sessions = [makeSession({ id: 'sess-idle' }), makeSession({ id: 'sess-working' })];
    const activity: Record<string, ActivityState> = { 'sess-idle': 'idle', 'sess-working': 'thinking' };
    expect(selectCommandTerminalSummary(sessions, activity, PROJECT_A)).toEqual({ count: 2, tone: 'thinking' });
  });

  it('lets working win regardless of iteration order', () => {
    // Guards the early-exit shape: a working terminal seen AFTER an idle one must
    // still take precedence.
    const sessions = [makeSession({ id: 'sess-working' }), makeSession({ id: 'sess-idle' })];
    const activity: Record<string, ActivityState> = { 'sess-working': 'thinking', 'sess-idle': 'permission' };
    expect(selectCommandTerminalSummary(sessions, activity, PROJECT_A).tone).toBe('thinking');
  });

  it('scores each project independently from one unscoped session list', () => {
    // The cross-project property the sidebar depends on: one list, many projects.
    const sessions = [
      makeSession({ id: 'sess-a1' }),
      makeSession({ id: 'sess-b1', projectId: PROJECT_B }),
      makeSession({ id: 'sess-b2', projectId: PROJECT_B }),
    ];
    const activity: Record<string, ActivityState> = { 'sess-a1': 'idle', 'sess-b1': 'thinking' };
    expect(selectCommandTerminalSummary(sessions, activity, PROJECT_A)).toEqual({ count: 1, tone: 'idle' });
    expect(selectCommandTerminalSummary(sessions, activity, PROJECT_B)).toEqual({ count: 2, tone: 'thinking' });
  });

  it('ignores activity belonging to a session that is not a live terminal', () => {
    // A stale activity entry for an exited terminal must not colour the tone.
    const sessions = [makeSession({ id: 'sess-live' }), makeSession({ id: 'sess-dead', status: 'exited' })];
    const activity: Record<string, ActivityState> = { 'sess-dead': 'thinking' };
    expect(selectCommandTerminalSummary(sessions, activity, PROJECT_A)).toEqual({ count: 1, tone: 'rest' });
  });
});
