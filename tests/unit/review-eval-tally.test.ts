/**
 * Pins scripts/review-eval/tally.mjs, the step that joins a blind scorer's output with the
 * anonymization key and the corpus into the per-arm numbers decide.mjs reads:
 *
 * 1. tallyCase merges every run of one arm and repetition (a case read in shards is several runs)
 *    into one row: hits are a union, so the same defect found by two shards counts once, and the
 *    raised counts add up.
 * 2. A hit is bucketed by its ground-truth class into sorted late, positive and negative lists. A
 *    scorer match that is null, or names an id the case does not carry, lands in no list.
 * 3. A report with no `findings` array still adds its raised count, and a key entry with no score
 *    throws and names its anonymous id instead of counting zero. So does a case id that is not a
 *    state (a typo, or a D case), which would otherwise tally every arm at zero recall.
 * 4. Rows sort by arm, then by the repetition as a number (10 comes after 2), and each row keeps
 *    its `runs` so the command line can price them.
 * 5. The committed corpus.json has the shape tally and prepare.mjs read: ground-truth classes tally
 *    knows, ids that match their state, the tags prepare resolves, and the counted E3 delta cases
 *    decide.mjs names.
 * 6. The command line prices every run of a row through cost.mjs (from --transcript-dir, or from
 *    the run's own transcript path), strips `runs` from the printed rows, and exits 2 with a usage
 *    line when a prices file or the three positional arguments are missing.
 *
 * Hit lists come from the corpus passed in, never from scripts/review-eval/corpus.json, except in
 * the corpus-shape tests and the command line, which read the committed file on purpose. Prices are
 * synthetic round numbers, and the expected dollar amounts are worked out by hand from the
 * transcript fixture (see review-eval-transcripts.test.ts for the token totals).
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tallyCase } from '../../scripts/review-eval/tally.mjs';
import { E3_COUNTED_CASES } from '../../scripts/review-eval/decide.mjs';

const TALLY_SCRIPT_PATH = path.resolve(__dirname, '../../scripts/review-eval/tally.mjs');
const CORPUS_PATH = path.resolve(__dirname, '../../scripts/review-eval/corpus.json');
const FIXTURE_PATH = path.resolve(__dirname, '../fixtures/review-eval-subagent-transcript.jsonl');

interface KeyEntry {
  anonymousId: string;
  arm: string;
  rep: number;
  agentId?: string;
  shard?: number;
  transcript?: string;
}

interface ScoredReport {
  raised: number;
  findings?: Array<{ match: string | null }>;
}

interface TallyRow {
  arm: string;
  rep: number;
  late: string[];
  positive: string[];
  negative: string[];
  raised: number;
  runs: KeyEntry[];
}

function scoresOf(reports: Record<string, ScoredReport>): { reports: Record<string, ScoredReport> } {
  return { reports };
}

function matchesOf(...ids: Array<string | null>): Array<{ match: string | null }> {
  return ids.map((match) => ({ match }));
}

// A small corpus of its own, so the expected lists do not move when the real corpus is edited.
const INLINE_CORPUS = {
  states: [
    {
      id: 'S9',
      groundTruth: [
        { id: 'S9-L1', class: 'late' },
        { id: 'S9-L2', class: 'late' },
        { id: 'S9-P1', class: 'positive' },
        { id: 'S9-N1', class: 'negative' },
      ],
    },
    { id: 'S8', groundTruth: [{ id: 'S8-L1', class: 'late' }] },
  ],
  deltas: [],
};

describe('tallyCase', () => {
  it('merges the runs of one arm and repetition: hits are a union and raised counts add up', () => {
    const key: KeyEntry[] = [
      { anonymousId: 'aaaaaa', arm: 'B', rep: 1, shard: 1 },
      { anonymousId: 'bbbbbb', arm: 'B', rep: 1, shard: 2 },
    ];
    const scores = scoresOf({
      aaaaaa: { raised: 3, findings: matchesOf('S9-L2', 'S9-P1') },
      bbbbbb: { raised: 2, findings: matchesOf('S9-L2', 'S9-N1') },
    });

    const rows: TallyRow[] = tallyCase('S9', scores, key, INLINE_CORPUS);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      arm: 'B',
      rep: 1,
      late: ['S9-L2'],
      positive: ['S9-P1'],
      negative: ['S9-N1'],
      raised: 5,
      runs: key,
    });
  });

  it('keeps the same arm in different repetitions as separate rows with separate hits', () => {
    const key: KeyEntry[] = [
      { anonymousId: 'aaaaaa', arm: 'A', rep: 1 },
      { anonymousId: 'bbbbbb', arm: 'A', rep: 2 },
    ];
    const scores = scoresOf({
      aaaaaa: { raised: 1, findings: matchesOf('S9-L1') },
      bbbbbb: { raised: 1, findings: matchesOf('S9-L2') },
    });

    const rows: TallyRow[] = tallyCase('S9', scores, key, INLINE_CORPUS);

    expect(rows.map((row) => [row.arm, row.rep, row.late])).toEqual([
      ['A', 1, ['S9-L1']],
      ['A', 2, ['S9-L2']],
    ]);
  });

  it('lists the hits of each class in sorted order, whatever order the scorer returned them', () => {
    const key: KeyEntry[] = [{ anonymousId: 'aaaaaa', arm: 'A', rep: 1 }];
    const scores = scoresOf({ aaaaaa: { raised: 4, findings: matchesOf('S9-L2', 'S9-L1', 'S9-N1', 'S9-P1') } });

    const [row]: TallyRow[] = tallyCase('S9', scores, key, INLINE_CORPUS);

    expect(row.late).toEqual(['S9-L1', 'S9-L2']);
    expect(row.positive).toEqual(['S9-P1']);
    expect(row.negative).toEqual(['S9-N1']);
  });

  it('puts a null match, an unknown id and another case\'s id in no list, but still counts them as raised', () => {
    const key: KeyEntry[] = [{ anonymousId: 'aaaaaa', arm: 'A', rep: 1 }];
    const scores = scoresOf({ aaaaaa: { raised: 3, findings: matchesOf(null, 'S9-ZZ', 'S8-L1') } });

    const [row]: TallyRow[] = tallyCase('S9', scores, key, INLINE_CORPUS);

    expect([row.late, row.positive, row.negative]).toEqual([[], [], []]);
    expect(row.raised).toBe(3);
  });

  it('adds the raised count of a report that has no findings array', () => {
    const key: KeyEntry[] = [
      { anonymousId: 'aaaaaa', arm: 'A', rep: 1 },
      { anonymousId: 'bbbbbb', arm: 'A', rep: 1 },
    ];
    const scores = scoresOf({ aaaaaa: { raised: 4 }, bbbbbb: { raised: 2, findings: matchesOf('S9-P1') } });

    const [row]: TallyRow[] = tallyCase('S9', scores, key, INLINE_CORPUS);

    expect(row.raised).toBe(6);
    expect(row.positive).toEqual(['S9-P1']);
  });

  it('throws, naming the anonymous id, when a key entry has no score', () => {
    const key: KeyEntry[] = [
      { anonymousId: 'aaaaaa', arm: 'A', rep: 1 },
      { anonymousId: 'cccccc', arm: 'A', rep: 2 },
    ];
    const scores = scoresOf({ aaaaaa: { raised: 1 } });

    expect(() => tallyCase('S9', scores, key, INLINE_CORPUS)).toThrow('no score for report cccccc');
  });

  it('throws on a case id that is not a state, instead of tallying zero recall', () => {
    const key: KeyEntry[] = [{ anonymousId: 'aaaaaa', arm: 'A', rep: 1 }];
    const scores = scoresOf({ aaaaaa: { raised: 1, findings: matchesOf('S9-L1') } });
    const corpusWithDelta = { ...INLINE_CORPUS, deltas: [{ id: 'D9' }] };

    // A typo of a state id, and a delta id, which tally.mjs does not score.
    expect(() => tallyCase('S09', scores, key, corpusWithDelta)).toThrow('no state S09 in corpus.json');
    expect(() => tallyCase('D9', scores, key, corpusWithDelta)).toThrow('no state D9 in corpus.json');
  });

  it('sorts rows by arm and then by the repetition as a number', () => {
    const key: KeyEntry[] = [
      { anonymousId: 'aaaaaa', arm: 'B', rep: 1 },
      { anonymousId: 'bbbbbb', arm: 'A', rep: 10 },
      { anonymousId: 'cccccc', arm: 'A', rep: 2 },
      { anonymousId: 'dddddd', arm: 'A', rep: 1 },
    ];
    const scores = scoresOf({
      aaaaaa: { raised: 0 },
      bbbbbb: { raised: 0 },
      cccccc: { raised: 0 },
      dddddd: { raised: 0 },
    });

    const rows: TallyRow[] = tallyCase('S9', scores, key, INLINE_CORPUS);

    // A string sort would put 10 before 2.
    expect(rows.map((row) => `${row.arm}${row.rep}`)).toEqual(['A1', 'A2', 'A10', 'B1']);
  });
});

describe('the committed corpus.json', () => {
  interface GroundTruthEntry {
    id: string;
    class: string;
  }
  interface CorpusState {
    id: string;
    tag: string;
    sha: string;
    groundTruth: GroundTruthEntry[];
  }
  interface CorpusDelta {
    id: string;
    tag: string;
    sha: string;
    control?: boolean;
  }
  const corpus: { states: CorpusState[]; deltas: CorpusDelta[]; dropped: Array<{ id: string }> } = JSON.parse(
    fs.readFileSync(CORPUS_PATH, 'utf8'),
  );

  it('gives every ground-truth entry a class tally knows and an id that starts with its state', () => {
    for (const state of corpus.states) {
      expect(state.groundTruth.length).toBeGreaterThan(0);
      for (const entry of state.groundTruth) {
        expect(['late', 'positive', 'negative']).toContain(entry.class);
        expect(entry.id.startsWith(`${state.id}-`)).toBe(true);
      }
    }
  });

  it('has no ground-truth id twice, and none that the dropped list says was removed', () => {
    const groundTruthIds = corpus.states.flatMap((state) => state.groundTruth.map((entry) => entry.id));

    expect(new Set(groundTruthIds).size).toBe(groundTruthIds.length);
    for (const dropped of corpus.dropped) expect(groundTruthIds).not.toContain(dropped.id);
  });

  it('names a local tag and a commit for every state and delta, the two things prepare.mjs resolves', () => {
    for (const entry of [...corpus.states, ...corpus.deltas]) {
      expect(entry.tag).toBe(`review-eval/${entry.id}`);
      expect(entry.sha).toMatch(/^[0-9a-f]{7,40}$/);
    }
  });

  it('carries exactly the delta cases decide.mjs counts for E3, plus one control', () => {
    const countedDeltaIds = corpus.deltas.filter((delta) => delta.control !== true).map((delta) => delta.id);

    expect(countedDeltaIds).toEqual(E3_COUNTED_CASES);
    expect(corpus.deltas.filter((delta) => delta.control === true).map((delta) => delta.id)).toEqual(['D5']);
  });
});

describe('tally.mjs command line', () => {
  const scratchDirectories: string[] = [];

  afterEach(() => {
    for (const scratchDirectory of scratchDirectories.splice(0)) {
      fs.rmSync(scratchDirectory, { recursive: true, force: true });
    }
  });

  interface CommandResult {
    exitCode: number;
    stdout: string;
    stderr: string;
  }

  function runTally(commandArguments: string[]): CommandResult {
    try {
      const stdout = execFileSync('node', [TALLY_SCRIPT_PATH, ...commandArguments], { encoding: 'utf8', stdio: 'pipe' });
      return { exitCode: 0, stdout, stderr: '' };
    } catch (error) {
      const failure = error as { status?: number | null; stdout?: string; stderr?: string };
      return { exitCode: failure.status ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
    }
  }

  // Round prices per million tokens, so the transcript fixture (sonnet 43 / 340 / 350 / 10028 /
  // 163 tokens, haiku 7 / 80 / 0 / 400 / 9) costs 42.7 + 1.812 = 44.512 dollars per run.
  const ROUND_PRICE = { input: 1000, cacheWrite5m: 2000, cacheWrite1h: 3000, cacheRead: 4000, output: 5000 };

  interface CommandFixture {
    root: string;
    transcriptDirectory: string;
    pricesPath: string;
    scoresPath: string;
    keyPath: string;
  }

  /**
   * Three runs over real S1 ground-truth ids: arm B in two shards (run one, run two) and arm A with
   * one run (run three). Run three's transcript is reached by its own path, so the key can also be
   * priced without --transcript-dir.
   */
  function makeCommandFixture(): CommandFixture {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-eval-tally-'));
    scratchDirectories.push(root);
    const transcriptDirectory = path.join(root, 'transcripts');
    fs.mkdirSync(transcriptDirectory);
    const fixtureText = fs.readFileSync(FIXTURE_PATH, 'utf8');
    for (const agentId of ['runone', 'runtwo', 'runthree']) {
      fs.writeFileSync(path.join(transcriptDirectory, `agent-${agentId}.jsonl`), fixtureText);
    }
    const pricesPath = path.join(root, 'prices.json');
    fs.writeFileSync(pricesPath, JSON.stringify({ 'claude-sonnet': ROUND_PRICE, 'claude-haiku': ROUND_PRICE }));
    const scoresPath = path.join(root, 'scores.json');
    fs.writeFileSync(
      scoresPath,
      JSON.stringify({
        reports: {
          aaaaaa: { raised: 3, findings: matchesOf('S1-L1', 'S1-P1', null) },
          bbbbbb: { raised: 2, findings: matchesOf('S1-L1', 'S1-N1') },
          cccccc: { raised: 1, findings: matchesOf('S1-L2') },
        },
      }),
    );
    const keyPath = path.join(root, 'key.json');
    fs.writeFileSync(
      keyPath,
      JSON.stringify([
        { anonymousId: 'aaaaaa', agentId: 'runone', arm: 'B', rep: 1, shard: 1 },
        { anonymousId: 'bbbbbb', agentId: 'runtwo', arm: 'B', rep: 1, shard: 2 },
        {
          anonymousId: 'cccccc',
          agentId: 'runthree',
          arm: 'A',
          rep: 1,
          transcript: path.join(transcriptDirectory, 'agent-runthree.jsonl'),
        },
      ]),
    );
    return { root, transcriptDirectory, pricesPath, scoresPath, keyPath };
  }

  const EXPECTED_ROWS = [
    {
      arm: 'A',
      rep: 1,
      late: ['S1-L2'],
      positive: [],
      negative: [],
      raised: 1,
      finders: 1,
      usd: 44.51,
      advisorCalls: 1,
      requestsAboveTier: 0,
      models: ['claude-haiku-fixture', 'claude-sonnet-5-5'],
    },
    {
      arm: 'B',
      rep: 1,
      late: ['S1-L1'],
      positive: ['S1-P1'],
      negative: ['S1-N1'],
      raised: 5,
      finders: 2,
      usd: 89.02,
      advisorCalls: 2,
      requestsAboveTier: 0,
      models: ['claude-haiku-fixture', 'claude-sonnet-5-5'],
    },
  ];

  it('prices each row from --transcript-dir, strips runs, and prints one row per arm and repetition', () => {
    const fixture = makeCommandFixture();

    const result = runTally(['S1', fixture.scoresPath, fixture.keyPath, '--prices', fixture.pricesPath, '--transcript-dir', fixture.transcriptDirectory]);

    expect(result.exitCode).toBe(0);
    const printed = JSON.parse(result.stdout);
    expect(printed.case).toBe('S1');
    expect(printed.rows).toEqual(EXPECTED_ROWS);
    for (const row of printed.rows) expect(row).not.toHaveProperty('runs');
  });

  it('accepts the flags before the positional arguments and reads each run\'s own transcript path without --transcript-dir', () => {
    const fixture = makeCommandFixture();
    // Only run three names its transcript in the key; give the other two the same, so the key alone
    // is enough.
    const key = JSON.parse(fs.readFileSync(fixture.keyPath, 'utf8')) as Array<{ agentId: string; transcript?: string }>;
    for (const entry of key) entry.transcript = path.join(fixture.transcriptDirectory, `agent-${entry.agentId}.jsonl`);
    fs.writeFileSync(fixture.keyPath, JSON.stringify(key));

    const result = runTally(['--prices', fixture.pricesPath, 'S1', fixture.scoresPath, fixture.keyPath]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).rows).toEqual(EXPECTED_ROWS);
  });

  it('exits 2 with a usage line when --prices is missing', () => {
    const fixture = makeCommandFixture();

    const result = runTally(['S1', fixture.scoresPath, fixture.keyPath]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('usage:');
  });

  it('exits 2 with a usage line when a positional argument is missing', () => {
    const fixture = makeCommandFixture();

    const result = runTally(['S1', fixture.scoresPath, '--prices', fixture.pricesPath]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('usage:');
  });
});
