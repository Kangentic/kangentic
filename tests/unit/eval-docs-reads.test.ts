/**
 * Pins scripts/eval-docs-reads.mjs, the harness that measures how many bytes of tool output an agent
 * reads to answer questions from docs/:
 *
 * 1. tallyStream counts what the main agent's context received: each tool result once, subagent
 *    lines left out, `<system-reminder>` text split into its own column, and the docs/ share found
 *    from the tool's input path.
 * 2. grade needs every expect pattern, case-insensitive, and fails an empty answer.
 * 3. gate passes only when the pilot drop beats the largest control change and no pilot question
 *    loses a pass, so a run-to-run wobble cannot pass for a real saving.
 * 4. The question file holds both groups with patterns that compile.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { gate, grade, loadQuestions, readsDocs, runArgs, summarize, tallyStream } from '../../scripts/eval-docs-reads.mjs';

const CHECKOUT = path.resolve('/scratch/checkout');

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
});

describe('readsDocs', () => {
  it('matches docs/ and files below it, relative or absolute, and nothing beside it', () => {
    expect(readsDocs({ file_path: path.join(CHECKOUT, 'docs', 'x', 'y.md') }, CHECKOUT)).toBe(true);
    expect(readsDocs({ path: 'docs' }, CHECKOUT)).toBe(true);
    expect(readsDocs({ path: 'docs-old/a.md' }, CHECKOUT)).toBe(false);
    expect(readsDocs({ pattern: 'codex' }, CHECKOUT)).toBe(false);
    expect(readsDocs(undefined, CHECKOUT)).toBe(false);
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
  const row = (questionId: string, group: string, medianGateBytes: number, passes = 3) => ({ questionId, group, runs: 3, passes, medianGateBytes });

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
});

describe('the run and its questions', () => {
  it('gives the agent file tools only, no MCP servers and no session file', () => {
    const argv = runArgs({ settingsPath: 's.json', model: 'claude-sonnet-5-5', effort: 'medium' });
    expect(argv[argv.indexOf('--tools') + 1]).toBe('Read,Grep,Glob');
    expect(argv).toContain('--strict-mcp-config');
    expect(argv).toContain('--no-session-persistence');
    expect(argv[argv.indexOf('--output-format') + 1]).toBe('stream-json');
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
