/**
 * Pins scripts/measure-docs-structure.mjs, the no-quota half of the second docs round (task 889):
 *
 * 1. changedLines reads a zero-context diff's new-side lines, and counts a pure deletion where it sits.
 * 2. headingPathsByLine and conceptForHeadingPath map a flat file's line to the concept that holds its
 *    section now, by heading text, using the concept's H1 to tell repeated headings apart.
 * 3. driftCase scores what `sources:` predicted against what a commit touched, and whether the old
 *    flat sync-docs row would have named the file at all.
 * 4. chunkRanges recovers each passage's character range, so a flat passage maps to its sections.
 * 5. bm25, firstRelevantRank and rankScores rank and score the way the report reads.
 * 6. parseArgs reads the command line (its defaults, a malformed --flat, a normalized --concepts).
 * 7. loadConcepts reads a real concept folder, and preambleConceptOf, conceptAtLine and
 *    touchedConceptsOf turn a flat file's changed lines into the concepts that hold them.
 * 8. The second-round question set is checked against the docs it points at: every `expect` pattern
 *    must match the text of at least one of the question's gold files, or no answer could pass.
 *    (The question file is found by its suffix, not named: the on-demand guard for the docs-reads
 *    harness lets no test but the harness's own mention that harness's name.)
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  FLAT_AUTHORITY,
  bm25,
  changedLines,
  chunkRanges,
  conceptAtLine,
  conceptForHeadingPath,
  driftCase,
  firstRelevantRank,
  headingPathsByLine,
  loadConcepts,
  parseArgs,
  preambleConceptOf,
  rankScores,
  touchedConceptsOf,
} from '../../scripts/measure-docs-structure.mjs';

const ROOT = path.resolve(__dirname, '../..');

describe('changedLines', () => {
  it('lists every new-side line of each hunk, and the position of a pure deletion', () => {
    const diff = [
      'diff --git a/docs/x.md b/docs/x.md',
      '@@ -3 +3 @@',
      '@@ -10,2 +10,3 @@',
      '@@ -20,4 +21,0 @@',
    ].join('\n');
    expect(changedLines(diff)).toEqual([3, 10, 11, 12, 21]);
  });

  it('counts a deletion at the top of the file as line 1', () => {
    expect(changedLines('@@ -1,2 +0,0 @@')).toEqual([1]);
  });
});

describe('mapping a flat file\'s lines to concepts', () => {
  const flat = [
    '# Agent Integration',
    'Intro.',
    '## Codex CLI',
    '### Permission Modes',
    'codex modes',
    '## Gemini CLI',
    '### Permission Modes',
    'gemini modes',
    '## Supported Agents',
    'table',
  ].join('\n');
  const concepts = [
    { path: 'docs/a/codex-cli.md', h1: 'Codex CLI', headings: new Set(['Codex CLI', 'Permission Modes']) },
    { path: 'docs/a/gemini-cli.md', h1: 'Gemini CLI', headings: new Set(['Gemini CLI', 'Permission Modes']) },
    { path: 'docs/a/adapter-interface.md', h1: 'Agent adapter interface', headings: new Set(['Agent adapter interface', 'Supported Agents']) },
  ];

  it('gives each line the H2-and-deeper heading path above it, a heading line its own section', () => {
    const paths = headingPathsByLine(flat);
    expect(paths[2]).toEqual([]);
    // A changed heading line belongs to the section it opens, not the one before it.
    expect(paths[3]).toEqual(['Codex CLI']);
    expect(paths[4]).toEqual(['Codex CLI', 'Permission Modes']);
    expect(paths[6]).toEqual(['Gemini CLI']);
    expect(paths[5]).toEqual(['Codex CLI', 'Permission Modes']);
    expect(paths[8]).toEqual(['Gemini CLI', 'Permission Modes']);
    expect(paths[10]).toEqual(['Supported Agents']);
  });

  it('tells a repeated heading apart by the concept whose H1 is the path\'s top heading', () => {
    expect(conceptForHeadingPath(['Codex CLI', 'Permission Modes'], concepts, null)).toBe('docs/a/codex-cli.md');
    expect(conceptForHeadingPath(['Gemini CLI', 'Permission Modes'], concepts, null)).toBe('docs/a/gemini-cli.md');
    expect(conceptForHeadingPath(['Supported Agents'], concepts, null)).toBe('docs/a/adapter-interface.md');
  });

  it('sends the preamble to the preamble concept, and a heading no concept has to nothing', () => {
    expect(conceptForHeadingPath([], concepts, 'docs/a/adapter-interface.md')).toBe('docs/a/adapter-interface.md');
    expect(conceptForHeadingPath(['Removed Section'], concepts, null)).toBeNull();
  });
});

describe('driftCase', () => {
  const concepts = [
    { path: 'docs/a/codex-cli.md', bytes: 100, frontmatter: { sources: [{ resource: 'src/main/agent/adapters/codex/' }] } },
    { path: 'docs/a/adapter-types.md', bytes: 400, frontmatter: { sources: [{ resource: 'src/main/agent/adapters/' }] } },
  ];

  it('scores recall against the touched concepts and sums the predicted concepts\' bytes', () => {
    const result = driftCase({ sourceFiles: ['src/main/agent/adapters/codex/command-builder.ts'], touchedConcepts: new Set(['docs/a/codex-cli.md']), concepts });
    expect(result.recall).toBe(1);
    expect(result.predicted.sort()).toEqual(['docs/a/adapter-types.md', 'docs/a/codex-cli.md']);
    expect(result.predictedBytes).toBe(500);
    expect(result.flatFlagged).toBe(true);
  });

  it('reports a miss, and that the flat row would not have named the file either', () => {
    const result = driftCase({ sourceFiles: ['src/main/pty/session-manager.ts'], touchedConcepts: new Set(['docs/a/codex-cli.md']), concepts });
    expect(result.recall).toBe(0);
    expect(result.predicted).toEqual([]);
    expect(result.flatFlagged).toBe(false);
  });

  it('scores two touched concepts with one predicted as recall 0.5, dividing by the touched concepts', () => {
    // Only the Codex concept lists the file, so one concept is predicted and two are touched. A recall
    // divided by the predicted count would read 1 here.
    const codexOnly = [concepts[0]];
    const result = driftCase({
      sourceFiles: ['src/main/agent/adapters/codex/command-builder.ts'],
      touchedConcepts: new Set(['docs/a/codex-cli.md', 'docs/a/gemini-cli.md']),
      concepts: codexOnly,
    });
    expect(result.predicted).toEqual(['docs/a/codex-cli.md']);
    expect(result.hits).toBe(1);
    expect(result.recall).toBe(0.5);
    expect(result.touched.sort()).toEqual(['docs/a/codex-cli.md', 'docs/a/gemini-cli.md']);
  });

  it('has no recall, not a zero or NaN one, when the commit touched no concept', () => {
    const result = driftCase({ sourceFiles: ['src/main/agent/adapters/codex/command-builder.ts'], touchedConcepts: new Set(), concepts });
    expect(result.hits).toBe(0);
    expect(result.recall).toBeNull();
  });

  it('lists a predicted concept, and counts its bytes, once when two source files map to it', () => {
    const result = driftCase({
      sourceFiles: ['src/main/agent/adapters/codex/command-builder.ts', 'src/main/agent/adapters/codex/session-history.ts'],
      touchedConcepts: new Set(['docs/a/codex-cli.md']),
      concepts,
    });
    expect(result.predicted.sort()).toEqual(['docs/a/adapter-types.md', 'docs/a/codex-cli.md']);
    expect(result.predictedBytes).toBe(500);
  });

  describe('flatFlagged, the old sync-docs row that pointed these files at the flat agent doc', () => {
    // One file per FLAT_AUTHORITY pattern. The patterns are disjoint, so dropping any one of them
    // turns its own case red.
    const flaggedFiles: Array<[string, string]> = [
      ['agent-adapter.ts', 'src/main/agent/agent-adapter.ts'],
      ['agent-registry.ts', 'src/main/agent/agent-registry.ts'],
      ['a file under adapters/', 'src/main/agent/adapters/claude/command-builder.ts'],
      ['agent-resolver.ts', 'src/main/transition-engine/agent-resolver.ts'],
    ];
    const flaggedFor = (file: string): boolean => driftCase({ sourceFiles: [file], touchedConcepts: new Set(), concepts: [] }).flatFlagged;

    it.each(flaggedFiles)('flags %s', (_label, file) => {
      expect(flaggedFor(file)).toBe(true);
    });

    it('has a flagged file above for every FLAT_AUTHORITY pattern', () => {
      for (const pattern of FLAT_AUTHORITY as RegExp[]) {
        expect(flaggedFiles.some(([, file]) => pattern.test(file)), String(pattern)).toBe(true);
      }
    });

    it.each([
      'src/main/pty/session-manager.ts',
      'src/main/agent/shared/exec-version.ts',
      'src/main/agent/agent-adapter.test.ts',
      'src/main/agent/agent-registry.ts.bak',
      'vendor/src/main/agent/agent-registry.ts',
      'src/main/agent/adapters.ts',
      'src/main/transition-engine/agent-resolver-cache.ts',
    ])('does not flag %s', (file) => {
      expect(flaggedFor(file)).toBe(false);
    });
  });
});

describe('chunkRanges', () => {
  it('recovers each passage body\'s character range from the chunk texts', () => {
    const chunks = [{ text: 'docs/x.md\n\nfirst body\n' }, { text: 'docs/x.md\n\nsecond\n' }];
    expect(chunkRanges(chunks, 'docs/x.md')).toEqual([{ start: 0, end: 11 }, { start: 11, end: 18 }]);
  });

  it('throws on a chunk cut under another header, such as the path plus a frontmatter description', () => {
    // codeChunks puts a concept's description on the line after the path, so the chunk does not start
    // with `<header>` and a blank line, and every offset computed after it would be wrong.
    const describedChunk = { text: 'docs/x.md\nWhat this concept holds\n\nfirst body\n' };
    expect(() => chunkRanges([describedChunk], 'docs/x.md')).toThrow(/does not start with its header/);
    expect(() => chunkRanges([{ text: 'docs/x.md\n\nfirst body\n' }, describedChunk], 'docs/x.md')).toThrow(/does not start with its header/);
  });
});

describe('ranking', () => {
  it('ranks a passage holding the query\'s rarer terms above one that does not', () => {
    const score = bm25(['the codex sandbox flags', 'the gemini settings file', 'the the the']);
    const scores = score('codex sandbox');
    expect(scores[0]).toBeGreaterThan(scores[1]);
    expect(scores[0]).toBeGreaterThan(scores[2]);
  });

  it('finds the first relevant rank, breaking ties by passage order, and null when none is relevant', () => {
    expect(firstRelevantRank([0.2, 0.9, 0.5], [true, false, false])).toBe(3);
    expect(firstRelevantRank([0.5, 0.5], [false, true])).toBe(2);
    expect(firstRelevantRank([0.5, 0.5], [false, false])).toBeNull();
  });

  it('scores MRR@10 and recall@5, counting a rank past the cutoff and a miss as zero', () => {
    expect(rankScores([1, 2, 11, null])).toEqual({ mrr: (1 + 0.5) / 4, recall5: 2 / 4 });
  });

  it('has no MRR or recall for an empty question set, not NaN', () => {
    expect(rankScores([])).toEqual({ mrr: null, recall5: null });
  });

  it('has no first relevant rank when there are no passages at all', () => {
    expect(firstRelevantRank([], [])).toBeNull();
  });

  it('ranks by file order when every score is 0, and keeps a zero-score passage behind the scored ones', () => {
    // BM25 scores every passage 0 when none shares a term with the question. The BM25 numbers in
    // docs/log.md were measured with those passages still ranked, in file order.
    expect(firstRelevantRank([0, 0, 0, 0], [false, false, true, false])).toBe(3);
    expect(firstRelevantRank([0, 0, 0, 0], [false, true, true, false])).toBe(2);
    // A positive score outranks every zero, and the zeros then follow in file order.
    expect(firstRelevantRank([0, 0.3, 0], [true, false, false])).toBe(2);
    expect(firstRelevantRank([0, 0.3, 0], [false, false, true])).toBe(3);
  });
});

describe('conceptForHeadingPath with a heading more than one concept has', () => {
  it('falls through to a shallower heading only one concept has when the deepest is shared and no H1 matches', () => {
    // 'Shared child' is in both concepts and neither H1 is the path's top heading, so the deepest
    // heading cannot decide it. 'Only here' can. The first holder is listed ahead of the right one,
    // so taking the first holder of an ambiguous heading is wrong here.
    const concepts = [
      { path: 'docs/a/first.md', h1: 'First page', headings: new Set(['First page', 'Shared child']) },
      { path: 'docs/a/second.md', h1: 'Second page', headings: new Set(['Second page', 'Shared child', 'Only here']) },
    ];
    expect(conceptForHeadingPath(['Only here', 'Shared child'], concepts, null)).toBe('docs/a/second.md');
  });

  it('gives no concept when two concepts share the path\'s top heading as their H1', () => {
    const twins = [
      { path: 'docs/a/twin-one.md', h1: 'Twin', headings: new Set(['Twin', 'Shared child']) },
      { path: 'docs/a/twin-two.md', h1: 'Twin', headings: new Set(['Twin', 'Shared child']) },
    ];
    expect(conceptForHeadingPath(['Twin', 'Shared child'], twins, null)).toBeNull();
  });

  it('lets a heading only one concept has win over a shared parent heading that another concept titles', () => {
    // 'Shared parent' alone would pick `titled.md` by its H1. The deeper, unique 'Unique child' says
    // the section is `owner.md`'s, and it is checked first.
    const concepts = [
      { path: 'docs/a/owner.md', h1: 'Owner page', headings: new Set(['Owner page', 'Shared parent', 'Unique child']) },
      { path: 'docs/a/titled.md', h1: 'Shared parent', headings: new Set(['Shared parent']) },
    ];
    expect(conceptForHeadingPath(['Shared parent', 'Unique child'], concepts, null)).toBe('docs/a/owner.md');
    expect(conceptForHeadingPath(['Shared parent'], concepts, null)).toBe('docs/a/titled.md');
  });
});

describe('conceptAtLine', () => {
  const flat = ['# Agent Integration', 'Intro.', '## Codex CLI', 'codex', '## Gemini CLI', 'gemini'].join('\n');
  const preambleConcept = 'docs/a/adapter-interface.md';
  const concepts = [
    { path: 'docs/a/codex-cli.md', h1: 'Codex CLI', headings: new Set(['Codex CLI']) },
    { path: 'docs/a/gemini-cli.md', h1: 'Gemini CLI', headings: new Set(['Gemini CLI']) },
    { path: preambleConcept, h1: 'Agent adapter interface', headings: new Set(['Agent adapter interface']) },
  ];

  it('maps a line past the end of the text to the last slot, the section the text ends in', () => {
    const pathsByLine = headingPathsByLine(flat);
    expect(conceptAtLine(pathsByLine, 6, concepts, preambleConcept)).toBe('docs/a/gemini-cli.md');
    // Without the clamp this index is undefined, which reads as "no H2 above" and maps to the preamble.
    expect(conceptAtLine(pathsByLine, 50, concepts, preambleConcept)).toBe('docs/a/gemini-cli.md');
  });

  it('maps a line with no H2 above it to the preamble concept', () => {
    const pathsByLine = headingPathsByLine(flat);
    expect(conceptAtLine(pathsByLine, 1, concepts, preambleConcept)).toBe(preambleConcept);
    expect(conceptAtLine(pathsByLine, 2, concepts, preambleConcept)).toBe(preambleConcept);
    expect(conceptAtLine(pathsByLine, 4, concepts, preambleConcept)).toBe('docs/a/codex-cli.md');
  });
});

describe('touchedConceptsOf', () => {
  const text = ['# Agent Integration', 'Intro.', '## Codex CLI', 'codex a', 'codex b', '## Removed Section', 'gone'].join('\n');
  const preambleConcept = 'docs/a/adapter-interface.md';
  const concepts = [{ path: 'docs/a/codex-cli.md', h1: 'Codex CLI', headings: new Set(['Codex CLI']) }];

  it('counts one touched concept and two mapped lines for two changed lines under one section', () => {
    const result = touchedConceptsOf({ diffText: '@@ -4 +4 @@\n@@ -5 +5 @@', text, concepts, preambleConcept });
    expect(result).toEqual({ touched: new Set(['docs/a/codex-cli.md']), mappedLines: 2, unmappedLines: 0 });
  });

  it('counts a changed line under a heading no concept holds as unmapped, and leaves it out of the touched set', () => {
    const result = touchedConceptsOf({ diffText: '@@ -4 +4 @@\n@@ -7 +7 @@', text, concepts, preambleConcept });
    expect(result).toEqual({ touched: new Set(['docs/a/codex-cli.md']), mappedLines: 1, unmappedLines: 1 });
    expect(touchedConceptsOf({ diffText: '@@ -7 +7 @@', text, concepts, preambleConcept }))
      .toEqual({ touched: new Set(), mappedLines: 0, unmappedLines: 1 });
  });

  it('counts a changed line above the first H2 against the preamble concept', () => {
    const result = touchedConceptsOf({ diffText: '@@ -2 +2 @@', text, concepts, preambleConcept });
    expect(result).toEqual({ touched: new Set([preambleConcept]), mappedLines: 1, unmappedLines: 0 });
  });
});

describe('parseArgs', () => {
  it('defaults to the agent doc before the split, the agents folder, its adapter-interface preamble and cpu', () => {
    expect(parseArgs(['drift'])).toEqual({
      mode: 'drift',
      before: '492f0c474',
      source: 'docs/agent-integration.md',
      concepts: 'docs/integrations/agents',
      preamble: 'adapter-interface.md',
      questions: null,
      device: 'cpu',
      verbose: false,
    });
  });

  it('reads each flag it is given, splitting --flat at its first colon', () => {
    expect(parseArgs([
      'retrieval', '--questions', 'questions.json', '--flat', 'abc123:docs/flat.md', '--concepts', 'docs/other',
      '--preamble', 'intro.md', '--device', 'dml', '--verbose',
    ])).toEqual({
      mode: 'retrieval',
      before: 'abc123',
      source: 'docs/flat.md',
      concepts: 'docs/other',
      preamble: 'intro.md',
      questions: 'questions.json',
      device: 'dml',
      verbose: true,
    });
  });

  it('keeps the default of a flag that is the last argument and has no value', () => {
    expect(parseArgs(['drift', '--device']).device).toBe('cpu');
    expect(parseArgs(['drift', '--flat']).before).toBe('492f0c474');
  });

  it('sets verbose only when --verbose is given', () => {
    expect(parseArgs(['drift']).verbose).toBe(false);
    expect(parseArgs(['drift', '--verbose']).verbose).toBe(true);
  });

  it.each(['abc', ':x', 'x:'])('rejects --flat %s, which is not <commit>:<path>', (flat) => {
    expect(() => parseArgs(['drift', '--flat', flat])).toThrow(/--flat/);
  });

  it('normalizes --concepts typed with Windows separators or a trailing slash to a forward-slash folder', () => {
    expect(parseArgs(['drift', '--concepts', 'docs\\integrations\\agents\\']).concepts).toBe('docs/integrations/agents');
    expect(parseArgs(['drift', '--concepts', 'docs/integrations/agents/']).concepts).toBe('docs/integrations/agents');
  });
});

describe('loadConcepts', () => {
  const agentsFolder = 'docs/integrations/agents';

  it('lists the folder\'s concepts as forward-slash paths under it, each with an H1 and its heading texts', () => {
    const concepts = loadConcepts(agentsFolder);
    const paths = concepts.map((concept: { path: string }) => concept.path);
    // Not vacuous: the folder holds the Claude Code concept, so an empty list cannot pass.
    expect(paths).toContain(`${agentsFolder}/claude-code.md`);
    for (const concept of concepts) {
      expect(concept.path.startsWith(`${agentsFolder}/`), concept.path).toBe(true);
      expect(typeof concept.h1, `${concept.path} has an H1`).toBe('string');
      expect(concept.headings.size, `${concept.path} has headings`).toBeGreaterThan(0);
      // The H1 is one of the concept's own headings, so a flat file's H2 of that text maps to it.
      expect(concept.headings.has(concept.h1), concept.path).toBe(true);
    }
  });

  it('leaves out index.md and log.md', () => {
    // Both exist, so a missing filter shows. The agents folder has an index.md; docs/ has both.
    expect(fs.existsSync(path.join(ROOT, agentsFolder, 'index.md'))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'docs', 'index.md'))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'docs', 'log.md'))).toBe(true);
    const agentPaths = loadConcepts(agentsFolder).map((concept: { path: string }) => concept.path);
    expect(agentPaths).not.toContain(`${agentsFolder}/index.md`);
    const docsPaths = loadConcepts('docs').map((concept: { path: string }) => concept.path);
    expect(docsPaths).not.toContain('docs/index.md');
    expect(docsPaths).not.toContain('docs/log.md');
    expect(docsPaths).toContain('docs/README.md');
  });
});

describe('preambleConceptOf', () => {
  const concepts = [
    { path: 'docs/a/codex-cli.md' },
    { path: 'docs/a/adapter-interface.md' },
  ];

  it('finds a concept by its file name and returns its path', () => {
    expect(preambleConceptOf(concepts, 'adapter-interface.md')).toBe('docs/a/adapter-interface.md');
  });

  it('throws naming --preamble for a file name no concept has, including a mere suffix of one', () => {
    expect(() => preambleConceptOf(concepts, 'no-such-concept.md')).toThrow(/--preamble/);
    expect(() => preambleConceptOf(concepts, 'interface.md')).toThrow(/--preamble/);
  });

  it('resolves the default --preamble to a real concept in the default --concepts folder', () => {
    const { concepts: folder, preamble } = parseArgs(['drift']);
    expect(preambleConceptOf(loadConcepts(folder), preamble)).toBe('docs/integrations/agents/adapter-interface.md');
  });
});

describe('the second-round question set', () => {
  interface RecordedQuestion {
    id: string;
    question: string;
    expect: string[];
    gold: string[];
  }

  /** The patterns that match none of `texts`, graded as a question's `expect` is: a case-insensitive regex. */
  function unmatchedPatterns(patterns: string[], texts: string[]): string[] {
    return patterns.filter((pattern) => !texts.some((text) => new RegExp(pattern, 'i').test(text)));
  }

  /**
   * The questions of the second-round file, found by its suffix and not by name: the on-demand guard
   * (eval-harness-on-demand-only.test.ts) allows no test but the harness's own to name that file.
   */
  function secondRoundQuestions(): RecordedQuestion[] {
    const scriptsFolder = path.join(ROOT, 'scripts');
    const files = fs.readdirSync(scriptsFolder).filter((name) => name.endsWith('-questions-v2.json'));
    expect(files).toHaveLength(1);
    const parsed = JSON.parse(fs.readFileSync(path.join(scriptsFolder, files[0]), 'utf8')) as { questions: RecordedQuestion[] };
    return parsed.questions;
  }

  it('finds the patterns no text matches, ignoring case, and none when each pattern matches some text', () => {
    expect(unmatchedPatterns(['WINDOWS', 'quo(t|te)', 'absent-term'], ['a windows quote', 'other text'])).toEqual(['absent-term']);
    expect(unmatchedPatterns(['a|b'], ['b'])).toEqual([]);
    expect(unmatchedPatterns(['anything'], [])).toEqual(['anything']);
  });

  it('holds questions that each name an expect pattern and a gold file', () => {
    const questions = secondRoundQuestions();
    expect(questions.length).toBeGreaterThan(0);
    for (const question of questions) {
      expect(question.expect.length, `${question.id} has an expect pattern`).toBeGreaterThan(0);
      expect(question.gold.length, `${question.id} has a gold file`).toBeGreaterThan(0);
    }
  });

  it('has every expect pattern match the text of at least one of the question\'s gold files', () => {
    const unmatched: string[] = [];
    for (const question of secondRoundQuestions()) {
      const goldTexts = question.gold.map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8'));
      for (const pattern of unmatchedPatterns(question.expect, goldTexts)) unmatched.push(`${question.id}: ${pattern}`);
    }
    expect(unmatched, 'a pattern no gold file can satisfy makes the question unanswerable').toEqual([]);
  });
});
