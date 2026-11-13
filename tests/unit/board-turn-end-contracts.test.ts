/**
 * Pins the final-line contracts between this repo's own board (`kangentic.json`) and the script,
 * skills and message that print the lines its On agent turn end rows read.
 *
 * A Text match row on the agent's line (`condition.text`, or the legacy `finalLine` this file still
 * carries) moves a card only when the WHOLE last line of the agent's final message matches it. A
 * row on the user's message (`condition.text.from: "user"`) reads the owner's last message instead. When a row and its producer drift apart (a reworded skill, a renamed row, the
 * verdict printed above its steps again), nothing errors anywhere: the card just waits in its
 * column. So each row is held to the thing that prints its line:
 *
 * 0. Design: the Design contract, its On task enter message, asks for exactly the Shelved line,
 *    and Shelved is the column's only Move to column row on the agent's line. On to Planning
 *    reads the owner's message instead (#1078), so Design stays a person's gate: the owner's
 *    "signed off" or drag moves the card on, never the agent.
 * 1. Code Review: scripts/review-verdict.mjs's closing block, and the summary the skill pastes,
 *    END on exactly the Back for revisions and On to Testing lines. Exact equality is stricter than
 *    the matcher on purpose: the script is deterministic, so the matcher's leniency is never what
 *    makes this pass. Back for revisions carries the reply, which is where the numbered steps are.
 *    A pass with a step only a person can do ends on `Needs owner:` instead, which matches neither.
 * 2. Testing: /pull-request prints the On to Merge line in its success report step and names the
 *    row that reads it, and its escalation step's line does not match the row.
 * 3. Executing: the Apply findings message asks for exactly the On to Code Review line.
 * 4. Merge: /merge-pull-request prints the Finish line in its report step and names the row that
 *    reads it, and prints the Back to Testing line in its re-verify step. Back to Testing returns a
 *    red-CI stop to Testing a limited number of times, and Testing's On to Merge allows one more run
 *    than that, so every round trip the board allows can come back to Merge. A hold ends on
 *    `Needs owner:`, which matches neither Merge row.
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
import { needsOwnerQuestion } from '../../src/shared/workflow-needs-owner';

const REPOSITORY_ROOT = path.resolve(__dirname, '../..');

type TextMatchValue = string | string[];

interface AutomationRow {
  name: string;
  type: string;
  /** The key older builds wrote, still read. This board's file no longer carries it. */
  finalLine?: string;
  /** A Text match in short form (the agent's line), or long form saying whose message it reads. */
  condition?: string | { text?: TextMatchValue | { from: 'agent' | 'user'; patterns: TextMatchValue }; agent?: string };
  targetColumn?: string;
  message?: string;
  maxRuns?: number;
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

/**
 * A row's Text match, from `condition.text` (joined one pattern per line) or the legacy
 * `finalLine`, or undefined. Either key, as the reader in `apply-automations.ts` takes either.
 */
function textMatchOf(row: AutomationRow): string | undefined {
  const condition = row.condition;
  if (typeof condition === 'object' && condition.text !== undefined) {
    const text = condition.text;
    const patterns = typeof text === 'object' && !Array.isArray(text) ? text.patterns : text;
    return Array.isArray(patterns) ? patterns.join('\n') : patterns;
  }
  return row.finalLine;
}

/** Whose message a row's Text match reads: the long form's `from`, else the agent's line. */
function textMatchSourceOf(row: AutomationRow): 'agent' | 'user' {
  const text = typeof row.condition === 'object' ? row.condition.text : undefined;
  return typeof text === 'object' && text !== null && !Array.isArray(text) ? text.from : 'agent';
}

/** The one line a contract row's agent has to end on. */
function finalLineOf(columnName: string, rowName: string): string {
  const finalLine = textMatchOf(turnEndRow(columnName, rowName));
  if (finalLine === undefined) throw new Error(`the ${columnName} "${rowName}" row has no Text match`);
  if (finalLine.includes('\n')) throw new Error(`the ${columnName} "${rowName}" row has several patterns; a contract pins one line`);
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
  'Design/Shelved',
  'Design/On to Planning',
  'Executing/On to Code Review',
  'Code Review/Back for revisions',
  'Code Review/On to Testing',
  'Testing/On to Merge',
  'Merge/Finish',
  'Merge/Back to Testing',
]);

const READY_REPORT = { checks: { typecheck: 'pass', hmrVitest: 'pass', scopedTests: 'none' }, findings: [] };

// A failed check is a blocker on its own, so no finding is needed to reach Blocked.
const BLOCKED_REPORT = { checks: { typecheck: 'fail', hmrVitest: 'pass', scopedTests: 'none' }, findings: [] };

describe('board turn-end contracts: Design', () => {
  function designRow(trigger: string, rowName: string): AutomationRow {
    const row = board.columns.find((column) => column.name === 'Design')?.automations?.[trigger]?.find((candidate) => candidate.name === rowName);
    if (!row) throw new Error(`kangentic.json's Design column has no "${rowName}" ${trigger} row`);
    return row;
  }

  // The agent can only end on a line it was told about, and nothing else prints this one.
  it('has the Design contract ask for exactly the Shelved line', () => {
    expectTextIn(designRow('onEnter', 'Design contract').message ?? '', 'the Design contract', `"${finalLineOf('Design', 'Shelved')}"`);
  });

  // Its only Move to column row on the agent's line sends the card back, which is what makes
  // Design a person's gate: a workflow never moves a card out of it on the agent's word.
  it('sends a shelved design back to To Do, and moves a card forward on no agent line', () => {
    expect(turnEndRow('Design', 'Shelved').targetColumn).toBe('To Do');
    const agentLineMoveRows = (board.columns.find((column) => column.name === 'Design')?.automations?.onTurnEnd ?? [])
      .filter((row) => row.type === 'move_to_column' && textMatchSourceOf(row) === 'agent');
    expect(agentLineMoveRows.map((row) => row.name)).toEqual(['Shelved']);
  });

  // The owner's sign-off is the way on (#1078): their message, never the agent's, at most once.
  it('moves the card to Planning on the owner\'s sign-off message, once', () => {
    const onToPlanning = turnEndRow('Design', 'On to Planning');
    expect(onToPlanning.type).toBe('move_to_column');
    expect(textMatchSourceOf(onToPlanning)).toBe('user');
    expect(onToPlanning.targetColumn).toBe('Planning');
    expect(onToPlanning.maxRuns).toBe(1);
    const patterns = textMatchOf(onToPlanning) ?? '';
    expect(matchFinalLine(patterns, 'Signed off, ship it').met, 'a sign-off moves it').toBe(true);
    expect(matchFinalLine(patterns, 'The design is approved.').met, 'an approval moves it').toBe(true);
    expect(matchFinalLine(patterns, 'This is not signed off yet').met, 'a refusal must not move it').toBe(false);
    expect(matchFinalLine(patterns, 'The rest look good').met, 'other feedback must not move it').toBe(false);
    // A sign-off with an exception still has a decision open, so it waits for a plain one.
    expect(matchFinalLine(patterns, 'all recommendations are signed off except everyone updates together').met, 'a partial sign-off must not move it').toBe(false);
  });

  // The contract tells the owner how to sign off and the agent what to do when they have.
  it('has the Design contract name the sign-off and leave the move to the board', () => {
    const contract = designRow('onEnter', 'Design contract').message ?? '';
    expectTextIn(contract, 'the Design contract', 'signed off');
    expectTextIn(contract, 'the Design contract', 'The board moves the card.');
    expectTextIn(contract, 'the Design contract', 'Never move this card yourself.');
  });

  // The agent's own sign-off hint line must not read as Shelved.
  it('keeps the sign-off hint line from reading as shelved', () => {
    const hint = 'To sign off, type signed off or move the card to Planning.';
    expectTextIn(designRow('onEnter', 'Design contract').message ?? '', 'the Design contract', hint);
    expect(matchFinalLine(finalLineOf('Design', 'Shelved'), hint).met).toBe(false);
  });

  // The exit row fires on every move out, and a straight drag to Executing must not enter plan mode.
  it('names the destination in the sign-off message', () => {
    expect(designRow('onExit', 'Signed off').message).toContain('{{toColumn}}');
  });
});

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

  it('leaves a pass with a step only a person can do where it is, on the line the app reads', () => {
    const personOnly = {
      ...READY_REPORT,
      findings: [{
        id: 1, severity: 'medium', category: 'Correctness', location: 'src/a.ts:1', file: 'src/a.ts', mechanism: 'no real sample',
        status: 'blocked', reason: 'no login on this machine', step: 'sign in and capture a reply', needsOwner: true,
      }],
    };
    const message = renderSummary(personOnly);
    expect(matchFinalLine(finalLineOf('Code Review', 'Back for revisions'), message).met, 'it must not take the Executing round trip').toBe(false);
    expect(matchFinalLine(finalLineOf('Code Review', 'On to Testing'), message).met, 'it must not move on').toBe(false);
    expect(needsOwnerQuestion(message)).toBe('sign in and capture a reply');
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

  // An agent told only "not as follow-up tasks" took on the four tasks it had
  // just filed, then deleted them. An unfiled finding still ships in the task.
  it('keeps the findings pass off work already filed as a task', () => {
    const applyFindingsMessage = turnEndRow('Executing', 'Apply findings').message ?? '';
    expectTextIn(applyFindingsMessage, 'the Apply findings message', 'not as follow-up tasks');
    expectTextIn(applyFindingsMessage, 'the Apply findings message', 'Skip anything already filed as a task on the board, and never delete or move one.');
  });
});

describe('board turn-end contracts: Merge', () => {
  const skillPath = '.claude/skills/merge-pull-request/SKILL.md';
  const mergePullRequestSkill = readRepositoryFile(skillPath);
  const outcomeSection = sectionOf(mergePullRequestSkill, skillPath, '## Outcome line');

  it('has /merge-pull-request print the Finish line in Step 5 and name the row that reads it', () => {
    const reportStep = sectionOf(mergePullRequestSkill, skillPath, '## Step 5 - Report');
    expectTextIn(reportStep, `${skillPath} Step 5`, `\`${finalLineOf('Merge', 'Finish')}\``);
    expectTextIn(outcomeSection, `${skillPath} Outcome line`, '"Finish"');
  });

  it('has /merge-pull-request print the Back to Testing line in Step 2 and name the row that reads it', () => {
    const reverifyStep = sectionOf(mergePullRequestSkill, skillPath, '## Step 2 - Re-verify');
    expectTextIn(reverifyStep, `${skillPath} Step 2`, `\`${finalLineOf('Merge', 'Back to Testing')}\``);
    expectTextIn(outcomeSection, `${skillPath} Outcome line`, '"Back to Testing"');
  });

  // Testing's onEnter already sends /pull-request, so a message here would be a second prompt.
  it('sends a red-CI stop back to Testing with no message of its own, a limited number of times', () => {
    const backToTesting = turnEndRow('Merge', 'Back to Testing');
    expect(backToTesting.targetColumn).toBe('Testing');
    expect(backToTesting.message).toBeUndefined();
    expect(backToTesting.maxRuns, 'an unlimited back-route lets a red main bounce a task forever').toBeGreaterThan(0);
  });

  // Frequency counts across the board's own moves, so with On to Merge spent after the
  // first trip, the task would go green in Testing and stay there.
  it('lets every round trip Back to Testing allows come back to Merge', () => {
    const backToTestingRuns = turnEndRow('Merge', 'Back to Testing').maxRuns ?? Number.POSITIVE_INFINITY;
    const onToMergeRuns = turnEndRow('Testing', 'On to Merge').maxRuns ?? Number.POSITIVE_INFINITY;
    expect(onToMergeRuns, 'On to Merge must allow one more run than Back to Testing').toBeGreaterThan(backToTestingRuns);
  });

  it('leaves a stop only a person can settle in Merge, on the line the app reads', () => {
    expectTextIn(outcomeSection, `${skillPath} Outcome line`, '`Needs owner: <the question>`');
    const message = 'The rebase conflicts in src/a.ts.\n\nNeeds owner: keep the new export or the old one?';
    expect(matchFinalLine(finalLineOf('Merge', 'Finish'), message).met, 'it must not finish').toBe(false);
    expect(matchFinalLine(finalLineOf('Merge', 'Back to Testing'), message).met, 'it must not go back to Testing').toBe(false);
    expect(needsOwnerQuestion(message)).toBe('keep the new export or the old one?');
  });
});

describe('board turn-end contracts: row shape', () => {
  const columnNames = new Set(board.columns.map((column) => column.name));
  const everyRow = board.columns.flatMap((column) =>
    Object.entries(column.automations ?? {}).flatMap(([trigger, rows]) =>
      rows.map((row) => ({ columnName: column.name, trigger, row })),
    ),
  );
  const textMatchRows = everyRow.flatMap(({ columnName, trigger, row }) => {
    const finalLine = textMatchOf(row);
    return finalLine === undefined ? [] : [{ columnName, trigger, row, finalLine, source: textMatchSourceOf(row) }];
  });
  // The rows the agent's last line is matched against. A row on the user's message reads other text.
  const agentLineRows = textMatchRows.filter(({ source }) => source === 'agent');

  // finalLine is sunset (#1078): every build that reads this file reads condition.text.
  it('writes no legacy finalLine key', () => {
    expect(everyRow.filter(({ row }) => row.finalLine !== undefined).map(({ columnName, row }) => `${columnName}/${row.name}`)).toEqual([]);
  });

  it('pins every Text match row on the board, and finds every row it pins', () => {
    const onBoard = new Set(textMatchRows.map(({ columnName, row }) => `${columnName}/${row.name}`));
    expect(onBoard).toEqual(PINNED_ROWS);
  });

  it('puts a Text match only on a turn-end row, never beside another condition', () => {
    for (const { columnName, trigger, row } of textMatchRows) {
      expect(trigger, `${columnName} "${row.name}"`).toBe('onTurnEnd');
      // One kind per row: a legacy finalLine never sits beside a condition of either shape.
      if (row.finalLine !== undefined) expect(row.condition, `${columnName} "${row.name}"`).toBeUndefined();
    }
  });

  it('never lets one row\'s line match another Text match row in its column', () => {
    for (const { columnName, row, finalLine } of agentLineRows) {
      for (const { columnName: otherColumn, row: otherRow, finalLine: otherFinalLine } of agentLineRows) {
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
