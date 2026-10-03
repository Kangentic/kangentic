/**
 * mergeBoardConfigs over a team or local file whose lists are the wrong shape.
 *
 * Both files come from JSON.parse and the merge runs before the validator for
 * every reader of the effective config (including the default base branch on
 * each task finalization), so it must not throw on them. The rules under test:
 *
 *   - A team list the merge cannot read (not a list, or an entry that is not an
 *     object) is left exactly as it is, for the validator to reject with a
 *     message. The local list is not merged into it.
 *   - A local entry that is not an object is skipped, and the valid entries
 *     beside it still merge.
 *
 * Pure function, so no mocks are needed.
 */

import { describe, it, expect } from 'vitest';
import { mergeBoardConfigs } from '../../src/main/config/board-config/config-helpers';
import type { BoardConfig } from '../../src/shared/types';

/** A config as JSON.parse could hand it over, whatever its real shape. */
function asBoardConfig(value: object): BoardConfig {
  return value as unknown as BoardConfig;
}

function asLocal(value: object): Partial<BoardConfig> {
  return value as unknown as Partial<BoardConfig>;
}

describe('mergeBoardConfigs: a team list the merge cannot read is left for the validator', () => {
  const localColumns = [{ id: 'local-lane', name: 'Local Lane' }];

  it('leaves team columns untouched when they are not a list', () => {
    const team = asBoardConfig({ version: 1, columns: {} });

    let merged: BoardConfig | undefined;
    expect(() => {
      merged = mergeBoardConfigs(team, asLocal({ columns: localColumns }));
    }).not.toThrow();

    expect(merged?.columns).toEqual({});
  });

  it('leaves team columns untouched when one is not an object', () => {
    const team = asBoardConfig({ version: 1, columns: [null] });

    let merged: BoardConfig | undefined;
    expect(() => {
      merged = mergeBoardConfigs(team, asLocal({ columns: localColumns }));
    }).not.toThrow();

    expect(merged?.columns).toEqual([null]);
  });

  it('does not merge local actions into a team actions list that holds a non-object', () => {
    const team = asBoardConfig({ version: 1, columns: [], actions: [null] });

    let merged: BoardConfig | undefined;
    expect(() => {
      merged = mergeBoardConfigs(team, asLocal({ actions: [{ id: 'a1', name: 'Local' }] }));
    }).not.toThrow();

    expect(merged?.actions).toEqual([null]);
  });

  it('does not merge local transitions into a team transitions list that holds a non-object', () => {
    const team = asBoardConfig({ version: 1, columns: [], transitions: [null] });

    let merged: BoardConfig | undefined;
    expect(() => {
      merged = mergeBoardConfigs(team, asLocal({ transitions: [{ from: 'A', to: 'B', actions: [] }] }));
    }).not.toThrow();

    expect(merged?.transitions).toEqual([null]);
  });

  it('does not merge local shortcuts into a team shortcuts list that holds a non-object', () => {
    const team = asBoardConfig({ version: 1, columns: [], shortcuts: [null] });

    let merged: BoardConfig | undefined;
    expect(() => {
      merged = mergeBoardConfigs(team, asLocal({ shortcuts: [{ id: 's1', label: 'Open', command: 'code .' }] }));
    }).not.toThrow();

    expect(merged?.shortcuts).toEqual([null]);
  });

  it('still merges local actions into an absent team actions list', () => {
    const team = asBoardConfig({ version: 1, columns: [] });

    const merged = mergeBoardConfigs(team, asLocal({ actions: [{ id: 'a1', name: 'Local' }] }));

    expect(merged.actions?.map((action) => action.id)).toEqual(['a1']);
  });
});

describe('mergeBoardConfigs: a local entry that is not an object is skipped', () => {
  it('skips a null local column and merges the valid one beside it', () => {
    const team = asBoardConfig({
      version: 1,
      columns: [{ id: 'todo', name: 'To Do', role: 'todo' }, { id: 'done', name: 'Done', role: 'done' }],
    });

    const merged = mergeBoardConfigs(team, asLocal({ columns: [null, { id: 'review', name: 'Review' }] }));

    expect(merged.columns.map((column) => column.name)).toEqual(['To Do', 'Review', 'Done']);
  });

  it('skips a null local action and merges the valid one, overriding by id', () => {
    const team = asBoardConfig({ version: 1, columns: [], actions: [{ id: 'a1', name: 'Team' }] });

    const merged = mergeBoardConfigs(team, asLocal({
      actions: [null, { id: 'a1', name: 'Overridden' }, { id: 'a2', name: 'Added' }],
    }));

    expect(merged.actions?.map((action) => action.name)).toEqual(['Overridden', 'Added']);
  });

  it('skips a null local transition and merges the valid one', () => {
    const team = asBoardConfig({
      version: 1,
      columns: [],
      transitions: [{ from: 'A', to: 'B', actions: ['team'] }],
    });

    const merged = mergeBoardConfigs(team, asLocal({
      transitions: [null, { from: 'A', to: 'B', actions: ['local'] }, { from: 'B', to: 'C', actions: [] }],
    }));

    expect(merged.transitions).toEqual([
      { from: 'A', to: 'B', actions: ['local'] },
      { from: 'B', to: 'C', actions: [] },
    ]);
  });

  it('skips a null local shortcut and merges the valid one, overriding by id', () => {
    const team = asBoardConfig({
      version: 1,
      columns: [],
      shortcuts: [{ id: 's1', label: 'Team', command: 'team' }],
    });

    const merged = mergeBoardConfigs(team, asLocal({
      shortcuts: [null, { id: 's1', label: 'Overridden', command: 'local' }, { id: 's2', label: 'Added', command: 'added' }],
    }));

    expect(merged.shortcuts?.map((shortcut) => shortcut.label)).toEqual(['Overridden', 'Added']);
  });

  it('ignores a local list that is not a list at all', () => {
    const team = asBoardConfig({ version: 1, columns: [], actions: [{ id: 'a1', name: 'Team' }] });

    const merged = mergeBoardConfigs(team, asLocal({ actions: {} }));

    expect(merged.actions).toEqual([{ id: 'a1', name: 'Team' }]);
  });
});
