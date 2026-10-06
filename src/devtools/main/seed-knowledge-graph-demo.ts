/**
 * Dev-only: register the web demo's sample install in a preview as real projects, so the
 * Knowledge Graph the demo shows is built by the shipped pipeline rather than written by hand.
 *
 * The web build (`npm run build:demo`) has no main process, so its graph is a fixture. The
 * parity rule (`.claude/rules/web-demo-parity.md`) wants that fixture derived, never authored, the
 * way the recordings' message trails are: the conversations are the agents' own histories on the
 * machine that recorded the sample install, and everything after that is main's code. This seeder
 * is the one step that is not: it writes the board rows a desktop install would hold (the
 * dataset's tasks and backlog, each recorded session pointing at its agent's history by
 * `agent_session_id` and `cwd`) into one project per sample project, at a repository whose history is the one the
 * demo's History pane shows. Opening each project then runs the real sweep (conversations, task
 * records, commits), the real embedding drain, the real projection pass and the real region
 * naming. scripts/capture-demo-knowledge-graph.mjs drives it and reads the snapshots out.
 *
 * Nothing here spawns an agent. Every task that is not Done lands in To Do, which starts nothing
 * on open, and every session row is already exited.
 *
 * Build-excluded from production (`__KANGENTIC_DEV__`); see
 * `.claude/rules/dev-tooling-build-exclusion.md`.
 */

import crypto from 'node:crypto';
import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { getProjectDb } from '../../main/db/database';
import { agentRegistry } from '../../main/agent/agent-registry';
import { TaskRepository } from '../../main/db/repositories/task-repository';
import { SessionRepository } from '../../main/db/repositories/session-repository';
import { SwimlaneRepository } from '../../main/db/repositories/swimlane-repository';
import { BacklogRepository } from '../../main/db/repositories/backlog-repository';
import { isSamePath } from '../../shared/paths';
import type { DevSeedKnowledgeGraphDemoPlan, DevSeedKnowledgeGraphDemoResult } from '../../shared/types';
import type { IpcContext } from '../../main/ipc/ipc-context';

/** The first value that appears twice in `values`, or undefined when every value is distinct. */
function firstRepeat(values: string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return undefined;
}

/**
 * Write every planned project's rows. The whole plan is checked before the first write, and a
 * plan that fails a check throws with nothing written: a project row already at a planned path (a
 * second seed would double every task, and the graph would carry each conversation twice), two
 * planned projects at one path (the same doubling, from one seed), two sessions pointing at one
 * history (that conversation drawn twice), a project, task or session key the plan carries twice
 * (the id maps would hand one key two rows), an agent with no adapter, tickets not numbered 1 to
 * n, or a session naming a task the plan lacks.
 * A throw after that (a new board with no To Do or Done column, the allocator numbering a task
 * other than the plan does) leaves the rows already written, so restart the preview to seed again.
 */
export function seedKnowledgeGraphDemo(context: Pick<IpcContext, 'projectRepo'>, plan: DevSeedKnowledgeGraphDemoPlan): DevSeedKnowledgeGraphDemoResult {
  // The plan arrives over IPC from a script, so its shape is checked once rather than trusted.
  if (!plan || !Array.isArray(plan.projects)) throw new Error('The demo graph plan carries no projects array');
  const repeatedProjectKey = firstRepeat(plan.projects.map((planned) => planned.key));
  if (repeatedProjectKey !== undefined) throw new Error(`The plan carries project ${repeatedProjectKey} twice`);
  const repeatedHistory = firstRepeat(plan.projects.flatMap((planned) => planned.sessions.flatMap((session) => (session.agentSessionId === null ? [] : [session.agentSessionId]))));
  if (repeatedHistory !== undefined) throw new Error(`The plan points two sessions at the history ${repeatedHistory}, so the graph would draw that conversation twice`);
  for (const [projectIndex, planned] of plan.projects.entries()) {
    if (context.projectRepo.list().some((existing) => isSamePath(existing.path, planned.path))) {
      throw new Error(`A project is already registered at ${planned.path}; restart the preview to seed the demo graph again`);
    }
    const sharedWith = plan.projects.slice(0, projectIndex).find((earlier) => isSamePath(earlier.path, planned.path));
    if (sharedWith) throw new Error(`${planned.name}: the plan puts it at ${planned.path}, where it also puts ${sharedWith.name}`);
    const repeatedTaskKey = firstRepeat(planned.tasks.map((task) => task.key));
    if (repeatedTaskKey !== undefined) throw new Error(`${planned.name}: the plan carries task ${repeatedTaskKey} twice`);
    const repeatedSessionKey = firstRepeat(planned.sessions.map((session) => session.key));
    if (repeatedSessionKey !== undefined) throw new Error(`${planned.name}: the plan carries session ${repeatedSessionKey} twice`);
    const displayIds = planned.tasks.map((task) => task.displayId).sort((left, right) => left - right);
    const gapAt = displayIds.findIndex((displayId, position) => displayId !== position + 1);
    if (gapAt !== -1) throw new Error(`${planned.name}: the plan's tickets are not numbered 1 to ${displayIds.length} (found #${displayIds[gapAt]} at position ${gapAt + 1})`);
    const taskKeys = new Set(planned.tasks.map((task) => task.key));
    for (const session of planned.sessions) {
      if (!agentRegistry.get(session.agent)) throw new Error(`No adapter is registered for agent "${session.agent}"`);
      if (!taskKeys.has(session.taskKey)) throw new Error(`${planned.name}: session ${session.key} names task ${session.taskKey}, which the plan does not carry`);
    }
  }

  const result: DevSeedKnowledgeGraphDemoResult = { projects: [] };
  for (const planned of plan.projects) {
    const project = context.projectRepo.create({ name: planned.name, path: planned.path, default_agent: planned.defaultAgent });
    const projectDatabase = getProjectDb(project.id);
    const lanes = new SwimlaneRepository(projectDatabase).list();
    const todoLane = lanes.find((lane) => lane.role === 'todo');
    const doneLane = lanes.find((lane) => lane.role === 'done');
    if (!todoLane || !doneLane) throw new Error(`${planned.name}: the new board has no To Do or Done column`);

    const taskRepository = new TaskRepository(projectDatabase);
    const taskKeys: Record<string, string> = {};
    const previewTaskIdByKey = new Map<string, string>();
    // Created in ticket order, so the allocator hands each task the number its card prints. The
    // sample install numbers every board from 1 without gaps, and a mismatch is refused rather
    // than re-stamped: it would mean the plan is not the dataset.
    const ordered = [...planned.tasks].sort((left, right) => left.displayId - right.displayId);
    for (const task of ordered) {
      const created = taskRepository.create({
        title: task.title,
        description: task.description,
        labels: task.labels,
        swimlane_id: task.done ? doneLane.id : todoLane.id,
      });
      if (created.display_id !== task.displayId) {
        throw new Error(`${planned.name}: "${task.title}" was numbered #${created.display_id}, the dataset says #${task.displayId}`);
      }
      if (task.archived) taskRepository.archive(created.id);
      taskKeys[created.id] = task.key;
      previewTaskIdByKey.set(task.key, created.id);
    }

    // The backlog is indexed with the tasks as task records, so the Index's count includes it.
    const backlogRepository = new BacklogRepository(projectDatabase);
    for (const item of planned.backlog) {
      backlogRepository.create({ title: item.title, description: item.description, priority: item.priority, labels: item.labels });
    }

    const sessionRepository = new SessionRepository(projectDatabase);
    const sessionKeys: Record<string, string> = {};
    const now = new Date().toISOString();
    for (const session of planned.sessions) {
      // Present: every session's task was checked against the plan before the first write.
      const previewTaskId = previewTaskIdByKey.get(session.taskKey)!;
      // The adapter's own session type, never a name mapped here (agent-adapters-boundary).
      const sessionType = agentRegistry.get(session.agent)?.sessionType ?? '';
      const created = sessionRepository.insert({
        id: crypto.randomUUID(),
        task_id: previewTaskId,
        session_type: sessionType,
        isolated_swimlane_id: null,
        agent_session_id: session.agentSessionId,
        command: '',
        cwd: session.cwd,
        permission_mode: null,
        prompt: null,
        status: 'exited',
        exit_code: 0,
        started_at: now,
        suspended_at: now,
        exited_at: now,
        suspended_by: null,
      });
      sessionKeys[created.id] = session.key;
    }

    result.projects.push({ key: planned.key, projectId: project.id, taskKeys, sessionKeys });
  }
  return result;
}

let devIpcRegistered = false;

export function registerSeedKnowledgeGraphDemoDevIpc(getContext: () => IpcContext | null): void {
  if (devIpcRegistered) return;
  devIpcRegistered = true;
  ipcMain.handle(IPC.DEV_SEED_KNOWLEDGE_GRAPH_DEMO, (_event, plan: DevSeedKnowledgeGraphDemoPlan): DevSeedKnowledgeGraphDemoResult => {
    const context = getContext();
    if (!context) throw new Error('IPC not initialized');
    return seedKnowledgeGraphDemo(context, plan);
  });
}
