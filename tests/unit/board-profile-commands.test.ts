/**
 * Board Profile MCP command handlers.
 *
 * The behaviors locked here are the ones a caller cannot see going wrong:
 *   - column NAME <-> swimlane uuid translation, in both directions. This is
 *     what makes a cross-project copy possible at all, since project X's uuids
 *     mean nothing on project Y's board.
 *   - the three-state sparse contract (absent = inherit, null = clear, value =
 *     set). A `??`-based implementation passes every other test in this file and
 *     silently collapses null onto absent.
 *   - merge-by-default on update, so a one-column retune does not wipe the rest.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  handleListBoardProfiles,
  handleCreateBoardProfile,
  handleUpdateBoardProfile,
  handleDeleteBoardProfile,
  resolveProfileSelector,
} from '../../src/main/agent/commands/profile-commands';
import type { CommandContext } from '../../src/main/agent/commands/types';
import type { BoardProfile, Swimlane } from '../../src/shared/types';

const PLANNING_ID = 'lane-planning';
const EXECUTING_ID = 'lane-executing';

function makeSwimlane(id: string, name: string): Swimlane {
  return {
    id,
    name,
    description: null,
    role: null,
    color: '#000000',
    icon: null,
    position: 0,
    is_archived: false,
    is_ghost: false,
    permission_mode: null,
    auto_spawn: true,
    auto_command: null,
    plan_exit_target_id: null,
    agent_override: null,
    model_override: null,
    effort_override: null,
    handoff_context: false,
    session_target: 'main',
    session_spawn_strategy: 'create_or_resume',
    created_at: '2026-01-01T00:00:00.000Z',
  } as Swimlane;
}

const SWIMLANES = [makeSwimlane(PLANNING_ID, 'Planning'), makeSwimlane(EXECUTING_ID, 'Executing')];

/**
 * Minimal db double: the handlers only reach SQLite for the swimlane list (via
 * SwimlaneRepository.list) and, on delete, the riding-task count.
 */
function createMockDb(profileTaskCount = 0) {
  return {
    prepare: vi.fn((sql: string) => {
      if (sql.includes('FROM tasks') && sql.includes('profile_id')) {
        return { get: vi.fn(() => ({ count: profileTaskCount })), all: vi.fn(() => []), run: vi.fn() };
      }
      if (sql.includes('FROM swimlanes')) {
        return { all: vi.fn(() => SWIMLANES), get: vi.fn(() => undefined), run: vi.fn() };
      }
      return { all: vi.fn(() => []), get: vi.fn(() => undefined), run: vi.fn() };
    }),
  };
}

function createContext(profiles: BoardProfile[], options: { taskCount?: number } = {}) {
  const stored = { profiles };
  const setBoardProfiles = vi.fn((next: BoardProfile[]) => {
    // Mirrors BoardConfigManager.setBoardProfiles assigning ids on write, so a
    // freshly created profile reads back with a real id.
    stored.profiles = next.map((profile) => ({ ...profile, id: profile.id || `generated-${profile.name}` }));
  });
  const context = {
    getProjectDb: () => createMockDb(options.taskCount ?? 0) as never,
    getProjectPath: () => '/projects/example',
    getBoardProfiles: () => stored.profiles,
    setBoardProfiles,
    onTaskCreated: vi.fn(),
    onTaskUpdated: vi.fn(),
    onTaskDeleted: vi.fn(),
    onTaskMove: vi.fn().mockResolvedValue(undefined),
    onSwimlaneUpdated: vi.fn(),
    onBacklogChanged: vi.fn(),
    onLabelColorsChanged: vi.fn(),
  } satisfies CommandContext;
  return { context, stored, setBoardProfiles };
}

describe('handleCreateBoardProfile', () => {
  it('translates column names to swimlane ids on write', () => {
    const { context, stored } = createContext([]);

    const response = handleCreateBoardProfile(
      { name: 'Heavy', description: null, columns: { Planning: { modelOverride: 'opus' } } },
      context,
    );

    expect(response.success).toBe(true);
    expect(Object.keys(stored.profiles[0].columns)).toEqual([PLANNING_ID]);
    expect(stored.profiles[0].columns[PLANNING_ID]).toEqual({ modelOverride: 'opus' });
  });

  it('matches column names case-insensitively', () => {
    const { context, stored } = createContext([]);

    handleCreateBoardProfile({ name: 'Heavy', columns: { '  planning  ': { effortOverride: 'xhigh' } } }, context);

    expect(Object.keys(stored.profiles[0].columns)).toEqual([PLANNING_ID]);
  });

  it('preserves an explicit null (clear to agent default) distinctly from an omitted key', () => {
    const { context, stored } = createContext([]);

    handleCreateBoardProfile(
      {
        name: 'Heavy',
        columns: {
          // modelOverride null = "run the agent default here even though the
          // column pins one"; effortOverride absent = "inherit the column's".
          Planning: { modelOverride: null },
          Executing: { effortOverride: 'high' },
        },
      },
      context,
    );

    const entry = stored.profiles[0].columns[PLANNING_ID];
    expect(Object.prototype.hasOwnProperty.call(entry, 'modelOverride')).toBe(true);
    expect(entry.modelOverride).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(entry, 'effortOverride')).toBe(false);
  });

  it('rejects an unknown column name and saves nothing', () => {
    const { context, setBoardProfiles } = createContext([]);

    const response = handleCreateBoardProfile(
      { name: 'Heavy', columns: { Nonexistent: { modelOverride: 'opus' } } },
      context,
    );

    expect(response.success).toBe(false);
    expect(response.error).toContain('Nonexistent');
    expect(response.error).toContain('Planning, Executing');
    expect(setBoardProfiles).not.toHaveBeenCalled();
  });

  it('rejects a duplicate name, ignoring case', () => {
    const { context, setBoardProfiles } = createContext([{ id: 'p1', name: 'Heavy', columns: {} }]);

    const response = handleCreateBoardProfile({ name: '  heavy ', columns: {} }, context);

    expect(response.success).toBe(false);
    expect(response.error).toContain('already exists');
    expect(setBoardProfiles).not.toHaveBeenCalled();
  });

  it('requires a name', () => {
    const { context } = createContext([]);
    expect(handleCreateBoardProfile({ name: '   ' }, context).success).toBe(false);
  });
});

describe('handleListBoardProfiles', () => {
  it('renders column keys back as names, so the output can be replayed onto another board', () => {
    const { context } = createContext([
      { id: 'p1', name: 'Heavy', description: 'Big guns', columns: { [PLANNING_ID]: { modelOverride: 'opus' } } },
    ]);

    const response = handleListBoardProfiles({}, context);

    expect(response.success).toBe(true);
    expect(response.data).toEqual([
      { id: 'p1', name: 'Heavy', description: 'Big guns', columns: { Planning: { modelOverride: 'opus' } } },
    ]);
  });

  it('omits entries for columns that no longer exist', () => {
    const { context } = createContext([
      { id: 'p1', name: 'Heavy', columns: { [PLANNING_ID]: { modelOverride: 'opus' }, 'lane-deleted': { modelOverride: 'haiku' } } },
    ]);

    const [rendered] = handleListBoardProfiles({}, context).data as Array<{ columns: Record<string, unknown> }>;
    expect(Object.keys(rendered.columns)).toEqual(['Planning']);
  });
});

describe('handleUpdateBoardProfile', () => {
  it('merges columns by default, leaving untouched columns intact', () => {
    const { context, stored } = createContext([
      {
        id: 'p1',
        name: 'Heavy',
        columns: { [PLANNING_ID]: { modelOverride: 'opus-4-8' }, [EXECUTING_ID]: { modelOverride: 'sonnet' } },
      },
    ]);

    handleUpdateBoardProfile({ profile: 'Heavy', columns: { Planning: { modelOverride: 'opus-5' } } }, context);

    expect(stored.profiles[0].columns[PLANNING_ID]).toEqual({ modelOverride: 'opus-5' });
    expect(stored.profiles[0].columns[EXECUTING_ID]).toEqual({ modelOverride: 'sonnet' });
  });

  it('replaces the whole column set when replaceColumns is set', () => {
    const { context, stored } = createContext([
      {
        id: 'p1',
        name: 'Heavy',
        columns: { [PLANNING_ID]: { modelOverride: 'opus' }, [EXECUTING_ID]: { modelOverride: 'sonnet' } },
      },
    ]);

    handleUpdateBoardProfile(
      { profile: 'Heavy', columns: { Planning: { modelOverride: 'opus-5' } }, replaceColumns: true },
      context,
    );

    expect(Object.keys(stored.profiles[0].columns)).toEqual([PLANNING_ID]);
  });

  it('resolves the profile by id as well as by name', () => {
    const { context, stored } = createContext([{ id: 'p1', name: 'Heavy', columns: {} }]);

    handleUpdateBoardProfile({ profile: 'p1', name: 'Heavier' }, context);

    expect(stored.profiles[0].name).toBe('Heavier');
  });

  it('allows renaming a profile to its own current name', () => {
    const { context } = createContext([{ id: 'p1', name: 'Heavy', columns: {} }]);
    expect(handleUpdateBoardProfile({ profile: 'p1', name: 'Heavy' }, context).success).toBe(true);
  });

  it('rejects renaming onto another profile\'s name', () => {
    const { context, setBoardProfiles } = createContext([
      { id: 'p1', name: 'Heavy', columns: {} },
      { id: 'p2', name: 'Light', columns: {} },
    ]);

    const response = handleUpdateBoardProfile({ profile: 'Heavy', name: 'Light' }, context);

    expect(response.success).toBe(false);
    expect(setBoardProfiles).not.toHaveBeenCalled();
  });

  it('reports the board\'s profiles when the selector matches none', () => {
    const { context } = createContext([{ id: 'p1', name: 'Heavy', columns: {} }]);

    const response = handleUpdateBoardProfile({ profile: 'Nope', name: 'X' }, context);

    expect(response.success).toBe(false);
    expect(response.error).toContain('Heavy');
  });

  it('clears the description on an empty string', () => {
    const { context, stored } = createContext([{ id: 'p1', name: 'Heavy', description: 'old', columns: {} }]);

    handleUpdateBoardProfile({ profile: 'Heavy', description: '' }, context);

    expect(stored.profiles[0].description).toBeUndefined();
  });
});

describe('handleDeleteBoardProfile', () => {
  it('removes the profile and reports how many tasks were riding it', () => {
    const { context, stored } = createContext(
      [{ id: 'p1', name: 'Heavy', columns: {} }, { id: 'p2', name: 'Light', columns: {} }],
      { taskCount: 3 },
    );

    const response = handleDeleteBoardProfile({ profile: 'Heavy' }, context);

    expect(response.success).toBe(true);
    expect(stored.profiles.map((profile) => profile.name)).toEqual(['Light']);
    expect((response.data as { tasksAffected: number }).tasksAffected).toBe(3);
    expect(response.message).toContain('3 task(s)');
  });

  it('errors on an unknown selector without writing', () => {
    const { context, setBoardProfiles } = createContext([{ id: 'p1', name: 'Heavy', columns: {} }]);

    expect(handleDeleteBoardProfile({ profile: 'Nope' }, context).success).toBe(false);
    expect(setBoardProfiles).not.toHaveBeenCalled();
  });
});

describe('resolveProfileSelector', () => {
  it('resolves by name and by id', () => {
    const { context } = createContext([{ id: 'p1', name: 'Heavy', columns: {} }]);

    expect(resolveProfileSelector(context, 'heavy')).toEqual({ ok: true, profileId: 'p1' });
    expect(resolveProfileSelector(context, 'p1')).toEqual({ ok: true, profileId: 'p1' });
  });

  it('errors rather than silently falling back to Default', () => {
    const { context } = createContext([{ id: 'p1', name: 'Heavy', columns: {} }]);

    const result = resolveProfileSelector(context, 'Heavey');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('Heavy');
  });
});
