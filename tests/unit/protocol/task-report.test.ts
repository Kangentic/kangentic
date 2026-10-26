/**
 * The phone's guard for a `get_task_report` result (`parseTaskReportWire`,
 * capabilities/task-report.ts). The desktop side of the same shape is held by
 * tests/unit/get-task-report-command.test.ts, which runs every result it
 * builds through this parser.
 */
import { describe, expect, it } from 'vitest';
import { parseTaskReportWire, type JsonValue, type TaskReportWire } from '@kangentic/protocol';

const FULL_REPORT: TaskReportWire = {
  taskId: '6f1c2a90-0000-4000-8000-000000000001',
  startedAt: '2026-10-20T09:04:00.000Z',
  endedAt: '2026-10-20T11:03:00.000Z',
  route: [{
    swimlaneId: 'executing',
    name: 'Executing',
    color: '#888888',
    icon: 'code',
    role: null,
    totalMs: 3_540_000,
    visits: [{ startedAt: '2026-10-20T09:24:00.000Z', durationMs: 3_540_000 }],
    visitCount: 1,
  }],
  commits: [{ sha: 'b'.repeat(40), subject: 'Add the report read', committedAt: '2026-10-20T10:40:00.000Z' }],
  commitCount: 4,
  changes: {
    files: [
      { path: 'src/report.ts', status: 'M', insertions: 120, deletions: 4, binary: false },
      { path: 'src/new-name.ts', status: 'R', insertions: 10, deletions: 2, oldPath: 'src/old-name.ts', binary: false },
    ],
    fileCount: 2,
    totals: { insertions: 130, deletions: 6, filesChanged: 2 },
    emptyReason: null,
  },
  changesError: null,
  summaryState: { kind: 'written', text: 'Gave the phone the completed report.' },
};

const FULL_CHANGES = FULL_REPORT.changes as NonNullable<TaskReportWire['changes']>;

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

describe('parseTaskReportWire', () => {
  it('round-trips a full report', () => {
    expect(parseTaskReportWire(asJson(FULL_REPORT))).toEqual(FULL_REPORT);
  });

  it('reads sections the desktop could not fill as null', () => {
    const report = { ...FULL_REPORT, commits: null, commitCount: null, changes: null, changesError: 'git failed' };
    expect(parseTaskReportWire(asJson(report))).toEqual(report);
  });

  it('reads an absent count as the length of its list', () => {
    const { commitCount: _commitCount, ...withoutCommitCount } = FULL_REPORT;
    const parsed = parseTaskReportWire(asJson(withoutCommitCount));
    expect(parsed.commitCount).toBe(1);
  });

  it('ignores an unknown field instead of failing', () => {
    expect(() => parseTaskReportWire(asJson({ ...FULL_REPORT, addedLater: { nested: true } }))).not.toThrow();
  });

  it('reads a file status a newer desktop adds as modified, keeping the file', () => {
    const report = asJson({ ...FULL_REPORT, changes: { ...FULL_REPORT.changes, files: [{ path: 'a.ts', status: 'X', insertions: 1, deletions: 0, binary: false }] } });
    expect(parseTaskReportWire(report).changes?.files).toEqual([{ path: 'a.ts', status: 'M', insertions: 1, deletions: 0, binary: false }]);
  });

  it('reads a summary kind a newer desktop adds, or a written one with no text, as pending', () => {
    expect(parseTaskReportWire(asJson({ ...FULL_REPORT, summaryState: { kind: 'failed' } })).summaryState).toEqual({ kind: 'pending' });
    expect(parseTaskReportWire(asJson({ ...FULL_REPORT, summaryState: { kind: 'written' } })).summaryState).toEqual({ kind: 'pending' });
  });

  it('reads an unknown empty reason as null', () => {
    const report = asJson({ ...FULL_REPORT, changes: { ...FULL_REPORT.changes, emptyReason: 'something-new' } });
    expect(parseTaskReportWire(report).changes?.emptyReason).toBeNull();
  });

  it('throws on a payload that is not an object, or is missing its task id or route', () => {
    expect(() => parseTaskReportWire('report')).toThrow('task report must be an object');
    const { taskId: _taskId, ...withoutTaskId } = FULL_REPORT;
    expect(() => parseTaskReportWire(asJson(withoutTaskId))).toThrow('"taskId"');
    const { route: _route, ...withoutRoute } = FULL_REPORT;
    expect(() => parseTaskReportWire(asJson(withoutRoute))).toThrow('"route"');
  });

  it('throws on a malformed route column, commit or file', () => {
    expect(() => parseTaskReportWire(asJson({ ...FULL_REPORT, route: [{ name: 'Executing' }] }))).toThrow('route column 0');
    expect(() => parseTaskReportWire(asJson({ ...FULL_REPORT, commits: [{ sha: 'abc' }] }))).toThrow('commit 0');
    const badFile = { ...FULL_REPORT, changes: { ...FULL_REPORT.changes, files: [{ path: 'a.ts', status: 'M' }] } };
    expect(() => parseTaskReportWire(asJson(badFile))).toThrow('file 0');
  });

  describe('an absent count in the route and the changes', () => {
    it('reads a route column with no visitCount as the length of its visits', () => {
      const { visitCount: _visitCount, ...columnWithoutVisitCount } = FULL_REPORT.route[0];
      const visits = [
        { startedAt: '2026-10-20T09:24:00.000Z', durationMs: 1_000 },
        { startedAt: '2026-10-20T09:40:00.000Z', durationMs: 2_000 },
        { startedAt: '2026-10-20T10:10:00.000Z', durationMs: 3_000 },
      ];
      const report = asJson({ ...FULL_REPORT, route: [{ ...columnWithoutVisitCount, visits }] });
      expect(parseTaskReportWire(report).route[0].visitCount).toBe(3);
    });

    it('keeps a visitCount larger than the visits it lists, because the desktop caps the list', () => {
      const report = asJson({ ...FULL_REPORT, route: [{ ...FULL_REPORT.route[0], visitCount: 40 }] });
      expect(parseTaskReportWire(report).route[0].visitCount).toBe(40);
    });

    it('reads changes with no fileCount as the length of its files', () => {
      const files = [
        { path: 'a.ts', status: 'M', insertions: 3, deletions: 1, binary: false },
        { path: 'b.ts', status: 'A', insertions: 8, deletions: 0, binary: false },
        { path: 'c.ts', status: 'D', insertions: 0, deletions: 5, binary: false },
      ];
      const { fileCount: _fileCount, ...changesWithoutFileCount } = FULL_CHANGES;
      const report = asJson({ ...FULL_REPORT, changes: { ...changesWithoutFileCount, files } });
      expect(parseTaskReportWire(report).changes?.fileCount).toBe(3);
    });

    it('keeps a fileCount larger than the files it lists, because the desktop caps the list', () => {
      const report = asJson({ ...FULL_REPORT, changes: { ...FULL_REPORT.changes, fileCount: 240 } });
      expect(parseTaskReportWire(report).changes?.fileCount).toBe(240);
    });
  });

  describe('a malformed changes section', () => {
    it('throws on totals that lack filesChanged', () => {
      const report = asJson({ ...FULL_REPORT, changes: { ...FULL_REPORT.changes, totals: { insertions: 130, deletions: 6 } } });
      expect(() => parseTaskReportWire(report)).toThrow('task report totals');
      expect(() => parseTaskReportWire(report)).toThrow('"filesChanged"');
    });

    it('reads totals that are not an object as no totals, keeping the files', () => {
      const report = asJson({ ...FULL_REPORT, changes: { ...FULL_REPORT.changes, totals: null } });
      const parsed = parseTaskReportWire(report);
      expect(parsed.changes?.totals).toBeNull();
      expect(parsed.changes?.files).toEqual(FULL_REPORT.changes?.files);
    });

    it('throws on changes that are neither an object nor null', () => {
      expect(() => parseTaskReportWire(asJson({ ...FULL_REPORT, changes: 5 }))).toThrow('must be an object or null');
    });

    it('throws on changes with no files array', () => {
      const { files: _files, ...changesWithoutFiles } = FULL_CHANGES;
      expect(() => parseTaskReportWire(asJson({ ...FULL_REPORT, changes: changesWithoutFiles }))).toThrow('"files"');
    });
  });

  describe('a route column\'s role and icon', () => {
    it('keeps a role string it does not know, so a newer desktop\'s role reaches the phone', () => {
      const report = asJson({ ...FULL_REPORT, route: [{ ...FULL_REPORT.route[0], role: 'future-role' }] });
      expect(parseTaskReportWire(report).route[0].role).toBe('future-role');
    });

    it('reads a role that is not a string as null', () => {
      const report = asJson({ ...FULL_REPORT, route: [{ ...FULL_REPORT.route[0], role: 7 }] });
      expect(parseTaskReportWire(report).route[0].role).toBeNull();
    });

    it('keeps a null icon null, and a null role null', () => {
      const report = asJson({ ...FULL_REPORT, route: [{ ...FULL_REPORT.route[0], icon: null, role: null }] });
      const column = parseTaskReportWire(report).route[0];
      expect(column.icon).toBeNull();
      expect(column.role).toBeNull();
    });
  });

  describe('the summary state', () => {
    it.each([
      { kind: 'off' },
      { kind: 'pending' },
      { kind: 'indexing-off' },
    ])('round-trips $kind unchanged', (summaryState) => {
      expect(parseTaskReportWire(asJson({ ...FULL_REPORT, summaryState })).summaryState).toEqual(summaryState);
    });

    it('reads a missing summaryState as pending', () => {
      const { summaryState: _summaryState, ...withoutSummaryState } = FULL_REPORT;
      expect(parseTaskReportWire(asJson(withoutSummaryState)).summaryState).toEqual({ kind: 'pending' });
    });
  });

  describe('commits the desktop could not read', () => {
    it('reads commits and commitCount as null when commits is absent, even if a commitCount is present', () => {
      const { commits: _commits, ...withoutCommits } = FULL_REPORT;
      expect(withoutCommits.commitCount).toBe(4);
      const parsed = parseTaskReportWire(asJson(withoutCommits));
      expect(parsed.commits).toBeNull();
      expect(parsed.commitCount).toBeNull();
    });

    it('reads commits that are not an array the same way', () => {
      const parsed = parseTaskReportWire(asJson({ ...FULL_REPORT, commits: 'none' }));
      expect(parsed.commits).toBeNull();
      expect(parsed.commitCount).toBeNull();
    });
  });
});
