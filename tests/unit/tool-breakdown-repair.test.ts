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
});
