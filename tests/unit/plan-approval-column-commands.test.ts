/**
 * `planApproval` on the MCP column commands, against a real in-memory SQLite DB.
 *
 * A plan column's approval is "manual" (the user answers the plan dialog) or
 * "automatic" (Kangentic answers it). The commands reachable from an agent or
 * the phone are:
 *   - `update_column`  sets it on an existing column;
 *   - `create_column`  sets it on a new one, and a column that does not name it
 *                      is Manual (the safe answer);
 *   - `get_column_detail` is the read-before-write call, so it prints it, and
 *                      says when the setting is inert because the column is not
 *                      a plan column.
 *
 * The mobile bridge reaches these handlers with no zod schema in front of them,
 * so the handler is the only narrowing. A bad value must be refused BEFORE any
 * write. Every "writes nothing" assertion reads the raw `plan_approval` column,
 * not the repository: `SwimlaneRepository.mapRow` narrows an unknown stored
 * value to 'manual', so a read through the repository would hide a 'bogus' that
 * hit disk.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import { openTestDatabase } from './helpers/test-database';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { handleCreateColumn, handleUpdateColumn } from '../../src/main/agent/commands/column-commands';
import { handleGetColumnDetail } from '../../src/main/agent/commands/analytics-commands';
import type { CommandContext } from '../../src/main/agent/commands/types';

describe('planApproval on the MCP column commands', () => {
  let database: DatabaseType.Database;
  let repository: SwimlaneRepository;
  let context: CommandContext;

  beforeEach(() => {
    database = openTestDatabase();
    runProjectMigrations(database);
    repository = new SwimlaneRepository(database);
    context = {
      getProjectDb: () => database,
      getProjectPath: () => 'C:/Users/dev/project',
      getBoardProfiles: () => [],
      setBoardProfiles: vi.fn(),
      onTaskCreated: vi.fn(),
      onTaskUpdated: vi.fn(),
      onTaskDeleted: vi.fn(),
      onTaskMove: vi.fn().mockResolvedValue(undefined),
      onTasksReordered: vi.fn(),
      onSwimlaneUpdated: vi.fn(),
      onSwimlaneDeleted: vi.fn(),
      onBacklogChanged: vi.fn(),
      onLabelColorsChanged: vi.fn(),
    } as unknown as CommandContext;
  });

  afterEach(() => {
    database.close();
  });

  /** The stored value, read around the repository's narrowing. */
  function storedPlanApproval(swimlaneId: string): string {
    const row = database.prepare('SELECT plan_approval FROM swimlanes WHERE id = ?').get(swimlaneId) as { plan_approval: string };
    return row.plan_approval;
  }

  function columnNamed(name: string) {
    const lane = repository.list().find((candidate) => candidate.name === name);
    if (!lane) throw new Error(`No column named "${name}"`);
    return lane;
  }

  describe('update_column', () => {
    it('stores "automatic" and echoes it', async () => {
      const lane = repository.create({ name: 'Plan Gate', permission_mode: 'plan' });
      expect(storedPlanApproval(lane.id)).toBe('manual');

      const response = await handleUpdateColumn({ column: 'Plan Gate', planApproval: 'automatic' }, context);

      expect(response.success).toBe(true);
      expect(storedPlanApproval(lane.id)).toBe('automatic');
      expect((response.data as { planApproval: string }).planApproval).toBe('automatic');
      expect(response.message).toContain('planApproval');
    });

    it('stores "manual" over a column that was Automatic', async () => {
      const lane = repository.create({ name: 'Plan Gate', permission_mode: 'plan', plan_approval: 'automatic' });

      const response = await handleUpdateColumn({ column: 'Plan Gate', planApproval: 'manual' }, context);

      expect(response.success).toBe(true);
      expect(storedPlanApproval(lane.id)).toBe('manual');
      expect((response.data as { planApproval: string }).planApproval).toBe('manual');
    });

    it.each([
      ['an unknown word', 'bogus'],
      ['the right word in the wrong case', 'AUTOMATIC'],
      ['an empty string', ''],
      ['a number', 7],
      ['a list holding the right word', ['automatic']],
    ])('refuses %s with the enum error and writes nothing, not even the other fields of the call', async (_label, planApproval) => {
      const lane = repository.create({ name: 'Plan Gate', permission_mode: 'plan', plan_approval: 'automatic' });

      const response = await handleUpdateColumn(
        { column: 'Plan Gate', name: 'Renamed Gate', planApproval },
        context,
      );

      expect(response.success).toBe(false);
      expect(response.error).toContain('Invalid planApproval');
      expect(response.error).toContain('automatic, manual');
      // The raw column, and the sibling field of the same call: a refusal that
      // came after the rename would leave a half-applied update behind.
      expect(storedPlanApproval(lane.id)).toBe('automatic');
      expect(repository.getById(lane.id)?.name).toBe('Plan Gate');
      expect(context.onSwimlaneUpdated).not.toHaveBeenCalled();
    });

    it('lists planApproval among the fields a caller may provide', async () => {
      repository.create({ name: 'Plan Gate' });

      const response = await handleUpdateColumn({ column: 'Plan Gate' }, context);

      expect(response.success).toBe(false);
      expect(response.error).toContain('planApproval');
    });
  });

  describe('create_column', () => {
    it('stores "automatic" and echoes it', async () => {
      const response = await handleCreateColumn(
        { name: 'Plan Gate', permissionMode: 'plan', planApproval: 'automatic' },
        context,
      );

      expect(response.success).toBe(true);
      const created = columnNamed('Plan Gate');
      expect(storedPlanApproval(created.id)).toBe('automatic');
      expect((response.data as { planApproval: string }).planApproval).toBe('automatic');
    });

    it('stores "manual" when asked for it', async () => {
      const response = await handleCreateColumn({ name: 'Plan Gate', planApproval: 'manual' }, context);

      expect(response.success).toBe(true);
      expect(storedPlanApproval(columnNamed('Plan Gate').id)).toBe('manual');
    });

    it('is Manual when the call does not name it, and says so', async () => {
      const response = await handleCreateColumn({ name: 'Plan Gate', permissionMode: 'plan' }, context);

      expect(response.success).toBe(true);
      expect(storedPlanApproval(columnNamed('Plan Gate').id)).toBe('manual');
      expect((response.data as { planApproval: string }).planApproval).toBe('manual');
    });

    it('refuses an invalid value and creates no column', async () => {
      const columnCountBefore = repository.list().length;

      const response = await handleCreateColumn({ name: 'Plan Gate', planApproval: 'bogus' }, context);

      expect(response.success).toBe(false);
      expect(response.error).toContain('Invalid planApproval');
      expect(response.error).toContain('automatic, manual');
      expect(repository.list()).toHaveLength(columnCountBefore);
      expect(repository.list().some((lane) => lane.name === 'Plan Gate')).toBe(false);
    });
  });

  describe('get_column_detail', () => {
    /** The detail line that starts with "Plan approval:", or undefined. */
    async function planApprovalLine(columnName: string): Promise<string | undefined> {
      const response = await handleGetColumnDetail({ column: columnName }, context);
      expect(response.success).toBe(true);
      return (response.message ?? '').split('\n').map((line) => line.trim()).find((line) => line.startsWith('Plan approval:'));
    }

    it('prints "Plan approval: automatic" for a plan column, with no caveat', async () => {
      repository.create({ name: 'Plan Gate', permission_mode: 'plan', plan_approval: 'automatic' });

      expect(await planApprovalLine('Plan Gate')).toBe('Plan approval: automatic');
    });

    it('prints "Plan approval: manual" for a plan column left at the default', async () => {
      repository.create({ name: 'Plan Gate', permission_mode: 'plan' });

      expect(await planApprovalLine('Plan Gate')).toBe('Plan approval: manual');
    });

    it('says the setting applies only while permission mode is plan, on a column that is not a plan column', async () => {
      repository.create({ name: 'Build Step', permission_mode: null, plan_approval: 'automatic' });
      repository.create({ name: 'Accept Step', permission_mode: 'acceptEdits', plan_approval: 'automatic' });

      expect(await planApprovalLine('Build Step'))
        .toBe('Plan approval: automatic (applies only while permission mode is plan)');
      expect(await planApprovalLine('Accept Step'))
        .toBe('Plan approval: automatic (applies only while permission mode is plan)');
    });

    it('carries the value on the structured data too', async () => {
      repository.create({ name: 'Plan Gate', permission_mode: 'plan', plan_approval: 'automatic' });
      repository.create({ name: 'Build Step', permission_mode: null });

      const planColumn = await handleGetColumnDetail({ column: 'Plan Gate' }, context);
      const otherColumn = await handleGetColumnDetail({ column: 'Build Step' }, context);

      expect((planColumn.data as { planApproval: string }).planApproval).toBe('automatic');
      expect((otherColumn.data as { planApproval: string }).planApproval).toBe('manual');
    });

    it('reads back what update_column wrote, so a caller can tell a default from a write that did not take', async () => {
      repository.create({ name: 'Plan Gate', permission_mode: 'plan' });
      expect(await planApprovalLine('Plan Gate')).toBe('Plan approval: manual');

      await handleUpdateColumn({ column: 'Plan Gate', planApproval: 'automatic' }, context);

      expect(await planApprovalLine('Plan Gate')).toBe('Plan approval: automatic');
    });
  });
});
