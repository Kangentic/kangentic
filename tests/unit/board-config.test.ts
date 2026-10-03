import { describe, it, expect } from 'vitest';
import { validateBoardConfig, mergeBoardConfigs } from '../../src/main/config/board-config/config-helpers';
import type { BoardConfig } from '../../src/shared/types';

function makeValidConfig(overrides: Partial<BoardConfig> = {}): BoardConfig {
  return {
    version: 1,
    columns: [
      { id: 'col-backlog', name: 'Backlog', role: 'backlog' },
      { id: 'col-planning', name: 'Planning', autoSpawn: true },
      { id: 'col-done', name: 'Done', role: 'done' },
    ],
    actions: [
      { id: 'act-kill', name: 'Kill Session', type: 'kill_session', config: {} },
    ],
    transitions: [
      { from: '*', to: 'Done', actions: ['Kill Session'] },
    ],
    ...overrides,
  };
}

describe('validateBoardConfig', () => {
  it('returns null for a valid config', () => {
    const result = validateBoardConfig(makeValidConfig());
    expect(result).toBeNull();
  });

  it('returns fatal error when version is missing', () => {
    const config = makeValidConfig({ version: 0 });
    const result = validateBoardConfig(config);
    expect(result).toContain('missing the version field');
  });

  it('returns fatal error when columns array is empty', () => {
    const config = makeValidConfig({ columns: [] });
    const result = validateBoardConfig(config);
    expect(result).toContain('no columns defined');
  });

  it('returns fatal error for duplicate column names', () => {
    const config = makeValidConfig({
      columns: [
        { name: 'Backlog', role: 'backlog' },
        { name: 'Backlog' },
        { name: 'Done', role: 'done' },
      ],
    });
    const result = validateBoardConfig(config);
    expect(result).toContain("duplicate column name 'Backlog'");
  });

  it('returns fatal error for duplicate action names', () => {
    const config = makeValidConfig({
      actions: [
        { id: 'a1', name: 'Kill Session', type: 'kill_session', config: {} },
        { id: 'a2', name: 'Kill Session', type: 'kill_session', config: {} },
      ],
    });
    const result = validateBoardConfig(config);
    expect(result).toContain("duplicate action name 'Kill Session'");
  });

  it('does not treat version > current as fatal (handled as warning in reconcile)', () => {
    const config = makeValidConfig({ version: 99 });
    const result = validateBoardConfig(config);
    expect(result).toBeNull();
  });

  // The file came from JSON.parse, so its lists can be any shape. Each case
  // below used to throw out of the validator or out of the reconcile it guards
  // (the same "is not iterable" class as Sentry DESKTOP-1H), instead of falling
  // back to the local database with a message.
  describe('a list that is the wrong shape', () => {
    function withRaw(overrides: Record<string, unknown>): BoardConfig {
      return { ...makeValidConfig(), ...overrides } as unknown as BoardConfig;
    }

    it.each([
      ['columns is an object', { columns: { planning: { name: 'Planning' } } }, 'columns'],
      ['a column is not an object', { columns: ['Planning', { name: 'Done', role: 'done' }] }, 'column'],
      ['a column has no name', { columns: [{ role: 'todo' }, { name: 'Done', role: 'done' }] }, 'column'],
      ['actions is an object', { actions: {} }, 'actions'],
      ['an action is not an object', { actions: [null] }, 'action'],
      ['transitions is an object', { transitions: {} }, 'transitions'],
      ['a transition is not an object', { transitions: [null] }, 'transition'],
      ['a transition has no actions list', { transitions: [{ from: '*', to: 'Done' }] }, 'transition'],
    ])('is fatal, without throwing, when %s', (_label, overrides, named) => {
      let result: string | null = null;
      expect(() => {
        result = validateBoardConfig(withRaw(overrides));
      }).not.toThrow();
      expect(result).toContain(named);
      expect(result).toContain('Board loaded from local database');
    });

    it('still accepts null actions and transitions as none', () => {
      expect(validateBoardConfig(withRaw({ actions: null, transitions: null }))).toBeNull();
    });
  });
});

describe('mergeBoardConfigs', () => {
  it('local overrides team column properties by id', () => {
    const team = makeValidConfig();
    const local: Partial<BoardConfig> = {
      columns: [
        { id: 'col-planning', name: 'In Progress', color: '#ff0000' },
      ],
    };
    const result = mergeBoardConfigs(team, local);
    const planning = result.columns.find((column) => column.id === 'col-planning');
    expect(planning?.name).toBe('In Progress');
    expect(planning?.color).toBe('#ff0000');
    expect(planning?.autoSpawn).toBe(true); // preserved from team
  });

  it('local-only columns are inserted before done', () => {
    const team = makeValidConfig();
    const local: Partial<BoardConfig> = {
      columns: [
        { name: 'QA Review', icon: 'test-tube' },
      ],
    };
    const result = mergeBoardConfigs(team, local);
    const names = result.columns.map((column) => column.name);
    const qaIndex = names.indexOf('QA Review');
    const doneIndex = names.indexOf('Done');
    expect(qaIndex).toBeGreaterThan(-1);
    expect(doneIndex).toBeGreaterThan(-1);
    expect(qaIndex).toBeLessThan(doneIndex);
  });

  it('local transitions replace matching from+to pairs', () => {
    const team = makeValidConfig();
    const local: Partial<BoardConfig> = {
      transitions: [
        { from: '*', to: 'Done', actions: ['Custom Action'] },
      ],
    };
    const result = mergeBoardConfigs(team, local);
    const doneTransition = result.transitions.find((transition) => transition.to === 'Done');
    expect(doneTransition?.actions).toEqual(['Custom Action']);
  });

  it('local transitions are additive for new from+to pairs', () => {
    const team = makeValidConfig();
    const local: Partial<BoardConfig> = {
      transitions: [
        { from: '*', to: 'Planning', actions: ['Start Agent'] },
      ],
    };
    const result = mergeBoardConfigs(team, local);
    expect(result.transitions).toHaveLength(2);
    const planningTransition = result.transitions.find((transition) => transition.to === 'Planning');
    expect(planningTransition?.actions).toEqual(['Start Agent']);
  });

  it('local actions override by id', () => {
    const team = makeValidConfig();
    const local: Partial<BoardConfig> = {
      actions: [
        { id: 'act-kill', name: 'Kill Session (Graceful)', type: 'kill_session', config: { graceful: true } },
      ],
    };
    const result = mergeBoardConfigs(team, local);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].name).toBe('Kill Session (Graceful)');
  });

  it('preserves team columns not mentioned in local', () => {
    const team = makeValidConfig();
    const local: Partial<BoardConfig> = {
      columns: [
        { id: 'col-planning', name: 'Sprint' },
      ],
    };
    const result = mergeBoardConfigs(team, local);
    expect(result.columns).toHaveLength(3);
    expect(result.columns[0].name).toBe('Backlog');
    expect(result.columns[2].name).toBe('Done');
  });

  // The merge runs before the validator, so a non-list here used to throw
  // "is not iterable" out of every reader of the effective config, including
  // getDefaultBaseBranch on each task finalization.
  describe('a list that is the wrong shape', () => {
    it.each(['columns', 'actions', 'transitions', 'shortcuts'])(
      'ignores a local %s that is not a list, keeping the team value',
      (key) => {
        const team = makeValidConfig({ shortcuts: [{ id: 's1', label: 'Open', command: 'code .' }] });
        const local = { [key]: {} } as unknown as Partial<BoardConfig>;

        let result: BoardConfig | null = null;
        expect(() => {
          result = mergeBoardConfigs(team, local);
        }).not.toThrow();
        expect((result as unknown as Record<string, unknown>)[key]).toEqual(
          (team as unknown as Record<string, unknown>)[key],
        );
      },
    );

    it.each(['actions', 'transitions', 'shortcuts'])(
      'leaves a team %s that is not a list for the validator, rather than throwing',
      (key) => {
        const team = { ...makeValidConfig(), [key]: {} } as unknown as BoardConfig;
        const local = makeValidConfig({ shortcuts: [{ id: 's1', label: 'Open', command: 'code .' }] });

        let result: BoardConfig | null = null;
        expect(() => {
          result = mergeBoardConfigs(team, local);
        }).not.toThrow();
        expect((result as unknown as Record<string, unknown>)[key]).toEqual({});
      },
    );

    it('skips a local column that is not an object', () => {
      const team = makeValidConfig();
      const local = { columns: [null, { name: 'QA Review' }] } as unknown as Partial<BoardConfig>;

      const result = mergeBoardConfigs(team, local);

      expect(result.columns.map((column) => column.name)).toEqual(['Backlog', 'Planning', 'QA Review', 'Done']);
    });
  });
});
