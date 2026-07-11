/**
 * Unit tests for resolving and moving a task to the Done column via MCP
 * (kangentic_move_task with column: "Done").
 *
 * The Done swimlane is always seeded/persisted `is_archived: 1`, and
 * resolveColumn's default lookup filters archived lanes out - so before this
 * fix, `handleMoveTask` could not resolve "Done" by name even though the
 * downstream id-based handleTaskMove already handles the archive correctly.
 *
 * Uses a real in-memory better-sqlite3 DB run through the actual project
 * migrations (which seed the default swimlane set, including the archived
 * Done lane), mirroring the ABI-probe pattern from
 * mcp-move-task-to-project.test.ts so the suite skips cleanly if
 * better-sqlite3 cannot load under the test runner's Node ABI.
 *
 * Covers:
 *   - resolveColumn resolves "Done" by name only when includeArchivedDone is set
 *   - resolveColumn still rejects "Done" by name without the flag (regression
 *     for create_task / move_task_to_project, which keep the active-only filter)
 *   - handleMoveTask moves a task to Done, dispatching to onTaskMove with the
 *     archived Done lane's id
 *   - handleCreateTask still rejects column: "Done" (regression)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type DatabaseType from 'better-sqlite3';

// ---------------------------------------------------------------------------
// ABI probe - mirrors mcp-move-task-to-project.test.ts / swimlane-repository.test.ts.
// ---------------------------------------------------------------------------

function probeBetterSqlite3(): typeof DatabaseType | null {
  try {
    const moduleName = 'better-sqlite3';
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nativeModule = require(moduleName) as unknown;
    const databaseConstructor = (
      (nativeModule as { default?: typeof DatabaseType }).default ?? nativeModule
    ) as typeof DatabaseType;
    const probeHandle = new databaseConstructor(':memory:');
    probeHandle.close();
    return databaseConstructor;
  } catch {
    return null;
  }
}

const Database = probeBetterSqlite3();
const CAN_RUN = Database !== null;

import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { TaskRepository } from '../../src/main/db/repositories/task-repository';
import { resolveColumn } from '../../src/main/agent/commands/column-resolver';
import { handleMoveTask, handleCreateTask } from '../../src/main/agent/commands/task-commands';
import type { CommandContext } from '../../src/main/agent/commands/types';

function makeContext(db: InstanceType<typeof DatabaseType>, projectPath: string): CommandContext & {
  onTaskCreated: ReturnType<typeof vi.fn>;
  onTaskMove: ReturnType<typeof vi.fn>;
} {
  return {
    getProjectDb: () => db as unknown as ReturnType<CommandContext['getProjectDb']>,
    getProjectPath: () => projectPath,
    onTaskCreated: vi.fn(),
    onTaskUpdated: vi.fn(),
    onTaskDeleted: vi.fn(),
    onTaskMove: vi.fn(async () => {}),
    onSwimlaneUpdated: vi.fn(),
    onBacklogChanged: vi.fn(),
    onLabelColorsChanged: vi.fn(),
  };
}

describe.runIf(CAN_RUN)('resolving and moving a task to the Done column', () => {
  let db: InstanceType<typeof DatabaseType>;
  let context: ReturnType<typeof makeContext>;
  let todoLane: { id: string; name: string };
  let doneLane: { id: string; name: string; is_archived: boolean };

  beforeEach(() => {
    if (!Database) return;
    db = new Database(':memory:');
    runProjectMigrations(db);

    const swimlanes = new SwimlaneRepository(db).list();
    const foundTodo = swimlanes.find((lane) => lane.role === 'todo');
    const foundDone = swimlanes.find((lane) => lane.role === 'done');
    if (!foundTodo) throw new Error('Seeded To Do swimlane not found');
    if (!foundDone) throw new Error('Seeded Done swimlane not found');
    todoLane = foundTodo;
    doneLane = foundDone;
    expect(doneLane.is_archived).toBe(true);

    context = makeContext(db, '/mock/project');
  });

  afterEach(() => {
    db?.close();
  });

  it('resolves "Done" by name when includeArchivedDone is set', () => {
    const resolution = resolveColumn(db, 'Done', 'todo', { includeArchivedDone: true });

    expect('error' in resolution).toBe(false);
    if (!('error' in resolution)) {
      expect(resolution.swimlane.id).toBe(doneLane.id);
    }
  });

  it('still rejects "Done" by name without the flag', () => {
    const resolution = resolveColumn(db, 'Done');

    expect('error' in resolution).toBe(true);
    if ('error' in resolution) {
      expect(resolution.error).toContain('Column "Done" not found');
      const availableColumns = resolution.error.split('Available columns: ')[1]?.split('.')[0] ?? '';
      expect(availableColumns.split(', ')).not.toContain('Done');
    }
  });

  it('moves a task to Done, dispatching onTaskMove with the archived Done lane id', () => {
    const taskRepo = new TaskRepository(db);
    const task = taskRepo.create({ title: 'Finish the thing', description: '', swimlane_id: todoLane.id });

    const response = handleMoveTask({ taskId: task.id, column: 'Done' }, context);

    expect(response.success).toBe(true);
    expect(context.onTaskMove).toHaveBeenCalledWith({
      taskId: task.id,
      targetSwimlaneId: doneLane.id,
      targetPosition: 0,
    });
  });

  it('surfaces Done in the "Available columns" list on a bad column name', () => {
    const taskRepo = new TaskRepository(db);
    const task = taskRepo.create({ title: 'Task', description: '', swimlane_id: todoLane.id });

    const response = handleMoveTask({ taskId: task.id, column: 'Nonexistent' }, context);

    expect(response.success).toBe(false);
    if (!response.success) {
      expect(response.error).toContain('Done');
    }
  });

  it('handleCreateTask still rejects column: "Done" by name', () => {
    const response = handleCreateTask({ title: 'New task', column: 'Done' }, context);

    expect(response.success).toBe(false);
    if (!response.success) {
      expect(response.error).toContain('Column "Done" not found');
    }
  });
});
