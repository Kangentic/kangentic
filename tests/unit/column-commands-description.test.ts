import { describe, it, expect, vi } from 'vitest';
import { handleUpdateColumn } from '../../src/main/agent/commands/column-commands';
import { handleGetColumnDetail } from '../../src/main/agent/commands/analytics-commands';
import type { CommandContext } from '../../src/main/agent/commands/types';

// ---------------------------------------------------------------------------
// Mock DB row shape
// Mirrors the private SwimlaneRow interface in swimlane-repository.ts so that
// SwimlaneRepository.mapRow() operates on it without any live SQLite database.
// ---------------------------------------------------------------------------

interface MockSwimlaneRow {
  id: string;
  name: string;
  description: string | null;
  role: string | null;
  position: number;
  color: string;
  icon: string | null;
  is_archived: number;
  is_ghost: number;
  permission_mode: string | null;
  auto_spawn: number;
  auto_command: string | null;
  plan_exit_target_id: string | null;
  agent_override: string | null;
  model_override: string | null;
  effort_override: string | null;
  handoff_context: number;
  session_target: string;
  session_spawn_strategy: string;
  created_at: string;
}

function makeSwimlaneRow(overrides: Partial<MockSwimlaneRow> = {}): MockSwimlaneRow {
  return {
    id: 'swimlane-todo',
    name: 'To Do',
    description: null,
    role: 'todo',
    position: 0,
    color: '#3b82f6',
    icon: null,
    is_archived: 0,
    is_ghost: 0,
    permission_mode: null,
    auto_spawn: 1,
    auto_command: null,
    plan_exit_target_id: null,
    agent_override: null,
    model_override: null,
    effort_override: null,
    handoff_context: 0,
    session_target: 'main',
    session_spawn_strategy: 'create_or_resume',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock DB
//
// Pattern-matches on SQL substrings exactly like inspect-commands.test.ts does
// for its mock. The three patterns needed by these handlers are:
//   - list()   : SELECT * FROM swimlanes ORDER BY position ASC
//   - getById(): SELECT * FROM swimlanes WHERE id = ?
//   - update() : UPDATE swimlanes SET ...
//   - tasks    : SELECT ... FROM tasks ... swimlane_id = ? ...
// ---------------------------------------------------------------------------

function createMockDb(swimlaneRows: MockSwimlaneRow[] = [], taskRows: unknown[] = []) {
  return {
    prepare: vi.fn((sql: string) => {
      // SwimlaneRepository.list() - also used by listActiveSwimlanes (resolveColumn)
      if (sql.includes('FROM swimlanes') && sql.includes('ORDER BY position')) {
        return {
          all: vi.fn(() => swimlaneRows),
          get: vi.fn(() => undefined),
          run: vi.fn(),
        };
      }
      // SwimlaneRepository.getById() - called inside update() to fetch existing row
      if (sql.includes('FROM swimlanes') && sql.includes('WHERE id = ?')) {
        return {
          get: vi.fn((rowId: string) => swimlaneRows.find((row) => row.id === rowId) ?? undefined),
          all: vi.fn(() => swimlaneRows),
          run: vi.fn(),
        };
      }
      // SwimlaneRepository.update() - writes the merged row back
      if (sql.startsWith('UPDATE swimlanes')) {
        return { run: vi.fn() };
      }
      // TaskRepository.list(swimlaneId) - SELECT t.* ... WHERE t.swimlane_id = ? ...
      if (sql.includes('FROM tasks') && sql.includes('swimlane_id = ?')) {
        return {
          all: vi.fn(() => taskRows),
          get: vi.fn(() => undefined),
        };
      }
      // Fallback for any unexpected prepare call
      return { all: vi.fn(() => []), get: vi.fn(() => undefined), run: vi.fn() };
    }),
  };
}

function createMockContext(db: ReturnType<typeof createMockDb>): CommandContext {
  return {
    getProjectDb: () => db as never,
    getProjectPath: () => 'C:/Users/dev/project',
    onTaskCreated: vi.fn(),
    onTaskUpdated: vi.fn(),
    onTaskDeleted: vi.fn(),
    onTaskMove: vi.fn().mockResolvedValue(undefined),
    onSwimlaneUpdated: vi.fn(),
    onSwimlaneDeleted: vi.fn(),
    onBacklogChanged: vi.fn(),
    onLabelColorsChanged: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// handleUpdateColumn - description behaviors
// ---------------------------------------------------------------------------

describe('handleUpdateColumn - description field', () => {
  it('(a) passes description through to the swimlane update when a string is provided', () => {
    const swimlaneRow = makeSwimlaneRow({ description: null });
    const db = createMockDb([swimlaneRow]);
    const context = createMockContext(db);

    const result = handleUpdateColumn(
      { column: 'To Do', description: 'Documents the purpose of this column' },
      context,
    );

    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).description).toBe(
      'Documents the purpose of this column',
    );
    // 'description' must appear in the success message listing the changed fields
    expect(result.message).toContain('description');
  });

  it('(b) sets description to null when description: null is passed (clear the field)', () => {
    const swimlaneRow = makeSwimlaneRow({ description: 'old purpose text' });
    const db = createMockDb([swimlaneRow]);
    const context = createMockContext(db);

    const result = handleUpdateColumn({ column: 'To Do', description: null }, context);

    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).description).toBeNull();
    // Clearing description still counts as a changed field
    expect(result.message).toContain('description');
  });

  it('(c) truncates a description longer than 1000 characters to exactly 1000 characters', () => {
    const longDescription = 'c'.repeat(1500);
    const swimlaneRow = makeSwimlaneRow({ description: null });
    const db = createMockDb([swimlaneRow]);
    const context = createMockContext(db);

    const result = handleUpdateColumn({ column: 'To Do', description: longDescription }, context);

    expect(result.success).toBe(true);
    const storedDescription = (result.data as Record<string, unknown>).description as string;
    expect(storedDescription).toHaveLength(1000);
  });

  it('(d) omitting description does not add it to changedFields', () => {
    const swimlaneRow = makeSwimlaneRow({ description: 'should not be touched' });
    const db = createMockDb([swimlaneRow]);
    const context = createMockContext(db);

    // Only 'name' is supplied - description is deliberately absent from params
    const result = handleUpdateColumn({ column: 'To Do', name: 'Renamed Column' }, context);

    expect(result.success).toBe(true);
    // The success message enumerates changedFields; 'description' must not appear
    expect(result.message).toContain('name');
    expect(result.message).not.toContain('description');
  });

  it('(d-boundary) passing no updatable fields alongside no description returns the no-fields error', () => {
    const swimlaneRow = makeSwimlaneRow();
    const db = createMockDb([swimlaneRow]);
    const context = createMockContext(db);

    // Only the required 'column' identifier is present; no field will be changed
    const result = handleUpdateColumn({ column: 'To Do' }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('No fields to update');
  });

  it('calls onSwimlaneUpdated with the updated swimlane carrying the new description', () => {
    const swimlaneRow = makeSwimlaneRow({ description: null });
    const db = createMockDb([swimlaneRow]);
    const context = createMockContext(db);

    handleUpdateColumn({ column: 'To Do', description: 'new description text' }, context);

    const onSwimlaneUpdated = context.onSwimlaneUpdated as ReturnType<typeof vi.fn>;
    expect(onSwimlaneUpdated).toHaveBeenCalledOnce();
    const updatedSwimlane = onSwimlaneUpdated.mock.calls[0][0] as Record<string, unknown>;
    expect(updatedSwimlane.description).toBe('new description text');
  });

  it('hands onSwimlaneUpdated the PRE-edit row as well, so the host can tell what changed', () => {
    // The MCP writer used to notify with the updated row alone, which is why it
    // propagated nothing to live sessions - not the auto_spawn reconcile, and
    // not even the model/effort injection the UI's SWIMLANE_UPDATE has had all
    // along. Without a before-row the host cannot compute a delta at all.
    const swimlaneRow = makeSwimlaneRow({ name: 'Planning', role: null, auto_spawn: 0 });
    const db = createMockDb([swimlaneRow]);
    const context = createMockContext(db);

    handleUpdateColumn({ column: 'Planning', autoSpawn: true }, context);

    const onSwimlaneUpdated = context.onSwimlaneUpdated as ReturnType<typeof vi.fn>;
    expect(onSwimlaneUpdated).toHaveBeenCalledOnce();
    const [updatedSwimlane, previousSwimlane] = onSwimlaneUpdated.mock.calls[0] as Array<Record<string, unknown>>;
    expect(updatedSwimlane.auto_spawn).toBe(true);
    expect(previousSwimlane).toBeTruthy();
    expect(previousSwimlane.auto_spawn).toBe(false);
  });

  it('does not include description in data when the field is not passed', () => {
    // Even though the stored row has a description, a name-only update must NOT
    // alter description. The returned data reflects whatever SwimlaneRepository.update
    // merges; since description was not in updates, it stays as the original value.
    // This pin guards against accidental zeroing of the field in future refactors.
    const swimlaneRow = makeSwimlaneRow({ description: 'preserved description' });
    const db = createMockDb([swimlaneRow]);
    const context = createMockContext(db);

    const result = handleUpdateColumn({ column: 'To Do', name: 'New Name' }, context);

    expect(result.success).toBe(true);
    // description is unchanged - it comes back from the merged swimlane
    expect((result.data as Record<string, unknown>).description).toBe('preserved description');
  });
});

// ---------------------------------------------------------------------------
// handleGetColumnDetail - description behaviors
// ---------------------------------------------------------------------------

describe('handleGetColumnDetail - description field', () => {
  it('(e) data.description matches the swimlane stored description', () => {
    const swimlaneRow = makeSwimlaneRow({ description: 'Column for incoming work items' });
    const db = createMockDb([swimlaneRow]);
    const context = createMockContext(db);

    const result = handleGetColumnDetail({ column: 'To Do' }, context);

    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).description).toBe(
      'Column for incoming work items',
    );
  });

  it('(f-present) a "Description:" line appears in the message when description is set', () => {
    const swimlaneRow = makeSwimlaneRow({ description: 'Column for incoming work items' });
    const db = createMockDb([swimlaneRow]);
    const context = createMockContext(db);

    const result = handleGetColumnDetail({ column: 'To Do' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('Description: Column for incoming work items');
  });

  it('(f-absent) the Description line is omitted from the message when description is null', () => {
    const swimlaneRow = makeSwimlaneRow({ description: null });
    const db = createMockDb([swimlaneRow]);
    const context = createMockContext(db);

    const result = handleGetColumnDetail({ column: 'To Do' }, context);

    expect(result.success).toBe(true);
    expect(result.message).not.toContain('Description:');
    // data payload still carries the field, as null
    expect((result.data as Record<string, unknown>).description).toBeNull();
  });

  it('data.description is null when description is null', () => {
    const swimlaneRow = makeSwimlaneRow({ description: null });
    const db = createMockDb([swimlaneRow]);
    const context = createMockContext(db);

    const result = handleGetColumnDetail({ column: 'To Do' }, context);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ description: null });
  });

  it('returns an error when the column name does not match any swimlane', () => {
    const swimlaneRow = makeSwimlaneRow({ name: 'To Do' });
    const db = createMockDb([swimlaneRow]);
    const context = createMockContext(db);

    const result = handleGetColumnDetail({ column: 'Nonexistent Column' }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Nonexistent Column');
  });

  it('column name matching is case-insensitive', () => {
    const swimlaneRow = makeSwimlaneRow({ name: 'To Do', description: 'case test' });
    const db = createMockDb([swimlaneRow]);
    const context = createMockContext(db);

    const result = handleGetColumnDetail({ column: 'to do' }, context);

    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).description).toBe('case test');
  });
});
