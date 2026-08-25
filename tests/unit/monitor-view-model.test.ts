import { describe, it, expect } from 'vitest';
import {
  applyProjectScope,
  bucketOf,
  filterRows,
  groupRows,
  sortRows,
  summarize,
  toRenderUnits,
  BUCKET_ORDER,
} from '../../src/renderer/components/monitor/monitor-view-model';
import { DEFAULT_CONFIG } from '../../src/shared/types';
import type { MonitorSessionRow, MonitorView } from '../../src/shared/types';

/**
 * The monitor's whole decision surface (bucketing, filtering, sorting, grouping,
 * and the chunking that feeds one virtualizer) is pure, so it is pinned here
 * rather than through the DOM. The UI spec covers what the user can reach; these
 * cover the branches it cannot.
 */

function makeRow(overrides: Partial<MonitorSessionRow> = {}): MonitorSessionRow {
  return {
    sessionId: 'session-1',
    projectId: 'project-1',
    projectName: 'kangentic',
    taskId: 'task-1',
    taskTitle: 'Fix PTY capture race',
    outputPeek: ['npm run typecheck', 'no errors'],
    displayId: 142,
    columnName: 'Tests',
    commandTerminalBranch: null,
    labels: [],
    prUrl: null,
    prNumber: null,
    prState: null,
    agentName: 'claude',
    modelDisplayName: 'Opus 5',
    effort: 'xhigh',
    permissionMode: 'plan',
    startedAt: '2026-01-01T00:00:00.000Z',
    exitedAt: null,
    status: 'running',
    activity: 'thinking',
    activityReason: null,
    lastEvent: null,
    contextPercent: null,
    isolated: false,
    isCommandTerminal: false,
    ...overrides,
  };
}

const VIEW: MonitorView = DEFAULT_CONFIG.monitor;

describe('bucketOf', () => {
  it('buckets a running session by whether it needs the user', () => {
    expect(bucketOf(makeRow({ status: 'running', activity: 'thinking' }))).toBe('working');
    expect(bucketOf(makeRow({ status: 'running', activity: 'idle' }))).toBe('needs-you');
  });

  it('treats permission like idle, not like working', () => {
    // The exact bug the shared classifier exists to prevent: a permission-blocked
    // agent is waiting on the user, not working.
    expect(bucketOf(makeRow({ status: 'running', activity: 'permission' }))).toBe('needs-you');
  });

  it('buckets by status ahead of activity for non-running sessions', () => {
    // A suspended session can still carry a stale 'thinking' activity; status wins.
    expect(bucketOf(makeRow({ status: 'suspended', activity: 'thinking' }))).toBe('idle');
    expect(bucketOf(makeRow({ status: 'queued', activity: 'thinking' }))).toBe('idle');
    expect(bucketOf(makeRow({ status: 'exited', activity: 'thinking' }))).toBe('finished');
  });

  it('treats a running session with no reported activity as working', () => {
    expect(bucketOf(makeRow({ status: 'running', activity: null }))).toBe('working');
  });
});

describe('filterRows', () => {
  const rows = [
    makeRow({ sessionId: 'a', activity: 'idle' }),
    makeRow({ sessionId: 'b', activity: 'thinking' }),
    makeRow({ sessionId: 'c', status: 'suspended' }),
    makeRow({ sessionId: 'd', status: 'exited' }),
  ];

  it('liveOnly removes parked AND finished, never what needs you', () => {
    const kept = filterRows(rows, { ...VIEW, liveOnly: true }).map((row) => row.sessionId);
    expect(kept).toEqual(['a', 'b']);
  });

  it('filters by project', () => {
    const mixed = [makeRow({ sessionId: 'a' }), makeRow({ sessionId: 'b', projectId: 'project-2' })];
    const kept = filterRows(mixed, { ...VIEW, projectFilter: ['project-2'] });
    expect(kept.map((row) => row.sessionId)).toEqual(['b']);
  });

  it('keeps a chosen SUBSET of projects, not just one', () => {
    const mixed = [
      makeRow({ sessionId: 'a' }),
      makeRow({ sessionId: 'b', projectId: 'project-2' }),
      makeRow({ sessionId: 'c', projectId: 'project-3' }),
    ];
    const kept = filterRows(mixed, { ...VIEW, projectFilter: ['project-1', 'project-3'] });
    expect(kept.map((row) => row.sessionId)).toEqual(['a', 'c']);
  });

  it('an empty projectFilter means every project, not none', () => {
    expect(filterRows(rows, { ...VIEW, projectFilter: [] })).toHaveLength(4);
  });

  it('filters by state bucket', () => {
    const kept = filterRows(rows, { ...VIEW, stateFilter: ['needs-you'] });
    expect(kept.map((row) => row.sessionId)).toEqual(['a']);
  });

  it('text filter matches title, project, ticket number, and labels case-insensitively', () => {
    const searchable = [
      makeRow({ sessionId: 'a', taskTitle: 'Landing copy' }),
      makeRow({ sessionId: 'b', taskTitle: 'Noise handshake', labels: ['crypto'] }),
      makeRow({ sessionId: 'c', taskTitle: 'Other', displayId: 999 }),
    ];
    expect(filterRows(searchable, { ...VIEW, textFilter: 'LANDING' }).map((r) => r.sessionId)).toEqual(['a']);
    expect(filterRows(searchable, { ...VIEW, textFilter: 'crypto' }).map((r) => r.sessionId)).toEqual(['b']);
    expect(filterRows(searchable, { ...VIEW, textFilter: '#999' }).map((r) => r.sessionId)).toEqual(['c']);
  });
});

describe('applyProjectScope', () => {
  const rows = [
    makeRow({ sessionId: 'a' }),
    makeRow({ sessionId: 'b', projectId: 'project-2' }),
    makeRow({ sessionId: 'c', projectId: 'project-3' }),
  ];

  it('returns the SAME array reference for an empty filter', () => {
    // Load-bearing, not an optimisation nicety: MonitorSummaryCards is memoized
    // on the rows identity, so the common unscoped path must not allocate.
    expect(applyProjectScope(rows, [])).toBe(rows);
  });

  it('keeps only rows from the named project', () => {
    expect(applyProjectScope(rows, ['project-2']).map((row) => row.sessionId)).toEqual(['b']);
  });

  it('keeps rows from EACH project of a multi-project filter', () => {
    const scoped = applyProjectScope(rows, ['project-1', 'project-3']);
    expect(scoped.map((row) => row.sessionId)).toEqual(['a', 'c']);
  });
});

describe('sortRows', () => {
  // Attention is deliberately NOT one of the sort modes: rows are always grouped,
  // and `groupRows` emits the state sections in BUCKET_ORDER, so attention-first is
  // structural. What sortRows owns is the order WITHIN a section, and that is purely
  // by start time - see the groupRows suite for the attention-order guarantee.
  it('orders by start time regardless of what each row is doing', () => {
    const rows = [
      makeRow({ sessionId: 'newest-needs', activity: 'idle', startedAt: '2026-01-01T00:10:00.000Z' }),
      makeRow({ sessionId: 'oldest-working', activity: 'thinking', startedAt: '2026-01-01T00:00:00.000Z' }),
    ];
    expect(sortRows(rows, 'longest-running').map((row) => row.sessionId))
      .toEqual(['oldest-working', 'newest-needs']);
  });

  it('stays deterministic for a row with an unparseable start time', () => {
    // Flooring to 0 rather than letting NaN through keeps the comparator
    // transitive; a NaN comparator leaves the order up to the engine's sort.
    const rows = [
      makeRow({ sessionId: 'valid', startedAt: '2026-01-01T00:05:00.000Z' }),
      makeRow({ sessionId: 'broken', startedAt: 'not-a-date' }),
    ];
    expect(sortRows(rows, 'longest-running').map((row) => row.sessionId)).toEqual(['broken', 'valid']);
  });

  it('longest-running and recently-started are inverses', () => {
    const rows = [
      makeRow({ sessionId: 'new', startedAt: '2026-01-01T00:10:00.000Z' }),
      makeRow({ sessionId: 'old', startedAt: '2026-01-01T00:00:00.000Z' }),
    ];
    expect(sortRows(rows, 'longest-running').map((r) => r.sessionId)).toEqual(['old', 'new']);
    expect(sortRows(rows, 'recently-started').map((r) => r.sessionId)).toEqual(['new', 'old']);
  });

  it('does not mutate the input array', () => {
    const rows = [
      makeRow({ sessionId: 'b', startedAt: '2026-01-01T00:10:00.000Z' }),
      makeRow({ sessionId: 'a', startedAt: '2026-01-01T00:00:00.000Z' }),
    ];
    sortRows(rows, 'longest-running');
    expect(rows.map((row) => row.sessionId)).toEqual(['b', 'a']);
  });
});

describe('groupRows', () => {
  it('groups by state in attention order', () => {
    // This is where attention-first lives now that it is not a sort mode: whatever
    // order the rows arrive in, the sections come out needs-you, working, idle,
    // finished.
    const rows = [
      makeRow({ sessionId: 'f', status: 'exited' }),
      makeRow({ sessionId: 'w', activity: 'thinking' }),
      makeRow({ sessionId: 'i', status: 'suspended' }),
      makeRow({ sessionId: 'n', activity: 'idle' }),
    ];
    const groups = groupRows(rows, 'state');
    expect(groups.map((group) => group.key)).toEqual(['needs-you', 'working', 'idle', 'finished']);
    expect(groups.map((group) => group.key)).toEqual([...BUCKET_ORDER]);
  });

  it('groups by project alphabetically', () => {
    const rows = [
      makeRow({ sessionId: 'a', projectId: 'p2', projectName: 'zebra' }),
      makeRow({ sessionId: 'b', projectId: 'p1', projectName: 'alpha' }),
    ];
    expect(groupRows(rows, 'project').map((group) => group.label)).toEqual(['alpha', 'zebra']);
  });

  it('flat returns one unlabelled group so callers have a single shape', () => {
    const groups = groupRows([makeRow()], 'flat');
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('');
  });

  it('returns no groups for no rows', () => {
    expect(groupRows([], 'flat')).toEqual([]);
    expect(groupRows([], 'state')).toEqual([]);
  });
});

describe('toRenderUnits', () => {
  it('emits a full-width header then chunks cards into rows of N', () => {
    const rows = [
      makeRow({ sessionId: 'a' }), makeRow({ sessionId: 'b' }), makeRow({ sessionId: 'c' }),
    ];
    const units = toRenderUnits(groupRows(rows, 'state'), 2);
    expect(units.map((unit) => unit.kind)).toEqual(['header', 'row', 'row']);
    expect(units[1].kind === 'row' && units[1].rows).toHaveLength(2);
    expect(units[2].kind === 'row' && units[2].rows).toHaveLength(1);
  });

  it('emits no header for the flat group', () => {
    const units = toRenderUnits(groupRows([makeRow()], 'flat'), 1);
    expect(units.map((unit) => unit.kind)).toEqual(['row']);
  });

  it('never chunks below one card per row, even for a nonsense column count', () => {
    // Guards the virtualizer against an infinite loop if a container measures 0.
    const units = toRenderUnits(groupRows([makeRow()], 'flat'), 0);
    expect(units).toHaveLength(1);
  });

  it('produces stable unique keys', () => {
    const rows = [makeRow({ sessionId: 'a' }), makeRow({ sessionId: 'b', activity: 'idle' })];
    const keys = toRenderUnits(groupRows(rows, 'state'), 1).map((unit) => unit.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('summarize', () => {
  it('counts every bucket and the projects with live work', () => {
    const rows = [
      makeRow({ sessionId: 'a', projectId: 'p1', activity: 'idle' }),
      makeRow({ sessionId: 'b', projectId: 'p1', activity: 'thinking' }),
      makeRow({ sessionId: 'c', projectId: 'p2', activity: 'thinking' }),
      makeRow({ sessionId: 'd', projectId: 'p3', status: 'exited' }),
    ];
    const { counts, projectCount } = summarize(rows);
    expect(counts['needs-you']).toBe(1);
    expect(counts.working).toBe(2);
    expect(counts.finished).toBe(1);
    // p3 only has a finished session, so it is not an ACTIVE project.
    expect(projectCount).toBe(2);
  });

  it('reports the longest wait and the most recent moment an agent stopped working', () => {
    const rows = [
      makeRow({
        sessionId: 'a',
        activity: 'idle',
        activityReason: { kind: 'idle', since: 1_000 },
      }),
      makeRow({
        sessionId: 'b',
        activity: 'idle',
        activityReason: { kind: 'idle', since: 5_000 },
      }),
      makeRow({ sessionId: 'c', status: 'exited', exitedAt: '1970-01-01T00:00:03.000Z' }),
    ];
    const { oldestNeedsYouSince, lastActiveAt } = summarize(rows);
    // Oldest looks backwards (who has waited longest); lastActive looks forwards
    // (when did anything last stop working), so they pick opposite ends.
    expect(oldestNeedsYouSince).toBe(1_000);
    expect(lastActiveAt).toBe(5_000);
  });

  it('takes lastActiveAt from an exit when that is the most recent thing that happened', () => {
    const rows = [
      makeRow({
        sessionId: 'a',
        activity: 'idle',
        activityReason: { kind: 'idle', since: 1_000 },
      }),
      makeRow({ sessionId: 'b', status: 'exited', exitedAt: '1970-01-01T00:00:09.000Z' }),
    ];
    expect(summarize(rows).lastActiveAt).toBe(9_000);
  });

  it('reports no lastActiveAt when nothing records when it stopped', () => {
    // A paused session carries no such timestamp, so the tile shows nothing rather
    // than inventing a time.
    expect(summarize([makeRow({ status: 'suspended' })]).lastActiveAt).toBeNull();
    expect(summarize([]).lastActiveAt).toBeNull();
  });
});
