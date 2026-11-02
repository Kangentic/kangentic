import type { SpawnSessionInput } from '../../shared/types';
import type { CappedColumnTask } from '../db/repositories/task-move-repository';
import { isColumnExempt, type ColumnHolder, type GatedInput, type QueueGate, type QueuedInput } from '../pty/session-queue';

export interface ColumnCapacityReads {
  /** Tasks in a project's limited columns, or null when its database is not open. */
  listCappedTasks(projectId: string): CappedColumnTask[] | null;
  /** Every agent holding a slot now, across projects. */
  listHolders(): ColumnHolder[];
}

type CappedTasks = Map<string, CappedColumnTask>;

/** One pass's reads, so a walk of the queue costs one statement per project. */
class CapacityView {
  private readonly projects = new Map<string, CappedTasks>();
  private readonly holders: ColumnHolder[];

  constructor(private readonly reads: ColumnCapacityReads) {
    this.holders = reads.listHolders();
  }

  capped(input: Pick<SpawnSessionInput, 'projectId' | 'taskId' | 'transient' | 'workflowId'>): CappedColumnTask | null {
    if (isColumnExempt(input)) return null;
    return this.tasksOf(input.projectId).get(input.taskId) ?? null;
  }

  /** Whether a restart is keeping this task's slot, so its respawn is not a new arrival. */
  keepsSlot(input: GatedInput): boolean {
    return this.holders.some((holder) => holder.sessionId === null
      && holder.projectId === input.projectId
      && holder.taskId === input.taskId);
  }

  /** Agents holding this column, not counting the task asking. */
  occupants(projectId: string, column: CappedColumnTask): number {
    const tasks = this.tasksOf(projectId);
    let count = 0;
    for (const holder of this.holders) {
      if (holder.projectId !== projectId || holder.taskId === column.taskId) continue;
      if (tasks.get(holder.taskId)?.swimlaneId === column.swimlaneId) count++;
    }
    return count;
  }

  private tasksOf(projectId: string): CappedTasks {
    const known = this.projects.get(projectId);
    if (known) return known;
    const listed = this.reads.listCappedTasks(projectId);
    if (!listed) {
      // Only deleting or pruning a project closes its database. Holding its
      // queued tasks for a limit nothing can read would strand them.
      console.warn(`[ColumnCapacity] project ${projectId.slice(0, 8)} is not open; admitting its tasks`);
    }
    const tasks: CappedTasks = new Map((listed ?? []).map((task) => [task.taskId, task]));
    this.projects.set(projectId, tasks);
    return tasks;
  }
}

/**
 * Order a batch of starts so the earliest-entered task in a limited column goes
 * first. Startup fires a project's spawns together, and whichever spawned first
 * would take the slot. Tasks in no limited column keep their relative order.
 */
export function orderByColumnEntry<T extends { task: { id: string } }>(inputs: T[], cappedTasks: CappedColumnTask[]): T[] {
  const enteredAt = new Map(cappedTasks.map((task) => [task.taskId, task.enteredAt]));
  const rank = (input: T): string => enteredAt.get(input.task.id) ?? '';
  return [...inputs].sort((left, right) => rank(left).localeCompare(rank(right)));
}

/**
 * How many more starts a limited column can take: its limit less the tasks in it
 * holding a slot or queued for one. The workflow engine plans with this, so a
 * full column leaves its tasks in To Do, the workflow's durable queue.
 */
export function columnRoom(
  column: { id: string; max_agents: number | null },
  cappedTasks: CappedColumnTask[],
  claimedTaskIds: ReadonlySet<string>,
): number {
  if (column.max_agents === null) return Number.POSITIVE_INFINITY;
  const claims = cappedTasks.filter((task) => task.swimlaneId === column.id && claimedTaskIds.has(task.taskId)).length;
  return Math.max(0, column.max_agents - claims);
}

/** The key of one column across projects. */
export function columnKey(projectId: string, swimlaneId: string): string {
  return `${projectId}:${swimlaneId}`;
}

/** Whether `candidate` is ahead of `other`. Queue order breaks a tie. */
function entersFirst(candidate: CappedColumnTask, candidateIndex: number, other: CappedColumnTask, otherIndex: number): boolean {
  if (candidate.enteredAt !== other.enteredAt) return candidate.enteredAt < other.enteredAt;
  return candidateIndex < otherIndex;
}

/** The earliest-entered queue index of each limited column. */
function firstInLine(view: CapacityView, queued: readonly QueuedInput[]): Map<string, number> {
  const first = new Map<string, { index: number; task: CappedColumnTask }>();
  queued.forEach((input, index) => {
    const task = view.capped(input);
    if (!task) return;
    const key = columnKey(input.projectId, task.swimlaneId);
    const current = first.get(key);
    if (!current || entersFirst(task, index, current.task, current.index)) first.set(key, { index, task });
  });
  return new Map([...first].map(([key, { index }]) => [key, index]));
}

/**
 * A column's agent limit, as the queue's gate.
 *
 * A column works in the order its tasks entered it, which is not the queue's
 * order: worktree setup takes a different time per task, and a task can change
 * column while queued. So the gate walks the queue for what may start, and reads
 * each task's column fresh rather than remembering it at enqueue.
 *
 * Global slots stay the queue's own: nothing here counts them.
 */
export function createColumnCapacityGate(reads: ColumnCapacityReads): QueueGate {
  return {
    mustWait(input, queued) {
      const view = new CapacityView(reads);
      const task = view.capped(input);
      if (!task) return false;
      // A restart only changes flags. It is not in line, so nothing it waits for.
      if (view.keepsSlot(input)) return false;
      if (view.occupants(input.projectId, task) >= task.maxAgents) return true;
      // Room in the column does not let a later task past one already waiting.
      // The asker is not queued yet, so it sorts after every entry on a tie.
      const askerIndex = queued.length;
      return queued.some((entry, index) => {
        if (entry.taskId === input.taskId) return false;
        const other = view.capped(entry);
        return other?.swimlaneId === task.swimlaneId
          && entry.projectId === input.projectId
          && entersFirst(other, index, task, askerIndex);
      });
    },

    pick(queued) {
      const view = new CapacityView(reads);
      const first = firstInLine(view, queued);
      for (let index = 0; index < queued.length; index++) {
        const input = queued[index];
        const task = view.capped(input);
        if (!task) return index;
        if (first.get(columnKey(input.projectId, task.swimlaneId)) !== index) continue;
        if (view.occupants(input.projectId, task) < task.maxAgents) return index;
      }
      return -1;
    },

    countBlocked(queued) {
      const view = new CapacityView(reads);
      const waiting = new Map<string, { task: CappedColumnTask; projectId: string; count: number }>();
      for (const input of queued) {
        const task = view.capped(input);
        if (!task) continue;
        const key = columnKey(input.projectId, task.swimlaneId);
        const column = waiting.get(key) ?? { task, projectId: input.projectId, count: 0 };
        column.count++;
        waiting.set(key, column);
      }
      let blocked = 0;
      for (const { task, projectId, count } of waiting.values()) {
        const free = Math.max(0, task.maxAgents - view.occupants(projectId, task));
        blocked += Math.max(0, count - free);
      }
      return blocked;
    },
  };
}
