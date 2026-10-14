/**
 * Pins scripts/eval-condition-check.mjs, the replay that picks a column's Condition wording, model
 * and effort:
 *
 * 1. Its call is the app's call: the flags, the settings file and the thinking pin match what the
 *    Claude adapter's `answerFromContext` passes a Condition check, captured from the real adapter,
 *    so a change to the adapter that the harness does not follow fails here.
 * 2. groupTurnEnds puts a task's rows judged a moment apart into one turn end, as the runner judges
 *    them, and splits a later row or another task's.
 * 3. outcomeOf does what the runner does with the answers: rows in board order, an unconditional
 *    row or a yes runs, a move ends the group, and nothing running is 'none' (a stall).
 * 4. truthOf and outcomePasses grade every wording from one hand label, and the either-way
 *    leniency never reaches a literal check.
 * 5. lastLineIs, readJsonResult and parseArgs read what the CLI and a person hand them.
 *    readJsonResult is also read against a real CLI capture.
 * 6. pendingRows keeps the rows a case judged, and summarize turns a run's records into the
 *    per-arm table, so a wrong median, a missed stall or a swallowed failure shows up here.
 * 7. assertCliStarts stops a run before any call is queued when the CLI cannot start.
 * 8. A Text match row is judged with the shipped matcher, not an agent: its design reports as the
 *    code arm at no cost, and the run lists where the matcher and the strict lastLineIs disagree.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RunCliPrintOptions } from '../../src/main/agent/shared/cli-print';

const { answerSpy } = vi.hoisted(() => ({ answerSpy: vi.fn(async () => '') }));
vi.mock('../../src/main/agent/shared/cli-answer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/agent/shared/cli-answer')>();
  return { ...actual, runCliPrintAnswer: answerSpy };
});

import { ClaudeAdapter } from '../../src/main/agent/adapters/claude/claude-adapter';
import {
  ANSWER_SETTINGS,
  CODE_ARM,
  assertCliStarts,
  assertDesignRows,
  conditionCheckArgs,
  conditionCheckEnv,
  groupTurnEnds,
  isGuarded,
  lastLineIs,
  lineDisagreements,
  matchRowsInCode,
  outcomeOf,
  outcomePasses,
  parseArgs,
  pendingRows,
  productionAnswerOf,
  productionOutcomeOf,
  readJsonResult,
  summarize,
  truthOf,
} from '../../scripts/eval-condition-check.mjs';
import { matchFinalLine } from '../../src/shared/final-line-match';

describe('the call the harness makes is the call the app makes', () => {
  it.each(['low', 'high'])('matches the Claude adapter\'s Condition-check flags, settings and thinking pin at %s', async (effort) => {
    const runDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'condition-harness-parity-'));
    try {
      answerSpy.mockClear();
      await new ClaudeAdapter().answerFromContext('THE PROMPT', '/bin/claude', '/answer-home', 'claude-haiku-5-5', {
        effort,
        runDirectory,
        onUsage: () => undefined,
      });
      const options = (answerSpy.mock.calls[0] as unknown as [RunCliPrintOptions])[0];
      const settingsPath = path.join(runDirectory, 'settings.json');

      expect(options.args).toEqual(conditionCheckArgs({ settingsPath, model: 'claude-haiku-5-5', effort }));
      expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))).toEqual(ANSWER_SETTINGS);
      // The prompt goes on stdin, which is how the harness sends it.
      expect(options.promptVia ?? 'stdin').toBe('stdin');
      const harnessEnv = conditionCheckEnv({}, effort);
      expect(harnessEnv.MAX_THINKING_TOKENS).toBe(options.env?.MAX_THINKING_TOKENS);
    } finally {
      fs.rmSync(runDirectory, { recursive: true, force: true });
    }
  });

  it('drops the shell\'s Claude session markers and a stray thinking cap', () => {
    const env = conditionCheckEnv({ PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', MAX_THINKING_TOKENS: '9000' }, 'medium');
    expect(env).toEqual({ PATH: '/bin' });
  });
});

describe('groupTurnEnds', () => {
  const row = (taskId: string, at: string, name: string) => ({ task_id: taskId, started_at: at, automation_name: name });

  it('groups one task\'s rows judged a moment apart, and splits a later row and another task\'s', () => {
    const groups = groupTurnEnds([
      row('task-a', '2026-10-12T20:00:56.552Z', 'Apply findings'),
      row('task-a', '2026-10-12T20:00:57.410Z', 'On to Code Review'),
      row('task-a', '2026-10-12T20:14:05.515Z', 'On to Code Review'),
      row('task-b', '2026-10-12T20:14:06.000Z', 'Apply findings'),
    ]);

    expect(groups.map((group: { rows: unknown[] }) => group.rows.length)).toEqual([2, 1, 1]);
    expect(groups[0].at).toBe('2026-10-12T20:00:56.552Z');
    expect(groups[2].taskId).toBe('task-b');
  });
});

describe('outcomeOf', () => {
  const apply = { key: 'apply', condition: 'leaves work' };
  const move = { key: 'move', condition: 'is done', endsGroup: true };

  it('runs a yes row, skips a no row, and reads nothing running as a stall', () => {
    expect(outcomeOf([apply, move], new Map([['apply', true], ['move', false]]))).toBe('apply');
    expect(outcomeOf([apply, move], new Map([['apply', false], ['move', true]]))).toBe('move');
    expect(outcomeOf([apply, move], new Map([['apply', false], ['move', false]]))).toBe('none');
    expect(outcomeOf([apply, move], new Map([['apply', true], ['move', true]]))).toBe('apply+move');
  });

  it('stops at a move, so an unconditional row after it never runs, and runs it when the move says no', () => {
    const always = { key: 'apply', condition: null };
    expect(outcomeOf([move, always], new Map([['move', true]]))).toBe('move');
    expect(outcomeOf([move, always], new Map([['move', false]]))).toBe('apply');
  });
});

describe('pendingRows', () => {
  const design = {
    name: 'two-step',
    rows: [
      { name: 'Apply findings', key: 'apply', condition: 'leaves work' },
      { name: 'Tell the team', key: 'tell', condition: null },
      { name: 'On to Code Review', key: 'move', condition: 'is done', endsGroup: true },
    ],
  };

  it('keeps only the rows the case lists as pending, in the design\'s own order', () => {
    const testCase = { pendingNames: ['On to Code Review', 'Apply findings'] };
    // The case names the third row before the first; the design's order wins.
    expect(pendingRows(design, testCase).map((row: { name: string }) => row.name)).toEqual(['Apply findings', 'On to Code Review']);
  });

  it('ignores a pending name the design has no row for, and returns nothing when none are pending', () => {
    expect(pendingRows(design, { pendingNames: ['Tell the team', 'Open a pull request'] }).map((row: { key: string }) => row.key)).toEqual(['tell']);
    expect(pendingRows(design, { pendingNames: [] })).toEqual([]);
  });
});

describe('grading', () => {
  it('reads each truth from the one label, with the findings line meaning done', () => {
    const leftWork = { leftWork: true, endsWithLine: false };
    const finished = { leftWork: false, endsWithLine: false };
    const signedOff = { leftWork: true, endsWithLine: true };
    expect([truthOf('leftWork', leftWork), truthOf('done', leftWork), truthOf('endsWithLine', leftWork)]).toEqual([true, false, false]);
    expect([truthOf('leftWork', finished), truthOf('done', finished), truthOf('endsWithLine', finished)]).toEqual([false, true, false]);
    expect([truthOf('leftWork', signedOff), truthOf('done', signedOff), truthOf('endsWithLine', signedOff)]).toEqual([false, true, true]);
  });

  it('reads a label row from that row\'s own hand answer, and refuses a row with none or a truth it does not know', () => {
    const facts = { leftWork: true, endsWithLine: false, rows: { 'Needs review': true, 'Ready to merge': false } };
    expect(truthOf('label', facts, 'Needs review')).toBe(true);
    // The label is the row's own answer, so it holds even where leftWork says the opposite.
    expect(truthOf('label', facts, 'Ready to merge')).toBe(false);
    expect(() => truthOf('label', facts, 'Open a pull request')).toThrow('no hand answer for the row Open a pull request');
    expect(() => truthOf('label', { leftWork: true, endsWithLine: false }, 'Needs review')).toThrow('no hand answer for the row Needs review');
    expect(() => truthOf('label', { ...facts, rows: { 'Needs review': 'yes' } }, 'Needs review')).toThrow('no hand answer for the row Needs review');
    expect(() => truthOf('sometimes', facts)).toThrow('unknown truth sometimes');
  });

  it('lets an either-way case apply or move on a judgment row, never stall, and never loosens a literal check', () => {
    const judgment = ['leftWork', 'done'];
    expect(outcomePasses({ got: 'apply', expected: 'move', acceptEither: true, judgedTruths: judgment })).toBe(true);
    expect(outcomePasses({ got: 'none', expected: 'move', acceptEither: true, judgedTruths: judgment })).toBe(false);
    expect(outcomePasses({ got: 'apply', expected: 'move', acceptEither: false, judgedTruths: judgment })).toBe(false);
    expect(outcomePasses({ got: 'move', expected: 'apply', acceptEither: true, judgedTruths: ['endsWithLine'] })).toBe(false);
  });
});

describe('reading what comes back', () => {
  it('takes the findings line as the last non-empty line, through emphasis and case', () => {
    expect(lastLineIs('Done.\n\nFindings: applied\n', 'Findings: applied')).toBe(true);
    expect(lastLineIs('Done.\n**findings: applied**', 'Findings: applied')).toBe(true);
    expect(lastLineIs('Findings: applied\n\nThe preview is still up.', 'Findings: applied')).toBe(false);
    expect(lastLineIs(null, 'Findings: applied')).toBe(false);
  });

  it('reads the result line of a JSON run, and an unreadable run as an error with no answer', () => {
    const result = readJsonResult(JSON.stringify({
      type: 'result', result: 'C1: yes - fine', total_cost_usd: 0.0002, duration_ms: 1755, is_error: false,
      modelUsage: { 'claude-haiku-5-5': {} },
      usage: { input_tokens: 2, cache_creation_input_tokens: 1935, cache_read_input_tokens: 2234, output_tokens: 159 },
    }));
    expect(result).toEqual({
      answer: 'C1: yes - fine', costUsd: 0.0002, models: ['claude-haiku-5-5'], durationMs: 1755, isError: false,
      tokens: { input: 2, cacheWrite: 1935, cacheRead: 2234, output: 159 },
    });
    expect(readJsonResult('not json')).toMatchObject({ answer: null, isError: true });
  });

  describe('against a real CLI capture', () => {
    // The real `claude --print --output-format json` envelope of a condition check (CLI 2.1.296, Haiku 5.5).
    const capture = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'claude-print-result-condition-check.json'), 'utf-8').trim();
    const expectedAnswer = 'C1: yes - The agent reply\'s final line is "Findings: applied", which matches the condition exactly.';
    const unreadable = { answer: null, costUsd: null, models: [], durationMs: null, isError: true, tokens: null };

    it('reads the answer, cost, tokens and model out of the envelope', () => {
      const result = readJsonResult(capture);

      expect(result).toEqual({
        answer: expectedAnswer,
        costUsd: 0.00050345,
        models: ['claude-haiku-5-5'],
        durationMs: expect.any(Number),
        isError: false,
        tokens: { input: 2, cacheWrite: 2402, cacheRead: 535, output: 35 },
      });
      expect(typeof result.durationMs).toBe('number');
    });

    it('scans from the end past the stderr noise before the envelope and the non-result line after it', () => {
      const withStderrBefore = ['warning: stdin is not a terminal', 'update available: run the installer', capture].join('\n');
      expect(readJsonResult(withStderrBefore)).toEqual(readJsonResult(capture));

      const withStatusAfter = [capture, JSON.stringify({ type: 'system', subtype: 'status' })].join('\n');
      // A reader of only the last line would take this for an unreadable run.
      expect(readJsonResult(withStatusAfter)).toEqual(readJsonResult(capture));
    });

    it('reads stdout with no result line as an unreadable run: an error, no answer, no tokens', () => {
      const withoutResult = JSON.stringify({ type: 'assistant', message: { content: 'C1: yes' } });
      expect(readJsonResult(withoutResult)).toEqual(unreadable);
      expect(readJsonResult('')).toEqual(unreadable);
    });
  });

  it('refuses an arm or a run count that would spend calls on nothing', () => {
    expect(() => parseArgs(['run', '--arms', 'haiku:lowest'])).toThrow(/--arms/);
    expect(() => parseArgs(['run', '--arms', 'gpt:low'])).toThrow(/--arms/);
    expect(() => parseArgs(['run', '--arms', 'haiku:low', '--runs', '0'])).toThrow(/--runs/);
    expect(parseArgs(['run', '--arms', 'haiku:low,haiku:high', '--case-ids', 'a,b']).caseIds).toEqual(['a', 'b']);
  });
});

describe('summarize', () => {
  interface CallRecord {
    caseId: string;
    design: string;
    model: string;
    effort: string;
    correct: boolean;
    outcome: string;
    expected: string;
    unanswered: string[];
    isError: boolean;
    exitCode: number;
    costUsd: number | null;
    durationMs: number | null;
    tokens: { input: number; cacheWrite: number; cacheRead: number; output: number } | null;
  }
  /** A correct, paid, cache-read call on the plain design at haiku:low, changed by whatever a case needs. */
  const call = (overrides: Partial<CallRecord> & Pick<CallRecord, 'caseId'>): CallRecord => ({
    design: 'plain',
    model: 'haiku',
    effort: 'low',
    correct: true,
    outcome: 'move',
    expected: 'move',
    unanswered: [],
    isError: false,
    exitCode: 0,
    costUsd: 0.0004,
    durationMs: 1000,
    tokens: { input: 2, cacheWrite: 0, cacheRead: 2937, output: 35 },
    ...overrides,
  });

  // The records interleave the arms, so a group is gathered by design and arm, not by position.
  const records: CallRecord[] = [
    call({ caseId: 'c1', tokens: { input: 2, cacheWrite: 2402, cacheRead: 535, output: 35 } }),
    call({
      caseId: 'c1', effort: 'high', correct: false, outcome: 'none', expected: 'move', unanswered: ['apply', 'move'],
      isError: true, costUsd: 0.0001, durationMs: 4000, tokens: { input: 5, cacheWrite: 0, cacheRead: 0, output: 0 },
    }),
    call({ caseId: 'c2', correct: false, outcome: 'apply', costUsd: 0.0002, durationMs: 3000, tokens: { input: 2, cacheWrite: 0, cacheRead: 2937, output: 55 } }),
    call({ caseId: 'c1', design: 'split', costUsd: null, durationMs: null, tokens: null }),
    // A stall that also left a row unanswered, and a call that was never priced.
    call({
      caseId: 'c2', correct: false, outcome: 'none', unanswered: ['apply'], costUsd: null, durationMs: 2000,
      tokens: { input: 2, cacheWrite: 0, cacheRead: 2937, output: 45 },
    }),
    // A CLI that exited non-zero with no readable result: no cost, no duration, no tokens.
    call({ caseId: 'c4', effort: 'high', correct: false, outcome: 'none', expected: 'apply', unanswered: ['apply'], exitCode: 1, costUsd: null, durationMs: null, tokens: null }),
    // Nothing was due to run and nothing ran: correct, and not a stall.
    call({ caseId: 'c3', outcome: 'none', expected: 'none', costUsd: 0.0008, durationMs: 5000 }),
    call({
      caseId: 'c3', effort: 'high', outcome: 'apply', expected: 'apply', costUsd: 0.0006, durationMs: 2000,
      tokens: { input: 2, cacheWrite: 1935, cacheRead: 2234, output: 159 },
    }),
  ];

  it('gathers one row per design and arm, in the order each first appears', () => {
    const rows = summarize(records);

    expect(rows.map((row: { design: string; arm: string; calls: number }) => [row.design, row.arm, row.calls])).toEqual([
      ['plain', 'haiku:low', 4],
      ['plain', 'haiku:high', 3],
      ['split', 'haiku:low', 1],
    ]);
  });

  it('counts correct calls, stalls, unanswered rows, failed calls and cache writes per arm, and names each wrong case once', () => {
    const [plainLow, plainHigh] = summarize(records);

    // Two calls missed c2: the case is named once. The none-for-none call is correct and not a stall.
    expect(plainLow).toEqual({
      design: 'plain',
      arm: 'haiku:low',
      calls: 4,
      agentCalls: 4,
      correct: 2,
      matchesProduction: 0,
      stalls: 1,
      unansweredRows: 1,
      failedCalls: 0,
      totalCostUsd: expect.closeTo(0.0014, 10),
      // The unpriced call is left out: the prices are 0.0002, 0.0004 and 0.0008. Counting it as a zero would give 0.0003.
      medianCostUsd: expect.closeTo(0.0004, 10),
      // Four durations: the mean of the middle two, 2000 and 3000.
      medianDurationMs: 2500,
      // Four counts of 35, 35, 45 and 55: the mean of the middle two.
      medianOutputTokens: 40,
      cacheWriteCalls: 1,
      wrongCases: ['c2'],
    });
    // A failed call counts both ways it can fail: an error result, and a non-zero exit code with no result at all.
    expect(plainHigh).toEqual({
      design: 'plain',
      arm: 'haiku:high',
      calls: 3,
      agentCalls: 3,
      correct: 1,
      matchesProduction: 0,
      stalls: 2,
      unansweredRows: 3,
      failedCalls: 2,
      totalCostUsd: expect.closeTo(0.0007, 10),
      // Two prices, 0.0001 and 0.0006: their mean. The call with no result carries none.
      medianCostUsd: expect.closeTo(0.00035, 10),
      medianDurationMs: 3000,
      // A real zero from the failed call counts; the call with no tokens does not.
      medianOutputTokens: 79.5,
      cacheWriteCalls: 1,
      wrongCases: ['c1', 'c4'],
    });
  });

  it('reports no median and a zero total for an arm whose calls carry no price, duration or tokens', () => {
    const split = summarize(records)[2];

    expect(split).toEqual({
      design: 'split',
      arm: 'haiku:low',
      calls: 1,
      agentCalls: 1,
      correct: 1,
      matchesProduction: 0,
      stalls: 0,
      unansweredRows: 0,
      failedCalls: 0,
      totalCostUsd: 0,
      medianCostUsd: null,
      medianDurationMs: null,
      medianOutputTokens: null,
      cacheWriteCalls: 0,
      wrongCases: [],
    });
  });

  it('reports a Text match design as the code arm: no agent calls, no cost, and how often it routed as production did', () => {
    const codeRecords = [
      { ...call({ caseId: 'c1', design: 'text-match' }), model: 'code', effort: 'none', agentCall: false, matchesProduction: true, costUsd: 0, durationMs: 0, tokens: null },
      { ...call({ caseId: 'c2', design: 'text-match', correct: false, outcome: 'apply' }), model: 'code', effort: 'none', agentCall: false, matchesProduction: false, costUsd: 0, durationMs: 0, tokens: null },
    ];

    const [row] = summarize(codeRecords);

    expect(row).toMatchObject({
      design: 'text-match', arm: 'code', calls: 2, agentCalls: 0, correct: 1, matchesProduction: 1,
      failedCalls: 0, totalCostUsd: 0, medianCostUsd: 0, cacheWriteCalls: 0, wrongCases: ['c2'],
    });
  });
});

describe('Text match rows', () => {
  const move = { key: 'move', name: 'On to Code Review', finalLine: 'Findings: applied', endsGroup: true };
  const apply = { key: 'apply', name: 'Apply findings', condition: null };

  it('counts a Text match row as guarded, and an unconditional row as not', () => {
    expect([isGuarded(move), isGuarded(apply), isGuarded({ key: 'judged', condition: 'is done' })]).toEqual([true, false, true]);
  });

  it('judges a Text match row with the shipped matcher, so the move runs on the line and Apply findings runs otherwise', () => {
    const signedOff = matchRowsInCode([move, apply], 'All three fixed.\n\n**Findings: applied.**', matchFinalLine);
    expect(signedOff).toEqual(new Map([['move', true]]));
    expect(outcomeOf([move, apply], signedOff)).toBe('move');

    const unfinished = matchRowsInCode([move, apply], 'Findings: applied once the tests pass.\n\nWant me to run them?', matchFinalLine);
    expect(outcomeOf([move, apply], unfinished)).toBe('apply');
  });

  it('refuses a design row that carries both kinds', () => {
    expect(() => assertDesignRows({ name: 'both', rows: [{ ...move, condition: 'is done' }] }))
      .toThrow('both: the row On to Code Review has both a condition and a finalLine; a row holds one kind');
    expect(() => assertDesignRows({ name: 'one-kind', rows: [move, apply] })).not.toThrow();
  });

  it('gives the outcome production\'s own answers lead to under the design, an unanswered row read as no', () => {
    const rows = [move, apply];
    expect(productionOutcomeOf(rows, { production: { 'On to Code Review': { met: true } } })).toBe('move');
    expect(productionOutcomeOf(rows, { production: { 'On to Code Review': { met: null } } })).toBe('apply');
    expect(productionOutcomeOf(rows, {})).toBe('apply');
  });

  it("reads a Text match run's answer from its own columns, since it leaves condition_met null", () => {
    expect(productionAnswerOf({
      condition_met: null, condition_reason: null, final_line_met: 1, final_line_reason: 'The final line reads "Verdict: Ready".',
    })).toEqual({ met: true, reason: 'The final line reads "Verdict: Ready".' });
    expect(productionAnswerOf({ condition_met: null, condition_reason: null, final_line_met: 0, final_line_reason: 'x' }).met).toBe(false);
    expect(productionAnswerOf({ condition_met: 1, condition_reason: 'Clean.', final_line_met: null, final_line_reason: null }))
      .toEqual({ met: true, reason: 'Clean.' });
    // A database from before Text match has no such columns at all.
    expect(productionAnswerOf({ condition_met: 0, condition_reason: 'Work left.' })).toEqual({ met: false, reason: 'Work left.' });
  });

  it('lists the cases where the matcher and the strict lastLineIs disagree, skipping wildcard lines and missing replies', () => {
    const cases = [
      { id: 'exact', reply: 'Done.\n\nFindings: applied' },
      { id: 'period', reply: 'Done.\n\nFindings: applied.' },
      { id: 'bullet', reply: 'Done.\n\n- Findings: applied' },
      { id: 'none', reply: null },
    ];

    expect(lineDisagreements(cases, ['Findings: applied', 'Findings: *'], matchFinalLine)).toEqual([
      { caseId: 'period', line: 'Findings: applied', code: true, strict: false },
      { caseId: 'bullet', line: 'Findings: applied', code: true, strict: false },
    ]);
  });

  it('names the code arm apart from any model, so parseArgs never has to accept it', () => {
    expect(CODE_ARM).toEqual({ model: 'code', effort: 'none' });
    expect(() => parseArgs(['run', '--arms', 'code:none'])).toThrow(/--arms/);
    expect(parseArgs(['run', '--cases', 'c.json']).arms).toEqual([]);
  });
});

describe('assertCliStarts', () => {
  it('names the CLI and the spawn error code when the executable is not there', () => {
    const missingCli = path.join(os.tmpdir(), 'no-such-cli-folder', 'claude');
    expect(() => assertCliStarts(missingCli)).toThrow(`--cli ${missingCli} did not start (ENOENT)`);
  });

  it('lets a CLI that answers --version through', () => {
    expect(() => assertCliStarts(process.execPath)).not.toThrow();
  });
});
