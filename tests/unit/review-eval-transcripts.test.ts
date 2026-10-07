/**
 * Pins the three review-eval scripts that read Claude Code subagent transcripts, against a
 * fixture that has the real shape of one (tests/fixtures/review-eval-subagent-transcript.jsonl):
 * one content block per line, the same message id repeated across lines with the usage growing,
 * a short usage record on streaming lines and a full one on the last line, a server_tool_use
 * advisor call, a SubagentHandback call carrying the final report, and a line that is not JSON.
 * Every value in it is a placeholder. The numbers below are worked out by hand from the lines:
 *
 *   claude-sonnet-5-5   8 messages: input 10+20+5+3+2+1+1+1=43, 5-minute writes 200+100+40=340,
 *                       1-hour writes 300+50=350, reads 1000+2000+3000+4000+10+5+6+7=10028,
 *                       output 42+30+10+60+15+2+3+1=163 (message 1 counts its LAST line, 42, not
 *                       the first, 5; message 6 appears on two lines and counts once)
 *   claude-haiku-fixture 1 message: input 7, 5-minute 80, 1-hour 0, reads 400, output 9. Its usage
 *                       has a 5-minute split and NO cache_creation_input_tokens, so the 1-hour
 *                       share must clamp to 0, never -80.
 *
 * The fixture also carries lines the DRIVER-side parser reads: a non-sidechain Agent call (on two
 * lines with one tool-use id), a non-sidechain legacy Task call, and a sidechain Agent call that
 * extractAgentCalls must skip while tallyTranscript still counts it. A real subagent transcript
 * is all sidechain lines, so those three lines stand in for a driver transcript.
 *
 * The collect-reports CLI is run for real, against temp copies of the fixture.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tallyTranscript, costOfRequests } from '../../scripts/review-eval/cost.mjs';
import { finalReportOf } from '../../scripts/review-eval/collect-reports.mjs';
import { extractAgentCalls } from '../../scripts/review-eval/extract-finder-prompts.mjs';

const FIXTURE_PATH = path.resolve(__dirname, '../fixtures/review-eval-subagent-transcript.jsonl');
const COLLECT_SCRIPT_PATH = path.resolve(__dirname, '../../scripts/review-eval/collect-reports.mjs');
const FIXTURE_TEXT = fs.readFileSync(FIXTURE_PATH, 'utf8');

const HANDBACK_REPORT = 'Fixture final report.\n\n1. src/example.ts: fixture finding one.\n2. src/other.ts: fixture finding two.';

interface Tokens {
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
}

interface TranscriptLineOptions {
  messageId?: string;
  model?: string;
  content?: unknown[];
  usage?: Record<string, unknown>;
  type?: string;
}

/** One assistant line, built inline for a targeted case. */
function transcriptLine(options: TranscriptLineOptions): string {
  const message: Record<string, unknown> = { role: 'assistant', content: options.content ?? [] };
  if (options.messageId !== undefined) message.id = options.messageId;
  if (options.model !== undefined) message.model = options.model;
  if (options.usage !== undefined) message.usage = options.usage;
  return JSON.stringify({ type: options.type ?? 'assistant', isSidechain: true, message });
}

function toolUseBlock(id: string, name: string, type = 'tool_use'): Record<string, unknown> {
  return { type, id, name, input: {} };
}

describe('tallyTranscript over the subagent transcript fixture', () => {
  const tally = tallyTranscript(FIXTURE_TEXT);

  it('counts each message id once and totals tokens per model and class', () => {
    expect(tally.messages).toBe(9);
    expect(tally.tokensByModel).toEqual({
      'claude-sonnet-5-5': { input: 43, cacheWrite5m: 340, cacheWrite1h: 350, cacheRead: 10028, output: 163 },
      'claude-haiku-fixture': { input: 7, cacheWrite5m: 80, cacheWrite1h: 0, cacheRead: 400, output: 9 },
    });
  });

  it('never produces a negative 1-hour count from a split with no top-level total', () => {
    const haiku: Tokens = tally.tokensByModel['claude-haiku-fixture'];

    expect(haiku.cacheWrite5m).toBe(80);
    expect(haiku.cacheWrite1h).toBe(0);
  });

  it('counts tool calls by name, a repeated tool-use id once, and a sidechain call too', () => {
    expect(tally.toolCalls).toEqual({ Read: 2, advisor: 1, SubagentHandback: 1, Agent: 2, Task: 1 });
  });

  it('counts the server_tool_use advisor call', () => {
    expect(tally.advisorCalls).toBe(1);
  });
});

describe('tallyTranscript targeted cases', () => {
  it('lets the last line of a message win, not the largest', () => {
    const growing = tallyTranscript([
      transcriptLine({ messageId: 'msg_a', model: 'm', usage: { input_tokens: 1, output_tokens: 5 } }),
      transcriptLine({ messageId: 'msg_a', model: 'm', usage: { input_tokens: 1, output_tokens: 42 } }),
    ].join('\n'));
    const shrinking = tallyTranscript([
      transcriptLine({ messageId: 'msg_a', model: 'm', usage: { input_tokens: 1, output_tokens: 42 } }),
      transcriptLine({ messageId: 'msg_a', model: 'm', usage: { input_tokens: 1, output_tokens: 5 } }),
    ].join('\n'));

    expect(growing.messages).toBe(1);
    expect(growing.tokensByModel.m.output).toBe(42);
    expect(shrinking.tokensByModel.m.output).toBe(5);
  });

  it('splits cache writes by TTL, taking an explicit 1-hour share and otherwise the rest of the total', () => {
    const text = [
      // A 5-minute split and no total: the 1-hour share clamps to 0.
      transcriptLine({ messageId: 'm1', model: 'split-only', usage: { cache_creation: { ephemeral_5m_input_tokens: 80 } } }),
      // A total and a 5-minute split: the 1-hour share is the remainder.
      transcriptLine({
        messageId: 'm2',
        model: 'total-and-five',
        usage: { cache_creation_input_tokens: 500, cache_creation: { ephemeral_5m_input_tokens: 200 } },
      }),
      // A total and no split: priced whole at the 1-hour rate.
      transcriptLine({ messageId: 'm3', model: 'total-only', usage: { cache_creation_input_tokens: 120 } }),
      // An explicit split wins over the total.
      transcriptLine({
        messageId: 'm4',
        model: 'explicit-split',
        usage: { cache_creation_input_tokens: 999, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 } },
      }),
      // A 5-minute share larger than the total still cannot subtract from the 1-hour share.
      transcriptLine({
        messageId: 'm5',
        model: 'oversized-five',
        usage: { cache_creation_input_tokens: 50, cache_creation: { ephemeral_5m_input_tokens: 80 } },
      }),
    ].join('\n');

    const { tokensByModel } = tallyTranscript(text);

    expect([tokensByModel['split-only'].cacheWrite5m, tokensByModel['split-only'].cacheWrite1h]).toEqual([80, 0]);
    expect([tokensByModel['total-and-five'].cacheWrite5m, tokensByModel['total-and-five'].cacheWrite1h]).toEqual([200, 300]);
    expect([tokensByModel['total-only'].cacheWrite5m, tokensByModel['total-only'].cacheWrite1h]).toEqual([0, 120]);
    expect([tokensByModel['explicit-split'].cacheWrite5m, tokensByModel['explicit-split'].cacheWrite1h]).toEqual([10, 20]);
    expect([tokensByModel['oversized-five'].cacheWrite5m, tokensByModel['oversized-five'].cacheWrite1h]).toEqual([80, 0]);
  });

  it('ignores usage with no message id and non-assistant lines, and files a missing model under unknown', () => {
    const text = [
      transcriptLine({ model: 'm', usage: { input_tokens: 99 } }),
      transcriptLine({ messageId: 'msg_user', model: 'm', usage: { input_tokens: 99 }, type: 'user' }),
      transcriptLine({ messageId: 'msg_a', usage: { input_tokens: 3 } }),
    ].join('\n');

    const tally = tallyTranscript(text);

    expect(tally.messages).toBe(1);
    expect(tally.tokensByModel).toEqual({ unknown: { input: 3, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 } });
  });

  it('counts a tool_use advisor call and a server_tool_use advisor call, each once per id', () => {
    const text = [
      transcriptLine({ messageId: 'm1', content: [toolUseBlock('id_1', 'advisor')] }),
      transcriptLine({ messageId: 'm1', content: [toolUseBlock('id_1', 'advisor')] }),
      transcriptLine({ messageId: 'm2', content: [toolUseBlock('srv_1', 'advisor', 'server_tool_use'), { type: 'text', text: 'not a call' }] }),
    ].join('\n');

    const tally = tallyTranscript(text);

    expect(tally.advisorCalls).toBe(2);
    expect(tally.toolCalls).toEqual({ advisor: 2 });
  });

  it('skips malformed lines and blank lines', () => {
    const text = ['', 'not json', transcriptLine({ messageId: 'm1', model: 'm', usage: { input_tokens: 1 } }), '   '].join('\n');

    expect(tallyTranscript(text).messages).toBe(1);
  });
});

describe('costOfRequests', () => {
  // Synthetic round prices per million tokens, chosen so each prefix gives a different answer.
  const broadPrefixPrice = { input: 3, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3, output: 15 };
  const narrowPrefixPrice = { input: 1, cacheWrite5m: 2, cacheWrite1h: 3, cacheRead: 4, output: 5 };
  const { requests } = tallyTranscript(FIXTURE_TEXT);
  const requestsOf = (model: string) => requests.filter((request: { model: string }) => request.model === model);

  it('returns one request per message id, whose tokens sum to the per-model totals', () => {
    const tally = tallyTranscript(FIXTURE_TEXT);

    expect(tally.requests).toHaveLength(tally.messages);
    const summed: Record<string, Tokens> = {};
    for (const request of tally.requests as Array<{ model: string; tokens: Tokens }>) {
      const tokens = summed[request.model] ?? (summed[request.model] = { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 });
      for (const tokenClass of Object.keys(tokens) as Array<keyof Tokens>) tokens[tokenClass] += request.tokens[tokenClass];
    }
    expect(summed).toEqual(tally.tokensByModel);
  });

  it('prices a model by the longest matching prefix, whatever order the prefixes are listed in', () => {
    const shortFirst = costOfRequests(requests, {
      'claude-sonnet': broadPrefixPrice,
      'claude-sonnet-5': narrowPrefixPrice,
      'claude-haiku': narrowPrefixPrice,
    });
    const longFirst = costOfRequests(requests, {
      'claude-sonnet-5': narrowPrefixPrice,
      'claude-sonnet': broadPrefixPrice,
      'claude-haiku': narrowPrefixPrice,
    });

    // Sonnet at the narrow prefix: 43*1 + 340*2 + 350*3 + 10028*4 + 163*5 = 42700.
    // Haiku at the narrow price: 7*1 + 80*2 + 0*3 + 400*4 + 9*5 = 1812.
    expect(shortFirst.usd).toBe(0.0445);
    expect(longFirst.usd).toBe(0.0445);
    expect(shortFirst.unpriced).toEqual([]);
  });

  it('would price sonnet far lower under the shorter prefix, so the longest-prefix result is not a tie', () => {
    const broadOnly = costOfRequests(requestsOf('claude-sonnet-5-5'), { 'claude-sonnet': broadPrefixPrice });
    const narrowOnly = costOfRequests(requestsOf('claude-sonnet-5-5'), { 'claude-sonnet-5': narrowPrefixPrice });

    expect(broadOnly.usd).toBe(0.009);
    expect(narrowOnly.usd).toBe(0.0427);
  });

  it('reports a model with no matching prefix as unpriced, once, and leaves it out of the total', () => {
    const result = costOfRequests([...requests, ...requestsOf('claude-haiku-fixture')], { 'claude-sonnet-5': narrowPrefixPrice });

    expect(result.unpriced).toEqual(['claude-haiku-fixture']);
    expect(result.usd).toBe(0.0427);
  });

  it('does not let a clamped negative cache count lower the cost', () => {
    const haikuOnly = costOfRequests(requestsOf('claude-haiku-fixture'), { 'claude-haiku': narrowPrefixPrice });

    // 7*1 + 80*2 + 0*3 + 400*4 + 9*5 = 1812 per million, which rounds to 0.0018.
    expect(haikuOnly.usd).toBe(0.0018);
  });

  it('returns zero, nothing unpriced and no tier counts for no requests', () => {
    expect(costOfRequests([], { 'claude-sonnet': broadPrefixPrice })).toEqual({ usd: 0, unpriced: [], aboveTier: {} });
  });

  describe('a rate card with an upper tier', () => {
    // Base rates of 1 per million on every class and 5 above, so a dollar figure reads as the tier.
    const flat = { input: 1, cacheWrite5m: 1, cacheWrite1h: 1, cacheRead: 1, output: 1 };
    const tiered = { 'claude-tiered': { ...flat, above: { promptTokens: 100_000, input: 5, cacheWrite5m: 5, cacheWrite1h: 5, cacheRead: 5, output: 5 } } };
    const request = (tokens: Partial<Tokens>) => ({
      model: 'claude-tiered-1',
      tokens: { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, ...tokens },
    });

    it('prices a request of exactly the threshold at the base rate', () => {
      // 10 + 40,000 + 59,990 = 100,000 prompt tokens, plus 1,000 output: 101,000 at 1 per million.
      const result = costOfRequests([request({ input: 10, cacheWrite5m: 40_000, cacheRead: 59_990, output: 1_000 })], tiered);

      expect(result.usd).toBe(0.101);
      expect(result.aboveTier).toEqual({ 'claude-tiered-1': { above: 0, requests: 1 } });
    });

    it('prices a request one token over at the upper rate, output included', () => {
      // 100,001 prompt tokens plus 1,000 output, all at 5 per million: 505,005 per million.
      const result = costOfRequests([request({ input: 11, cacheWrite1h: 40_000, cacheRead: 59_990, output: 1_000 })], tiered);

      expect(result.usd).toBe(0.505);
      expect(result.aboveTier).toEqual({ 'claude-tiered-1': { above: 1, requests: 1 } });
    });

    it('prices each request on its own card, which a per-model sum cannot', () => {
      // A small request (50,000 + 100 output at 1) and a large one (150,000 + 100 output at 5):
      // 50,100 + 750,500 = 800,600 per million. Summed first, 200,200 tokens would all price at 5.
      const result = costOfRequests([request({ cacheRead: 50_000, output: 100 }), request({ cacheRead: 150_000, output: 100 })], tiered);

      expect(result.usd).toBe(0.8006);
      expect(result.aboveTier).toEqual({ 'claude-tiered-1': { above: 1, requests: 2 } });
    });

    it('counts no tier for a model priced on a flat card', () => {
      const result = costOfRequests([{ model: 'claude-flat', tokens: request({ cacheRead: 500_000 }).tokens }], { 'claude-flat': flat });

      expect(result.usd).toBe(0.5);
      expect(result.aboveTier).toEqual({});
    });
  });
});

describe('finalReportOf', () => {
  it('returns the handback message, not a text block that comes after it', () => {
    expect(finalReportOf(FIXTURE_TEXT)).toBe(HANDBACK_REPORT);
  });

  it('falls back to the last non-blank text block when there is no handback', () => {
    const withoutHandback = FIXTURE_TEXT.split('\n')
      .filter((line) => !line.includes('"SubagentHandback"'))
      .join('\n');

    // The fixture holds an interim text, a trailing text, and a whitespace-only text, in that order.
    expect(finalReportOf(withoutHandback)).toBe('Trailing note after the handback.');
  });

  it('takes the last handback when a transcript has two', () => {
    const text = [
      transcriptLine({ content: [{ type: 'tool_use', id: 'h1', name: 'SubagentHandback', input: { message: 'first report' } }] }),
      transcriptLine({ content: [{ type: 'tool_use', id: 'h2', name: 'SubagentHandback', input: { message: 'second report' } }] }),
    ].join('\n');

    expect(finalReportOf(text)).toBe('second report');
  });

  it('ignores a handback whose message is not a string', () => {
    const text = [
      transcriptLine({ content: [{ type: 'text', text: 'the only text' }] }),
      transcriptLine({ content: [{ type: 'tool_use', id: 'h1', name: 'SubagentHandback', input: { message: 42 } }] }),
    ].join('\n');

    expect(finalReportOf(text)).toBe('the only text');
  });

  it('returns null when the transcript has neither a handback nor any text', () => {
    const text = [
      'not json',
      transcriptLine({ content: [toolUseBlock('t1', 'Read')] }),
      transcriptLine({ content: [{ type: 'text', text: '   ' }] }),
    ].join('\n');

    expect(finalReportOf(text)).toBeNull();
    expect(finalReportOf('')).toBeNull();
  });
});

describe('extractAgentCalls', () => {
  it('returns the driver Agent and Task calls in order, once per tool-use id', () => {
    const calls = extractAgentCalls(FIXTURE_TEXT);

    // The Agent call is written on two lines with one id: it is kept once, with the FIRST line's
    // timestamp. The sidechain Agent call (toolu_fixture_agent_2) is not in the list.
    expect(calls).toEqual([
      {
        subagentType: 'code-reviewer',
        description: 'Fixture finder one',
        model: 'haiku',
        prompt: 'Review src/example.ts for correctness.',
        timestamp: '2026-01-01T00:00:09.000Z',
      },
      {
        subagentType: 'general-purpose',
        description: 'Legacy fixture task',
        model: null,
        prompt: 'Inspect src/other.ts.',
        timestamp: '2026-01-01T00:00:10.000Z',
      },
    ]);
  });

  it('defaults the subagent type to general-purpose and the model to null', () => {
    const calls = extractAgentCalls(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'a1', name: 'Agent', input: { description: 'no type', prompt: 'p' } }] },
      }),
    );

    expect(calls).toEqual([{ subagentType: 'general-purpose', description: 'no type', model: null, prompt: 'p', timestamp: null }]);
  });

  it('skips every Agent call on a sidechain line', () => {
    const sidechainOnly = FIXTURE_TEXT.split('\n')
      .filter((line) => !line.includes('"isSidechain":false'))
      .join('\n');

    expect(extractAgentCalls(sidechainOnly)).toEqual([]);
  });

  it('ignores tools that are not Agent or Task, and malformed lines', () => {
    const text = ['not json', transcriptLine({ content: [toolUseBlock('r1', 'Read')] }).replace('"isSidechain":true', '"isSidechain":false')].join('\n');

    expect(extractAgentCalls(text)).toEqual([]);
  });
});

describe('collect-reports CLI', () => {
  let tempRoot: string | null = null;

  afterEach(() => {
    if (tempRoot !== null) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = null;
    }
  });

  interface CollectFixture {
    root: string;
    runsPath: string;
    outDirectory: string;
    firstTranscriptPath: string;
    secondTranscriptPath: string;
  }

  /**
   * A ledger naming two runs. The first is found through transcriptDir (agent-<id>.jsonl), the
   * second through its own "transcript" path, so both lookup branches run. The second transcript's
   * report is reworded, so each written report can be told apart and tied back to its run.
   */
  function makeCollectFixture(): CollectFixture {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-eval-collect-'));
    tempRoot = root;
    const transcriptDirectory = path.join(root, 'transcripts');
    const elsewhereDirectory = path.join(root, 'elsewhere');
    fs.mkdirSync(transcriptDirectory);
    fs.mkdirSync(elsewhereDirectory);
    const firstTranscriptPath = path.join(transcriptDirectory, 'agent-runone.jsonl');
    const secondTranscriptPath = path.join(elsewhereDirectory, 'second-run.jsonl');
    fs.writeFileSync(firstTranscriptPath, FIXTURE_TEXT);
    fs.writeFileSync(secondTranscriptPath, FIXTURE_TEXT.split('Fixture final report.').join('Second run report.'));
    const runsPath = path.join(root, 'runs.json');
    fs.writeFileSync(
      runsPath,
      JSON.stringify({
        transcriptDir: transcriptDirectory,
        E1: {
          'case-a': [
            { agentId: 'runone', arm: 'A', rep: 1, shard: 1 },
            { agentId: 'runtwo', arm: 'B', rep: 2, shard: 1, transcript: secondTranscriptPath },
          ],
        },
      }),
    );
    // A new child of the temp root, never the root itself: the key is written BESIDE it.
    return { root, runsPath, outDirectory: path.join(root, 'collected'), firstTranscriptPath, secondTranscriptPath };
  }

  interface CollectResult {
    status: number;
    stdout: string;
    stderr: string;
  }

  function runCollect(commandArguments: string[]): CollectResult {
    try {
      const stdout = execFileSync('node', [COLLECT_SCRIPT_PATH, ...commandArguments], { encoding: 'utf8', stdio: 'pipe' });
      return { status: 0, stdout, stderr: '' };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      return { status: failure.status ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
    }
  }

  interface KeyEntry {
    anonymousId: string;
    agentId: string;
    arm: string;
    rep: number;
    shard: number;
    transcript: string;
  }

  it('writes one anonymous report per run into a new folder and a key file beside it', () => {
    const fixture = makeCollectFixture();

    const result = runCollect([fixture.runsPath, 'E1', 'case-a', fixture.outDirectory]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('wrote 2 anonymized reports');
    const reportFiles = fs.readdirSync(fixture.outDirectory);
    expect(reportFiles).toHaveLength(2);
    for (const reportFile of reportFiles) expect(reportFile).toMatch(/^[0-9a-f]{6}\.md$/);

    // The key sits beside the folder (the scorer is handed the folder), never inside it.
    const keyPath = `${fixture.outDirectory}.key.json`;
    expect(fs.existsSync(keyPath)).toBe(true);
    expect(fs.readdirSync(fixture.root).sort()).toEqual(['collected', 'collected.key.json', 'elsewhere', 'runs.json', 'transcripts']);

    const key: KeyEntry[] = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    expect(key).toHaveLength(2);
    expect(new Set(key.map((entry) => entry.anonymousId)).size).toBe(2);
    const firstEntry = key.find((entry) => entry.agentId === 'runone');
    const secondEntry = key.find((entry) => entry.agentId === 'runtwo');
    expect(firstEntry).toMatchObject({ arm: 'A', rep: 1, shard: 1, transcript: fixture.firstTranscriptPath });
    expect(secondEntry).toMatchObject({ arm: 'B', rep: 2, shard: 1, transcript: fixture.secondTranscriptPath });
    if (!firstEntry || !secondEntry) throw new Error('both runs must appear in the key');

    // Each anonymous id points at the report of its own run.
    expect(fs.readFileSync(path.join(fixture.outDirectory, `${firstEntry.anonymousId}.md`), 'utf8')).toBe(HANDBACK_REPORT);
    expect(fs.readFileSync(path.join(fixture.outDirectory, `${secondEntry.anonymousId}.md`), 'utf8')).toBe(
      HANDBACK_REPORT.replace('Fixture final report.', 'Second run report.'),
    );
  });

  it('refuses to collect into a folder that already holds reports and writes nothing new', () => {
    const fixture = makeCollectFixture();
    const keyPath = `${fixture.outDirectory}.key.json`;
    expect(runCollect([fixture.runsPath, 'E1', 'case-a', fixture.outDirectory]).status).toBe(0);
    const filesBefore = fs.readdirSync(fixture.outDirectory).sort();
    const keyBefore = fs.readFileSync(keyPath, 'utf8');
    const reportsBefore = filesBefore.map((file) => fs.readFileSync(path.join(fixture.outDirectory, file), 'utf8'));

    const second = runCollect([fixture.runsPath, 'E1', 'case-a', fixture.outDirectory]);

    expect(second.status).toBe(2);
    expect(second.stderr).toContain('is not empty');
    expect(fs.readdirSync(fixture.outDirectory).sort()).toEqual(filesBefore);
    expect(fs.readFileSync(keyPath, 'utf8')).toBe(keyBefore);
    expect(filesBefore.map((file) => fs.readFileSync(path.join(fixture.outDirectory, file), 'utf8'))).toEqual(reportsBefore);
  });

  it('accepts an existing empty folder', () => {
    const fixture = makeCollectFixture();
    fs.mkdirSync(fixture.outDirectory);

    const result = runCollect([fixture.runsPath, 'E1', 'case-a', fixture.outDirectory]);

    expect(result.status).toBe(0);
    expect(fs.readdirSync(fixture.outDirectory)).toHaveLength(2);
  });

  it('exits 2 with usage text when the argument count is wrong', () => {
    const result = runCollect(['only-one-argument']);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage:');
  });

  it('exits 2 when the ledger has no runs for the experiment and case', () => {
    const fixture = makeCollectFixture();

    const result = runCollect([fixture.runsPath, 'E1', 'no-such-case', fixture.outDirectory]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('no runs for E1 no-such-case');
    expect(fs.existsSync(fixture.outDirectory)).toBe(false);
  });

  it('exits 1 and names the run when its transcript is missing', () => {
    const fixture = makeCollectFixture();
    fs.rmSync(fixture.secondTranscriptPath);

    const result = runCollect([fixture.runsPath, 'E1', 'case-a', fixture.outDirectory]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing transcript for runtwo');
    expect(fs.existsSync(`${fixture.outDirectory}.key.json`)).toBe(false);
  });
});
