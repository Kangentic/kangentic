/**
 * The low-memory census (Sentry DESKTOP-5C, 5D, 5E, 5F, 5P): one Windows
 * install ran out of commit for two days, and nothing said whether Kangentic's
 * leftovers or the user's own programs held it. The census sorts the commit
 * charge into groups as a spell starts. If the sorting drifts, the next event
 * names the wrong holder; if a pid, a name or a task id slips into what is
 * sent, it leaves the user's machine.
 */
import { describe, expect, it } from 'vitest';
import { sumCensus, type HostMemoryCensusResult } from '../../src/main/pty/process-tag/memory-census';
import { censusHostMemory } from '../../src/main/pty/process-tag/tagged-reap';
import {
  CENSUS_GROUPS,
  bucketCensus,
  bucketCensusBytes,
  bucketCensusCount,
  censusLine,
} from '../../src/main/diagnostics/host-memory-census';
import type { ScannedProcess, TaggedProcessReader } from '../../src/main/pty/process-tag/process-scan';

const GB = 1024 ** 3;
const MID_BOARD_TASK = 'aaaaaaaa-1111-4111-8111-111111111111';
const LIVE_TASK = 'bbbbbbbb-2222-4222-8222-222222222222';
const DONE_TASK = 'cccccccc-3333-4333-8333-333333333333';
const UNKNOWN_TASK = 'dddddddd-4444-4444-8444-444444444444';

/** A Windows process row: a creation time orders parent and child. */
function row(pid: number, ppid: number, startedAtMs: number, extra: Partial<ScannedProcess> = {}): ScannedProcess {
  return { pid, ppid, startKey: `start-${pid}`, startedAtMs, tagValue: null, ...extra };
}

/**
 * Main (10) and its pty host (11), a live PTY root (100) with an agent and a
 * dev server under it, a headless CLI run the host started outside any PTY
 * (150, with a child), a server the live task's agent detached (300), a
 * leftover of a parked task from an earlier run (400, with a child), a Done
 * task's leftover (500), an id no project knows (600), the user's browser
 * (700), a process whose commit could not be read (800) and another user's
 * (900, never opened).
 */
function processTable(): ScannedProcess[] {
  return [
    row(10, 1, 1_000, { commitBytes: 0.5 * GB }),
    row(11, 10, 1_100, { commitBytes: 0.25 * GB }),
    row(100, 11, 2_000, { tagValue: LIVE_TASK, commitBytes: 0.01 * GB }),
    row(101, 100, 2_100, { tagValue: LIVE_TASK, commitBytes: 1.2 * GB }),
    row(102, 101, 2_200, { tagValue: LIVE_TASK, commitBytes: 0.3 * GB }),
    row(150, 11, 2_250, { commitBytes: 0.6 * GB }),
    row(151, 150, 2_260, { commitBytes: 0.1 * GB }),
    row(300, 1, 2_300, { tagValue: LIVE_TASK, commitBytes: 0.4 * GB }),
    row(400, 4_242, 500, { tagValue: MID_BOARD_TASK, commitBytes: 1.1 * GB }),
    row(401, 400, 600, { tagValue: MID_BOARD_TASK, commitBytes: 2 * GB }),
    row(500, 1, 700, { tagValue: DONE_TASK, commitBytes: 0.2 * GB }),
    row(600, 1, 800, { tagValue: UNKNOWN_TASK, commitBytes: 0.1 * GB }),
    row(700, 1, 900, { commitBytes: 6 * GB }),
    row(800, 1, 950, { commitBytes: null }),
    row(900, 1, 960),
  ];
}

function standingOf(taskId: string): 'mid_board' | 'terminal' | 'unknown' {
  if (taskId === MID_BOARD_TASK || taskId === LIVE_TASK) return 'mid_board';
  if (taskId === DONE_TASK) return 'terminal';
  return 'unknown';
}

describe('sumCensus', () => {
  it('sorts each process into the first group it fits', () => {
    const result = sumCensus(processTable(), {
      electronPids: new Set([10, 11]),
      liveRoots: [{ pid: 100, taskId: LIVE_TASK }],
    });

    expect(result.kangentic).toEqual({ bytes: 0.75 * GB, count: 2 });
    expect(result.livePty.count).toBe(3);
    expect(result.livePty.bytes).toBeCloseTo(1.51 * GB);
    expect(result.kangenticChildren.count).toBe(2);
    expect(result.kangenticChildren.bytes).toBeCloseTo(0.7 * GB);
    expect(result.otherSameUser).toEqual({ bytes: 6 * GB, count: 1 });
    expect(result.unmeasuredCount).toBe(1);
    const byTask = Object.fromEntries(result.tagged.map((tagged) => [tagged.taskId, tagged]));
    expect(byTask[LIVE_TASK]).toMatchObject({ hasLiveSession: true, count: 1 });
    expect(byTask[MID_BOARD_TASK]).toMatchObject({ hasLiveSession: false, bytes: 3.1 * GB, count: 2 });
    expect(byTask[DONE_TASK]).toMatchObject({ hasLiveSession: false, count: 1 });
    expect(byTask[UNKNOWN_TASK]).toMatchObject({ count: 1 });
  });

  // Windows hands a dead parent's pid on: a process created before the pid's
  // current owner is no child of it, and must not be read as live.
  it('keeps a process out of a live tree when its parent pid was reused by the live root', () => {
    const result = sumCensus(
      [row(100, 11, 5_000, { tagValue: LIVE_TASK, commitBytes: GB }), row(150, 100, 1_000, { tagValue: MID_BOARD_TASK, commitBytes: 2 * GB })],
      { electronPids: new Set(), liveRoots: [{ pid: 100, taskId: LIVE_TASK }] },
    );

    expect(result.livePty).toEqual({ bytes: GB, count: 1 });
    expect(result.tagged).toEqual([{ taskId: MID_BOARD_TASK, hasLiveSession: false, bytes: 2 * GB, count: 1 }]);
  });
});

describe('bucketCensus', () => {
  function census(): HostMemoryCensusResult {
    return sumCensus(processTable(), { electronPids: new Set([10, 11]), liveRoots: [{ pid: 100, taskId: LIVE_TASK }] });
  }

  it('classifies each tag, sends buckets only, and carries no pid, name or task id', () => {
    const tags = bucketCensus(census(), standingOf);

    expect(tags).toMatchObject({
      census: 'ok',
      kangentic_gb: '0.5-1',
      kangentic_count: '1-4',
      live_pty_gb: '1-2',
      live_pty_count: '1-4',
      kangentic_children_gb: '0.5-1',
      kangentic_children_count: '1-4',
      mid_board_beside_session_gb: '<0.5',
      mid_board_no_session_gb: '2-4',
      mid_board_no_session_count: '1-4',
      terminal_task_gb: '<0.5',
      unknown_tag_gb: '<0.5',
      other_same_user_gb: '4-8',
      unmeasured_count: '1-4',
    });
    expect(Object.keys(tags).sort()).toEqual([
      'census',
      ...CENSUS_GROUPS.flatMap((group) => [`${group}_gb`, `${group}_count`]),
      'unmeasured_count',
    ].sort());
    const sent = JSON.stringify(tags);
    for (const forbidden of [MID_BOARD_TASK, LIVE_TASK, DONE_TASK, UNKNOWN_TASK, '"401"', '"700"']) {
      expect(sent).not.toContain(forbidden);
    }
    expect(sent).not.toMatch(/\d{3,}/);
  });

  it('logs one line of the same buckets, which names every group and nothing more', () => {
    const line = censusLine(bucketCensus(census(), standingOf));

    expect(line).toMatch(/^ok, kangentic 0\.5-1 GB \(1-4\), live_pty 1-2 GB \(1-4\), kangentic_children 0\.5-1 GB \(1-4\), /);
    for (const group of CENSUS_GROUPS) expect(line).toContain(`${group} `);
    expect(line).not.toContain(MID_BOARD_TASK);
  });

  it('says a failed census failed, with every group empty', () => {
    const failed: HostMemoryCensusResult = {
      supported: true,
      failed: true,
      kangentic: { bytes: 0, count: 0 },
      livePty: { bytes: 0, count: 0 },
      kangenticChildren: { bytes: 0, count: 0 },
      tagged: [],
      otherSameUser: { bytes: 0, count: 0 },
      unmeasuredCount: 0,
    };
    const tags = bucketCensus(failed, standingOf);
    expect(tags.census).toBe('failed');
    expect(tags.other_same_user_gb).toBe('0');
  });

  it.each([
    [0, '0'], [0.49 * GB, '<0.5'], [0.5 * GB, '0.5-1'], [1.5 * GB, '1-2'], [3 * GB, '2-4'],
    [7.9 * GB, '4-8'], [8 * GB, '8-16'], [20 * GB, '16-32'], [32 * GB, '32+'],
  ] as const)('buckets %d bytes as %s', (bytes, bucket) => {
    expect(bucketCensusBytes(bytes)).toBe(bucket);
  });

  it.each([[0, '0'], [1, '1-4'], [5, '5-19'], [20, '20-99'], [100, '100+']] as const)('buckets a count of %d as %s', (count, bucket) => {
    expect(bucketCensusCount(count)).toBe(bucket);
  });
});

describe('censusHostMemory in the host', () => {
  function readerOver(processes: ScannedProcess[], seen: Array<{ readCommit?: boolean } | undefined>): TaggedProcessReader {
    return {
      scan: async (options) => {
        seen.push(options);
        return { processes, unreadableCount: 0 };
      },
      kill: async () => false,
      describe: async () => new Map(),
    };
  }

  it('scans with readCommit on Windows and sums the table', async () => {
    const seen: Array<{ readCommit?: boolean } | undefined> = [];
    const result = await censusHostMemory({ electronPids: [10, 11] }, {
      reader: readerOver(processTable(), seen),
      liveRootPids: () => [100],
      liveRoots: () => [{ pid: 100, taskId: LIVE_TASK }],
      platform: 'win32',
    });

    expect(seen).toEqual([{ readCommit: true }]);
    expect(result.supported).toBe(true);
    expect(result.failed).toBe(false);
    expect(result.otherSameUser.bytes).toBe(6 * GB);
  });

  it('answers unsupported off Windows without scanning', async () => {
    const seen: Array<{ readCommit?: boolean } | undefined> = [];
    const result = await censusHostMemory({ electronPids: [] }, { reader: readerOver([], seen), liveRootPids: () => [], platform: 'linux' });

    expect(result.supported).toBe(false);
    expect(seen).toEqual([]);
  });

  it('answers failed, and relays a fixed code, when the scan throws', async () => {
    const relayed: string[] = [];
    const reader: TaggedProcessReader = { scan: async () => { throw new Error('snapshot failed'); }, kill: async () => false, describe: async () => new Map() };
    const result = await censusHostMemory({ electronPids: [] }, {
      reader,
      liveRootPids: () => [],
      platform: 'win32',
      handledErrors: { report: (code) => { relayed.push(code); } },
    });

    expect(result.failed).toBe(true);
    expect(relayed).toEqual(['host_memory_census']);
  });
});
