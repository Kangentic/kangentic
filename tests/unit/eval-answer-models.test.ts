/**
 * Pins scripts/eval-answer-models.mjs, the replay that picks the Knowledge Graph agent's model:
 *
 * 1. readAnswerStream takes the answering model from every `message_start`, the first text delta's
 *    time, and the result line's time, cost, model usage and text. The init line names the model
 *    asked for, not the one that answered, so it is never read.
 * 2. tableRefsOf collects only refs that open a table row, so the example refs in the rules
 *    (`#561`) are not taken as real tasks; inventedRefs is every other ref an answer names. It reads
 *    the prompt out of a stream-json stdin first, since the Ask path sends one.
 * 3. replayArgv changes only the model, the effort and the two captured file paths; replayEnv drops
 *    Claude session markers the app did not pass and pins thinking off at low only.
 * 4. recommendAnswerLevel (fixed 2026-10-07, before any run): a Haiku level passes only when it is
 *    right at least as often as Sonnet low, invents no ref, and has a median done time no longer.
 *    Ties go to more right, then the shorter median, then the lower effort. A run answered from a
 *    model other than its arm's throws.
 * 5. adoptSummaryModel (fixed 2026-10-07): zero invented details AND no more tasks passed over.
 * 6. The parsers replay real, sanitized CLI output (tests/fixtures/claude-ask-stream.jsonl and
 *    claude-print-result-success.json), and the Ask stdin comes from the Claude adapter's own
 *    `formatTurn`, so a change to either side of the wire shape fails here.
 * 7. REF_PATTERN is character for character the one `parseAnswerRefs` uses, and rejects lookalikes.
 * 8. parseArgs refuses an arm or run count that would spend agent calls on nothing, summaryTaskCountOf
 *    reads the tags the real `buildSummaryPrompt` writes, and runOnce never rejects.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StdinJsonSessionOptions } from '../../src/main/agent/shared/answer-session/stdin-json-session';
import { buildSummaryPrompt } from '../../src/main/retrieval/summary/summary-prompt';

const { sessionSpy } = vi.hoisted(() => ({ sessionSpy: vi.fn() }));
vi.mock('../../src/main/agent/shared/answer-session/stdin-json-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/agent/shared/answer-session/stdin-json-session')>();
  return { ...actual, openStdinJsonSession: sessionSpy };
});

import { ClaudeAdapter } from '../../src/main/agent/adapters/claude/claude-adapter';
import {
  REF_PATTERN,
  readAnswerStream,
  readJsonResult,
  tableRefsOf,
  inventedRefs,
  selectedRefs,
  replayArgv,
  replayEnv,
  recommendAnswerLevel,
  adoptSummaryModel,
  parseArgs,
  summaryTaskCountOf,
  runOnce,
} from '../../scripts/eval-answer-models.mjs';

const FIXTURE_DIRECTORY = path.resolve(__dirname, '../fixtures');

const streamEvent = (event: Record<string, unknown>): string => JSON.stringify({ type: 'stream_event', event });

describe('readAnswerStream', () => {
  const timedLines = [
    { atMs: 900, line: JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-5-5' }) },
    { atMs: 1_000, line: streamEvent({ type: 'message_start', message: { model: 'claude-haiku-5-5', content: [] } }) },
    { atMs: 1_100, line: streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'mcp__kangentic__kangentic_search' } }) },
    { atMs: 2_000, line: streamEvent({ type: 'message_start', message: { model: 'claude-haiku-5-5', content: [] } }) },
    { atMs: 2_100, line: streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '' } }) },
    { atMs: 2_200, line: streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '12 tasks.' } }) },
    { atMs: 2_300, line: 'not json' },
    {
      atMs: 2_900,
      line: JSON.stringify({ type: 'result', result: '12 tasks.\nSELECTED: none', total_cost_usd: 0.0123, modelUsage: { 'claude-haiku-5-5': {} } }),
    },
  ];

  it('reads the answering model from message_start, never the init line, and the timings from the deltas and the result', () => {
    expect(readAnswerStream(timedLines)).toEqual({
      models: ['claude-haiku-5-5', 'claude-haiku-5-5'],
      firstTextMs: 2_200,
      doneMs: 2_900,
      costUsd: 0.0123,
      usageModels: ['claude-haiku-5-5'],
      answer: '12 tasks.\nSELECTED: none',
      isError: false,
      toolCalls: 1,
    });
  });

  it('reports a run with no result line as not done', () => {
    const result = readAnswerStream(timedLines.slice(0, 6));
    expect(result.doneMs).toBeNull();
    expect(result.answer).toBeNull();
  });

  it('reads an error result, and takes a cost that is not a number as unknown', () => {
    const result = readAnswerStream([
      { atMs: 10, line: JSON.stringify({ type: 'result', is_error: true, result: 'boom', total_cost_usd: '0.5' }) },
    ]);
    expect(result.isError).toBe(true);
    expect(result.costUsd).toBeNull();
    expect(result.doneMs).toBe(10);
  });

  it('replays a real Claude CLI 2.1.293 Ask run (sanitized fixture)', () => {
    const timedLines = fs.readFileSync(path.join(FIXTURE_DIRECTORY, 'claude-ask-stream.jsonl'), 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '')
      .map((line, lineIndex) => ({ atMs: lineIndex * 10, line }));

    const result = readAnswerStream(timedLines);

    // The init line (index 0) also names claude-sonnet-5-5; reading it would list the model twice.
    expect(result.models).toEqual(['claude-sonnet-5-5']);
    // Index 4 is the first non-empty text_delta ("By"); index 3 is the empty content_block_start.
    expect(result.firstTextMs).toBe(40);
    // Index 27 is the `result` line, after the assistant, content_block_stop and message_stop lines.
    expect(result.doneMs).toBe(270);
    expect(result.costUsd).toBe(0.297064);
    expect(result.usageModels).toEqual(['claude-sonnet-5-5']);
    expect(result.isError).toBe(false);
    expect(result.toolCalls).toBe(0);
    expect(result.answer?.endsWith('SELECTED: #529')).toBe(true);
    expect(selectedRefs(result.answer)).toEqual(['#529']);
  });
});

describe('readJsonResult', () => {
  it('replays a real --print --output-format json result (sanitized fixture)', () => {
    const stdout = fs.readFileSync(path.join(FIXTURE_DIRECTORY, 'claude-print-result-success.json'), 'utf8');
    expect(readJsonResult(stdout)).toEqual({
      answer: 'ok',
      costUsd: 0.020622,
      usageModels: ['claude-haiku-4-5-20251001'],
      durationMs: 2918,
      isError: false,
    });
  });

  it('reads a json-output run and treats unparseable output as an error', () => {
    expect(readJsonResult(JSON.stringify({ result: 'D1: x', total_cost_usd: 0.002, duration_ms: 6600, modelUsage: { 'claude-sonnet-5-5': {} } }))).toEqual({
      answer: 'D1: x',
      costUsd: 0.002,
      usageModels: ['claude-sonnet-5-5'],
      durationMs: 6600,
      isError: false,
    });
    expect(readJsonResult('oops').isError).toBe(true);
  });
});

describe('tableRefsOf and inventedRefs', () => {
  const prompt = [
    'Name every task by its ref exactly as the table writes it, like #561. Never invent a ref.',
    '<task_table>',
    'ref|task|cost_usd',
    '#12|Relay reconnect|1.20',
    'mobile#88|Pairing screen|0.40',
    'C3|Untitled conversation|0.10',
    '</task_table>',
  ].join('\n');
  const refs = tableRefsOf(prompt);

  it('collects the refs that open a row, and not the example ref in the rules', () => {
    expect([...refs].sort()).toEqual(['#12', 'C3', 'mobile#88']);
  });

  it('reads the table out of a stream-json stdin, where the Ask path escapes every newline', () => {
    const stdin = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } }) + '\n';
    expect([...tableRefsOf(stdin)].sort()).toEqual(['#12', 'C3', 'mobile#88']);
  });

  it('reads the table out of the stdin line the Claude adapter\'s own formatTurn writes', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'answer-replay-test-'));
    try {
      sessionSpy.mockReturnValue({});
      new ClaudeAdapter().openAnswerSession({
        cliPath: '/bin/claude',
        cwd: '/answer-home',
        runDirectory: directory,
        model: 'sonnet',
        effort: 'low',
        retrieval: { url: 'http://127.0.0.1:1/mcp/p/answer-chat', token: 'secret' },
      });
      const options = sessionSpy.mock.calls[sessionSpy.mock.calls.length - 1][0] as StdinJsonSessionOptions;
      const stdin = `${options.formatTurn(prompt)}\n`;
      // The prompt's newlines are escaped on the wire, so a reader that skipped the stream-json
      // unwrap would see one line and find no row.
      expect(stdin.trimEnd().split('\n')).toHaveLength(1);
      expect([...tableRefsOf(stdin)].sort()).toEqual(['#12', 'C3', 'mobile#88']);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses a first cell that only starts like a ref', () => {
    expect([...tableRefsOf('#12abc|x\nC3x|y\n#1234567|z')]).toEqual([]);
  });

  it('reads a markdown row that opens with a pipe', () => {
    const markdown = ['| ref | task |', '| --- | --- |', '| #1 | Task 1 |', '| #300 | Task 300 |'].join('\n');
    expect([...tableRefsOf(markdown)].sort()).toEqual(['#1', '#300']);
  });

  it('flags every ref the tables do not hold, once, and matches a project prefix case-blind', () => {
    expect(inventedRefs('#12 and Mobile#88 cost most, then #561 and #561.\nSELECTED: #12, C9', refs)).toEqual(['#561', 'C9']);
    expect(inventedRefs('Nothing matched.\nSELECTED: none', refs)).toEqual([]);
  });

  it('reads the SELECTED line refs', () => {
    expect(selectedRefs('#12 is the one.\nSELECTED: #12, mobile#88')).toEqual(['#12', 'mobile#88']);
    expect(selectedRefs('no line')).toEqual([]);
  });

  it('reads a SELECTED line in any case, anywhere after the first line', () => {
    expect(selectedRefs('x\nselected: #5')).toEqual(['#5']);
  });
});

describe('REF_PATTERN', () => {
  it('is the pattern parseAnswerRefs uses, character for character', () => {
    const promptSource = fs.readFileSync(path.resolve(__dirname, '../../src/main/retrieval/answer-prompt.ts'), 'utf8');
    const literal = promptSource.match(/const refPattern = (\/.+\/[a-z]*);/);
    expect(literal).not.toBeNull();
    const text = (literal as RegExpMatchArray)[1];
    const lastSlash = text.lastIndexOf('/');
    const shipped = new RegExp(text.slice(1, lastSlash), text.slice(lastSlash + 1));
    expect(REF_PATTERN.source).toBe(shipped.source);
    expect(REF_PATTERN.flags).toBe(shipped.flags);
  });

  it('names no ref in a lookalike: a word ending in C and digits, a doubled hash, a seven-digit number', () => {
    expect(inventedRefs('ABC12 and ##12 and #1234567', new Set())).toEqual([]);
  });
});

describe('replayArgv and replayEnv', () => {
  const captured = ['--print', '--tools', '', '--settings', 'C:\\temp\\run\\settings.json', '--mcp-config', 'C:\\temp\\run\\mcp.json', '--model', 'sonnet', '--effort', 'low'];

  it('changes only the model, the effort and the two captured paths', () => {
    expect(replayArgv(captured, { model: 'haiku', effort: 'max', settingsPath: '/c/settings.json', mcpPath: '/c/mcp.json', jsonOutput: false })).toEqual([
      '--print', '--tools', '', '--settings', '/c/settings.json', '--mcp-config', '/c/mcp.json', '--model', 'haiku', '--effort', 'max',
    ]);
  });

  it('adds a model and effort the captured call left unset, and json output for a summary', () => {
    expect(replayArgv(['--print'], { model: 'haiku', effort: 'low', settingsPath: null, mcpPath: null, jsonOutput: true })).toEqual([
      '--print', '--model', 'haiku', '--effort', 'low', '--output-format', 'json',
    ]);
  });

  it('adds neither file flag when the captured call had none, even if a path is supplied', () => {
    expect(replayArgv(['--print'], { model: 'haiku', effort: 'low', settingsPath: '/c/settings.json', mcpPath: '/c/mcp.json', jsonOutput: false })).toEqual([
      '--print', '--model', 'haiku', '--effort', 'low',
    ]);
  });

  it('does not append a second output format when the captured call already sets one', () => {
    const argv = replayArgv(['--print', '--output-format', 'stream-json'], { model: 'haiku', effort: 'low', settingsPath: null, mcpPath: null, jsonOutput: true });
    expect(argv.filter((argument) => argument === '--output-format')).toHaveLength(1);
    expect(argv[argv.indexOf('--output-format') + 1]).toBe('stream-json');
  });

  it('pins thinking off at low only, and drops Claude session markers the app did not pass', () => {
    const base = { PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CONFIG_DIR: '/c', MAX_THINKING_TOKENS: '9' };
    expect(replayEnv(base, ['CLAUDE_CONFIG_DIR'], 'low')).toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/c', MAX_THINKING_TOKENS: '0' });
    expect(replayEnv(base, [], 'high')).toEqual({ PATH: '/bin' });
  });
});

interface AnswerRun {
  right: boolean;
  inventedRefs: string[];
  doneMs: number;
  models: string[];
  expectedModel: string;
}

const sonnetRun = (right: boolean, doneMs: number): AnswerRun => ({ right, inventedRefs: [], doneMs, models: ['claude-sonnet-5-5'], expectedModel: 'claude-sonnet-5-5' });
const haikuRun = (right: boolean, doneMs: number, invented: string[] = []): AnswerRun => ({ right, inventedRefs: invented, doneMs, models: ['claude-haiku-5-5'], expectedModel: 'claude-haiku-5-5' });

describe('recommendAnswerLevel', () => {
  // Sonnet low: 4 of 6 right, median done (2000 + 3000) / 2 = 2500.
  const baseline = [sonnetRun(true, 1000), sonnetRun(true, 2000), sonnetRun(true, 2000), sonnetRun(true, 3000), sonnetRun(false, 3000), sonnetRun(false, 4000)];

  it('recommends a level right as often, inventing nothing, with exactly the same median', () => {
    const low = [haikuRun(true, 500), haikuRun(true, 2000), haikuRun(true, 2000), haikuRun(true, 3000), haikuRun(false, 3000), haikuRun(false, 9000)];
    const result = recommendAnswerLevel(baseline, { low });
    expect(result.recommended).toBe('low');
    expect(result.stats.low).toEqual({ right: 4, invented: 0, medianDoneMs: 2500, runs: 6 });
  });

  it('refuses a level one right answer short, one invented ref, or one millisecond slower at the median', () => {
    const fewerRight = [haikuRun(true, 100), haikuRun(true, 100), haikuRun(true, 100), haikuRun(false, 100), haikuRun(false, 100), haikuRun(false, 100)];
    const invents = [haikuRun(true, 100), haikuRun(true, 100), haikuRun(true, 100), haikuRun(true, 100, ['#9999']), haikuRun(false, 100), haikuRun(false, 100)];
    const slower = [haikuRun(true, 2501), haikuRun(true, 2501), haikuRun(true, 2501), haikuRun(true, 2501), haikuRun(false, 2501), haikuRun(false, 2501)];
    expect(recommendAnswerLevel(baseline, { low: fewerRight, high: invents, max: slower })).toMatchObject({ recommended: null, passing: [] });
  });

  it('prefers more right, then the shorter median, then the lower effort', () => {
    const allRight = (doneMs: number) => Array.from({ length: 6 }, () => haikuRun(true, doneMs));
    const fourRight = (doneMs: number) => [...Array.from({ length: 4 }, () => haikuRun(true, doneMs)), haikuRun(false, doneMs), haikuRun(false, doneMs)];
    expect(recommendAnswerLevel(baseline, { low: fourRight(100), max: allRight(2000) }).recommended).toBe('max');
    expect(recommendAnswerLevel(baseline, { low: allRight(2000), high: allRight(1000) }).recommended).toBe('high');
    expect(recommendAnswerLevel(baseline, { high: allRight(1000), low: allRight(1000) }).recommended).toBe('low');
  });

  it('throws when a run answered from another model, or the run counts differ', () => {
    const stray = [...Array.from({ length: 5 }, () => haikuRun(true, 100)), { ...haikuRun(true, 100), models: ['claude-sonnet-5-5'] }];
    expect(() => recommendAnswerLevel(baseline, { low: stray })).toThrow('answered from claude-sonnet-5-5');
    expect(() => recommendAnswerLevel(baseline, { low: [haikuRun(true, 100)] })).toThrow('1 runs');
    expect(() => recommendAnswerLevel(baseline, { low: [...baseline].map(() => ({ ...haikuRun(true, 1), models: [] })) })).toThrow('no answering model');
  });

  it('throws on a run with no result line, or one that is not graded', () => {
    const candidateWith = (override: Record<string, unknown>) => [
      ...Array.from({ length: 5 }, () => haikuRun(true, 100)),
      { ...haikuRun(true, 100), ...override } as unknown as AnswerRun,
    ];
    expect(() => recommendAnswerLevel(baseline, { low: candidateWith({ doneMs: null }) })).toThrow(/no result line/);
    expect(() => recommendAnswerLevel(baseline, { low: candidateWith({ right: null }) })).toThrow(/not graded/);
  });

  it('applies the same checks to a baseline run, and needs one', () => {
    expect(() => recommendAnswerLevel([], {})).toThrow('needs baseline runs');
    const strayBaseline = [sonnetRun(true, 100), { ...sonnetRun(true, 100), models: ['claude-haiku-5-5'] }];
    expect(() => recommendAnswerLevel(strayBaseline, {})).toThrow(/baseline: .*answered from/);
  });

  it('throws on an effort that is not a known level', () => {
    expect(() => recommendAnswerLevel(baseline, { turbo: baseline.map(() => haikuRun(true, 100)) })).toThrow(/unknown effort/);
  });

  it('takes the middle value as the median of an odd run count, whatever order the runs came in', () => {
    const oddBaseline = [sonnetRun(true, 3000), sonnetRun(true, 1000), sonnetRun(true, 2000)];
    const result = recommendAnswerLevel(oddBaseline, { low: [haikuRun(true, 9000), haikuRun(true, 500), haikuRun(true, 1500)] });
    expect(result.baseline.medianDoneMs).toBe(2000);
    expect(result.stats.low.medianDoneMs).toBe(1500);
    expect(result.recommended).toBe('low');
  });
});

describe('parseArgs', () => {
  it('refuses an arm with no effort or an unknown one', () => {
    expect(() => parseArgs(['ask', '--arms', 'sonnet'])).toThrow(/--arms/);
    expect(() => parseArgs(['ask', '--arms', 'sonnet:turbo'])).toThrow(/--arms/);
  });

  it('refuses a run count that is not a positive whole number', () => {
    expect(() => parseArgs(['ask', '--arms', 'haiku:low', '--runs', 'abc'])).toThrow(/--runs/);
    expect(() => parseArgs(['ask', '--arms', 'haiku:low', '--runs', '0'])).toThrow(/--runs/);
    expect(() => parseArgs(['ask', '--arms', 'haiku:low', '--runs', '1.5'])).toThrow(/--runs/);
  });

  it('reads a valid command line', () => {
    expect(parseArgs(['ask', '--capture', 'cap', '--arms', 'haiku:low', '--runs', '3', '--out', 'out'])).toEqual({
      mode: 'ask',
      capture: 'cap',
      expect: null,
      arms: [{ model: 'haiku', effort: 'low' }],
      runs: 3,
      out: 'out',
    });
  });
});

describe('summaryTaskCountOf', () => {
  const inputOf = (taskId: string) => ({ taskId, title: `Task ${taskId}`, description: 'Does a thing.', changedFiles: ['src/a.ts'], commits: [], closingMessages: [] });

  it('counts the tasks the real buildSummaryPrompt writes', () => {
    expect(summaryTaskCountOf(buildSummaryPrompt([inputOf('one'), inputOf('two'), inputOf('three')]))).toBe(3);
    expect(summaryTaskCountOf(buildSummaryPrompt([inputOf('one')]))).toBe(1);
  });

  it('throws, saying the format changed, for a prompt with no task tags', () => {
    expect(() => summaryTaskCountOf('just some text')).toThrow(/format changed/);
  });
});

describe('runOnce', () => {
  it('resolves with code -1 and a message, instead of rejecting, for a CLI that does not exist', async () => {
    const outcome = await runOnce('kangentic-no-such-cli-for-test', [], '', process.env);
    expect(outcome.code).toBe(-1);
    expect(outcome.stderr.length).toBeGreaterThan(0);
    expect(outcome.timedLines).toEqual([]);
  }, 15_000);
});

describe('adoptSummaryModel', () => {
  const sonnet = { tasks: 50, inventedDetails: 2, passedOver: 1 };

  it('adopts with zero invented details and no more tasks passed over', () => {
    expect(adoptSummaryModel(sonnet, { tasks: 50, inventedDetails: 0, passedOver: 1 })).toEqual({ adopt: true, nothingInvented: true, coverageHeld: true });
  });

  it('refuses one invented detail, or one more task passed over', () => {
    expect(adoptSummaryModel(sonnet, { tasks: 50, inventedDetails: 1, passedOver: 0 }).adopt).toBe(false);
    expect(adoptSummaryModel(sonnet, { tasks: 50, inventedDetails: 0, passedOver: 2 }).adopt).toBe(false);
  });

  it('throws when the sides cover different tasks or a count is missing', () => {
    expect(() => adoptSummaryModel(sonnet, { tasks: 40, inventedDetails: 0, passedOver: 0 })).toThrow('same tasks');
    expect(() => adoptSummaryModel(sonnet, { tasks: 50, inventedDetails: 0 } as unknown as typeof sonnet)).toThrow('passedOver');
  });
});
