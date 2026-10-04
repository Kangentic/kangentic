/**
 * Unit tests for src/renderer/stores/leftover-processes-store.ts.
 *
 * tests/ui/leftover-processes.spec.ts drives the Review list over the mock
 * bridge, but it only ever holds one or two reports, so it cannot reach the
 * bounds `addReport` enforces. This file drives the store directly and pins:
 *  - the store keeps only the newest 20 reports (RETAINED_REPORTS), oldest
 *    first, so the 21st report evicts the oldest and exactly 20 evict nothing;
 *  - a Stop outcome (`stopStates`) lives only as long as a retained report
 *    lists its process: evicting a report drops its processes' outcomes, a
 *    retained report's outcomes stay, and an outcome for a process no report
 *    lists is dropped too;
 *  - re-adding a report id replaces that report, moves it to the newest
 *    position, and never lists it twice, so a refreshed report is the last one
 *    evicted rather than the first;
 *  - `stopProcess` writes `stopping` at once, then whatever outcome the bridge
 *    answers, and `failed` when the bridge rejects, except that a row whose
 *    report a newer report evicted while main was still answering gets no
 *    outcome back (the final write checks the row is still in `stopStates`).
 *
 * `window.electronAPI.leftoverProcesses.stop` is stubbed per test with
 * `vi.stubGlobal`, mirroring config-store-project-override.test.ts for a Node
 * (non-jsdom) test environment: the store reads it at call time, not at import.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { LeftoverProcess, LeftoverProcessReport, LeftoverStopOutcome } from '../../src/shared/types';
import { useLeftoverProcessesStore } from '../../src/renderer/stores/leftover-processes-store';

// Matches RETAINED_REPORTS in the store. Restated here on purpose: the test
// pins the contract, so a silent change to the constant must fail it.
const RETAINED_REPORT_COUNT = 20;

const stopMock = vi.fn<(processId: string) => Promise<LeftoverStopOutcome>>();

function makeProcess(id: string): LeftoverProcess {
  return {
    id,
    taskId: 'task-a',
    taskTitle: 'Fix login',
    pid: 48211,
    label: 'node (vite)',
    outcome: 'kept',
    reason: 'window',
    place: 'worktree',
  };
}

function makeReport(id: string, processIds: string[] = [`${id}-process`]): LeftoverProcessReport {
  return { id, stoppingEnabled: true, processes: processIds.map(makeProcess) };
}

/** Adds `count` reports named report-0 .. report-<count-1>, each listing one process, process-<n>. */
function addNumberedReports(count: number): void {
  for (let index = 0; index < count; index++) {
    useLeftoverProcessesStore.getState().addReport(makeReport(`report-${index}`, [`process-${index}`]));
  }
}

function reportIds(): string[] {
  return Object.keys(useLeftoverProcessesStore.getState().reports);
}

beforeEach(() => {
  stopMock.mockReset();
  vi.stubGlobal('window', { electronAPI: { leftoverProcesses: { stop: stopMock } } });
  useLeftoverProcessesStore.setState({ reports: {}, reportToasts: {}, openReportId: null, stopStates: {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('leftover-processes-store addReport retention', () => {
  it('keeps exactly the newest 20 reports without evicting any', () => {
    addNumberedReports(RETAINED_REPORT_COUNT);

    expect(reportIds()).toHaveLength(RETAINED_REPORT_COUNT);
    expect(reportIds()[0]).toBe('report-0');
  });

  it('evicts the oldest report when a 21st arrives, keeping the rest oldest first', () => {
    addNumberedReports(RETAINED_REPORT_COUNT + 1);

    const ids = reportIds();
    expect(ids).toHaveLength(RETAINED_REPORT_COUNT);
    expect(ids).not.toContain('report-0');
    expect(ids[0]).toBe('report-1');
    expect(ids[ids.length - 1]).toBe('report-20');
  });

  it('keeps the contents of a retained report untouched while others are evicted', () => {
    addNumberedReports(RETAINED_REPORT_COUNT + 1);

    expect(useLeftoverProcessesStore.getState().reports['report-7']).toEqual(makeReport('report-7', ['process-7']));
  });
});

describe('leftover-processes-store addReport and the toasts that link to reports', () => {
  it('returns the toast of a report it evicts, so its dead Review link can be closed', () => {
    const store = useLeftoverProcessesStore.getState();
    expect(store.addReport(makeReport('report-sticky'), 'toast-sticky')).toEqual([]);
    // Positive control: twenty more reports fill the store without evicting the first one's toast.
    for (let index = 0; index < RETAINED_REPORT_COUNT - 1; index += 1) {
      expect(useLeftoverProcessesStore.getState().addReport(makeReport(`report-${index}`), `toast-${index}`)).toEqual([]);
    }
    expect(useLeftoverProcessesStore.getState().reportToasts['report-sticky']).toBe('toast-sticky');

    const evicted = useLeftoverProcessesStore.getState().addReport(makeReport('report-newest'), 'toast-newest');

    expect(evicted).toEqual(['toast-sticky']);
    expect(reportIds()).not.toContain('report-sticky');
    expect(useLeftoverProcessesStore.getState().reportToasts['report-sticky']).toBeUndefined();
    expect(useLeftoverProcessesStore.getState().reportToasts['report-newest']).toBe('toast-newest');
  });

  it('returns nothing for an evicted report that was added without a toast', () => {
    useLeftoverProcessesStore.getState().addReport(makeReport('report-quiet'));
    addNumberedReports(RETAINED_REPORT_COUNT - 1);

    expect(useLeftoverProcessesStore.getState().addReport(makeReport('report-newest'), 'toast-newest')).toEqual([]);
    expect(reportIds()).not.toContain('report-quiet');
  });
});

describe('leftover-processes-store addReport stopStates pruning', () => {
  it('drops the Stop outcome of a process in an evicted report and keeps a retained report\'s', () => {
    addNumberedReports(RETAINED_REPORT_COUNT);
    useLeftoverProcessesStore.setState({ stopStates: { 'process-0': 'stopped', 'process-1': 'failed' } });

    // The 21st report evicts report-0 (and with it process-0's row).
    useLeftoverProcessesStore.getState().addReport(makeReport('report-20', ['process-20']));

    const { stopStates } = useLeftoverProcessesStore.getState();
    expect(stopStates['process-0']).toBeUndefined();
    expect(stopStates['process-1']).toBe('failed');
  });

  it('drops an outcome for a process that no retained report lists', () => {
    useLeftoverProcessesStore.getState().addReport(makeReport('report-a', ['process-a']));
    useLeftoverProcessesStore.setState({ stopStates: { 'process-a': 'ended', 'process-ghost': 'stopped' } });

    useLeftoverProcessesStore.getState().addReport(makeReport('report-b', ['process-b']));

    expect(useLeftoverProcessesStore.getState().stopStates).toEqual({ 'process-a': 'ended' });
  });

  it('keeps the outcomes of every process in a retained multi-process report', () => {
    useLeftoverProcessesStore.getState().addReport(makeReport('report-multi', ['process-x', 'process-y']));
    useLeftoverProcessesStore.setState({ stopStates: { 'process-x': 'stopped', 'process-y': 'ended' } });

    useLeftoverProcessesStore.getState().addReport(makeReport('report-other', ['process-z']));

    expect(useLeftoverProcessesStore.getState().stopStates).toEqual({ 'process-x': 'stopped', 'process-y': 'ended' });
  });
});

describe('leftover-processes-store addReport with a repeated id', () => {
  it('replaces the report instead of listing it twice', () => {
    useLeftoverProcessesStore.getState().addReport(makeReport('report-a', ['process-old']));
    useLeftoverProcessesStore.getState().addReport(makeReport('report-b', ['process-b']));

    useLeftoverProcessesStore.getState().addReport(makeReport('report-a', ['process-new']));

    const { reports } = useLeftoverProcessesStore.getState();
    expect(Object.keys(reports)).toHaveLength(2);
    expect(reports['report-a'].processes.map((entry) => entry.id)).toEqual(['process-new']);
  });

  it('does not grow the count when the store is already full', () => {
    addNumberedReports(RETAINED_REPORT_COUNT);

    useLeftoverProcessesStore.getState().addReport(makeReport('report-5', ['process-5-again']));

    expect(reportIds()).toHaveLength(RETAINED_REPORT_COUNT);
    expect(reportIds()).toContain('report-0');
  });

  it('moves the repeated report to the newest position, so it is evicted last', () => {
    addNumberedReports(RETAINED_REPORT_COUNT);

    // Refresh the oldest report, then push one more report in.
    useLeftoverProcessesStore.getState().addReport(makeReport('report-0', ['process-0']));
    expect(reportIds()[reportIds().length - 1]).toBe('report-0');
    useLeftoverProcessesStore.getState().addReport(makeReport('report-20', ['process-20']));

    const ids = reportIds();
    expect(ids).toHaveLength(RETAINED_REPORT_COUNT);
    // report-1 was the oldest once report-0 was refreshed, so it is the one evicted.
    expect(ids).not.toContain('report-1');
    expect(ids).toContain('report-0');
    expect(ids[ids.length - 1]).toBe('report-20');
  });

  it('keeps the Stop outcome of a process in the replaced report that is still listed', () => {
    useLeftoverProcessesStore.getState().addReport(makeReport('report-a', ['process-a']));
    useLeftoverProcessesStore.setState({ stopStates: { 'process-a': 'stopped' } });

    useLeftoverProcessesStore.getState().addReport(makeReport('report-a', ['process-a']));

    expect(useLeftoverProcessesStore.getState().stopStates['process-a']).toBe('stopped');
  });
});

describe('leftover-processes-store stopProcess', () => {
  it('writes stopping at once, then the outcome the bridge answers', async () => {
    let answerStop: (outcome: LeftoverStopOutcome) => void = () => {};
    stopMock.mockImplementation(() => new Promise<LeftoverStopOutcome>((resolve) => { answerStop = resolve; }));

    const pending = useLeftoverProcessesStore.getState().stopProcess('process-a');

    // The row reads Stopping before main has answered.
    expect(useLeftoverProcessesStore.getState().stopStates['process-a']).toBe('stopping');
    expect(stopMock).toHaveBeenCalledWith('process-a');

    answerStop('ended');
    await pending;

    expect(useLeftoverProcessesStore.getState().stopStates['process-a']).toBe('ended');
  });

  it.each<LeftoverStopOutcome>(['stopped', 'ended', 'failed'])('records the bridge answer %s on the row', async (outcome) => {
    stopMock.mockResolvedValue(outcome);

    await useLeftoverProcessesStore.getState().stopProcess('process-a');

    expect(useLeftoverProcessesStore.getState().stopStates['process-a']).toBe(outcome);
  });

  it('records failed when the bridge rejects, without throwing', async () => {
    stopMock.mockRejectedValue(new Error('ipc channel closed'));

    await expect(useLeftoverProcessesStore.getState().stopProcess('process-a')).resolves.toBeUndefined();

    expect(useLeftoverProcessesStore.getState().stopStates['process-a']).toBe('failed');
  });

  it('only touches the stopped row, leaving other rows\' outcomes alone', async () => {
    useLeftoverProcessesStore.setState({ stopStates: { 'process-other': 'ended' } });
    stopMock.mockResolvedValue('stopped');

    await useLeftoverProcessesStore.getState().stopProcess('process-a');

    expect(useLeftoverProcessesStore.getState().stopStates).toEqual({ 'process-other': 'ended', 'process-a': 'stopped' });
  });
});

describe('leftover-processes-store stopProcess while newer reports arrive', () => {
  /** A Stop whose answer from main is held open: settle it with `answer` or `fail`. */
  function holdStopAnswer(): { answer: (outcome: LeftoverStopOutcome) => void; fail: (error: Error) => void } {
    const settle = { answer: (_outcome: LeftoverStopOutcome) => {}, fail: (_error: Error) => {} };
    stopMock.mockImplementation(() => new Promise<LeftoverStopOutcome>((resolve, reject) => {
      settle.answer = resolve;
      settle.fail = reject;
    }));
    return { answer: (outcome) => settle.answer(outcome), fail: (error) => settle.fail(error) };
  }

  // 'report-target' is not one of report-0 .. report-19, which addNumberedReports
  // names: re-adding an id moves that report to the newest slot instead of
  // evicting anything.
  function addTargetReport(): void {
    useLeftoverProcessesStore.getState().addReport(makeReport('report-target', ['process-target']));
  }

  it('records the outcome when the row\'s report is still retained after newer ones arrived', async () => {
    const held = holdStopAnswer();
    addTargetReport();
    const pending = useLeftoverProcessesStore.getState().stopProcess('process-target');
    expect(useLeftoverProcessesStore.getState().stopStates['process-target']).toBe('stopping');

    // 19 newer reports plus the target make exactly the 20 the store keeps.
    addNumberedReports(RETAINED_REPORT_COUNT - 1);
    expect(reportIds()).toContain('report-target');
    expect(useLeftoverProcessesStore.getState().stopStates['process-target']).toBe('stopping');

    held.answer('stopped');
    await pending;

    expect(useLeftoverProcessesStore.getState().stopStates['process-target']).toBe('stopped');
  });

  it('does not bring a Stop outcome back for a row whose report was evicted while main answered', async () => {
    const held = holdStopAnswer();
    addTargetReport();
    const pending = useLeftoverProcessesStore.getState().stopProcess('process-target');

    // 20 newer reports push the target out, and addReport drops its stopping state with it.
    addNumberedReports(RETAINED_REPORT_COUNT);
    expect(reportIds()).not.toContain('report-target');
    expect(Object.hasOwn(useLeftoverProcessesStore.getState().stopStates, 'process-target')).toBe(false);

    held.answer('stopped');
    await pending;

    // Nothing lists the process any more, so the map must not regrow an entry for it.
    expect(Object.hasOwn(useLeftoverProcessesStore.getState().stopStates, 'process-target')).toBe(false);
    expect(useLeftoverProcessesStore.getState().stopStates).toEqual({});
  });

  it('does not record a failure for an evicted row either, when the bridge rejects after the eviction', async () => {
    const held = holdStopAnswer();
    addTargetReport();
    const pending = useLeftoverProcessesStore.getState().stopProcess('process-target');
    addNumberedReports(RETAINED_REPORT_COUNT);
    expect(Object.hasOwn(useLeftoverProcessesStore.getState().stopStates, 'process-target')).toBe(false);

    held.fail(new Error('ipc channel closed'));
    await expect(pending).resolves.toBeUndefined();

    expect(useLeftoverProcessesStore.getState().stopStates).toEqual({});
  });
});
