/**
 * A Text match that reads the USER's last message (`text_match_source: 'user'`,
 * #1078) is worded as the user's message everywhere a person or an agent reads
 * a row: the sentence, the guards line, the marks, and the column detail an
 * agent gets from kangentic_get_column. The agent default keeps its wording.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type DatabaseType from 'better-sqlite3';
import {
  describeAutomationGuards,
  describeAutomationMarks,
  describeAutomationMarksInWords,
  describeAutomationTextMatch,
} from '../../src/shared/automation-describe';
import { englishI18n } from '../../src/shared/i18n/english';
import { openTestDatabase } from './helpers/test-database';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { AutomationRepository } from '../../src/main/db/repositories/automation-repository';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { handleGetColumnDetail } from '../../src/main/agent/commands/analytics-commands';
import type { CommandContext } from '../../src/main/agent/commands/types';

describe('describeAutomationTextMatch by source', () => {
  it('words a user source as the user\'s message', () => {
    expect(describeAutomationTextMatch('Verdict: Ready', englishI18n, 'user'))
      .toBe('Only if your message reads "Verdict: Ready".');
  });

  it('words the agent source, and the default, as the last line', () => {
    const expected = 'Only if the last line reads "Verdict: Ready".';
    expect(describeAutomationTextMatch('Verdict: Ready', englishI18n, 'agent')).toBe(expected);
    expect(describeAutomationTextMatch('Verdict: Ready', englishI18n)).toBe(expected);
  });

  it('returns null with no Text match whatever the source', () => {
    expect(describeAutomationTextMatch(null, englishI18n, 'user')).toBeNull();
  });
});

describe('describeAutomationGuards and marks by source', () => {
  const baseRow = {
    type: 'notify' as const,
    trigger: 'turn_end' as const,
    config: { title: 'Ready' },
    condition: null,
    final_line: 'Verdict: Ready',
    max_runs: null,
  };

  it('guards: a user source reads as the user\'s message, the default as the last line', () => {
    expect(describeAutomationGuards({ ...baseRow, text_match_source: 'user' }, englishI18n))
      .toBe('Only if your message reads "Verdict: Ready".');
    expect(describeAutomationGuards(baseRow, englishI18n))
      .toBe('Only if the last line reads "Verdict: Ready".');
  });

  it('marks: the text-match mark carries the user label and phrase', () => {
    const userMark = describeAutomationMarks({ ...baseRow, text_match_source: 'user' }, englishI18n)
      .find((mark) => mark.kind === 'text-match');
    expect(userMark?.label).toBe('Condition: only if your message reads "Verdict: Ready".');
    expect(userMark?.phrase).toBe('only if your message reads "Verdict: Ready"');

    const agentMark = describeAutomationMarks({ ...baseRow, text_match_source: 'agent' }, englishI18n)
      .find((mark) => mark.kind === 'text-match');
    expect(agentMark?.label).toBe('Condition: only if the last line reads "Verdict: Ready".');
    expect(agentMark?.phrase).toBe('only if the last line reads "Verdict: Ready"');
  });

  it('marks in words use the user phrase', () => {
    expect(describeAutomationMarksInWords({ ...baseRow, text_match_source: 'user' }, englishI18n))
      .toContain('only if your message reads "Verdict: Ready"');
  });
});

describe('handleGetColumnDetail words a user-source row as the user\'s message', () => {
  let database: DatabaseType.Database;
  let context: CommandContext;
  let columnId: string;

  beforeEach(() => {
    database = openTestDatabase();
    database.exec('PRAGMA foreign_keys = ON');
    runProjectMigrations(database);
    context = { getProjectDb: () => database } as unknown as CommandContext;
    const lane = new SwimlaneRepository(database).list().find((candidate) => candidate.name === 'Executing');
    if (!lane) throw new Error('The seeded board has no Executing column');
    columnId = lane.id;
  });

  afterEach(() => {
    database.close();
  });

  function lineFor(rowName: string): string | undefined {
    const response = handleGetColumnDetail({ column: 'Executing' }, context);
    expect(response.success).toBe(true);
    return (response.message ?? '').split('\n').find((line) => line.includes(rowName));
  }

  it('says "the user\'s message" for a user row and "the last line" for an agent row', () => {
    new AutomationRepository(database).replaceForColumn(columnId, [
      { name: 'User ping', type: 'notify', trigger: 'turn_end', enabled: true, config: { title: 'U' }, final_line: 'go ahead', text_match_source: 'user' },
      { name: 'Agent ping', type: 'notify', trigger: 'turn_end', enabled: true, config: { title: 'A' }, final_line: 'Verdict: Ready' },
    ]);

    const userLine = lineFor('User ping');
    expect(userLine).toContain('only if the user\'s message reads "go ahead"');
    expect(userLine).not.toContain('the last line');
    expect(lineFor('Agent ping')).toContain('only if the last line reads "Verdict: Ready"');
  });
});
