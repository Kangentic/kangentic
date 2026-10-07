/**
 * Pins the command lines of the review-eval scripts that read Claude Code transcripts. The parsers
 * behind them are pinned in review-eval-transcripts.test.ts, and tally.mjs in review-eval-tally.test.ts.
 * What is left is the glue that decides what lands on disk and on stdout:
 *
 * 1. cost.mjs sums tokens, advisor calls, tool calls and dollars across every transcript, lists a
 *    model with no price once, names each transcript by its file name, takes `--prices` in any
 *    position, and exits 2 with a usage line when the prices file is missing.
 * 2. extract-finder-prompts.mjs writes each Agent prompt exactly as sent into `<index>-<type>.md`,
 *    turns every character outside letters, digits and hyphens in the subagent type into an
 *    underscore (a plugin type such as `toolkit:code-reviewer` holds a colon, which a Windows file
 *    name cannot), creates a missing output folder, and lists the calls in index.json.
 * 3. collect-reports.mjs exits 1 without a key file when a transcript holds no report, exits 2 when
 *    neither the ledger nor every run names where the transcripts are, and accepts a ledger with no
 *    transcriptDir when every run carries its own transcript path.
 *
 * Every script runs for real, against temp folders under os.tmpdir(). The token totals come from the
 * hand-worked transcript fixture: per copy, claude-sonnet-5-5 is 43 input, 340 five-minute writes,
 * 350 one-hour writes, 10028 reads and 163 output tokens, and claude-haiku-fixture is 7, 80, 0, 400 and
 * 9. At the round prices below one copy costs 43 + 680 + 1050 + 40112 + 815 = 42700 per million for
 * sonnet, which is 0.0427 dollars.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const SCRIPT_DIRECTORY = path.resolve(__dirname, '../../scripts/review-eval');
const COST_SCRIPT_PATH = path.join(SCRIPT_DIRECTORY, 'cost.mjs');
const EXTRACT_SCRIPT_PATH = path.join(SCRIPT_DIRECTORY, 'extract-finder-prompts.mjs');
const COLLECT_SCRIPT_PATH = path.join(SCRIPT_DIRECTORY, 'collect-reports.mjs');
const FIXTURE_TEXT = fs.readFileSync(path.resolve(__dirname, '../fixtures/review-eval-subagent-transcript.jsonl'), 'utf8');

const scratchDirectories: string[] = [];

afterEach(() => {
  for (const scratchDirectory of scratchDirectories.splice(0)) {
    fs.rmSync(scratchDirectory, { recursive: true, force: true });
  }
});

function makeScratchDirectory(): string {
  const scratchDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'review-eval-cli-'));
  scratchDirectories.push(scratchDirectory);
  return scratchDirectory;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runScript(scriptPath: string, commandArguments: string[]): CommandResult {
  try {
    const stdout = execFileSync('node', [scriptPath, ...commandArguments], { encoding: 'utf8', stdio: 'pipe' });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number | null; stdout?: string; stderr?: string };
    return { exitCode: failure.status ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

describe('cost.mjs command line', () => {
  const NARROW_PRICE = { input: 1, cacheWrite5m: 2, cacheWrite1h: 3, cacheRead: 4, output: 5 };

  interface CostFixture {
    firstPath: string;
    secondPath: string;
    pricesPath: string;
  }

  /** Two copies of the transcript fixture in different folders, and prices for sonnet only. */
  function makeCostFixture(): CostFixture {
    const root = makeScratchDirectory();
    fs.mkdirSync(path.join(root, 'one'));
    fs.mkdirSync(path.join(root, 'two'));
    const firstPath = path.join(root, 'one', 'first.jsonl');
    const secondPath = path.join(root, 'two', 'second.jsonl');
    fs.writeFileSync(firstPath, FIXTURE_TEXT);
    fs.writeFileSync(secondPath, FIXTURE_TEXT);
    const pricesPath = path.join(root, 'prices.json');
    fs.writeFileSync(pricesPath, JSON.stringify({ 'claude-sonnet': NARROW_PRICE }));
    return { firstPath, secondPath, pricesPath };
  }

  interface CostOutput {
    total: {
      tokensByModel: Record<string, Record<string, number>>;
      advisorCalls: number;
      toolCalls: Record<string, number>;
      usd: number;
      unpriced: string[];
    };
    perTranscript: Array<{ transcript: string; usd: number; messages: number; advisorCalls: number; unpriced: string[] }>;
  }

  it('sums every transcript, lists an unpriced model once, and names each transcript by file name', () => {
    const fixture = makeCostFixture();

    const result = runScript(COST_SCRIPT_PATH, ['--prices', fixture.pricesPath, fixture.firstPath, fixture.secondPath]);

    expect(result.exitCode).toBe(0);
    const output: CostOutput = JSON.parse(result.stdout);
    expect(output.total.tokensByModel).toEqual({
      'claude-sonnet-5-5': { input: 86, cacheWrite5m: 680, cacheWrite1h: 700, cacheRead: 20056, output: 326 },
      'claude-haiku-fixture': { input: 14, cacheWrite5m: 160, cacheWrite1h: 0, cacheRead: 800, output: 18 },
    });
    expect(output.total.advisorCalls).toBe(2);
    expect(output.total.toolCalls).toEqual({ Read: 4, advisor: 2, SubagentHandback: 2, Agent: 4, Task: 2 });
    expect(output.total.usd).toBe(0.0854);
    expect(output.total.unpriced).toEqual(['claude-haiku-fixture']);
    expect(output.perTranscript.map((entry) => entry.transcript)).toEqual(['first.jsonl', 'second.jsonl']);
    for (const entry of output.perTranscript) {
      expect(entry.usd).toBe(0.0427);
      expect(entry.messages).toBe(9);
      expect(entry.advisorCalls).toBe(1);
      expect(entry.unpriced).toEqual(['claude-haiku-fixture']);
    }
  });

  it('takes --prices after the transcript paths as well as before them', () => {
    const fixture = makeCostFixture();

    const result = runScript(COST_SCRIPT_PATH, [fixture.firstPath, '--prices', fixture.pricesPath, fixture.secondPath]);

    expect(result.exitCode).toBe(0);
    const output: CostOutput = JSON.parse(result.stdout);
    expect(output.perTranscript.map((entry) => entry.transcript)).toEqual(['first.jsonl', 'second.jsonl']);
    expect(output.total.usd).toBe(0.0854);
  });

  it('exits 2 with a usage line when --prices is missing or has no value', () => {
    const fixture = makeCostFixture();

    for (const commandArguments of [[fixture.firstPath], [fixture.firstPath, '--prices']]) {
      const result = runScript(COST_SCRIPT_PATH, commandArguments);

      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('usage:');
    }
  });
});

describe('extract-finder-prompts.mjs command line', () => {
  interface AgentCallInput {
    toolName: string;
    subagentType?: string;
    description: string;
    model?: string;
    prompt: string;
    timestamp: string;
  }

  function assistantLine(call: AgentCallInput, toolUseId: string): string {
    const input: Record<string, string> = { description: call.description, prompt: call.prompt };
    if (call.subagentType !== undefined) input.subagent_type = call.subagentType;
    if (call.model !== undefined) input.model = call.model;
    return JSON.stringify({
      type: 'assistant',
      isSidechain: false,
      timestamp: call.timestamp,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: call.toolName, input }] },
    });
  }

  const CALLS: AgentCallInput[] = [
    {
      toolName: 'Agent',
      subagentType: 'toolkit:code-reviewer',
      description: 'Finder one',
      model: 'haiku',
      prompt: 'Review the pack.\nRead it in ranges.\n',
      timestamp: '2026-01-01T00:00:01.000Z',
    },
    { toolName: 'Agent', description: 'Finder two', prompt: 'Inspect the diff.', timestamp: '2026-01-01T00:00:02.000Z' },
    {
      toolName: 'Task',
      subagentType: 'team/lead reviewer',
      description: 'Legacy call',
      prompt: 'Look at the rest.',
      timestamp: '2026-01-01T00:00:03.000Z',
    },
  ];

  it('writes each prompt as sent under a file name safe on every platform, and lists the calls', () => {
    const root = makeScratchDirectory();
    const transcriptPath = path.join(root, 'session.jsonl');
    fs.writeFileSync(transcriptPath, CALLS.map((call, callIndex) => assistantLine(call, `toolu_${callIndex + 1}`)).join('\n') + '\n');
    // Not an existing folder, and two levels deep, so the create has to be recursive.
    const outDirectory = path.join(root, 'nested', 'prompts');

    const result = runScript(EXTRACT_SCRIPT_PATH, [transcriptPath, outDirectory]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('extracted 3 Agent calls to');
    expect(fs.readdirSync(outDirectory).sort()).toEqual([
      '01-toolkit_code-reviewer.md',
      '02-general-purpose.md',
      '03-team_lead_reviewer.md',
      'index.json',
    ]);
    expect(fs.readFileSync(path.join(outDirectory, '01-toolkit_code-reviewer.md'), 'utf8')).toBe(CALLS[0].prompt);
    expect(fs.readFileSync(path.join(outDirectory, '02-general-purpose.md'), 'utf8')).toBe(CALLS[1].prompt);
    expect(fs.readFileSync(path.join(outDirectory, '03-team_lead_reviewer.md'), 'utf8')).toBe(CALLS[2].prompt);
    expect(JSON.parse(fs.readFileSync(path.join(outDirectory, 'index.json'), 'utf8'))).toEqual([
      {
        index: 1,
        file: '01-toolkit_code-reviewer.md',
        subagentType: 'toolkit:code-reviewer',
        description: 'Finder one',
        model: 'haiku',
        promptChars: CALLS[0].prompt.length,
        timestamp: '2026-01-01T00:00:01.000Z',
      },
      {
        index: 2,
        file: '02-general-purpose.md',
        subagentType: 'general-purpose',
        description: 'Finder two',
        model: null,
        promptChars: CALLS[1].prompt.length,
        timestamp: '2026-01-01T00:00:02.000Z',
      },
      {
        index: 3,
        file: '03-team_lead_reviewer.md',
        subagentType: 'team/lead reviewer',
        description: 'Legacy call',
        model: null,
        promptChars: CALLS[2].prompt.length,
        timestamp: '2026-01-01T00:00:03.000Z',
      },
    ]);
  });

  it('exits 2 with a usage line when the argument count is wrong', () => {
    const result = runScript(EXTRACT_SCRIPT_PATH, ['only-one-argument']);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('usage:');
  });
});

describe('collect-reports.mjs early exits', () => {
  const RUN = { agentId: 'runone', arm: 'A', rep: 1, shard: 1 };

  function writeLedger(root: string, ledger: Record<string, unknown>): string {
    const runsPath = path.join(root, 'runs.json');
    fs.writeFileSync(runsPath, JSON.stringify(ledger));
    return runsPath;
  }

  it('exits 1, names the transcript and writes no key file when a transcript holds no report', () => {
    const root = makeScratchDirectory();
    const transcriptDirectory = path.join(root, 'transcripts');
    fs.mkdirSync(transcriptDirectory);
    // A user line only: no handback and no assistant text to fall back to.
    fs.writeFileSync(
      path.join(transcriptDirectory, 'agent-runone.jsonl'),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Review it.' } }) + '\n',
    );
    const runsPath = writeLedger(root, { transcriptDir: transcriptDirectory, E1: { 'case-a': [RUN] } });
    const outDirectory = path.join(root, 'collected');

    const result = runScript(COLLECT_SCRIPT_PATH, [runsPath, 'E1', 'case-a', outDirectory]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no final report in');
    expect(result.stderr).toContain('agent-runone.jsonl');
    expect(fs.existsSync(`${outDirectory}.key.json`)).toBe(false);
  });

  it('exits 2 and creates nothing when there is no transcriptDir and a run names no transcript', () => {
    const root = makeScratchDirectory();
    const runsPath = writeLedger(root, { E1: { 'case-a': [RUN] } });
    const outDirectory = path.join(root, 'collected');

    const result = runScript(COLLECT_SCRIPT_PATH, [runsPath, 'E1', 'case-a', outDirectory]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('needs "transcriptDir"');
    expect(fs.existsSync(outDirectory)).toBe(false);
    expect(fs.existsSync(`${outDirectory}.key.json`)).toBe(false);
  });

  it('accepts a ledger with no transcriptDir when every run carries its own transcript path', () => {
    const root = makeScratchDirectory();
    const transcriptPath = path.join(root, 'own-transcript.jsonl');
    fs.writeFileSync(transcriptPath, FIXTURE_TEXT);
    const runsPath = writeLedger(root, { E1: { 'case-a': [{ ...RUN, transcript: transcriptPath }] } });
    const outDirectory = path.join(root, 'collected');

    const result = runScript(COLLECT_SCRIPT_PATH, [runsPath, 'E1', 'case-a', outDirectory]);

    expect(result.exitCode).toBe(0);
    expect(fs.readdirSync(outDirectory)).toHaveLength(1);
    expect(fs.existsSync(`${outDirectory}.key.json`)).toBe(true);
  });
});
