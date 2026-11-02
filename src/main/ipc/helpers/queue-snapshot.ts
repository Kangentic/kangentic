import { getOpenProjectDb } from '../../db/database';
import { TaskMoveRepository, type CappedColumnTask } from '../../db/repositories/task-move-repository';
import { TaskRepository } from '../../db/repositories/task-repository';
import { columnKey } from '../../transition-engine/column-capacity';
import { isColumnExempt, type ColumnHolder, type QueuedInput } from '../../pty/session-queue';
import type { QueueColumnLine, QueueSnapshot, QueueTask } from '../../../shared/types';
import type { IpcContext } from '../ipc-context';

export const EMPTY_QUEUE_SNAPSHOT: QueueSnapshot = { columns: [], global: [] };

export interface QueueProjectReads {
  name: string;
  cappedTasks: CappedColumnTask[];
  task(taskId: string): { title: string; displayId: number } | null;
}

/** One project's reads for one snapshot, so each task and each list is read once. */
interface QueueProject {
  name: string;
  capped: Map<string, CappedColumnTask>;
  taskOf(taskId: string): { title: string; displayId: number } | null;
}

function indexProject(reads: QueueProjectReads): QueueProject {
  const tasks = new Map<string, { title: string; displayId: number } | null>();
  return {
    name: reads.name,
    capped: new Map(reads.cappedTasks.map((task) => [task.taskId, task])),
    taskOf: (taskId) => {
      if (!tasks.has(taskId)) tasks.set(taskId, reads.task(taskId));
      return tasks.get(taskId) ?? null;
    },
  };
}

/**
 * Who is waiting and why, for the cards and the task detail. Pure over its
 * reads. A column appears only with a task waiting in it, and lists its holders
 * too, because the task detail shows the running task at the head of the line.
 */
export function buildQueueSnapshot(
  entries: readonly QueuedInput[],
  holders: readonly ColumnHolder[],
  readProject: (projectId: string) => QueueProjectReads | null,
): QueueSnapshot {
  const projects = new Map<string, QueueProject | null>();
  const projectOf = (projectId: string): QueueProject | null => {
    if (!projects.has(projectId)) {
      const reads = readProject(projectId);
      projects.set(projectId, reads ? indexProject(reads) : null);
    }
    return projects.get(projectId) ?? null;
  };
  const toTask = (projectId: string, taskId: string, sessionId: string | null): QueueTask => {
    const project = projectOf(projectId);
    const task = project?.taskOf(taskId) ?? null;
    return { sessionId, taskId, projectId, projectName: project?.name ?? '', title: task?.title ?? null, displayId: task?.displayId ?? null };
  };

  const lines = new Map<string, QueueColumnLine>();
  const enteredAtOf = (projectId: string, taskId: string): string => projectOf(projectId)?.capped.get(taskId)?.enteredAt ?? '';
  for (const entry of entries) {
    if (isColumnExempt(entry)) continue;
    const capped = projectOf(entry.projectId)?.capped.get(entry.taskId);
    if (!capped) continue;
    const key = columnKey(entry.projectId, capped.swimlaneId);
    const line = lines.get(key) ?? {
      projectId: entry.projectId,
      swimlaneId: capped.swimlaneId,
      columnName: capped.swimlaneName,
      maxAgents: capped.maxAgents,
      holders: [],
      waiting: [],
    };
    line.waiting.push(toTask(entry.projectId, entry.taskId, entry.id));
    lines.set(key, line);
  }

  for (const line of lines.values()) {
    const capped = projectOf(line.projectId)?.capped;
    const waitingIds = new Set(line.waiting.map((task) => task.taskId));
    const byEntry = (leftTaskId: string, rightTaskId: string): number =>
      enteredAtOf(line.projectId, leftTaskId).localeCompare(enteredAtOf(line.projectId, rightTaskId));
    line.waiting.sort((left, right) => byEntry(left.taskId, right.taskId));
    line.holders = holders
      .filter((holder) => holder.projectId === line.projectId
        && capped?.get(holder.taskId)?.swimlaneId === line.swimlaneId
        && !waitingIds.has(holder.taskId))
      .sort((left, right) => byEntry(left.taskId, right.taskId))
      .map((holder) => toTask(holder.projectId, holder.taskId, holder.sessionId));
  }

  return {
    columns: [...lines.values()],
    global: entries.map((entry) => toTask(entry.projectId, entry.taskId, entry.id)),
  };
}

/**
 * The line as it stands. An empty queue reads no database, and this runs on
 * session changes, so most calls cost nothing. A project whose database is not
 * open still shows its tasks, by no title, rather than losing their places.
 */
export function readQueueSnapshot(context: IpcContext): QueueSnapshot {
  const entries = context.sessionManager.listQueuedInputs();
  if (entries.length === 0) return EMPTY_QUEUE_SNAPSHOT;
  return buildQueueSnapshot(entries, context.sessionManager.listColumnHolders(), (projectId) => {
    const db = getOpenProjectDb(projectId);
    if (!db) return null;
    const tasks = new TaskRepository(db);
    return {
      name: context.projectRepo.getById(projectId)?.name ?? '',
      cappedTasks: new TaskMoveRepository(db).listCappedColumnTasks(),
      task: (taskId) => {
        const task = tasks.getById(taskId);
        return task ? { title: task.title, displayId: task.display_id } : null;
      },
    };
  });
}
