/**
 * The engine hands a remote project's `run_script` row the host runner.
 *
 * `runAutomationGroup` builds the AutomationContext, and `runOnHost: hostScriptRunner(...)` there is the only thing that
 * sends a remote task's script to its host. remote-run-script.test.ts builds its own context, so a deleted line leaves
 * it green and every script on a remote project runs in the empty stand-in here and records exit 0.
 *
 * Tier: Unit (real better-sqlite3 in memory, a fake HostAccess).
 */

import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import { openTestDatabase } from './helpers/test-database';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { AutomationRepository } from '../../src/main/db/repositories/automation-repository';
import { AutomationRunRepository } from '../../src/main/db/repositories/automation-run-repository';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { setRemoteProjectLookup } from '../../src/main/remote/host-paths';
import { setHostAccessLookup, type HostAccess } from '../../src/main/remote/host-transfer';
import type { HostCommandRequest } from '../../src/main/remote/protocol/messages';
import { TransitionEngine } from '../../src/main/transition-engine/transition-engine';
import type { ColumnAutomation, Swimlane, Task } from '../../src/shared/types';
import { HOST_PROJECT, HOST_WORKTREE, SHELL_FOLDER, STAND_IN_WORKTREE } from './helpers/remote-project-fixture';

const TASK_ID = 'task-remote-script-1';

describe('TransitionEngine runs a remote project\'s script on the host', () => {
  let database: DatabaseType.Database;
  let column: Swimlane;
  let task: Task;
  let scriptRow: ColumnAutomation;
  let hostRequests: HostCommandRequest[];
  let getShell: ReturnType<typeof vi.fn>;

  const access: HostAccess = {
    hostId: 'host-1',
    runCommand: async (request) => {
      hostRequests.push(request);
      return { code: 0, stdout: '', stderr: '', timedOut: false };
    },
    pathPresence: vi.fn(),
    removeFiles: vi.fn(),
    listeningPorts: vi.fn(),
  };

  function engineFor(projectPath: string): TransitionEngine {
    return new TransitionEngine(
      { getShell } as never,
      {} as never,
      { getById: vi.fn(() => task) } as never,
      () => ({ projectId: 'project-1', projectPath, projectName: 'Mock Project', gitConfig: { defaultBaseBranch: 'main' } }) as never,
      undefined,
      { getPathsForTask: vi.fn(() => []) } as never,
      new AutomationRepository(database),
      new AutomationRunRepository(database),
    );
  }

  const options = () => ({ signal: new AbortController().signal, deliverToAgent: async (): Promise<void> => undefined, showNotification: vi.fn() });

  beforeEach(() => {
    database = openTestDatabase();
    database.exec('PRAGMA foreign_keys = ON');
    runProjectMigrations(database);
    const lane = new SwimlaneRepository(database).list().find((candidate) => candidate.name === 'Executing');
    if (!lane) throw new Error('The seeded board has no Executing column');
    column = lane;
    database
      .prepare('INSERT INTO tasks (id, title, description, swimlane_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(TASK_ID, 'Ship it', '', column.id, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    task = {
      id: TASK_ID,
      display_id: 12,
      title: 'Ship it',
      description: '',
      swimlane_id: column.id,
      position: 0,
      agent: 'claude',
      session_id: 'pty-1',
      worktree_path: STAND_IN_WORKTREE,
      branch_name: null,
      labels: [],
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    } as unknown as Task;
    scriptRow = new AutomationRepository(database).replaceForColumn(column.id, [{
      name: 'Build',
      type: 'run_script',
      trigger: 'enter',
      enabled: true,
      config: { script: 'npm test', timeoutMinutes: 1 },
    }])[0];
    hostRequests = [];
    getShell = vi.fn();
    setRemoteProjectLookup((projectPath) => (projectPath === SHELL_FOLDER ? { hostId: 'host-1', path: HOST_PROJECT } : null));
    setHostAccessLookup(() => access);
  });

  afterEach(() => {
    setRemoteProjectLookup(null);
    setHostAccessLookup(null);
    database.close();
  });

  // Without it a remote task's script runs in the stand-in, does nothing, and the run log says it passed.
  it('sends the script to the host in the task\'s host worktree, and starts no shell here', async () => {
    const summary = await engineFor(SHELL_FOLDER).executeSingleAutomation(task, column, scriptRow, options());

    expect(summary.outcomes[0]).toMatchObject({ status: 'succeeded', detail: 'exit 0 on the host' });
    expect(hostRequests).toHaveLength(1);
    expect(hostRequests[0]).toMatchObject({ file: 'sh', cwd: HOST_WORKTREE });
    expect(hostRequests[0].args[3]).toBe('npm test');
    expect(getShell).not.toHaveBeenCalled();
  });

  // Without it a local project's script would be sent to a host it does not have.
  it('leaves a project on this computer to its own shell, asking no host', async () => {
    setHostAccessLookup(() => { throw new Error('a host was asked'); });
    getShell.mockRejectedValue(new Error('local shell reached'));
    const localTask = { ...task, worktree_path: path.resolve('/mock/local-project/.kangentic/worktrees/12') } as Task;

    const summary = await engineFor(path.resolve('/mock/local-project')).executeSingleAutomation(localTask, column, scriptRow, options());

    expect(getShell).toHaveBeenCalledTimes(1);
    expect(summary.outcomes[0].status).toBe('failed');
    expect(hostRequests).toEqual([]);
  });
});
