/**
 * The `kangentic.json` file format is versioned, and this test is what makes
 * the version mean something.
 *
 * On 2026-11-12 the file moved from `finalLine` to `condition.text` with
 * `version` still at 1. A running build from before the change read every
 * `condition.text` as noise, ran the guarded Move to column rows unguarded,
 * and wrote the file back without them. A build reads `version` to learn it
 * cannot read all of a file, and then never writes it (`isNewerFileFormat`),
 * but only if every change to what the serializer writes bumps it.
 *
 * So this serializes a maximal board from a real database (every column
 * field, every automation type on every trigger it runs on with every field
 * set, every Condition variant, and every key the file carries across) and
 * holds its shape to the signature recorded for `CURRENT_VERSION`. A change to
 * that shape fails here until the version is bumped and a new signature
 * recorded. The coverage checks fail when the fixture stops exercising a key,
 * so a new field cannot slip past by never being set.
 *
 * Real better-sqlite3, the driver production uses.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import type { AutomationWriteInput, BoardConfig } from '../../src/shared/types';
import type { AutomationField } from '../../src/shared/automation-manifest';

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../src/main/db/database', () => ({
  getProjectDb: () => harness.db,
}));

const { runProjectMigrations } = await import('../../src/main/db/migrations/project-schema');
const { buildBoardConfigFromDb } = await import('../../src/main/config/board-config/build-config');
const { AutomationRepository } = await import('../../src/main/db/repositories/automation-repository');
const { SwimlaneRepository } = await import('../../src/main/db/repositories/swimlane-repository');
const { AUTOMATION_MANIFEST, AUTOMATION_TRIGGERS, AUTOMATION_TRIGGER_FILE_KEYS, isTypeOfferedOnTrigger } =
  await import('../../src/shared/automation-manifest');
const { CURRENT_VERSION, LEGACY_FILE_KEYS, isLegacyPermissionValue } = await import('../../src/main/config/board-config/config-helpers');

import { openTestDatabase } from './helpers/test-database';
import { readInterfaceFieldNames } from './helpers/shared-type-source';
import { FORMAT_SIGNATURE_BY_VERSION } from './helpers/board-config-format-history';

/** Keys the file still READS from older formats and never writes (`LEGACY_FILE_KEYS`). */
const READ_ONLY_COLUMN_KEYS = new Set(['autoCommand', 'autoCommandMode']);
const READ_ONLY_TOP_LEVEL_KEYS = new Set(['actions', 'transitions']);

/** Object keys that are data, not format: a profile's column ids and a webhook's header names. */
function isDataKeyedObject(path: string): boolean {
  return path === 'profiles[].columns' || path.endsWith('.headers');
}

/**
 * The shape of a JSON value as sorted `path:jsonType` lines. An array's index
 * collapses to `[]`, so one row stands for every row of its group; an empty
 * array or object is a line of its own.
 */
function signatureOf(value: unknown): string[] {
  const lines = new Set<string>();
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      if (node.length === 0) lines.add(`${path}:array`);
      for (const item of node) walk(item, `${path}[]`);
    } else if (node !== null && typeof node === 'object') {
      const entries = Object.entries(node);
      if (entries.length === 0) lines.add(`${path}:object`);
      for (const [key, child] of entries) {
        const segment = isDataKeyedObject(path) ? '{key}' : key;
        walk(child, path === '' ? segment : `${path}.${segment}`);
      }
    } else {
      lines.add(`${path}:${node === null ? 'null' : typeof node}`);
    }
  };
  walk(value, '');
  return [...lines].sort();
}

/** A value of the field's own kind, never its default, so the serializer writes it. */
function valueForField(field: AutomationField): unknown {
  switch (field.kind) {
    case 'segmented':
    case 'select': {
      const options = field.options ?? [];
      const other = options.find((option) => option.value !== field.defaultValue) ?? options[0];
      if (!other) throw new Error(`Field ${field.key} has no options to choose from`);
      return other.value;
    }
    case 'number':
      return (field.min ?? 1) + 1;
    case 'headers':
      return { 'X-Board': 'kangentic' };
    case 'column':
      return 'Executing';
    default:
      return `${field.key} value`;
  }
}

describe('kangentic.json file format version', () => {
  const openDatabases: DatabaseType.Database[] = [];

  afterEach(() => {
    harness.db = null;
    for (const database of openDatabases.splice(0)) database.close();
  });

  /** Every key the serializer can write, set to a value it writes. */
  function buildMaximalBoard(): BoardConfig {
    const database = openTestDatabase();
    openDatabases.push(database);
    database.exec('PRAGMA foreign_keys = ON');
    runProjectMigrations(database);
    harness.db = database;
    const lanes = new SwimlaneRepository(database);
    const automations = new AutomationRepository(database);

    const executing = lanes.list().find((lane) => lane.name === 'Executing')!;
    const everything = lanes.create({
      name: 'Everything',
      description: 'Every column field, set',
      color: '#123456',
      icon: 'star',
      is_archived: true,
      permission_mode: 'plan',
      auto_spawn: true,
      plan_exit_target_id: executing.id,
      plan_approval: 'automatic',
      agent_override: 'claude',
      model_override: 'opus',
      effort_override: 'high',
      handoff_context: true,
      session_target: 'isolated',
      session_spawn_strategy: 'always_spawn_new',
      max_agents: 2,
    });

    const rows: AutomationWriteInput[] = [];
    for (const [type, entry] of Object.entries(AUTOMATION_MANIFEST)) {
      for (const trigger of AUTOMATION_TRIGGERS) {
        if (!isTypeOfferedOnTrigger(type as keyof typeof AUTOMATION_MANIFEST, trigger)) continue;
        const config = Object.fromEntries(entry.fields.map((field) => [field.key, valueForField(field)]));
        rows.push({ name: `${type} ${trigger}`, type: type as AutomationWriteInput['type'], trigger, enabled: true, config });
      }
    }
    // Every Condition variant, the row keys beside it, and the one written value of `enabled`.
    rows.push(
      { name: 'Agent condition', type: 'notify', trigger: 'turn_end', enabled: false, config: {}, condition: 'The review is clean', max_runs: 3 },
      { name: 'One pattern', type: 'notify', trigger: 'turn_end', enabled: true, config: {}, final_line: 'Verdict: Ready' },
      { name: 'Pattern list', type: 'notify', trigger: 'turn_end', enabled: true, config: {}, final_line: 'Ready for *\n!Ready for review' },
      { name: 'User message', type: 'notify', trigger: 'turn_end', enabled: true, config: {}, final_line: 'signed off', text_match_source: 'user' },
      { name: 'User patterns', type: 'notify', trigger: 'turn_end', enabled: true, config: {}, final_line: 'signed off\n!not signed off', text_match_source: 'user' },
    );
    automations.replaceForColumn(everything.id, rows);

    // The keys with no database representation, carried across from the file.
    const existingTeamConfig: BoardConfig = {
      version: CURRENT_VERSION,
      columns: [],
      shortcuts: [{ id: 'shortcut-1', label: 'Open in editor', icon: 'code', command: 'code "{{cwd}}"', display: 'both' }],
      profiles: [{
        id: 'profile-1',
        name: 'Heavy',
        description: 'Opus everywhere',
        columns: {
          [executing.id]: {
            agentOverride: 'claude',
            modelOverride: 'opus',
            effortOverride: 'xhigh',
            permissionMode: 'acceptEdits',
            autoCommand: '/plan',
            autoCommandMode: 'deferred',
            autoSpawn: false,
            handoffContext: true,
            sessionTarget: 'isolated',
            sessionSpawnStrategy: 'always_spawn_new',
            planExitTarget: 'Executing',
          },
        },
      }],
      defaultBaseBranch: 'main',
      stopScript: 'npm run stop',
    };
    return buildBoardConfigFromDb({ projectId: 'p1', existingTeamConfig, fingerprint: 'test' });
  }

  it('writes the shape recorded for the current version', () => {
    const signature = signatureOf(buildMaximalBoard());
    const recorded = FORMAT_SIGNATURE_BY_VERSION[CURRENT_VERSION];

    const added = signature.filter((line) => !recorded?.includes(line));
    const removed = (recorded ?? []).filter((line) => !signature.includes(line));
    expect(
      { added, removed },
      `kangentic.json changed shape at version ${CURRENT_VERSION}. An older build reading the new file would `
      + 'drop what it cannot read when it writes the file back. Bump CURRENT_VERSION in config-helpers.ts, record '
      + 'the new signature as a NEW entry in tests/unit/helpers/board-config-format-history.ts (never edit a shipped '
      + 'one), and add any key the new format replaces to LEGACY_FILE_KEYS.\nNew signature:\n'
      + JSON.stringify(signature, null, 2),
    ).toEqual({ added: [], removed: [] });
  });

  it('records a signature for every version up to the current one', () => {
    for (let version = 1; version <= CURRENT_VERSION; version++) {
      expect(FORMAT_SIGNATURE_BY_VERSION[version], `no signature recorded for version ${version}`).toBeDefined();
    }
    expect(Math.max(...Object.keys(FORMAT_SIGNATURE_BY_VERSION).map(Number))).toBe(CURRENT_VERSION);
  });

  describe('the fixture sets every key, so a new one cannot pass by never being written', () => {
    const signature = (): string[] => signatureOf(buildMaximalBoard());

    it('every column key', () => {
      const lines = signature();
      for (const key of readInterfaceFieldNames('BoardColumnConfig')) {
        if (READ_ONLY_COLUMN_KEYS.has(key)) continue;
        expect(lines.some((line) => line.startsWith(`columns[].${key}`)), `columns[].${key}`).toBe(true);
      }
    });

    it('every top-level key', () => {
      const lines = signature();
      for (const key of readInterfaceFieldNames('BoardConfig')) {
        if (READ_ONLY_TOP_LEVEL_KEYS.has(key)) continue;
        expect(lines.some((line) => line.startsWith(`${key}:`) || line.startsWith(`${key}[]`) || line.startsWith(`${key}.`)), key).toBe(true);
      }
    });

    // Shortcuts and Board Profiles have no database representation: the export
    // carries them across from the file as they are, so their shape is the file's.
    it('every shortcut, profile and profile entry key', () => {
      const lines = signature();
      const covered = (prefix: string) => lines.some((line) => line.startsWith(prefix));
      for (const key of readInterfaceFieldNames('ShortcutConfig')) expect(covered(`shortcuts[].${key}`), `shortcuts[].${key}`).toBe(true);
      for (const key of readInterfaceFieldNames('BoardProfile')) expect(covered(`profiles[].${key}`), `profiles[].${key}`).toBe(true);
      for (const key of readInterfaceFieldNames('BoardProfileEntry')) {
        expect(covered(`profiles[].columns.{key}.${key}`), `profiles[].columns.{key}.${key}`).toBe(true);
      }
    });

    it('every automation group, and every field of every type', () => {
      const lines = signature();
      for (const fileKey of Object.values(AUTOMATION_TRIGGER_FILE_KEYS)) {
        expect(lines.some((line) => line.startsWith(`columns[].automations.${fileKey}[]`)), fileKey).toBe(true);
      }
      for (const entry of Object.values(AUTOMATION_MANIFEST)) {
        for (const field of entry.fields) {
          expect(lines.some((line) => new RegExp(`^columns\\[\\]\\.automations\\.\\w+\\[\\]\\.${field.key}[.:\\[]`).test(line)), field.key).toBe(true);
        }
      }
    });

    it('every Condition variant and row key', () => {
      const lines = signature();
      const row = (suffix: string) => lines.some((line) => /^columns\[\]\.automations\.onTurnEnd\[\]\./.test(line) && line.endsWith(suffix));
      expect(row('.condition.agent:string')).toBe(true);
      expect(row('.condition.text:string')).toBe(true);
      expect(row('.condition.text[]:string')).toBe(true);
      expect(row('.condition.text.from:string')).toBe(true);
      expect(row('.condition.text.patterns:string')).toBe(true);
      expect(row('.condition.text.patterns[]:string')).toBe(true);
      expect(row('.maxRuns:number')).toBe(true);
      expect(row('.enabled:boolean')).toBe(true);
    });
  });

  // A key the newest format replaced is read and converted, never written: the
  // open-time export is what migrates a file to the newest format.
  describe('legacy keys', () => {
    const LEGACY_KEY_ABSENT: Record<string, (lines: string[], file: BoardConfig) => boolean> = {
      finalLine: (lines) => !lines.some((line) => /^columns\[\]\.automations\.\w+\[\]\.finalLine:/.test(line)),
      textCondition: (lines) => !lines.some((line) => /^columns\[\]\.automations\.\w+\[\]\.condition:string$/.test(line)),
      sendCommandType: (_lines, file) => !JSON.stringify(file.columns).includes('"send_command"'),
      commandField: (lines) => !lines.some((line) => /^columns\[\]\.automations\.\w+\[\]\.command:/.test(line)),
      autoCommand: (lines) => !lines.some((line) => /^columns\[\]\.autoCommand(Mode)?:/.test(line)),
      permissionStrategy: (lines) => !lines.some((line) => line.startsWith('columns[].permissionStrategy')),
      legacyPermissionValue: (_lines, file) => !file.columns.some((column) => isLegacyPermissionValue(column.permissionMode)),
      actions: (lines) => !lines.some((line) => line.startsWith('actions')),
      transitions: (lines) => !lines.some((line) => line.startsWith('transitions')),
    };

    it('has a check for every LEGACY_FILE_KEYS entry', () => {
      expect(Object.keys(LEGACY_KEY_ABSENT).sort()).toEqual(Object.keys(LEGACY_FILE_KEYS).sort());
    });

    it('writes none of them', () => {
      const file = buildMaximalBoard();
      const lines = signatureOf(file);
      for (const [key, absent] of Object.entries(LEGACY_KEY_ABSENT)) {
        expect(absent(lines, file), key).toBe(true);
      }
    });

    it('retires each one at or before the current version', () => {
      for (const [key, entry] of Object.entries(LEGACY_FILE_KEYS)) {
        expect(entry.lastVersion, key).toBeLessThanOrEqual(CURRENT_VERSION);
      }
    });
  });
});
