/**
 * `handleCreateColumn`'s session-track and enum handling, on mocked repositories.
 *
 * column-commands-create-delete.test.ts already covers this against a real
 * SQLite DB, but that file is gated on better-sqlite3 loading under the
 * runner's Node ABI and `postinstall` rebuilds better-sqlite3 for ELECTRON's
 * ABI, so it skips on CI as well as locally (vitest.config.ts says the same).
 * Create is the path the parity rule's own example describes - "set up a Code
 * Review column" is a create call - so it needs coverage that executes.
 *
 * It is also a genuinely different code path from update: it passes the
 * DEFAULT_SESSION_TARGET literal as `previousTarget` rather than a stored
 * value, so a swapped argument or a wrong default here passes session-track.ts's
 * own unit tests, passes the update-path cases, and passes typecheck.
 *
 * Mocks the repositories the way inventory-commands-list-columns.test.ts does,
 * and asserts on the input object the repository was handed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SwimlaneCreateInput } from '../../src/shared/types';

const { mockSwimlaneCreate, mockSwimlaneList } = vi.hoisted(() => ({
  mockSwimlaneCreate: vi.fn(),
  mockSwimlaneList: vi.fn(),
}));

vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({
  SwimlaneRepository: class {
    create = mockSwimlaneCreate;
    list = mockSwimlaneList;
  },
}));

import { handleCreateColumn } from '../../src/main/agent/commands/column-commands';
import { COLUMN_ENUM_FIELDS } from '../../src/main/agent/commands/column-enums';
import type { CommandContext } from '../../src/main/agent/commands/types';

const TODO_LANE = {
  id: 'lane-todo',
  name: 'To Do',
  role: 'todo',
  position: 0,
  is_archived: false,
  session_target: 'main',
  session_spawn_strategy: 'create_or_resume',
};
const DONE_LANE = {
  id: 'lane-done',
  name: 'Done',
  role: 'done',
  position: 100,
  is_archived: true,
  session_target: 'main',
  session_spawn_strategy: 'create_or_resume',
};

/**
 * The handler wraps the position shift and the insert in one transaction, so
 * the fake runs the body straight through: better-sqlite3's `transaction(fn)`
 * returns a callable, and the handler invokes it immediately.
 */
function makeDb() {
  return {
    transaction: (body: () => unknown) => () => body(),
    prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn(), all: vi.fn(() => []) })),
  };
}

function makeContext(): CommandContext {
  return {
    getProjectDb: vi.fn(() => makeDb() as never),
    getProjectPath: () => 'C:/Users/dev/project',
    getBoardProfiles: () => [],
    setBoardProfiles: vi.fn(),
    onSwimlaneUpdated: vi.fn(),
    onSwimlaneDeleted: vi.fn(),
  } as unknown as CommandContext;
}

/** The input object the handler handed the repository. */
function createdInput(): SwimlaneCreateInput {
  expect(mockSwimlaneCreate).toHaveBeenCalledTimes(1);
  return mockSwimlaneCreate.mock.calls[0][0] as SwimlaneCreateInput;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSwimlaneList.mockReturnValue([TODO_LANE, DONE_LANE]);
  // The handler reads the created row back to build its response.
  mockSwimlaneCreate.mockImplementation((input: SwimlaneCreateInput) => ({
    ...input,
    id: 'lane-new',
    role: null,
    position: 50,
    description: null,
    color: '#3b82f6',
    icon: null,
    is_archived: false,
    is_ghost: false,
    created_at: '2026-01-01T00:00:00.000Z',
  }));
});

describe('handleCreateColumn - session track pairing', () => {
  it('gives a column asked only for isolation a fresh session per entry', () => {
    // The motivating case. Without the carry, an isolated review column is
    // created with create_or_resume and resumes its own previous review, which
    // is the independence the isolated track exists to provide.
    const result = handleCreateColumn({ name: 'Code Review', sessionTarget: 'isolated' }, makeContext());

    expect(result.success).toBe(true);
    expect(createdInput().session_target).toBe('isolated');
    expect(createdInput().session_spawn_strategy).toBe('always_spawn_new');
  });

  it('leaves a column asked only for the main track at resuming', () => {
    // Takes the same derive branch as the isolated case rather than the
    // omitted-field default, so a wrong default read here would be invisible
    // without asserting it separately.
    const result = handleCreateColumn({ name: 'Build', sessionTarget: 'main' }, makeContext());

    expect(result.success).toBe(true);
    expect(createdInput().session_target).toBe('main');
    expect(createdInput().session_spawn_strategy).toBe('create_or_resume');
  });

  it('preserves an explicit persistent isolated track instead of snapping it', () => {
    const result = handleCreateColumn(
      { name: 'Triage', sessionTarget: 'isolated', sessionSpawnStrategy: 'create_or_resume' },
      makeContext(),
    );

    expect(result.success).toBe(true);
    expect(createdInput().session_target).toBe('isolated');
    expect(createdInput().session_spawn_strategy).toBe('create_or_resume');
  });

  it('sets neither field when the caller asks for no track at all', () => {
    // Absent means absent: the two NOT NULL column DEFAULTs decide, not the
    // handler, so it must not write a value it was never given.
    const result = handleCreateColumn({ name: 'Plain' }, makeContext());

    expect(result.success).toBe(true);
    expect(createdInput().session_target).toBeUndefined();
    expect(createdInput().session_spawn_strategy).toBeUndefined();
  });
});

// The "auto-command timing" pair that used to sit here asserted
// `swimlanes.auto_command_mode` on the created row. That column is retired: the
// automations migration blanks it and no delivery path reads it, so those two
// tests would now pass over a write nothing consumes, which is the exact
// silent-success shape the automations work set out to end.
//
// The behaviour moved, it was not dropped. `automation-commands.test.ts` pins
// it where it lives now, against the message automation the engine actually
// reads: "gives a newly created column its message too", "applies
// autoCommandMode to the row", and "refuses an unrecognized autoCommandMode on
// create rather than coercing it to immediate". `column-message-write.test.ts`
// covers `setColumnMessage` / `setColumnMessageMode` underneath those.

describe('handleCreateColumn - enum narrowing on the unvalidated path', () => {
  // Same loop as the update-path guard in column-commands-description.test.ts.
  // Create needs its own: it parses the params in a separate block, so a field
  // narrowed on update can still be written raw here.
  for (const [paramName, validValues] of Object.entries(COLUMN_ENUM_FIELDS)) {
    it(`rejects an invalid ${paramName} without creating the column`, () => {
      const result = handleCreateColumn(
        { name: 'New Column', [paramName]: 'not-a-real-value' },
        makeContext(),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('not-a-real-value');
      for (const validValue of validValues) {
        expect(result.error).toContain(validValue);
      }
      // A refused value must not leave a half-configured column behind.
      expect(mockSwimlaneCreate).not.toHaveBeenCalled();
    });

    it(`rejects a non-string ${paramName} rather than coercing it`, () => {
      const result = handleCreateColumn(
        { name: 'New Column', [paramName]: [validValues[0]] },
        makeContext(),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain(`Invalid ${paramName}`);
      expect(mockSwimlaneCreate).not.toHaveBeenCalled();
    });
  }
});
