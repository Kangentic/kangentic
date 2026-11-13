/**
 * What a user loses if these reports go quiet: a board that fails to load, a card click
 * that opens nothing, a terminal whose replay fails and a terminal stuck on the slow DOM
 * renderer all look like "the app is a bit off" with nothing on screen to say why, so a
 * regression in any of them reaches us only as a vague complaint.
 *
 * These run the real code and drive each catch with a throwing dependency, then assert
 * the call to `reportRendererFailure` (mocked here, so its area, op and error are what
 * is checked). They replace source-text pins in error-reporting-feature-gaps.test.ts.
 *
 * useTerminal is the one site kept as a source read. Both replay catches live inside a
 * very large hook whose refs, HMR rules and arrival-focus obligation (see
 * .claude/rules/terminal-arrival-focus.md) make an extraction risky, and the unit tier
 * has no DOM to render it. The read is scoped to the catch that follows each
 * 'replay-error' trace so a deleted report fails by trigger.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';

vi.mock('../../src/renderer/utils/renderer-failure', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/renderer/utils/renderer-failure')>()),
  reportRendererFailure: vi.fn(() => true),
}));

import { reportRendererFailure } from '../../src/renderer/utils/renderer-failure';
import { createBoardStore } from '../../src/renderer/stores/board-store';
import { requestDetailOpenFromMain } from '../../src/renderer/window-manager/bridge/useTaskDetailWindowBridge';
import { attachWebglRenderer } from '../../src/renderer/utils/terminal-webgl';

const reportMock = vi.mocked(reportRendererFailure);

beforeEach(() => {
  reportMock.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('board load failure', () => {
  function stubElectronApi(tasksList: () => Promise<unknown[]>): void {
    vi.stubGlobal('window', {
      electronAPI: {
        tasks: {
          list: tasksList,
          listArchivedPreview: async () => ({ tasks: [], totalCount: 0 }),
        },
        swimlanes: { list: async () => [] },
        boardConfig: {
          getShortcuts: async () => [],
          getBoardProfiles: async () => [],
        },
        automations: { list: async () => [] },
      },
    });
  }

  it('reports a failed load as board/load and leaves the board hydrated', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = new TypeError('renderer-side defect');
    stubElectronApi(async () => { throw failure; });
    const store = createBoardStore();

    await store.getState().loadBoard();

    expect(reportMock).toHaveBeenCalledWith('board', 'load', failure);
    expect(store.getState().loading).toBe(false);
    expect(store.getState().hydrated).toBe(true);
  });

  it('reports nothing when the load succeeds', async () => {
    stubElectronApi(async () => []);
    const store = createBoardStore();

    await store.getState().loadBoard();

    expect(reportMock).not.toHaveBeenCalledWith('board', 'load', expect.anything());
  });
});

describe('card click that cannot resolve where to open', () => {
  it('reports a rejected requestOpen as task_detail/open', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = new Error('main unreachable');

    await requestDetailOpenFromMain(async () => { throw failure; }, 'project-a', 'task-a');

    expect(reportMock).toHaveBeenCalledWith('task_detail', 'open', failure);
  });

  it('reports nothing when main answers', async () => {
    const requestOpen = vi.fn(async () => ({ kind: 'open-here' }));

    await requestDetailOpenFromMain(requestOpen, 'project-a', 'task-a');

    expect(requestOpen).toHaveBeenCalledWith('project-a', 'task-a', 'board');
    expect(reportMock).not.toHaveBeenCalled();
  });
});

describe('terminal WebGL fallback', () => {
  it('reports the DOM fallback once, when the first retry pass is spent', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fakeTerminal = { loadAddon: vi.fn() } as unknown as Terminal;
    const dispose = attachWebglRenderer(fakeTerminal, 'session-webgl-report', {
      createAddon: () => { throw new Error('WebGL blocked'); },
      retryDelaysMs: [10, 20],
    });

    // Failures 1 and 2 are inside the schedule's first pass: nothing is reported yet.
    vi.advanceTimersByTime(10);
    expect(reportMock).not.toHaveBeenCalled();

    // The third failure is the first past the schedule.
    vi.advanceTimersByTime(20);
    expect(reportMock).toHaveBeenCalledTimes(1);
    const [area, operation, error, contexts] = reportMock.mock.calls[0];
    expect(area).toBe('terminal');
    expect(operation).toBe('webgl_fallback');
    expect((error as Error).name).toBe('WebglFallbackError');
    expect(contexts).toEqual({ webgl: { failure: 're-init-failed', contextLosses: 0 } });

    // Later failures stay quiet.
    vi.advanceTimersByTime(200);
    expect(reportMock).toHaveBeenCalledTimes(1);

    dispose();
  });
});

describe('terminal replay failure (source read, see header)', () => {
  const hookSource = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'src', 'renderer', 'hooks', 'useTerminal.ts'),
    'utf-8',
  );

  function catchBodyFor(trigger: 'mount' | 'reload'): string {
    const marker = `traceReplay('replay-error', { trigger: '${trigger}'`;
    const start = hookSource.indexOf(marker);
    expect(start, `no replay-error trace for ${trigger}`).toBeGreaterThan(-1);
    const end = hookSource.indexOf("focusOnArrival('replay-error')", start);
    expect(end, `no arrival discharge after the ${trigger} catch`).toBeGreaterThan(start);
    // Comment lines dropped, so a commented-out call does not count.
    return hookSource
      .slice(start, end)
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
  }

  it.each(['mount', 'reload'] as const)('the %s replay catch reports terminal/replay with its trigger', (trigger) => {
    expect(catchBodyFor(trigger)).toContain(
      `reportRendererFailure('terminal', 'replay', error, { replay: { trigger: '${trigger}' } });`,
    );
  });
});
