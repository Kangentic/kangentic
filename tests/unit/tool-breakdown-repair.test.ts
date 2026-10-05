/**
 * Real-database tests (node:sqlite behind the better-sqlite3 slice the app
 * uses, migrated with the production schema) for:
 *   - the one-time repair of per-tool durations saved while tool events were
 *     paired by name (`repairToolBreakdownDurations`), driven by the real event
 *     log replay (`replayToolBreakdowns`) over temp directories;
 *   - `SessionRepository.updateTranscriptToolCounts`, whose merge of transcript
 *     `resultTokens` onto a healthy live breakdown is otherwise covered only by
 *     mock-database tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import type DatabaseType from 'better-sqlite3';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { TaskRepository } from '../../src/main/db/repositories/task-repository';
import { SessionRepository } from '../../src/main/db/repositories/session-repository';
import {
  repairToolBreakdownDurations,
  toolBreakdownRepairRan,
  type ToolBreakdownReplay,
} from '../../src/main/ipc/helpers/tool-breakdown-repair';
import { replayToolBreakdowns } from '../../src/main/activity-engine/tool-breakdown-replay';
import type { PerToolStat, SessionRecordStatus } from '../../src/shared/types';
import { adaptDatabase } from './helpers/node-sqlite-database';

/** A sanitized capture of a real session's events.jsonl, id-paired, with one permission prompt. */
const REAL_EVENT_LOG_FIXTURE = path.join(__dirname, '..', 'fixtures', 'replay', 'session-010-subagent-permission-resume.jsonl');

type SqliteModule = typeof import('node:sqlite');
let sqlite: SqliteModule | null = null;
try {
  sqlite = await import('node:sqlite');
} catch {
  sqlite = null;
}
const describeWithSqlite = sqlite ? describe : describe.skip;

function migratedDatabase(): DatabaseType.Database {
  const database = adaptDatabase(new sqlite!.DatabaseSync(':memory:'));
  runProjectMigrations(database);
  return database;
}

function insertRecord(
  database: DatabaseType.Database,
  recordId: string,
  status: SessionRecordStatus,
  breakdown: PerToolStat[] | null,
  toolCallCount: number,
): void {
  const laneId = (database.prepare('SELECT id FROM swimlanes LIMIT 1').get() as { id: string }).id;
  const task = new TaskRepository(database).create({ title: `Task for ${recordId}`, description: '', swimlane_id: laneId });
  new SessionRepository(database).insert({
    id: recordId,
    task_id: task.id,
    session_type: 'claude_agent',
    isolated_swimlane_id: null,
    agent_session_id: null,
    command: 'claude',
    cwd: '/mock/project',
    permission_mode: null,
    prompt: null,
    status,
    exit_code: status === 'exited' ? 0 : null,
    started_at: new Date().toISOString(),
    suspended_at: null,
    exited_at: null,
    suspended_by: null,
  });
  database.prepare('UPDATE sessions SET tool_breakdown = ?, tool_call_count = ? WHERE id = ?')
    .run(breakdown ? JSON.stringify(breakdown) : null, toolCallCount, recordId);
}

function storedBreakdown(database: DatabaseType.Database, recordId: string): PerToolStat[] {
  const row = database.prepare('SELECT tool_breakdown FROM sessions WHERE id = ?').get(recordId) as { tool_breakdown: string | null };
  return row.tool_breakdown ? (JSON.parse(row.tool_breakdown) as PerToolStat[]) : [];
}

/** The `tool_breakdown` column exactly as stored, for byte-for-byte comparisons. */
function rawBreakdown(database: DatabaseType.Database, recordId: string): string | null {
  const row = database.prepare('SELECT tool_breakdown FROM sessions WHERE id = ?').get(recordId) as { tool_breakdown: string | null };
  return row.tool_breakdown;
}

/** Overwrite the column with arbitrary text, which `insertRecord`'s typed rows cannot express. */
function setRawBreakdown(database: DatabaseType.Database, recordId: string, raw: string): void {
  database.prepare('UPDATE sessions SET tool_breakdown = ? WHERE id = ?').run(raw, recordId);
}

/** A log where a denied Bash start never ends, then three 100ms Bash calls 10s apart, and one Read. */
function writeInflatingLog(sessionsDir: string, recordId: string): void {
  const directory = path.join(sessionsDir, recordId);
  fs.mkdirSync(directory, { recursive: true });
  const events = [
    { ts: 0, type: 'tool_start', tool: 'Bash', toolId: 'denied' },
    { ts: 10_000, type: 'tool_start', tool: 'Bash', toolId: 'b1' },
    { ts: 10_100, type: 'tool_end', tool: 'Bash', toolId: 'b1' },
    { ts: 20_000, type: 'tool_start', tool: 'Bash', toolId: 'b2' },
    { ts: 20_100, type: 'tool_end', tool: 'Bash', toolId: 'b2' },
    { ts: 30_000, type: 'tool_start', tool: 'Bash', toolId: 'b3' },
    { ts: 30_100, type: 'tool_end', tool: 'Bash', toolId: 'b3' },
    { ts: 31_000, type: 'tool_start', tool: 'Read', toolId: 'r1' },
    { ts: 31_300, type: 'tool_end', tool: 'Read', toolId: 'r1' },
  ];
  fs.writeFileSync(path.join(directory, 'events.jsonl'), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
}

/** What name pairing saved for that log: each Bash end paired with the previous start. */
const INFLATED: PerToolStat[] = [
  { toolName: 'Bash', callCount: 3, totalDurationMs: 30_300, interruptedCount: 0, resultTokens: 900 },
  { toolName: 'Read', callCount: 1, totalDurationMs: 300, interruptedCount: 0, resultTokens: 1_400 },
];

describeWithSqlite('repairToolBreakdownDurations (real database, real replay)', () => {
  let database: DatabaseType.Database;
  let sessionsDir: string;

  beforeEach(() => {
    database = migratedDatabase();
    sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-breakdown-repair-'));
  });

  afterEach(() => {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  });

  it('corrects an inflated duration and keeps counts and resultTokens as stored', async () => {
    insertRecord(database, 'rec-inflated', 'exited', INFLATED, 4);
    writeInflatingLog(sessionsDir, 'rec-inflated');

    const result = await repairToolBreakdownDurations(database, sessionsDir, replayToolBreakdowns);

    expect(result).toEqual({ completed: true, scanned: 1, repaired: 1 });
    expect(storedBreakdown(database, 'rec-inflated')).toEqual([
      { toolName: 'Bash', callCount: 3, totalDurationMs: 300, interruptedCount: 0, resultTokens: 900 },
      { toolName: 'Read', callCount: 1, totalDurationMs: 300, interruptedCount: 0, resultTokens: 1_400 },
    ]);
    expect(toolBreakdownRepairRan(database)).toBe(true);
  });

  it('writes the waited count with the corrected duration, leaving the wait out of it', async () => {
    // A plan approval: ExitPlanMode starts, the permission prompt follows, and
    // the user answers 9 minutes later. Name pairing saved all of it as time.
    const directory = path.join(sessionsDir, 'rec-waited');
    fs.mkdirSync(directory, { recursive: true });
    const events = [
      { ts: 0, type: 'tool_start', tool: 'Read', toolId: 'r1' },
      { ts: 200, type: 'tool_end', tool: 'Read', toolId: 'r1' },
      { ts: 1_000, type: 'tool_start', tool: 'ExitPlanMode', toolId: 'p1' },
      { ts: 1_100, type: 'idle', detail: 'permission' },
      { ts: 541_000, type: 'tool_end', tool: 'ExitPlanMode', toolId: 'p1' },
    ];
    fs.writeFileSync(path.join(directory, 'events.jsonl'), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
    insertRecord(database, 'rec-waited', 'exited', [
      { toolName: 'ExitPlanMode', callCount: 1, totalDurationMs: 540_000, interruptedCount: 0 },
      { toolName: 'Read', callCount: 1, totalDurationMs: 200, interruptedCount: 0 },
    ], 2);

    const result = await repairToolBreakdownDurations(database, sessionsDir, replayToolBreakdowns);

    expect(result.repaired).toBe(1);
    expect(storedBreakdown(database, 'rec-waited')).toEqual([
      { toolName: 'ExitPlanMode', callCount: 1, totalDurationMs: 0, interruptedCount: 0, waitedCount: 1 },
      { toolName: 'Read', callCount: 1, totalDurationMs: 200, interruptedCount: 0 },
    ]);
  });

  it('leaves a row alone when the replay saw a different number of calls', async () => {
    // Stored Bash says 5 calls, the log has 3: not the same events, so no patch.
    insertRecord(database, 'rec-mismatch', 'exited', [
      { toolName: 'Bash', callCount: 5, totalDurationMs: 99_999, interruptedCount: 0 },
      { toolName: 'Read', callCount: 1, totalDurationMs: 300, interruptedCount: 0 },
    ], 6);
    writeInflatingLog(sessionsDir, 'rec-mismatch');

    const result = await repairToolBreakdownDurations(database, sessionsDir, replayToolBreakdowns);

    expect(result.repaired).toBe(0);
    expect(storedBreakdown(database, 'rec-mismatch')[0].totalDurationMs).toBe(99_999);
  });

  it('skips a running record and a record with no log', async () => {
    insertRecord(database, 'rec-running', 'running', INFLATED, 4);
    writeInflatingLog(sessionsDir, 'rec-running');
    insertRecord(database, 'rec-no-log', 'exited', INFLATED, 4);

    const result = await repairToolBreakdownDurations(database, sessionsDir, replayToolBreakdowns);

    expect(result).toEqual({ completed: true, scanned: 1, repaired: 0 });
    expect(storedBreakdown(database, 'rec-running')[0].totalDurationMs).toBe(30_300);
    expect(storedBreakdown(database, 'rec-no-log')[0].totalDurationMs).toBe(30_300);
  });

  it('runs once: a second call changes nothing and replays nothing', async () => {
    insertRecord(database, 'rec-once', 'exited', INFLATED, 4);
    writeInflatingLog(sessionsDir, 'rec-once');
    await repairToolBreakdownDurations(database, sessionsDir, replayToolBreakdowns);

    let replayCalls = 0;
    const countingReplay: ToolBreakdownReplay = async (directory, ids) => {
      replayCalls += 1;
      return replayToolBreakdowns(directory, ids);
    };
    const second = await repairToolBreakdownDurations(database, sessionsDir, countingReplay);

    expect(second).toEqual({ completed: true, scanned: 0, repaired: 0 });
    expect(replayCalls).toBe(0);
  });

  it('leaves the flag unset when a batch fails, so the next open retries', async () => {
    insertRecord(database, 'rec-retry', 'exited', INFLATED, 4);
    const failingReplay: ToolBreakdownReplay = async () => {
      throw new Error('The retrieval worker is restarting');
    };

    const result = await repairToolBreakdownDurations(database, sessionsDir, failingReplay);

    expect(result.completed).toBe(false);
    expect(toolBreakdownRepairRan(database)).toBe(false);
    expect(storedBreakdown(database, 'rec-retry')[0].totalDurationMs).toBe(30_300);
  });
});

describe('replayToolBreakdowns', () => {
  let sessionsDir: string;

  beforeEach(() => {
    sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-breakdown-replay-'));
  });

  afterEach(() => {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  });

  it('rebuilds a breakdown with id pairing and leaves out ids it cannot read', async () => {
    writeInflatingLog(sessionsDir, 'rec-a');
    const replayed = await replayToolBreakdowns(sessionsDir, ['rec-a', 'rec-missing', '../escape']);
    expect(Object.keys(replayed)).toEqual(['rec-a']);
    expect(replayed['rec-a']).toEqual([
      { toolName: 'Bash', callCount: 3, totalDurationMs: 300, interruptedCount: 0 },
      { toolName: 'Read', callCount: 1, totalDurationMs: 300, interruptedCount: 0 },
    ]);
  });

  // The cases above write their own events, so none of them shows that the field
  // names and literals replay reads (`ts`, `type`, `tool`, `toolId`, 'tool_start',
  // 'tool_end', 'idle', detail 'permission') are what event-bridge.js really
  // writes. This one replays a sanitized capture of a real session and asserts
  // properties derived from the capture itself, never the numbers the code emits.
  // Limit: a positive duration does not prove the `toolId` field name by itself,
  // because the name-FIFO fallback also yields positive durations here; the
  // id-pairing is pinned by the synthetic cases above.
  it('replays a real captured event log: durations stay inside the session, and the permission-waited call is counted but not timed', async () => {
    interface CapturedEvent { ts: number; type: string; tool?: string; toolId?: string; detail?: string }
    const fixtureText = fs.readFileSync(REAL_EVENT_LOG_FIXTURE, 'utf-8');
    const events = fixtureText
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as CapturedEvent);
    const sessionId = 'real-capture-010';
    fs.mkdirSync(path.join(sessionsDir, sessionId), { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, sessionId, 'events.jsonl'), fixtureText);

    const replayed = await replayToolBreakdowns(sessionsDir, [sessionId]);

    expect(Object.keys(replayed)).toEqual([sessionId]);
    const rows = replayed[sessionId];
    const wallSpanMs = events[events.length - 1].ts - events[0].ts;
    expect(wallSpanMs).toBeGreaterThan(0);

    // Some tool ran and took measurable time, and none outlasted the session.
    expect(rows.some((row) => row.callCount > 0 && row.totalDurationMs > 0)).toBe(true);
    for (const row of rows) {
      expect(row.totalDurationMs).toBeGreaterThanOrEqual(0);
      expect(row.totalDurationMs).toBeLessThan(wallSpanMs);
    }

    // Every tool_end line in the capture is one counted call.
    const toolEndLines = events.filter((event) => event.type === 'tool_end').length;
    expect(toolEndLines).toBeGreaterThan(0);
    expect(rows.reduce((total, row) => total + row.callCount, 0)).toBe(toolEndLines);

    // The call the permission prompt interrupted: the newest tool still pending
    // when the idle arrived. It is counted as waited and its time is left out.
    const permissionIdleIndex = events.findIndex((event) => event.type === 'idle' && event.detail === 'permission');
    expect(permissionIdleIndex).toBeGreaterThan(-1);
    const beforeIdle = events.slice(0, permissionIdleIndex);
    const endedBeforeIdle = new Set(beforeIdle.filter((event) => event.type === 'tool_end').map((event) => event.toolId));
    const pendingAtIdle = beforeIdle.filter((event) => event.type === 'tool_start' && !endedBeforeIdle.has(event.toolId));
    const awaitedStart = pendingAtIdle[pendingAtIdle.length - 1];
    expect(awaitedStart).toBeDefined();
    const awaitedEnd = events.find((event) => event.type === 'tool_end' && event.toolId === awaitedStart.toolId);
    expect(awaitedEnd).toBeDefined();
    const waitedRunMs = awaitedEnd!.ts - awaitedStart.ts;
    expect(waitedRunMs).toBeGreaterThan(0);

    const awaitedRow = rows.find((row) => row.toolName === awaitedStart.tool);
    expect(awaitedRow).toBeDefined();
    expect(awaitedRow!.waitedCount).toBeGreaterThanOrEqual(1);
    expect(awaitedRow!.totalDurationMs).toBeLessThan(waitedRunMs);

    // One permission prompt in the capture, one waited call across all rows.
    const permissionIdles = events.filter((event) => event.type === 'idle' && event.detail === 'permission').length;
    expect(rows.reduce((total, row) => total + (row.waitedCount ?? 0), 0)).toBe(permissionIdles);
  });
});

describeWithSqlite('SessionRepository.updateTranscriptToolCounts (real database)', () => {
  let database: DatabaseType.Database;

  beforeEach(() => {
    database = migratedDatabase();
  });

  it('merges resultTokens onto a healthy live breakdown and keeps the live count', () => {
    insertRecord(database, 'rec-live', 'exited', [
      { toolName: 'Read', callCount: 40, totalDurationMs: 12_000, interruptedCount: 1 },
      { toolName: 'Bash', callCount: 9, totalDurationMs: 30_000, interruptedCount: 0 },
    ], 49);

    new SessionRepository(database).updateTranscriptToolCounts('rec-live', {
      toolCallCount: 35,
      toolBreakdown: [{ toolName: 'Read', callCount: 35, totalDurationMs: 0, interruptedCount: 0, resultTokens: 41_000 }],
    });

    const row = database.prepare('SELECT tool_call_count FROM sessions WHERE id = ?').get('rec-live') as { tool_call_count: number };
    expect(row.tool_call_count).toBe(49);
    expect(storedBreakdown(database, 'rec-live')).toEqual([
      { toolName: 'Read', callCount: 40, totalDurationMs: 12_000, interruptedCount: 1, resultTokens: 41_000 },
      { toolName: 'Bash', callCount: 9, totalDurationMs: 30_000, interruptedCount: 0 },
    ]);
  });

  it('writes the transcript rows outright over an empty live count', () => {
    insertRecord(database, 'rec-empty', 'suspended', null, 0);

    new SessionRepository(database).updateTranscriptToolCounts('rec-empty', {
      toolCallCount: 2,
      toolBreakdown: [{ toolName: 'Read', callCount: 2, totalDurationMs: 0, interruptedCount: 0, resultTokens: 800 }],
    });

    const row = database.prepare('SELECT tool_call_count FROM sessions WHERE id = ?').get('rec-empty') as { tool_call_count: number };
    expect(row.tool_call_count).toBe(2);
    expect(storedBreakdown(database, 'rec-empty')).toEqual([
      { toolName: 'Read', callCount: 2, totalDurationMs: 0, interruptedCount: 0, resultTokens: 800 },
    ]);
  });

  it('leaves a stored array holding a malformed entry byte-identical instead of rewriting it without that entry', () => {
    // A healthy live count, so the merge branch runs. The second entry fails the
    // shape guard (callCount is a string); a writer that read through the
    // filtering parser would save the array back without it.
    insertRecord(database, 'rec-malformed', 'exited', null, 12);
    const storedRaw = JSON.stringify([
      { toolName: 'Read', callCount: 10, totalDurationMs: 4_000, interruptedCount: 0 },
      { toolName: 'X', callCount: 'bad', totalDurationMs: 0, interruptedCount: 0 },
    ]);
    setRawBreakdown(database, 'rec-malformed', storedRaw);

    new SessionRepository(database).updateTranscriptToolCounts('rec-malformed', {
      toolCallCount: 10,
      toolBreakdown: [{ toolName: 'Read', callCount: 10, totalDurationMs: 0, interruptedCount: 0, resultTokens: 5_000 }],
    });

    expect(rawBreakdown(database, 'rec-malformed')).toBe(storedRaw);
    const row = database.prepare('SELECT tool_call_count FROM sessions WHERE id = ?').get('rec-malformed') as { tool_call_count: number };
    expect(row.tool_call_count).toBe(12);
  });

  it('merges the same transcript tokens when the stored array is entirely well formed (control for the malformed case)', () => {
    insertRecord(database, 'rec-wellformed', 'exited', [
      { toolName: 'Read', callCount: 10, totalDurationMs: 4_000, interruptedCount: 0 },
    ], 12);

    new SessionRepository(database).updateTranscriptToolCounts('rec-wellformed', {
      toolCallCount: 10,
      toolBreakdown: [{ toolName: 'Read', callCount: 10, totalDurationMs: 0, interruptedCount: 0, resultTokens: 5_000 }],
    });

    expect(storedBreakdown(database, 'rec-wellformed')).toEqual([
      { toolName: 'Read', callCount: 10, totalDurationMs: 4_000, interruptedCount: 0, resultTokens: 5_000 },
    ]);
  });
});

describeWithSqlite('SessionRepository.patchToolBreakdownDurations (real database)', () => {
  let database: DatabaseType.Database;
  let repository: SessionRepository;

  /** What a replay of a log with 3 quick Bash calls and no permission prompts reports. */
  const REPLAYED_WITHOUT_WAITS: PerToolStat[] = [
    { toolName: 'Bash', callCount: 3, totalDurationMs: 300, interruptedCount: 0 },
  ];

  beforeEach(() => {
    database = migratedDatabase();
    repository = new SessionRepository(database);
  });

  it('leaves a stored array holding an entry the shape guard rejects whole, and reports no change', () => {
    insertRecord(database, 'rec-guard', 'exited', null, 4);
    const storedRaw = JSON.stringify([
      { toolName: 'Bash', callCount: 3, totalDurationMs: 30_300, interruptedCount: 0 },
      { toolName: 'X', callCount: 'bad', totalDurationMs: 0, interruptedCount: 0 },
    ]);
    setRawBreakdown(database, 'rec-guard', storedRaw);

    // The replay would correct Bash's duration if the row were patchable.
    expect(repository.patchToolBreakdownDurations('rec-guard', REPLAYED_WITHOUT_WAITS)).toBe(false);
    expect(rawBreakdown(database, 'rec-guard')).toBe(storedRaw);
  });

  it('patches the same replay onto an entirely well formed array (control for the shape-guard case)', () => {
    insertRecord(database, 'rec-control', 'exited', [
      { toolName: 'Bash', callCount: 3, totalDurationMs: 30_300, interruptedCount: 0 },
    ], 3);

    expect(repository.patchToolBreakdownDurations('rec-control', REPLAYED_WITHOUT_WAITS)).toBe(true);
    expect(storedBreakdown(database, 'rec-control')).toEqual([
      { toolName: 'Bash', callCount: 3, totalDurationMs: 300, interruptedCount: 0 },
    ]);
  });

  it('drops a stored waitedCount the replay no longer sees, with the corrected duration', async () => {
    // A log with no permission prompts, whose Bash call count matches the stored 3.
    const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-breakdown-waited-'));
    try {
      writeInflatingLog(sessionsDir, 'rec-stale-wait');
      insertRecord(database, 'rec-stale-wait', 'exited', [
        { toolName: 'Bash', callCount: 3, totalDurationMs: 30_300, interruptedCount: 0, waitedCount: 2 },
        { toolName: 'Read', callCount: 1, totalDurationMs: 300, interruptedCount: 0 },
      ], 4);

      const result = await repairToolBreakdownDurations(database, sessionsDir, replayToolBreakdowns);

      expect(result.repaired).toBe(1);
      const [bash, read] = storedBreakdown(database, 'rec-stale-wait');
      expect(bash.toolName).toBe('Bash');
      expect(bash.totalDurationMs).toBe(300);
      expect(bash).not.toHaveProperty('waitedCount');
      expect(read).toEqual({ toolName: 'Read', callCount: 1, totalDurationMs: 300, interruptedCount: 0 });
    } finally {
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  it('drops a stale waitedCount even when the duration already matches the replay', () => {
    // Only the waitedCount differs, so the row changes on that alone.
    insertRecord(database, 'rec-wait-only', 'exited', [
      { toolName: 'Bash', callCount: 3, totalDurationMs: 300, interruptedCount: 0, waitedCount: 2 },
    ], 3);

    expect(repository.patchToolBreakdownDurations('rec-wait-only', REPLAYED_WITHOUT_WAITS)).toBe(true);
    const [bash] = storedBreakdown(database, 'rec-wait-only');
    expect(bash.totalDurationMs).toBe(300);
    expect(bash).not.toHaveProperty('waitedCount');
  });

  it('does not report a change when the stored row already equals the replay, waitedCount included', () => {
    insertRecord(database, 'rec-equal', 'exited', [
      { toolName: 'Bash', callCount: 3, totalDurationMs: 300, interruptedCount: 0, waitedCount: 1 },
    ], 3);
    const before = rawBreakdown(database, 'rec-equal');

    const replayedWithWait: PerToolStat[] = [{ ...REPLAYED_WITHOUT_WAITS[0], waitedCount: 1 }];
    expect(repository.patchToolBreakdownDurations('rec-equal', replayedWithWait)).toBe(false);
    expect(rawBreakdown(database, 'rec-equal')).toBe(before);
  });

  it.each([
    ['unparseable JSON', '{"toolName": "Bash", '],
    ['a JSON value that is not an array', '{"toolName":"Bash","callCount":3,"totalDurationMs":30300,"interruptedCount":0}'],
    ['an empty array', '[]'],
  ])('leaves a column holding %s alone without throwing', (_label, storedRaw) => {
    insertRecord(database, 'rec-unreadable', 'exited', null, 3);
    setRawBreakdown(database, 'rec-unreadable', storedRaw);

    expect(() => repository.patchToolBreakdownDurations('rec-unreadable', REPLAYED_WITHOUT_WAITS)).not.toThrow();
    expect(repository.patchToolBreakdownDurations('rec-unreadable', REPLAYED_WITHOUT_WAITS)).toBe(false);
    expect(rawBreakdown(database, 'rec-unreadable')).toBe(storedRaw);
  });

  it('does nothing for a record with no stored breakdown or no such record', () => {
    insertRecord(database, 'rec-null', 'exited', null, 0);

    expect(repository.patchToolBreakdownDurations('rec-null', REPLAYED_WITHOUT_WAITS)).toBe(false);
    expect(rawBreakdown(database, 'rec-null')).toBeNull();
    expect(repository.patchToolBreakdownDurations('rec-absent', REPLAYED_WITHOUT_WAITS)).toBe(false);
  });
});
