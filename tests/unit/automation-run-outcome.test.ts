/**
 * The failure notice is RATIONED, and that is the whole point of this file.
 *
 * The durable record is the `automation_runs` row, which the runner writes for
 * every execution whatever happens. This is the other sink: the one that
 * interrupts. A bulk move of twelve tasks through one column fails the same
 * webhook twelve times, and twelve identical toasts is the failure mode the
 * cooldown exists to prevent.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  notifyAutomationFailure,
  __resetAutomationFailureCooldownsForTest,
} from '../../src/main/automations/automation-run-outcome';
// Shared, not main-side: the renderer's toast draws this string and cannot
// import from `src/main/`, so both sides read the one definition.
import { describeAutomationFailure } from '../../src/shared/automation-describe';
import type { AutomationRunFailure } from '../../src/shared/types';

vi.mock('electron', () => ({ BrowserWindow: class {} }));

function makeFailure(overrides: Partial<AutomationRunFailure> = {}): AutomationRunFailure {
  return {
    runId: 'run-1',
    automationId: 'automation-1',
    automationName: 'Ping the channel',
    columnName: 'Code Review',
    taskId: 'task-1',
    taskTitle: 'Fix the thing',
    projectId: 'project-1',
    status: 'failed',
    detail: 'HTTP 500',
    ...overrides,
  };
}

/** A window stand-in that records what was sent, and can play destroyed. */
function makeWindow(destroyed = false) {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  return {
    sent,
    isDestroyed: () => destroyed,
    webContents: {
      send: (channel: string, payload: unknown) => { sent.push({ channel, payload }); },
    },
  };
}

describe('notifyAutomationFailure', () => {
  beforeEach(() => {
    __resetAutomationFailureCooldownsForTest();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends the first failure', () => {
    const window = makeWindow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a structural window stand-in; the module only calls isDestroyed and webContents.send
    const sent = notifyAutomationFailure({ window: window as any, projectId: 'project-1', failure: makeFailure() });

    expect(sent).toBe(true);
    expect(window.sent).toHaveLength(1);
    expect(window.sent[0].channel).toBe('automation:runFailed');
    expect(window.sent[0].payload).toMatchObject({ automationName: 'Ping the channel', detail: 'HTTP 500' });
  });

  it('swallows a repeat of the SAME automation inside the cooldown', () => {
    const window = makeWindow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
    const send = () => notifyAutomationFailure({ window: window as any, projectId: 'project-1', failure: makeFailure() });

    expect(send()).toBe(true);
    // Twelve tasks dragged through one column, one broken webhook. One toast.
    for (let repeat = 0; repeat < 11; repeat++) expect(send()).toBe(false);
    expect(window.sent).toHaveLength(1);
  });

  it('lets a DIFFERENT automation through immediately', () => {
    const window = makeWindow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
    const send = (id: string) => notifyAutomationFailure({ window: window as any, projectId: 'project-1', failure: makeFailure({ automationId: id }) });

    expect(send('automation-1')).toBe(true);
    // Keyed on the automation, not the column or the project: two broken rows
    // are two separate pieces of news.
    expect(send('automation-2')).toBe(true);
    expect(window.sent).toHaveLength(2);
  });

  it('lets the same automation through again once the cooldown lapses', () => {
    const window = makeWindow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
    const send = () => notifyAutomationFailure({ window: window as any, projectId: 'project-1', failure: makeFailure() });

    expect(send()).toBe(true);
    vi.advanceTimersByTime(59_000);
    expect(send()).toBe(false);
    vi.advanceTimersByTime(2_000);
    expect(send()).toBe(true);
  });

  it('scopes the cooldown per project', () => {
    const window = makeWindow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
    const send = (projectId: string) => notifyAutomationFailure({ window: window as any, projectId, failure: makeFailure() });

    expect(send('project-1')).toBe(true);
    // The same automation id cannot exist in two projects, but the key carries
    // the project anyway so a shared id can never silence another project.
    expect(send('project-2')).toBe(true);
  });

  it('sends nothing when the window is gone, and does not burn the cooldown', () => {
    const destroyed = makeWindow(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
    expect(notifyAutomationFailure({ window: destroyed as any, projectId: 'project-1', failure: makeFailure() })).toBe(false);
    expect(destroyed.sent).toHaveLength(0);

    // The failure was never announced, so the next live window still gets it.
    const live = makeWindow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
    expect(notifyAutomationFailure({ window: live as any, projectId: 'project-1', failure: makeFailure() })).toBe(true);
  });

  it('sends nothing when there is no window at all', () => {
    expect(notifyAutomationFailure({ window: null, projectId: 'project-1', failure: makeFailure() })).toBe(false);
  });
});

describe('describeAutomationFailure', () => {
  it('names the automation AND the column', () => {
    // Neither alone locates it: two columns can hold rows with the same name,
    // and a column name alone does not say which of its rows broke.
    expect(describeAutomationFailure(makeFailure())).toBe('Ping the channel failed on Code Review');
  });
});
