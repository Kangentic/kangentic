/**
 * What a workflow's agent may read beyond its own project, on real, migrated
 * SQLite and real directories (#732, the user's call: the workflow's projects,
 * plus any registered project it needs, granted automatically):
 * - it reads every other project a task of its workflow is on, and every one it
 *   asked for, and never a checkout that is gone from disk;
 * - a request is granted at once and kept on the workflow, and a running agent
 *   picks it up at its next idle, or at once when it is idle already.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';

const harness = vi.hoisted(() => ({ dbs: new Map<string, unknown>() }));
vi.mock('../../src/main/db/database', () => ({
  getProjectDb: (projectId: string) => {
    const db = harness.dbs.get(projectId);
    if (!db) throw new Error(`No database for ${projectId}`);
    return db;
  },
}));
vi.mock('../../src/main/ipc/handlers/task-move', () => ({ handleTaskMove: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/sessions', () => ({ pauseTaskSession: vi.fn(), resumeTaskSession: vi.fn() }));
vi.mock('../../src/main/ipc/send-to-renderer', () => ({ sendToRenderer: vi.fn() }));

const { runProjectMigrations } = await import('../../src/main/db/migrations/project-schema');
const { WorkflowRepository } = await import('../../src/main/db/repositories/workflow-repository');
const service = await import('../../src/main/workflows/workflow-service');
const agent = await import('../../src/main/workflows/workflow-agent');

import { openTestDatabase } from './helpers/test-database';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

interface FakeSession {
  id: string;
  workflowId: string;
  status: string;
}

describe('the workflow agent\'s reads across projects', () => {
  let root: string;
  let context: IpcContext;
  let sessions: FakeSession[];
  let activity: Record<string, string>;
  let suspend: ReturnType<typeof vi.fn>;
  let paths: Record<string, string>;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-workflow-access-'));
    paths = {};
    for (const name of ['home', 'mobile', 'relay']) {
      paths[name] = path.join(root, name);
      fs.mkdirSync(paths[name]);
    }
    // Registered, but its checkout is gone from disk.
    paths.gone = path.join(root, 'gone');
    harness.dbs.clear();
    for (const projectId of ['home', 'mobile', 'relay', 'gone']) {
      const db = openTestDatabase();
      db.exec('PRAGMA foreign_keys = ON');
      runProjectMigrations(db);
      harness.dbs.set(projectId, db);
    }
    const projects = [
      { id: 'home', name: 'kangentic', path: paths.home },
      { id: 'mobile', name: 'kangentic-mobile', path: paths.mobile },
      { id: 'relay', name: 'kangentic-relay', path: paths.relay },
      { id: 'gone', name: 'old-checkout', path: paths.gone },
    ];
    sessions = [];
    activity = {};
    suspend = vi.fn(async () => undefined);
    context = {
      projectRepo: {
        list: () => projects,
        getById: (id: string) => projects.find((project) => project.id === id),
      },
      sessionManager: {
        listSessions: () => sessions,
        getSessionAgentName: () => 'claude',
        getActivityCache: () => activity,
        suspend,
      },
      boardEvents: { emitBoardChanged: vi.fn() },
      configManager: { load: () => ({}) },
    } as unknown as IpcContext;
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const homeDb = () => harness.dbs.get('home') as Database.Database;
  const read = (workflowId: string) => new WorkflowRepository(homeDb()).getById(workflowId)!;

  it('reads the projects its tasks are on and the ones it asked for, never its own or a missing one', () => {
    const workflow = service.createWorkflow('home', {});
    service.savePlan(context, 'home', workflow.id, {
      tasks: [
        { key: 'app', title: 'Budgets screen', project: 'kangentic-mobile' },
        { key: 'api', title: 'Budgets API' },
      ],
      links: [],
    });
    const repository = new WorkflowRepository(homeDb());
    repository.addAgentReadProject(workflow.id, 'relay');
    repository.addAgentReadProject(workflow.id, 'gone');

    const readable = agent.readableProjectsOf(context, 'home', read(workflow.id));
    expect(readable.map((entry) => entry.name).sort()).toEqual(['kangentic-mobile', 'kangentic-relay']);
    expect(readable.find((entry) => entry.name === 'kangentic-relay')!.path).toBe(paths.relay);
  });

  it('grants a request at once and keeps it; with no agent running, the next start reads it', () => {
    const workflow = service.createWorkflow('home', {});
    expect(agent.requestWorkflowAgentProjectAccess(context, 'home', workflow.id, 'home').when).toBe('home');

    const result = agent.requestWorkflowAgentProjectAccess(context, 'home', workflow.id, 'relay');
    expect(result).toEqual({ name: 'kangentic-relay', path: paths.relay, when: 'next-start' });
    expect(read(workflow.id).agent_read_project_ids).toEqual(['relay']);
  });

  it('restarts a working agent when its turn ends, and an idle one at once', async () => {
    const working = service.createWorkflow('home', {});
    sessions.push({ id: 'session-working', workflowId: working.id, status: 'running' });
    activity['session-working'] = 'thinking';
    expect(agent.requestWorkflowAgentProjectAccess(context, 'home', working.id, 'mobile').when).toBe('next-turn');
    // Nothing is cut short mid-turn.
    await new Promise((resolve) => setImmediate(resolve));
    expect(suspend).not.toHaveBeenCalled();

    const idle = service.createWorkflow('home', {});
    sessions.push({ id: 'session-idle', workflowId: idle.id, status: 'running' });
    activity['session-idle'] = 'idle';
    // The restart's own start fails here (no config in this context) and logs; the suspend is what matters.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(agent.requestWorkflowAgentProjectAccess(context, 'home', idle.id, 'mobile').when).toBe('now');
    await vi.waitFor(() => expect(suspend).toHaveBeenCalledWith('session-idle'));
    errorSpy.mockRestore();
  });
});
