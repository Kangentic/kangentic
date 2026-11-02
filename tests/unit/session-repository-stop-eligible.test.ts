/**
 * SessionRepository.listStopEligiblePausedTasks over a real in-memory database
 * with the project schema: the tasks a low-memory pass may run a project's Stop
 * script for. A pause Kangentic made (`auto`, the idle timeout, or `low_memory`)
 * qualifies; a person's Pause or Stop, a move's suspend and a quit do not, and
 * neither does a task that has moved on to a newer session. Oldest pause first.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import { openTestDatabase } from './helpers/test-database';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { SessionRepository } from '../../src/main/db/repositories/session-repository';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';

const MINUTE = 60_000;
const BASE = Date.parse('2026-01-01T00:00:00.000Z');

function at(minutes: number): string {
  return new Date(BASE + minutes * MINUTE).toISOString();
}

describe('SessionRepository.listStopEligiblePausedTasks', () => {
  let database: DatabaseType.Database;
  let sessions: SessionRepository;
  let laneId: string;
  let nextRecord = 0;

  beforeEach(() => {
    database = openTestDatabase();
    runProjectMigrations(database);
    sessions = new SessionRepository(database);
    laneId = new SwimlaneRepository(database).list().find((candidate) => candidate.role === null)!.id;
    nextRecord = 0;
  });

  afterEach(() => database.close());

  function addTask(taskId: string): void {
    database
      .prepare('INSERT INTO tasks (id, title, description, swimlane_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)')
      .run(taskId, taskId, '', laneId, at(0), at(0));
  }

  function addSession(
    taskId: string,
    options: { status: string; suspendedBy: string | null; startedAtMinutes: number; suspendedAtMinutes?: number },
  ): void {
    nextRecord += 1;
    database
      .prepare(`INSERT INTO sessions (id, task_id, session_type, command, cwd, status, started_at, suspended_at, suspended_by)
        VALUES (?, ?, 'claude_agent', 'claude', '/work', ?, ?, ?, ?)`)
      .run(
        `record-${nextRecord}`,
        taskId,
        options.status,
        at(options.startedAtMinutes),
        options.suspendedAtMinutes === undefined ? null : at(options.suspendedAtMinutes),
        options.suspendedBy,
      );
  }

  it('answers none when nothing is paused', () => {
    expect(sessions.listStopEligiblePausedTasks()).toEqual([]);
  });

  it('answers only the tasks an idle timeout or a low-memory pause parked', () => {
    for (const [taskId, suspendedBy] of [
      ['task-auto', 'auto'],
      ['task-low-memory', 'low_memory'],
      ['task-user', 'user'],
      ['task-system', 'system'],
      ['task-unrecorded', null],
    ] as const) {
      addTask(taskId);
      addSession(taskId, { status: 'suspended', suspendedBy, startedAtMinutes: 1, suspendedAtMinutes: 5 });
    }

    expect(sessions.listStopEligiblePausedTasks().sort()).toEqual(['task-auto', 'task-low-memory']);
  });

  it('leaves out a record that is not suspended, whoever it names', () => {
    addTask('task-exited');
    addSession('task-exited', { status: 'exited', suspendedBy: 'auto', startedAtMinutes: 1, suspendedAtMinutes: 5 });
    addTask('task-running');
    addSession('task-running', { status: 'running', suspendedBy: 'auto', startedAtMinutes: 1 });

    expect(sessions.listStopEligiblePausedTasks()).toEqual([]);
  });

  it('leaves out a task that has a newer session, which is where its pause was lifted', () => {
    addTask('task-resumed');
    addSession('task-resumed', { status: 'suspended', suspendedBy: 'auto', startedAtMinutes: 1, suspendedAtMinutes: 2 });
    addSession('task-resumed', { status: 'running', suspendedBy: null, startedAtMinutes: 10 });
    addTask('task-parked-again');
    addSession('task-parked-again', { status: 'exited', suspendedBy: null, startedAtMinutes: 1 });
    addSession('task-parked-again', { status: 'suspended', suspendedBy: 'low_memory', startedAtMinutes: 10, suspendedAtMinutes: 11 });

    // The resumed task's old pause would sort first if it were counted.
    expect(sessions.listStopEligiblePausedTasks()).toEqual(['task-parked-again']);
  });

  it('puts the task paused longest ago first, whatever order the records were written in', () => {
    for (const [taskId, suspendedBy, suspendedAtMinutes] of [
      ['task-newest', 'auto', 30],
      ['task-oldest', 'low_memory', 10],
      ['task-middle', 'auto', 20],
    ] as const) {
      addTask(taskId);
      addSession(taskId, { status: 'suspended', suspendedBy, startedAtMinutes: 1, suspendedAtMinutes });
    }

    expect(sessions.listStopEligiblePausedTasks()).toEqual(['task-oldest', 'task-middle', 'task-newest']);
  });
});
