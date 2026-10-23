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
 */
import { describe, it, expect } from 'vitest';
import {
  bm25,
  changedLines,
  chunkRanges,
  conceptForHeadingPath,
  driftCase,
  firstRelevantRank,
  headingPathsByLine,
  rankScores,
} from '../../scripts/measure-docs-structure.mjs';

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
});

describe('chunkRanges', () => {
  it('recovers each passage body\'s character range from the chunk texts', () => {
    const chunks = [{ text: 'docs/x.md\n\nfirst body\n' }, { text: 'docs/x.md\n\nsecond\n' }];
    expect(chunkRanges(chunks, 'docs/x.md')).toEqual([{ start: 0, end: 11 }, { start: 11, end: 18 }]);
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
});
