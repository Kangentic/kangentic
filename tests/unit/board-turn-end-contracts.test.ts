/**
 * Pins the final-line contracts between this repo's own board (`kangentic.json`) and the script,
 * skills and message that print the lines its On agent turn end rows read.
 *
 * A Text match row (`finalLine`) moves a card only when the WHOLE last line of the agent's final
 * message matches it. When a row and its producer drift apart (a reworded skill, a renamed row, the
 * verdict printed above its steps again), nothing errors anywhere: the card just waits in its
 * column. So each row is held to the thing that prints its line:
 *
 * 1. Code Review: scripts/review-verdict.mjs's closing block, and the summary the skill pastes,
 *    END on exactly the Back for revisions and On to Testing lines. Exact equality is stricter than
 *    the matcher on purpose: the script is deterministic, so the matcher's leniency is never what
 *    makes this pass. Back for revisions carries the reply, which is where the numbered steps are.
 * 2. Testing: /pull-request prints the On to Merge line in its success report step and names the
 *    row that reads it, and its escalation step's line does not match the row.
 * 3. Executing: the Apply findings message asks for exactly the On to Code Review line.
 * 4. Merge: /merge-pull-request prints the Finish line in its report step and names the row that
 *    reads it.
 *
 * A skill pin reads only the step that prints the line, because each skill also quotes it in its
 * intro and its Outcome line section, where a quote would pass with the printing step gone.
 * 5. Row shape: every Text match row on the board is one this file pins, a Text match sits only on
 *    a turn-end row and never beside a condition, no row's line in a column matches another row
 *    there, and every Move to column target is a column that exists.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { renderClosingBlock, renderSummary } from '../../scripts/review-verdict.mjs';
import { matchFinalLine } from '../../src/shared/final-line-match';

const REPOSITORY_ROOT = path.resolve(__dirname, '../..');

interface AutomationRow {
  name: string;
  type: string;
  finalLine?: string;
  condition?: string;
  targetColumn?: string;
  message?: string;
}

interface BoardColumn {
  id: string;
  name: string;
  automations?: Record<string, AutomationRow[]>;
}

interface BoardConfig {
  columns: BoardColumn[];
}

function readRepositoryFile(relativePath: string): string {
  return fs.readFileSync(path.join(REPOSITORY_ROOT, relativePath), 'utf8');
}

const board = JSON.parse(readRepositoryFile('kangentic.json')) as BoardConfig;

function turnEndRow(columnName: string, rowName: string): AutomationRow {
  const column = board.columns.find((candidate) => candidate.name === columnName);
  if (!column) throw new Error(`kangentic.json has no "${columnName}" column`);
  const row = column.automations?.onTurnEnd?.find((candidate) => candidate.name === rowName);
  if (!row) throw new Error(`kangentic.json's ${columnName} column has no "${rowName}" turn-end row`);
  return row;
}

function finalLineOf(columnName: string, rowName: string): string {
  const { finalLine } = turnEndRow(columnName, rowName);
  if (finalLine === undefined) throw new Error(`the ${columnName} "${rowName}" row has no finalLine`);
  return finalLine;
}

// A boolean with a message, so a failure names the missing text instead of printing a whole skill.
function expectTextIn(source: string, sourceName: string, expectedText: string): void {
  expect(source.includes(expectedText), `${sourceName} does not contain ${expectedText}`).toBe(true);
}

// The text from a `## ` heading up to the next one. The search for the end keeps the trailing
// space, so a `### ` subheading inside the step does not end it.
function sectionOf(source: string, sourceName: string, heading: string): string {
  const start = source.indexOf(`\n${heading}`);
  if (start === -1) throw new Error(`${sourceName} has no "${heading}" heading`);
  const end = source.indexOf('\n## ', start + 1);
  return source.slice(start, end === -1 ? undefined : end);
}

function lastLineOf(text: string): string {
  const lines = text.trimEnd().split('\n');
  return lines[lines.length - 1];
}

/**
 * Every Text match row this file holds to a producer, as `<column>/<row>`. Each entry has its
 * producer test in a describe below, so add the two together.
 */
const PINNED_ROWS = new Set([
  'Executing/On to Code Review',
  'Code Review/Back for revisions',
  'Code Review/On to Testing',
  'Testing/On to Merge',
  'Merge/Finish',
]);

const READY_REPORT = { checks: { typecheck: 'pass', hmrVitest: 'pass', scopedTests: 'none' }, findings: [] };

// A failed check is a blocker on its own, so no finding is needed to reach Blocked.
const BLOCKED_REPORT = { checks: { typecheck: 'fail', hmrVitest: 'pass', scopedTests: 'none' }, findings: [] };

describe('board turn-end contracts: Code Review', () => {
  it('ends a Ready pass on exactly the On to Testing line', () => {
    const onToTesting = finalLineOf('Code Review', 'On to Testing');
    expect(lastLineOf(renderClosingBlock(READY_REPORT)), 'the closing block').toBe(onToTesting);
    expect(lastLineOf(renderSummary(READY_REPORT)), 'the summary').toBe(onToTesting);
  });

  it('ends a Blocked pass on exactly the Back for revisions line, below its numbered steps', () => {
    const backForRevisions = finalLineOf('Code Review', 'Back for revisions');
    const closingLines = renderClosingBlock(BLOCKED_REPORT).split('\n');
    const stepLines = closingLines.slice(0, -1);
    expect(stepLines.length, 'numbered steps above the verdict').toBeGreaterThan(0);
    expect(closingLines[closingLines.length - 1], 'the closing block').toBe(backForRevisions);
    expect(
      stepLines.filter((line: string) => !/^\d+\. /.test(line)),
      'closing block lines above the verdict that are not numbered steps',
    ).toEqual([]);
    expect(lastLineOf(renderSummary(BLOCKED_REPORT)), 'the summary').toBe(backForRevisions);
  });

  it('sends the review reply back to Executing, since the steps live in it', () => {
    const backForRevisions = turnEndRow('Code Review', 'Back for revisions');
    expect(backForRevisions.targetColumn).toBe('Executing');
    expect(backForRevisions.message).toContain('{{agentReply}}');
  });
});

describe('board turn-end contracts: Testing', () => {
  const skillPath = '.claude/skills/pull-request/SKILL.md';

  it('has /pull-request print the On to Merge line in Step 8 and name the row that reads it', () => {
    const pullRequestSkill = readRepositoryFile(skillPath);
    const reportStep = sectionOf(pullRequestSkill, skillPath, '## Step 8 - Report');
    expectTextIn(reportStep, `${skillPath} Step 8`, `\`${finalLineOf('Testing', 'On to Merge')}\``);
    expectTextIn(pullRequestSkill, skillPath, '"On to Merge"');
  });

  it('keeps the escalation line from reading as ready to merge', () => {
    const pullRequestSkill = readRepositoryFile(skillPath);
    const escalateStep = sectionOf(pullRequestSkill, skillPath, '## Step 8b - Escalate');
    expectTextIn(escalateStep, `${skillPath} Step 8b`, '`PR: blocked`');
    expect(
      matchFinalLine(finalLineOf('Testing', 'On to Merge'), 'Three rounds failed.\n\nPR: blocked').met,
      'PR: blocked matches the On to Merge row',
    ).toBe(false);
  });
});

describe('board turn-end contracts: Executing', () => {
  it('asks the agent for exactly the line On to Code Review matches', () => {
    const applyFindingsMessage = turnEndRow('Executing', 'Apply findings').message ?? '';
    expectTextIn(applyFindingsMessage, 'the Apply findings message', `"${finalLineOf('Executing', 'On to Code Review')}"`);
  });
});

describe('board turn-end contracts: Merge', () => {
  it('has /merge-pull-request print the Finish line in Step 5 and name the row that reads it', () => {
    const skillPath = '.claude/skills/merge-pull-request/SKILL.md';
    const mergePullRequestSkill = readRepositoryFile(skillPath);
    const reportStep = sectionOf(mergePullRequestSkill, skillPath, '## Step 5 - Report');
    expectTextIn(reportStep, `${skillPath} Step 5`, `\`${finalLineOf('Merge', 'Finish')}\``);
    expectTextIn(mergePullRequestSkill, skillPath, '"Finish"');
  });
});

describe('board turn-end contracts: row shape', () => {
  const columnNames = new Set(board.columns.map((column) => column.name));
  const everyRow = board.columns.flatMap((column) =>
    Object.entries(column.automations ?? {}).flatMap(([trigger, rows]) =>
      rows.map((row) => ({ columnName: column.name, trigger, row })),
    ),
  );
  const textMatchRows = everyRow.flatMap(({ columnName, trigger, row }) =>
    row.finalLine === undefined ? [] : [{ columnName, trigger, row, finalLine: row.finalLine }],
  );

  it('pins every Text match row on the board, and finds every row it pins', () => {
    const onBoard = new Set(textMatchRows.map(({ columnName, row }) => `${columnName}/${row.name}`));
    expect(onBoard).toEqual(PINNED_ROWS);
  });

  it('puts a Text match only on a turn-end row, never beside a condition', () => {
    for (const { columnName, trigger, row } of textMatchRows) {
      expect(trigger, `${columnName} "${row.name}"`).toBe('onTurnEnd');
      expect(row.condition, `${columnName} "${row.name}"`).toBeUndefined();
    }
  });

  it('never lets one row\'s line match another Text match row in its column', () => {
    for (const { columnName, row, finalLine } of textMatchRows) {
      for (const { columnName: otherColumn, row: otherRow, finalLine: otherFinalLine } of textMatchRows) {
        if (otherColumn !== columnName || otherRow === row) continue;
        expect(matchFinalLine(otherFinalLine, finalLine).met, `${columnName}: "${finalLine}" matches "${otherRow.name}"`).toBe(false);
      }
    }
  });

  it('moves only to a column the board has', () => {
    for (const { columnName, row } of everyRow) {
      if (row.type !== 'move_to_column' || row.targetColumn === undefined) continue;
      expect(columnNames.has(row.targetColumn), `${columnName} "${row.name}" -> ${row.targetColumn}`).toBe(true);
    }
  });
});
