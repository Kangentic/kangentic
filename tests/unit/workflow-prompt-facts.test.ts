/**
 * `readWorkflowPromptFacts` (src/main/workflows/workflow-prompt-facts.ts) reads
 * what `{{workflow_xml}}` tells a workflow task's agent.
 *
 * A workflow's home and the far end of each of its links are ids that other
 * records stored, so they can outlive their project. Reading one must never
 * create a database for it: `getProjectDb` on main creates, migrates and seeds
 * an empty file for any id it is given, which would resurrect a deleted project
 * as a ghost. A far end that is gone drops out of the facts; a home that is gone
 * leaves no facts at all.
 *
 * Real files in the per-file temp data directory, through the real
 * `getProjectDb`: whether a file got created is the thing under test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { PATHS } from '../../src/main/config/paths';
import { getProjectDb, closeAll } from '../../src/main/db/database';
import { TaskRepository } from '../../src/main/db/repositories/task-repository';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { WorkflowRepository } from '../../src/main/db/repositories/workflow-repository';
import { TaskLinkRepository } from '../../src/main/db/repositories/task-link-repository';
import { readWorkflowPromptFacts } from '../../src/main/workflows/workflow-prompt-facts';
import type { Task } from '../../src/shared/types';

const PROJECT_IDS = ['home', 'member', 'idle', 'missing'];

const dbFiles = (projectId: string) => ['', '-wal', '-shm'].map((suffix) => PATHS.projectDb(projectId) + suffix);
const filesPresent = (projectId: string) => dbFiles(projectId).filter((file) => fs.existsSync(file)).length;

function laneOf(projectId: string, name: string): string {
  return new SwimlaneRepository(getProjectDb(projectId)).list().find((lane) => lane.name === name)!.id;
}

/** A task on `projectId`'s board, in `laneName`, a member of `workflowId` homed at `homeProjectId`. */
function workflowTask(projectId: string, laneName: string, title: string, workflowId: string, homeProjectId: string): Task {
  return new TaskRepository(getProjectDb(projectId)).create({
    title,
    description: '',
    swimlane_id: laneOf(projectId, laneName),
    workflow: {
      workflow_id: workflowId,
      workflow_project_id: homeProjectId,
      route_start_swimlane_id: null,
      route_last_swimlane_id: null,
      skipped_swimlane_ids: [],
      canvas_x: null,
      canvas_y: null,
    },
  });
}

describe('readWorkflowPromptFacts', () => {
  beforeEach(() => {
    closeAll();
    for (const projectId of PROJECT_IDS) {
      for (const file of dbFiles(projectId)) fs.rmSync(file, { force: true });
    }
  });

  afterEach(() => closeAll());

  it('reads the ends of its links that still exist, drops the ones whose project is gone, and creates no database for them', () => {
    const workflows = new WorkflowRepository(getProjectDb('home'));
    const workflow = workflows.create({ title: 'Usage budgets' });
    workflows.markStarted(workflow.id);
    const task = workflowTask('member', 'Executing', 'Budget dashboard', workflow.id, 'home');
    const blocker = workflowTask('idle', 'Done', 'Ship the schema', workflow.id, 'home');
    const dependent = workflowTask('home', 'To Do', 'Wire the settings page', workflow.id, 'home');
    const links = new TaskLinkRepository(getProjectDb('home'));
    links.insert({ workflow_id: workflow.id, blocker_project_id: 'idle', blocker_task_id: blocker.id, blocked_project_id: 'member', blocked_task_id: task.id });
    links.insert({ workflow_id: workflow.id, blocker_project_id: 'member', blocker_task_id: task.id, blocked_project_id: 'home', blocked_task_id: dependent.id });
    // The far ends of two more links are on a project whose file is gone.
    links.insert({ workflow_id: workflow.id, blocker_project_id: 'missing', blocker_task_id: 'removed-blocker', blocked_project_id: 'member', blocked_task_id: task.id });
    links.insert({ workflow_id: workflow.id, blocker_project_id: 'member', blocker_task_id: task.id, blocked_project_id: 'missing', blocked_task_id: 'removed-dependent' });
    expect(filesPresent('missing')).toBe(0);

    const facts = readWorkflowPromptFacts(task, 'member');

    expect(facts).not.toBeNull();
    expect(facts!.title).toBe('Usage budgets');
    expect(facts!.route.at(-1)).toBe('Done');
    expect(facts!.route).toContain('Executing');
    expect(facts!.waitsFor.map(({ number, title, column }) => ({ number, title, column })))
      .toEqual([{ number: blocker.display_id, title: 'Ship the schema', column: 'Done' }]);
    expect(facts!.blocks).toEqual([{ number: dependent.display_id, title: 'Wire the settings page', column: 'To Do' }]);
    expect(filesPresent('missing')).toBe(0);
  });

  it('returns no facts for a task whose workflow home is gone, and creates no database for it', () => {
    const workflowId = new WorkflowRepository(getProjectDb('home')).create({ title: 'Usage budgets' }).id;
    const task = workflowTask('member', 'Executing', 'Budget dashboard', workflowId, 'missing');
    expect(filesPresent('missing')).toBe(0);

    expect(readWorkflowPromptFacts(task, 'member')).toBeNull();

    expect(filesPresent('missing')).toBe(0);
  });
});
