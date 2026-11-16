/**
 * The file format version gates in `kangentic.json` reading. A build that reads
 * a file it cannot fully read must never plan it as if it could, so each gate
 * here is pinned by the value that sits on its edge. Pure functions, no database.
 */
import { describe, it, expect } from 'vitest';
import type { BoardColumnConfig, BoardConfig } from '../../src/shared/types';
import {
  CURRENT_VERSION,
  isNewerFileFormat,
  legacyKeyReadable,
  migrateBoardColumnFields,
  newerFormatReason,
} from '../../src/main/config/board-config/config-helpers';
import {
  fileHoldsUnreadableAutomations,
  planColumnAutomations,
} from '../../src/main/config/board-config/apply-automations';

/** A column as JSON.parse would hand it over, with keys the declared type does not know. */
function columnFromFile(fields: Record<string, unknown>): BoardColumnConfig {
  return { name: 'Executing', ...fields } as unknown as BoardColumnConfig;
}

function configFromFile(version: unknown, column: Record<string, unknown>): BoardConfig {
  return { version, columns: [columnFromFile(column)] } as unknown as BoardConfig;
}

describe('isNewerFileFormat', () => {
  it.each<[string, unknown, boolean]>([
    ['undefined', undefined, false],
    ['null', null, false],
    ['the current version', CURRENT_VERSION, false],
    ['a newer whole number', CURRENT_VERSION + 1, true],
    ['a numeric string of a newer version', String(CURRENT_VERSION + 1), true],
    ['a numeric string of the current version', String(CURRENT_VERSION), true],
    ['a fractional number', 1.5, true],
  ])('%s', (_label, version, expected) => {
    expect(isNewerFileFormat(version)).toBe(expected);
  });
});

describe('newerFormatReason', () => {
  it('names a string version as text', () => {
    expect(newerFormatReason('beta')).toContain('file format beta');
  });

  it('renders an object version as its JSON', () => {
    expect(newerFormatReason({ major: 2 })).toContain('file format {"major":2}');
  });
});

describe('legacyKeyReadable', () => {
  it.each<[string, unknown, boolean]>([
    ['undefined (the local file)', undefined, true],
    ['null', null, true],
    ['the last version that carries the key', 1, true],
    ['a version past it', 2, false],
    ['a string version', '1', false],
  ])('finalLine at %s', (_label, version, expected) => {
    expect(legacyKeyReadable('finalLine', version)).toBe(expected);
  });
});

describe('migrateBoardColumnFields', () => {
  it('converts permissionStrategy and an old permissionMode value in a version 1 file', () => {
    const strategyConfig = configFromFile(1, { permissionStrategy: 'acceptEdits' });
    migrateBoardColumnFields(strategyConfig);
    const migratedStrategy = strategyConfig.columns[0] as unknown as Record<string, unknown>;
    expect(migratedStrategy.permissionMode).toBe('acceptEdits');
    expect(migratedStrategy.permissionStrategy).toBeUndefined();

    const valueConfig = configFromFile(1, { permissionMode: 'bypass-permissions' });
    migrateBoardColumnFields(valueConfig);
    expect(valueConfig.columns[0].permissionMode).toBe('bypassPermissions');
  });

  it('leaves both untouched in a version 2 file', () => {
    const strategyConfig = configFromFile(2, { permissionStrategy: 'acceptEdits' });
    migrateBoardColumnFields(strategyConfig);
    const untouchedStrategy = strategyConfig.columns[0] as unknown as Record<string, unknown>;
    expect(untouchedStrategy.permissionStrategy).toBe('acceptEdits');
    expect(untouchedStrategy.permissionMode).toBeUndefined();

    const valueConfig = configFromFile(2, { permissionMode: 'bypass-permissions' });
    migrateBoardColumnFields(valueConfig);
    expect(valueConfig.columns[0].permissionMode).toBe('bypass-permissions');
  });

  it('converts in a config with no version (the local file)', () => {
    const config = configFromFile(undefined, { permissionStrategy: 'acceptEdits' });
    migrateBoardColumnFields(config);
    expect(config.columns[0].permissionMode).toBe('acceptEdits');

    const valueConfig = configFromFile(undefined, { permissionMode: 'manual' });
    migrateBoardColumnFields(valueConfig);
    expect(valueConfig.columns[0].permissionMode).toBe('default');
  });
});

describe('fileHoldsUnreadableAutomations', () => {
  it('is false when columns is not a list', () => {
    expect(fileHoldsUnreadableAutomations({ name: 'Executing' }, 1)).toBe(false);
    expect(fileHoldsUnreadableAutomations(undefined, 1)).toBe(false);
  });

  it('skips a null entry without throwing', () => {
    expect(fileHoldsUnreadableAutomations([null], 1)).toBe(false);
  });

  it('is true for a column with a row whose maxRuns is not a number', () => {
    const column = columnFromFile({
      automations: { onTurnEnd: [{ name: 'Loop', type: 'notify', maxRuns: '3' }] },
    });
    expect(fileHoldsUnreadableAutomations([column], 1)).toBe(true);
  });

  it('is true for a retired key in a version 2 file', () => {
    const column = columnFromFile({ autoCommand: '/start' });
    expect(fileHoldsUnreadableAutomations([column], 2)).toBe(true);
    expect(fileHoldsUnreadableAutomations([column], 1)).toBe(false);
  });
});

describe('planColumnAutomations at file format 2', () => {
  it.each<[string, unknown]>([
    ['null', null],
    ['blank text', '   '],
  ])('plans a column whose autoCommand is %s normally', (_label, autoCommand) => {
    const plan = planColumnAutomations(columnFromFile({ autoCommand }), { formatVersion: 2 });
    expect(plan.keepExisting).toBe(false);
    expect(plan.rows).toEqual([]);
    expect(plan.warnings.filter((warning) => warning.includes('no longer reads'))).toEqual([]);
  });

  it('keeps the column and warns for an autoCommand that carries a message', () => {
    const plan = planColumnAutomations(columnFromFile({ autoCommand: '/start' }), { formatVersion: 2 });
    expect(plan.keepExisting).toBe(true);
    expect(plan.warnings.join('\n')).toContain('uses autoCommand, which file format 2 no longer reads.');
  });

  it('reads a run_script row with workingDir and its declared fields', () => {
    const column = columnFromFile({
      automations: {
        onEnter: [{ name: 'Setup', type: 'run_script', script: 'npm ci', timeoutMinutes: 5, workingDir: 'packages/app' }],
      },
    });
    const plan = planColumnAutomations(column, { formatVersion: 2 });
    expect(plan.keepExisting).toBe(false);
    expect(plan.rows).toHaveLength(1);
    expect(plan.warnings.filter((warning) => warning.includes('which this build cannot read'))).toEqual([]);
  });

  it('keeps the column for a send_message row that carries only command', () => {
    const column = columnFromFile({
      automations: { onEnter: [{ name: 'Start', type: 'send_message', command: '/start' }] },
    });
    const plan = planColumnAutomations(column, { formatVersion: 2 });
    expect(plan.keepExisting).toBe(true);
    expect(plan.warnings.join('\n')).toContain('uses command, which file format 2 no longer reads.');
  });

  it('flags a key this build does not know on a known row type', () => {
    const column = columnFromFile({
      automations: { onEnter: [{ name: 'Setup', type: 'run_script', script: 'npm ci', futureGuard: true }] },
    });
    const plan = planColumnAutomations(column, { formatVersion: 2 });
    expect(plan.keepExisting).toBe(true);
    expect(plan.warnings.join('\n')).toContain('"futureGuard", which this build cannot read');
    expect(planColumnAutomations(column, { formatVersion: 1 }).keepExisting).toBe(false);
  });
});
