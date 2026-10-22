/**
 * Pins scripts/eval-docs-reads.mjs, the harness that measures how many bytes of tool output an agent
 * reads to answer questions from docs/:
 *
 * 1. tallyStream counts what the main agent's context received: each tool result once, subagent
 *    lines left out, `<system-reminder>` text split into its own column, and the docs/ share found
 *    from the tool's input path. It is replayed against a sanitized real `claude -p` stream and then
 *    branch by branch.
 * 2. grade needs every expect pattern, case-insensitive, and fails an empty answer.
 * 3. gate passes only when the pilot drop beats the largest control change and no pilot question
 *    loses a pass, so a run-to-run wobble cannot pass for a real saving.
 * 4. summarize takes the medians the gate reads, and counts failed runs.
 * 5. readsDocs, parseArgs and runArgs: what counts as a docs/ read, what the CLI accepts, and the
 *    flags every run passes.
 * 6. The question file holds both groups with patterns that compile.
 *
 * This file may name the harness only in the import below (tests/unit/eval-harness-on-demand-only.test.ts
 * enforces it), so nothing here can start a run. That also keeps the compare and summary command
 * paths out of this file: spawning them needs the script's path, and the guard's own file is the one
 * place a test may name it.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  callTarget,
  gate,
  grade,
  HARNESS_FILE_PREFIX,
  harnessFilesIn,
  loadQuestions,
  loadQuestionSet,
  pairedComparison,
  parseArgs,
  readsDocs,
  RUN_SETTINGS,
  runArgs,
  SECOND_ROUND_QUESTIONS_PATH,
  summarize,
  tallyStream,
} from '../../scripts/eval-docs-reads.mjs';

const CHECKOUT = path.resolve('/scratch/checkout');
const FIXTURE_PATH = path.resolve(__dirname, '../fixtures/claude-docs-read-stream.jsonl');
/** The checkout path inside the fixture is this token, so the file holds no machine path. */
const CHECKOUT_TOKEN = '__CHECKOUT__';
/**
 * UTF-8 sizes of the fixture's two tool results (the Grep file list, the Read of background-commands.md),
 * measured by parsing the fixture lines directly and not through the harness.
 */
const FIXTURE_GREP_RESULT_BYTES = 104;
const FIXTURE_READ_RESULT_BYTES = 1063;

function line(record: unknown): string {
  return JSON.stringify(record);
}

function toolUse(id: string, name: string, input: Record<string, unknown>, parent: string | null = null): string {
  return line({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'tool_use', id, name, input }] } });
}

function toolResult(id: string, content: unknown, parent: string | null = null): string {
  return line({ type: 'user', parent_tool_use_id: parent, message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });
}

const RESULT_LINE = line({
  type: 'result',
  result: 'The flags are --sandbox workspace-write --ask-for-approval on-request.',
  total_cost_usd: 0.1,
  modelUsage: { 'claude-sonnet-5-5': {} },
  duration_ms: 1200,
  is_error: false,
});

/** The fixture with its checkout token replaced by `checkout`, JSON-escaped so a Windows path stays valid JSON. */
function replayFixture(checkout: string): string {
  const escapedCheckout = JSON.stringify(checkout).slice(1, -1);
  return fs.readFileSync(FIXTURE_PATH, 'utf8').split(CHECKOUT_TOKEN).join(escapedCheckout);
}

describe('tallyStream on a real claude -p stream', () => {
  it('tallies a Grep and a Read that both land under docs/', () => {
    const tally = tallyStream(replayFixture(CHECKOUT), CHECKOUT);

    expect(tally.toolCalls).toBe(2);
    expect(tally.toolCallsByName).toEqual({ Grep: 1, Read: 1 });
    expect(tally.toolResultBytes).toBe(FIXTURE_GREP_RESULT_BYTES + FIXTURE_READ_RESULT_BYTES);
    expect(tally.toolResultBytes).toBeGreaterThan(0);
    // The run saw no path-scoped rule, so nothing is split out.
    expect(tally.reminderBytes).toBe(0);
    expect(tally.gateBytes).toBe(tally.toolResultBytes - tally.reminderBytes);
    // Both calls read under docs/: the Grep by a relative path, the Read by an absolute one.
    expect(tally.docsBytes).toBe(tally.gateBytes);
    expect(tally.answer).toMatch(/^background-commands\.md/);
    expect(tally.costUsd).toBe(0.00484419);
    expect(tally.models).toEqual(['claude-haiku-5-5']);
    expect(tally.isError).toBe(false);
    expect(tally.durationMs).toBe(7667);
  });

  it('counts the absolute Read as docs only under the checkout the stream was run in', () => {
    // The Read's path names CHECKOUT. Tallied against another checkout it is not that checkout's docs/,
    // while the Grep's relative path still resolves into the checkout it is given.
    const otherCheckout = path.resolve('/scratch/elsewhere');

    const tally = tallyStream(replayFixture(CHECKOUT), otherCheckout);

    expect(tally.toolResultBytes).toBe(FIXTURE_GREP_RESULT_BYTES + FIXTURE_READ_RESULT_BYTES);
    expect(tally.docsBytes).toBe(FIXTURE_GREP_RESULT_BYTES);
  });
});

describe('tallyStream', () => {
  it('counts each main-agent tool result once and splits out reminder text', () => {
    const reminder = '<system-reminder>rule text</system-reminder>';
    const stdout = [
      line({ type: 'system', subtype: 'init' }),
      toolUse('t1', 'Grep', { pattern: 'codex', path: path.join(CHECKOUT, 'docs') }),
      toolResult('t1', 'docs/a.md:3: codex'),
      toolUse('t2', 'Read', { file_path: path.join(CHECKOUT, 'src', 'main.ts') }),
      toolResult('t2', [{ type: 'text', text: `body${reminder}` }]),
      // A duplicate of t1's result and a subagent's call and result are not the main agent's reads.
      toolResult('t1', 'docs/a.md:3: codex'),
      toolUse('s1', 'Read', { file_path: path.join(CHECKOUT, 'docs', 'b.md') }, 'agent-1'),
      toolResult('s1', 'subagent bytes', 'agent-1'),
      RESULT_LINE,
    ].join('\n');

    const tally = tallyStream(stdout, CHECKOUT);

    const reminderBytes = Buffer.byteLength(reminder);
    const firstBytes = Buffer.byteLength('docs/a.md:3: codex');
    const secondBytes = Buffer.byteLength(`body${reminder}`);
    expect(tally.toolCalls).toBe(2);
    expect(tally.toolCallsByName).toEqual({ Grep: 1, Read: 1 });
    expect(tally.toolResultBytes).toBe(firstBytes + secondBytes);
    expect(tally.reminderBytes).toBe(reminderBytes);
    expect(tally.gateBytes).toBe(firstBytes + secondBytes - reminderBytes);
    expect(tally.docsBytes).toBe(firstBytes);
    expect(tally.answer).toMatch(/workspace-write/);
    expect(tally.costUsd).toBe(0.1);
    expect(tally.models).toEqual(['claude-sonnet-5-5']);
    expect(tally.isError).toBe(false);
  });

  it('counts a reminder sent beside the results, and survives lines that are not JSON', () => {
    const reminder = '<system-reminder>injected</system-reminder>';
    const stdout = [
      'not json',
      line({ type: 'user', message: { content: [{ type: 'text', text: reminder }] } }),
      line({ type: 'user', message: { content: reminder } }),
      RESULT_LINE,
    ].join('\n');

    const tally = tallyStream(stdout, CHECKOUT);

    expect(tally.reminderBytes).toBe(Buffer.byteLength(reminder) * 2);
    expect(tally.gateBytes).toBe(0);
  });

  it('reads a run with no result line as failed', () => {
    expect(tallyStream('', CHECKOUT).isError).toBe(true);
  });

  it('counts bytes, not characters, for text outside ASCII', () => {
    // 9 UTF-16 units: c, a, f, e-acute (2 bytes), space, check mark (3 bytes), space, and a 4-byte
    // character held as a surrogate pair. 14 UTF-8 bytes.
    const text = 'café ✓ \u{1F600}';
    expect(text.length).toBe(9);

    const tally = tallyStream([
      toolUse('t1', 'Read', { file_path: path.join(CHECKOUT, 'docs', 'a.md') }),
      toolResult('t1', text),
    ].join('\n'), CHECKOUT);

    expect(tally.toolResultBytes).toBe(14);
    expect(tally.gateBytes).toBe(14);
    expect(tally.docsBytes).toBe(14);
  });

  it('joins the text blocks of an array result and counts an image as no text', () => {
    const talliedBytes = (content: unknown): number => tallyStream([
      toolUse('t1', 'Read', { file_path: path.join(CHECKOUT, 'src', 'a.ts') }),
      toolResult('t1', content),
    ].join('\n'), CHECKOUT).toolResultBytes;
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(500) } };

    // 'alpha' + separator + 'beta'.
    expect(talliedBytes([{ type: 'text', text: 'alpha' }, { type: 'text', text: 'beta' }])).toBe(10);
    expect(talliedBytes([image])).toBe(0);
    // The image's 500-character payload is not counted, and it leaves no empty segment in the join.
    expect(talliedBytes([{ type: 'text', text: 'alpha' }, image, { type: 'text', text: 'beta' }])).toBe(10);
    // Content that is neither a string nor an array holds no text.
    expect(talliedBytes(null)).toBe(0);
    expect(talliedBytes({ type: 'text', text: 'not an array' })).toBe(0);
  });

  it('takes every reminder block out of a docs Read, from docsBytes and gateBytes alike', () => {
    const firstReminder = '<system-reminder>first rule</system-reminder>';
    const secondReminder = '<system-reminder>\nsecond rule\nover two lines\n</system-reminder>';
    const stdout = [
      toolUse('t1', 'Read', { file_path: path.join(CHECKOUT, 'docs', 'a.md') }),
      toolResult('t1', `a${firstReminder}b${secondReminder}`),
    ].join('\n');

    const tally = tallyStream(stdout, CHECKOUT);

    const fullBytes = Buffer.byteLength(`a${firstReminder}b${secondReminder}`);
    const reminderBytes = Buffer.byteLength(firstReminder) + Buffer.byteLength(secondReminder);
    expect(tally.toolResultBytes).toBe(fullBytes);
    expect(tally.reminderBytes).toBe(reminderBytes);
    // Only the 'a' and the 'b' are the document's own text.
    expect(tally.gateBytes).toBe(2);
    expect(tally.docsBytes).toBe(2);
  });

  it('counts a tool_use id once, however many assistant lines repeat it', () => {
    const firstRead = toolUse('t1', 'Read', { file_path: path.join(CHECKOUT, 'docs', 'a.md') });
    const secondRead = toolUse('t2', 'Read', { file_path: path.join(CHECKOUT, 'docs', 'b.md') });
    const grep = toolUse('t3', 'Grep', { pattern: 'codex' });

    const tally = tallyStream([
      firstRead, firstRead, toolResult('t1', 'abc'),
      secondRead, grep, grep, grep,
    ].join('\n'), CHECKOUT);

    expect(tally.toolCalls).toBe(3);
    expect(tally.toolCallsByName).toEqual({ Read: 2, Grep: 1 });
    expect(tally.toolResultBytes).toBe(3);
  });

  it('reads a result line with is_error true as a failed run and keeps its answer', () => {
    const stdout = line({ type: 'result', result: 'API Error', total_cost_usd: 0.01, modelUsage: {}, duration_ms: 50, is_error: true });

    const tally = tallyStream(stdout, CHECKOUT);

    expect(tally.isError).toBe(true);
    expect(tally.answer).toBe('API Error');
    expect(tally.models).toEqual([]);
  });

  it('leaves cost and duration null when they are not numbers', () => {
    const stringValues = tallyStream(line({ type: 'result', result: 'ok', total_cost_usd: '0.5', duration_ms: '120', is_error: false }), CHECKOUT);
    const missingValues = tallyStream(line({ type: 'result', result: 'ok', is_error: false }), CHECKOUT);

    expect(stringValues.costUsd).toBeNull();
    expect(stringValues.durationMs).toBeNull();
    expect(missingValues.costUsd).toBeNull();
    expect(missingValues.durationMs).toBeNull();
  });
});

describe('readsDocs', () => {
  const foldsCase = process.platform === 'win32' || process.platform === 'darwin';

  it('matches docs/ and files below it, relative or absolute, and nothing beside it', () => {
    expect(readsDocs({ file_path: path.join(CHECKOUT, 'docs', 'x', 'y.md') }, CHECKOUT)).toBe(true);
    expect(readsDocs({ path: 'docs' }, CHECKOUT)).toBe(true);
    expect(readsDocs({ path: 'docs-old/a.md' }, CHECKOUT)).toBe(false);
    expect(readsDocs({ pattern: 'codex' }, CHECKOUT)).toBe(false);
    expect(readsDocs(undefined, CHECKOUT)).toBe(false);
  });

  it('reads a backslash target under the checkout the way the agent reports it on Windows', () => {
    // Absolute on both platforms because the checkout leads. Built as the fixture is: the checkout,
    // then backslash separators.
    expect(readsDocs({ file_path: `${CHECKOUT}\\docs\\x\\y.md` }, CHECKOUT)).toBe(true);
    expect(readsDocs({ file_path: `${CHECKOUT}\\src\\x.ts` }, CHECKOUT)).toBe(false);
    expect(readsDocs({ file_path: `${CHECKOUT}\\docs-old\\x.md` }, CHECKOUT)).toBe(false);
  });

  it('takes file_path over path when a call carries both', () => {
    const docsFile = path.join(CHECKOUT, 'docs', 'a.md');
    const sourceFile = path.join(CHECKOUT, 'src', 'a.ts');

    expect(readsDocs({ file_path: docsFile, path: 'src' }, CHECKOUT)).toBe(true);
    expect(readsDocs({ file_path: sourceFile, path: 'docs' }, CHECKOUT)).toBe(false);
  });

  it('resolves a relative path against the checkout, not the working directory', () => {
    expect(readsDocs({ path: 'docs/a.md' }, CHECKOUT)).toBe(true);
    expect(readsDocs({ file_path: 'docs/a.md' }, CHECKOUT)).toBe(true);
    expect(readsDocs({ path: 'src/a.ts' }, CHECKOUT)).toBe(false);
    // A relative path that climbs out of the checkout lands beside it, not in its docs/.
    expect(readsDocs({ path: '../docs/a.md' }, CHECKOUT)).toBe(false);
  });

  it('takes a checkout given with a trailing slash', () => {
    expect(readsDocs({ path: 'docs/a.md' }, `${CHECKOUT}/`)).toBe(true);
    expect(readsDocs({ file_path: path.join(CHECKOUT, 'docs', 'a.md') }, `${CHECKOUT}/`)).toBe(true);
    expect(readsDocs({ file_path: path.join(CHECKOUT, 'src', 'a.ts') }, `${CHECKOUT}/`)).toBe(false);
  });

  it('does not count a path that climbs out of docs/ through ..', () => {
    expect(readsDocs({ path: 'docs/../src/x.ts' }, CHECKOUT)).toBe(false);
    expect(readsDocs({ file_path: 'docs/../src/x.ts' }, CHECKOUT)).toBe(false);
    // An absolute path is resolved too (string-built, since path.join would fold the `..` away).
    expect(readsDocs({ file_path: `${CHECKOUT}/docs/../src/x.ts` }, CHECKOUT)).toBe(false);
    expect(readsDocs({ file_path: `${CHECKOUT}/src/../docs/a.md` }, CHECKOUT)).toBe(true);
  });

  it('folds case only where the filesystem does', () => {
    expect(readsDocs({ path: 'DOCS/x.md' }, CHECKOUT)).toBe(foldsCase);
    expect(readsDocs({ file_path: `${CHECKOUT}/docs/x.md`.toUpperCase() }, CHECKOUT)).toBe(foldsCase);
  });

  it('reads an empty or missing target as not docs', () => {
    expect(readsDocs({ file_path: '' }, CHECKOUT)).toBe(false);
    expect(readsDocs({}, CHECKOUT)).toBe(false);
  });
});

describe('grade', () => {
  it('needs every pattern, case-insensitive', () => {
    expect(grade('Uses MD5 of the path, under ~/.kimi/sessions/, file wire.jsonl', ['wire\\.jsonl', '\\.kimi[\\\\/]sessions', 'md5'])).toBe(true);
    expect(grade('Uses wire.jsonl only', ['wire\\.jsonl', 'md5'])).toBe(false);
    expect(grade(null, ['x'])).toBe(false);
    expect(grade('', ['x'])).toBe(false);
  });
});

describe('gate', () => {
  const row = (questionId: string, group: string, medianGateBytes: number | null, passes = 3) => ({ questionId, group, runs: 3, passes, medianGateBytes });

  it('passes a pilot drop larger than the largest control change', () => {
    const verdict = gate(
      [row('p1', 'pilot', 10_000), row('p2', 'pilot', 8_000), row('c1', 'control', 5_000), row('c2', 'control', 6_000)],
      [row('p1', 'pilot', 6_000), row('p2', 'pilot', 7_000), row('c1', 'control', 5_900), row('c2', 'control', 5_500)],
    );
    expect(verdict.pilotDrop).toBe(5_000);
    expect(verdict.controlNoise).toBe(900);
    expect(verdict.passed).toBe(true);
  });

  it('fails a drop the controls moved by as much on their own', () => {
    const verdict = gate(
      [row('p1', 'pilot', 10_000), row('c1', 'control', 5_000)],
      [row('p1', 'pilot', 9_000), row('c1', 'control', 7_000)],
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/control noise/);
  });

  it('fails when a pilot question loses a pass, even with a large drop', () => {
    const verdict = gate(
      [row('p1', 'pilot', 10_000, 3), row('c1', 'control', 5_000)],
      [row('p1', 'pilot', 2_000, 2), row('c1', 'control', 5_000)],
    );
    expect(verdict.fewerPasses).toEqual(['p1']);
    expect(verdict.passed).toBe(false);
  });

  it('fails when the two runs did not ask the same questions', () => {
    const verdict = gate([row('p1', 'pilot', 10_000), row('c1', 'control', 1)], [row('p1', 'pilot', 1)]);
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/only one run: c1/);
  });

  it('needs the pilot drop to be strictly larger than the control swing', () => {
    const baseline = [row('p1', 'pilot', 5_000), row('c1', 'control', 5_000)];

    const equal = gate(baseline, [row('p1', 'pilot', 4_000), row('c1', 'control', 6_000)]);
    const oneAbove = gate(baseline, [row('p1', 'pilot', 3_999), row('c1', 'control', 6_000)]);

    expect(equal.pilotDrop).toBe(1_000);
    expect(equal.controlNoise).toBe(1_000);
    expect(equal.passed).toBe(false);
    expect(equal.reasons).toEqual(['pilot drop 1000 is not above the control noise 1000']);
    expect(oneAbove.pilotDrop).toBe(1_001);
    expect(oneAbove.passed).toBe(true);
    expect(oneAbove.reasons).toEqual([]);
  });

  it('measures a control swing in either direction', () => {
    // The control got smaller by 2000 while the pilot dropped by 1000: the swing is the size of the change.
    const verdict = gate(
      [row('p1', 'pilot', 5_000), row('c1', 'control', 5_000)],
      [row('p1', 'pilot', 4_000), row('c1', 'control', 3_000)],
    );

    expect(verdict.controlNoise).toBe(2_000);
    expect(verdict.passed).toBe(false);
  });

  it('fails when neither run has a pilot question, and says so', () => {
    const verdict = gate([row('c1', 'control', 5_000)], [row('c1', 'control', 5_000)]);

    expect(verdict.passed).toBe(false);
    expect(verdict.reasons).toContain('no pilot questions in both runs');
  });

  it('reports a question only the candidate has, and keeps it out of the totals', () => {
    const verdict = gate(
      [row('p1', 'pilot', 10_000), row('c1', 'control', 5_000)],
      [row('p1', 'pilot', 2_000), row('c1', 'control', 5_000), row('p2', 'pilot', 99_000)],
    );

    expect(verdict.passed).toBe(false);
    expect(verdict.reasons).toContain('questions in only one run: p2');
    expect(verdict.pilotAfter).toBe(2_000);
    expect(verdict.pilotDrop).toBe(8_000);
  });

  it('lists questions missing from either side, baseline first', () => {
    const verdict = gate(
      [row('p1', 'pilot', 10_000), row('c1', 'control', 5_000)],
      [row('p1', 'pilot', 2_000), row('p2', 'pilot', 2_000)],
    );

    expect(verdict.reasons).toContain('questions in only one run: c1, p2');
  });

  it('counts a pilot row with no median as zero bytes', () => {
    const lostEverything = gate([row('p1', 'pilot', 5_000), row('c1', 'control', 5_000)], [row('p1', 'pilot', null), row('c1', 'control', 5_000)]);
    const startedWithNothing = gate([row('p1', 'pilot', null), row('c1', 'control', 5_000)], [row('p1', 'pilot', 300), row('c1', 'control', 5_000)]);

    expect(lostEverything.pilotAfter).toBe(0);
    expect(lostEverything.pilotDrop).toBe(5_000);
    expect(lostEverything.passed).toBe(true);
    expect(startedWithNothing.pilotBefore).toBe(0);
    expect(startedWithNothing.pilotDrop).toBe(-300);
    expect(startedWithNothing.passed).toBe(false);
  });

  it('counts a control row with no median as zero bytes when it measures the swing', () => {
    const verdict = gate(
      [row('p1', 'pilot', 10_000), row('c1', 'control', null)],
      [row('p1', 'pilot', 2_000), row('c1', 'control', 700)],
    );

    expect(verdict.controlNoise).toBe(700);
    expect(verdict.passed).toBe(true);
  });

  it('does not fail a pilot question that passes more runs than before', () => {
    const verdict = gate(
      [row('p1', 'pilot', 10_000, 2), row('c1', 'control', 5_000)],
      [row('p1', 'pilot', 2_000, 3), row('c1', 'control', 5_000)],
    );

    expect(verdict.fewerPasses).toEqual([]);
    expect(verdict.passed).toBe(true);
  });

  it('looks for lost passes among the pilot questions only', () => {
    const verdict = gate(
      [row('p1', 'pilot', 10_000, 3), row('c1', 'control', 5_000, 3)],
      [row('p1', 'pilot', 2_000, 3), row('c1', 'control', 5_000, 1)],
    );

    expect(verdict.fewerPasses).toEqual([]);
    expect(verdict.passed).toBe(true);
  });
});

describe('summarize', () => {
  it('takes per-question medians and counts passes and failed runs', () => {
    const base = { group: 'pilot', docsBytes: 0, reminderBytes: 0, toolCalls: 2, costUsd: 0.1, isError: false, exitCode: 0 };
    const rows = summarize([
      { ...base, questionId: 'p1', passed: true, gateBytes: 300 },
      { ...base, questionId: 'p1', passed: false, gateBytes: 100 },
      { ...base, questionId: 'p1', passed: true, gateBytes: 200, isError: true },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ questionId: 'p1', runs: 3, passes: 2, failedRuns: 1, medianGateBytes: 200 });
    expect(rows[0].totalCostUsd).toBeCloseTo(0.3);
  });

  it('averages the two middle values of an even run count, for every median it reports', () => {
    // Each column is distinct, so a median read from the wrong column cannot match. The gate bytes
    // are 9, 10, 100 and 1000 out of order: sorted as numbers the middle pair is 10 and 100, sorted
    // as text it is 100 and 1000.
    const base = { questionId: 'p1', group: 'pilot', passed: true, isError: false, exitCode: 0 };
    const rows = summarize([
      { ...base, gateBytes: 1000, docsBytes: 80, reminderBytes: 7, toolCalls: 8, costUsd: 0.8 },
      { ...base, gateBytes: 9, docsBytes: 10, reminderBytes: 1, toolCalls: 2, costUsd: 0.1 },
      { ...base, gateBytes: 100, docsBytes: 40, reminderBytes: 5, toolCalls: 6, costUsd: 0.4 },
      { ...base, gateBytes: 10, docsBytes: 20, reminderBytes: 3, toolCalls: 4, costUsd: 0.2 },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].medianGateBytes).toBe(55);
    expect(rows[0].medianDocsBytes).toBe(30);
    expect(rows[0].medianReminderBytes).toBe(4);
    expect(rows[0].medianToolCalls).toBe(5);
    expect(rows[0].medianCostUsd).toBeCloseTo(0.3);
    expect(rows[0].totalCostUsd).toBeCloseTo(1.5);
  });

  it('counts a nonzero exit code as a failed run even when the stream said no error', () => {
    const base = { questionId: 'p1', group: 'pilot', passed: false, gateBytes: 100, docsBytes: 0, reminderBytes: 0, toolCalls: 1, costUsd: 0.1 };
    const rows = summarize([
      { ...base, isError: false, exitCode: 0 },
      { ...base, isError: false, exitCode: 1 },
      { ...base, isError: false, exitCode: -1 },
      { ...base, isError: true, exitCode: 0 },
      // Both signals on one run still make one failed run.
      { ...base, isError: true, exitCode: 1 },
    ]);

    expect(rows[0].runs).toBe(5);
    expect(rows[0].failedRuns).toBe(4);
  });

  it('leaves a null cost out of the median and the total', () => {
    const base = { questionId: 'p1', group: 'pilot', passed: true, isError: false, exitCode: 0, gateBytes: 100, docsBytes: 0, reminderBytes: 0, toolCalls: 1 };
    const rows = summarize([
      { ...base, costUsd: 0.1 },
      { ...base, costUsd: null },
      { ...base, costUsd: 0.3 },
    ]);

    // Two priced runs. Counting the null as 0 would make the median 0.1.
    expect(rows[0].runs).toBe(3);
    expect(rows[0].medianCostUsd).toBeCloseTo(0.2);
    expect(rows[0].totalCostUsd).toBeCloseTo(0.4);
  });

  it('reports no median and a zero total when no run has a cost', () => {
    const rows = summarize([
      { questionId: 'p1', group: 'pilot', passed: true, isError: false, exitCode: 0, gateBytes: 100, costUsd: null },
    ]);

    expect(rows[0].medianCostUsd).toBeNull();
    expect(rows[0].totalCostUsd).toBe(0);
  });

  it('gives each question its own row, in the order the questions first appear', () => {
    const base = { isError: false, exitCode: 0, gateBytes: 100, costUsd: 0.1 };
    const rows = summarize([
      { ...base, questionId: 'p1', group: 'pilot', passed: true },
      { ...base, questionId: 'c1', group: 'control', passed: false },
      { ...base, questionId: 'p1', group: 'pilot', passed: false },
    ]);

    expect(rows.map((row) => [row.questionId, row.group, row.runs, row.passes])).toEqual([
      ['p1', 'pilot', 2, 1],
      ['c1', 'control', 1, 0],
    ]);
  });
});

describe('parseArgs', () => {
  it('defaults to 3 runs, 4 at once, sonnet at medium effort, the claude CLI, and every question', () => {
    expect(parseArgs(['run'])).toEqual({
      mode: 'run',
      ref: null,
      label: null,
      out: null,
      baseline: null,
      candidate: null,
      only: [],
      questions: null,
      cli: 'claude',
      runs: 3,
      concurrency: 4,
      model: 'sonnet',
      effort: 'medium',
    });
  });

  it('reads every flag it knows', () => {
    const options = parseArgs([
      'run', '--ref', 'main', '--label', 'baseline', '--out', 'results', '--runs', '5', '--concurrency', '2',
      '--model', 'opus', '--effort', 'max', '--cli', 'claude-binary', '--only', 'p1,c1', '--questions', 'set.json',
    ]);

    expect(options).toEqual({
      mode: 'run',
      ref: 'main',
      label: 'baseline',
      out: 'results',
      baseline: null,
      candidate: null,
      only: ['p1', 'c1'],
      questions: 'set.json',
      cli: 'claude-binary',
      runs: 5,
      concurrency: 2,
      model: 'opus',
      effort: 'max',
    });
    expect(parseArgs(['compare', '--baseline', 'a', '--candidate', 'b'])).toMatchObject({ mode: 'compare', baseline: 'a', candidate: 'b' });
  });

  it.each(['haiku', 'sonnet', 'opus'])('accepts the model %s', (model) => {
    expect(parseArgs(['run', '--model', model]).model).toBe(model);
  });

  it.each(['low', 'medium', 'high', 'xhigh', 'max'])('accepts the effort %s', (effort) => {
    expect(parseArgs(['run', '--effort', effort]).effort).toBe(effort);
  });

  it('splits --only on commas and drops empty entries', () => {
    expect(parseArgs(['run', '--only', 'a,b']).only).toEqual(['a', 'b']);
    expect(parseArgs(['run', '--only', 'a,,b,']).only).toEqual(['a', 'b']);
    expect(parseArgs(['run', '--only', 'solo']).only).toEqual(['solo']);
  });

  it.each([
    ['--runs 0', ['run', '--runs', '0'], /--runs: 0 is not a positive whole number/],
    ['--runs 1.5', ['run', '--runs', '1.5'], /--runs: 1\.5 is not a positive whole number/],
    ['--runs abc', ['run', '--runs', 'abc'], /--runs: abc is not a positive whole number/],
    ['--runs -2', ['run', '--runs', '-2'], /--runs: -2 is not a positive whole number/],
    ['--concurrency 0', ['run', '--concurrency', '0'], /--concurrency: 0 is not a positive whole number/],
    ['--concurrency 1.5', ['run', '--concurrency', '1.5'], /--concurrency: 1\.5 is not a positive whole number/],
    ['--concurrency abc', ['run', '--concurrency', 'abc'], /--concurrency: abc is not a positive whole number/],
    ['an unknown --model', ['run', '--model', 'gpt'], /--model: gpt is not one of haiku, sonnet, opus/],
    ['a --model named like an object prototype key', ['run', '--model', 'toString'], /--model: toString is not one of haiku, sonnet, opus/],
    ['an unknown --effort', ['run', '--effort', 'extreme'], /--effort: extreme is not one of low, medium, high, xhigh, max/],
  ])('refuses %s', (_description, argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message);
  });

  it('falls back to the default when a flag is the last argument and has no value', () => {
    expect(parseArgs(['run', '--runs']).runs).toBe(3);
    expect(parseArgs(['run', '--concurrency']).concurrency).toBe(4);
    expect(parseArgs(['run', '--model']).model).toBe('sonnet');
    expect(parseArgs(['run', '--effort']).effort).toBe('medium');
    expect(parseArgs(['run', '--cli']).cli).toBe('claude');
    expect(parseArgs(['run', '--only']).only).toEqual([]);
    expect(parseArgs(['run', '--ref']).ref).toBeNull();
  });
});

describe('the run and its questions', () => {
  it('gives the agent file tools only, no MCP servers and no session file', () => {
    const argv = runArgs({ settingsPath: 's.json', model: 'claude-sonnet-5-5', effort: 'medium' });
    expect(argv[argv.indexOf('--tools') + 1]).toBe('Read,Grep,Glob');
    expect(argv).toContain('--strict-mcp-config');
    expect(argv).toContain('--no-session-persistence');
    expect(argv[argv.indexOf('--output-format') + 1]).toBe('stream-json');
  });

  it('passes exactly these flags and values to every run', () => {
    expect(runArgs({ settingsPath: 'run-settings.json', model: 'claude-haiku-5-5', effort: 'high' })).toEqual([
      '--print',
      '--no-session-persistence',
      '--permission-prompts', 'none',
      '--tools', 'Read,Grep,Glob',
      '--strict-mcp-config',
      '--settings', 'run-settings.json',
      '--output-format', 'stream-json',
      '--verbose',
      '--model', 'claude-haiku-5-5',
      '--effort', 'high',
    ]);
  });

  it('takes the settings path, model and effort from its arguments', () => {
    const argv = runArgs({ settingsPath: 'other-settings.json', model: 'claude-opus-5-5', effort: 'low' });

    expect(argv[argv.indexOf('--settings') + 1]).toBe('other-settings.json');
    expect(argv[argv.indexOf('--model') + 1]).toBe('claude-opus-5-5');
    expect(argv[argv.indexOf('--effort') + 1]).toBe('low');
  });

  it('writes a settings file with no advisor and no auto memory', () => {
    expect(RUN_SETTINGS).toEqual({ advisorModel: '', autoMemoryEnabled: false });
  });

  it('holds a second-round set of keyword-free and broad questions, each naming concepts that exist', () => {
    const questionSet = loadQuestionSet(SECOND_ROUND_QUESTIONS_PATH);
    const questions = questionSet.questions as Array<{ id: string; group: string; question: string; expect: string[]; gold: string[] }>;
    expect(questionSet.promptPrefix).toMatch(/docs\/README\.md/);
    expect(new Set(questions.map((question) => question.id)).size).toBe(questions.length);
    expect(new Set(questions.map((question) => question.group))).toEqual(new Set(['paraphrase', 'broad']));
    for (const question of questions) {
      expect(question.expect.length, question.id).toBeGreaterThan(0);
      for (const pattern of question.expect) expect(() => new RegExp(pattern, 'i')).not.toThrow();
      expect(question.gold.length, question.id).toBeGreaterThan(0);
      for (const concept of question.gold) expect(fs.existsSync(path.resolve(__dirname, '../..', concept)), concept).toBe(true);
    }
  });

  it('holds pilot and control questions whose patterns compile', () => {
    const questions = loadQuestions() as Array<{ id: string; group: string; question: string; expect: string[] }>;
    expect(new Set(questions.map((question) => question.id)).size).toBe(questions.length);
    expect(questions.some((question) => question.group === 'pilot')).toBe(true);
    expect(questions.some((question) => question.group === 'control')).toBe(true);
    for (const question of questions) {
      expect(['pilot', 'control']).toContain(question.group);
      expect(question.expect.length).toBeGreaterThan(0);
      for (const pattern of question.expect) expect(() => new RegExp(pattern, 'i')).not.toThrow();
    }
  });
});

describe('the per-call trace', () => {
  it('names each call\'s target relative to the checkout, in call order, with its result bytes', () => {
    const stdout = [
      toolUse('t1', 'Read', { file_path: path.join(CHECKOUT, 'docs', 'README.md') }),
      toolResult('t1', 'index text'),
      toolUse('t2', 'Grep', { pattern: 'trust', path: path.join(CHECKOUT, 'docs') }),
      toolResult('t2', 'docs/a.md'),
      toolUse('t3', 'Glob', { pattern: '**/*.md' }),
      toolResult('t3', 'a.md\nb.md'),
      RESULT_LINE,
    ].join('\n');

    const tally = tallyStream(stdout, CHECKOUT);

    expect(tally.trace).toEqual([
      { tool: 'Read', target: 'docs/README.md', bytes: Buffer.byteLength('index text') },
      { tool: 'Grep', target: 'trust @ docs', bytes: Buffer.byteLength('docs/a.md') },
      { tool: 'Glob', target: '**/*.md', bytes: Buffer.byteLength('a.md\nb.md') },
    ]);
  });

  it('keeps only the file name of a path outside the checkout, so no machine path reaches a record', () => {
    const outside = path.resolve('/home/someone/notes/private.md');
    expect(callTarget('Read', { file_path: outside }, CHECKOUT)).toBe('private.md');
    expect(callTarget('Read', { file_path: path.join(CHECKOUT, 'docs', '..', '..', 'x.md') }, CHECKOUT)).toBe('x.md');
    expect(callTarget('Grep', { pattern: 'codex' }, CHECKOUT)).toBe('codex');
    expect(callTarget('Read', {}, CHECKOUT)).toBe('');
  });

  it('records a call whose result never came back with zero bytes', () => {
    const tally = tallyStream([toolUse('t1', 'Read', { file_path: 'docs/x.md' }), RESULT_LINE].join('\n'), CHECKOUT);
    expect(tally.trace).toEqual([{ tool: 'Read', target: 'docs/x.md', bytes: 0 }]);
  });
});

describe('context tokens', () => {
  it('sums every input token class from the result line, and keeps output apart', () => {
    const result = line({
      type: 'result', result: 'ok', is_error: false,
      usage: { input_tokens: 12, cache_read_input_tokens: 70_000, cache_creation_input_tokens: 9_000, output_tokens: 400 },
    });
    const tally = tallyStream(result, CHECKOUT);
    expect(tally.contextTokens).toBe(79_012);
    expect(tally.outputTokens).toBe(400);
  });

  it('leaves both null when the run reported no usage', () => {
    const tally = tallyStream(RESULT_LINE, CHECKOUT);
    expect(tally.contextTokens).toBeNull();
    expect(tally.outputTokens).toBeNull();
  });
});

describe('harnessFilesIn', () => {
  it('finds the harness\'s script, question sets and test in a checkout, and nothing else', () => {
    const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-scrub-'));
    fs.mkdirSync(path.join(checkout, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(checkout, 'tests', 'unit'), { recursive: true });
    const prefix = HARNESS_FILE_PREFIX as string;
    const harnessNames = [`${prefix}.mjs`, `${prefix}-questions.json`, `${prefix}-questions-v2.json`];
    for (const name of [...harnessNames, 'docs-bundle.mjs']) fs.writeFileSync(path.join(checkout, 'scripts', name), '');
    fs.writeFileSync(path.join(checkout, 'tests', 'unit', `${prefix}.test.ts`), '');
    fs.writeFileSync(path.join(checkout, 'tests', 'unit', 'code-corpus.test.ts'), '');

    const found = harnessFilesIn(checkout).map((file: string) => path.relative(checkout, file).replace(/\\/g, '/')).sort();

    expect(found).toEqual([...harnessNames.map((name) => `scripts/${name}`), `tests/unit/${prefix}.test.ts`].sort());
    expect(prefix.length).toBeGreaterThan(5);
  });

  it('finds nothing in a checkout from before the harness existed', () => {
    expect(harnessFilesIn(fs.mkdtempSync(path.join(os.tmpdir(), 'eval-scrub-empty-')))).toEqual([]);
  });
});

describe('loadQuestionSet', () => {
  const writeTemp = (content: unknown): string => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-set-'));
    const file = path.join(directory, 'set.json');
    fs.writeFileSync(file, JSON.stringify(content));
    return file;
  };

  it('reads a bare list with the default prefix, and an object with its own', () => {
    const bare = loadQuestionSet(writeTemp([{ id: 'a' }]));
    expect(bare.questions).toEqual([{ id: 'a' }]);
    expect(bare.promptPrefix).toMatch(/^Answer from this repository's documentation\./);

    const shaped = loadQuestionSet(writeTemp({ promptPrefix: 'Start at docs/README.md.\n\n', questions: [{ id: 'b' }] }));
    expect(shaped).toEqual({ promptPrefix: 'Start at docs/README.md.\n\n', questions: [{ id: 'b' }] });
  });

  it('refuses a file that is neither shape', () => {
    expect(() => loadQuestionSet(writeTemp({ items: [] }))).toThrow(/expected a list of questions/);
  });
});

describe('pairedComparison', () => {
  const record = (questionId: string, group: string, overrides: Record<string, unknown>) => ({
    questionId, group, passed: true, gateBytes: 1000, toolCalls: 2, contextTokens: 50_000, costUsd: 0.05, ...overrides,
  });

  it('reports the candidate-over-baseline ratio of summed question means, and pass rates', () => {
    const baseline = [
      record('q1', 'paraphrase', { gateBytes: 1000 }), record('q1', 'paraphrase', { gateBytes: 3000 }),
      record('q2', 'broad', { gateBytes: 4000, passed: false }), record('q2', 'broad', { gateBytes: 4000 }),
    ];
    const candidate = [
      record('q1', 'paraphrase', { gateBytes: 1000 }), record('q1', 'paraphrase', { gateBytes: 1000 }),
      record('q2', 'broad', { gateBytes: 2000 }), record('q2', 'broad', { gateBytes: 2000 }),
    ];

    const result = pairedComparison(baseline, candidate);

    // Baseline means 2000 + 4000 = 6000, candidate 1000 + 2000 = 3000.
    expect(result.measures.gateBytes.ratio).toBeCloseTo(0.5);
    expect(result.measures.toolCalls.ratio).toBeCloseTo(1);
    expect(result.passRate).toEqual({ baseline: 0.75, candidate: 1 });
    expect(result.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ group: 'paraphrase', questions: 1, gateBytes: 0.5 }),
      expect.objectContaining({ group: 'broad', questions: 1, gateBytes: 0.5 }),
    ]));
    const { low, high } = result.measures.gateBytes;
    expect(low).not.toBeNull();
    expect(low as number).toBeLessThanOrEqual(0.5);
    expect(high as number).toBeGreaterThanOrEqual(0.5);
  });

  it('gives an interval that spans 1 when the arms differ only by noise, and the same interval every time', () => {
    const baseline = ['a', 'b', 'c', 'd'].flatMap((id, index) => [record(id, 'paraphrase', { gateBytes: 1000 + index * 400 })]);
    const candidate = ['a', 'b', 'c', 'd'].flatMap((id, index) => [record(id, 'paraphrase', { gateBytes: index % 2 === 0 ? 900 + index * 400 : 1100 + index * 400 })]);

    const first = pairedComparison(baseline, candidate);
    const second = pairedComparison(baseline, candidate);

    expect(first.measures.gateBytes.low as number).toBeLessThan(1);
    expect(first.measures.gateBytes.high as number).toBeGreaterThan(1);
    expect(second.measures).toEqual(first.measures);
  });

  it('counts only questions run in both arms, and skips a measure a record lacks', () => {
    const baseline = [record('q1', 'paraphrase', { contextTokens: null }), record('only-before', 'paraphrase', { gateBytes: 99_999 })];
    const candidate = [record('q1', 'paraphrase', { contextTokens: null })];

    const result = pairedComparison(baseline, candidate);

    expect(result.questions.map((row: { questionId: string }) => row.questionId)).toEqual(['q1']);
    expect(result.measures.gateBytes.ratio).toBeCloseTo(1);
    expect(result.measures.contextTokens.ratio).toBeNull();
  });
});
