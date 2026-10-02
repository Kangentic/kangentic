/**
 * What each line of the Knowledge Graph's Index panel says. It reads as the
 * Settings Index card without its switches, from the graph's own summed index
 * summary rather than the Settings status, so these pin the mapping between
 * the two: the same pattern, the same tags, and a source with nothing in it
 * that says so instead of showing a checked 0.
 */
import { describe, expect, it } from 'vitest';
import { buildProgressRow, indexMapLines, indexSourceLines, type IndexSourceLinesInput } from '../../src/renderer/components/knowledge-graph/index-panel-lines';
import { leastBuildProgress } from '../../src/renderer/components/knowledge-graph/use-graph-view';
import type {
  KnowledgeGraphCoverageBucket,
  KnowledgeGraphCoverageSummary,
  KnowledgeGraphIndexCorpus,
  KnowledgeGraphIndexSummary,
  KnowledgeGraphSnapshot,
} from '../../src/shared/types';

function corpus(name: KnowledgeGraphIndexCorpus, documents: number, chunks: number, embeddedChunks: number, embeds = true) {
  return { corpus: name, documents, chunks, embeddedChunks, embeds };
}

function indexOf(overrides: Partial<KnowledgeGraphIndexSummary> = {}): KnowledgeGraphIndexSummary {
  return {
    corpora: [
      corpus('conversation', 1005, 96840, 96840),
      corpus('task', 706, 2400, 2400),
      corpus('change', 900, 1100, 0, false),
      corpus('commit', 2419, 2419, 0, false),
      corpus('code', 1488, 12186, 12186),
    ],
    summaries: { written: 674, finishedTasks: 674, skipped: 0 },
    storageBytes: 412 * 1024 * 1024,
    ...overrides,
  };
}

// The lines render counts through `toLocaleString()`, so grouping follows the
// PROCESS locale ('1,005' reads '1.005' under de-DE). Expected counts ask the
// same runtime for their text rather than hard-coding en-US, so the file passes
// on any developer machine and on CI. Percentages, `MB`, and the words around a
// count are not locale-formatted by the source and stay literal.
const COUNT_FORMAT = new Intl.NumberFormat();

function counted(value: number): string {
  return COUNT_FORMAT.format(value);
}

const NOTHING_WAITS = { summaries: undefined, code: undefined };

function input(overrides: Partial<IndexSourceLinesInput> = {}): IndexSourceLinesInput {
  return {
    index: indexOf(),
    semanticAvailable: true,
    summariesOn: true,
    codeOn: true,
    requirements: NOTHING_WAITS,
    ...overrides,
  };
}

function lineFor(lines: ReturnType<typeof indexSourceLines>, label: string) {
  const line = lines.find((entry) => entry.label === label);
  if (!line) throw new Error(`no line labelled ${label}`);
  return line;
}

function bucket(documents: number): KnowledgeGraphCoverageBucket {
  return { documents, chunks: documents * 10, tone: 'neutral' };
}

function coverageOf(overrides: Partial<KnowledgeGraphCoverageSummary> = {}): KnowledgeGraphCoverageSummary {
  return {
    indexed: bucket(291),
    sourceMissingButSearchable: bucket(714),
    empty: bucket(0),
    failed: bucket(0),
    notYetIndexed: bucket(0),
    totalDocumentsWithChunks: 1005,
    totalChunks: 96840,
    totalEmbeddedChunks: 96840,
    embeddedFraction: 1,
    knownDocumentIdsMatched: 0,
    ...overrides,
  };
}

describe('the source lines', () => {
  it('are the Settings card\'s five, in its order, with no line for session changes', () => {
    expect(indexSourceLines(input()).map((line) => line.label))
      .toEqual(['Conversations', 'Tasks', 'Commits', 'Task summaries', 'Source code']);
  });

  it('are each count with a check once caught up', () => {
    const lines = indexSourceLines(input());
    expect(lineFor(lines, 'Conversations')).toMatchObject({ value: counted(1005), tone: 'ready' });
    expect(lineFor(lines, 'Commits')).toMatchObject({ value: counted(2419), tone: 'ready' });
    expect(lineFor(lines, 'Task summaries')).toMatchObject({ value: counted(674), tone: 'ready' });
    expect(lineFor(lines, 'Source code')).toMatchObject({ value: `${counted(1488)} files`, tone: 'ready' });
  });

  it('show a share with a track and no time left while embedding, since the summary carries no rate', () => {
    const index = indexOf({ corpora: [corpus('conversation', 1005, 1000, 405), corpus('code', 1488, 12186, 4874)] });
    const lines = indexSourceLines(input({ index }));
    expect(lineFor(lines, 'Conversations')).toMatchObject({ value: '40%', percent: 40 });
    expect(lineFor(lines, 'Source code')).toMatchObject({ value: '39%', percent: 39 });
  });

  it('never read 100% while a passage still waits', () => {
    const index = indexOf({ corpora: [corpus('conversation', 10, 1000, 999)] });
    expect(lineFor(indexSourceLines(input({ index })), 'Conversations')).toMatchObject({ value: '99%', percent: 99 });
  });

  it('show no share with the Knowledge Graph off, only the count', () => {
    const index = indexOf({ corpora: [corpus('conversation', 1005, 1000, 405)] });
    expect(lineFor(indexSourceLines(input({ index, semanticAvailable: false })), 'Conversations'))
      .toMatchObject({ value: counted(1005), tone: 'ready' });
  });

  it('say Not yet indexed for a source with nothing in it, never a checked 0', () => {
    const index = indexOf({ corpora: [corpus('conversation', 0, 0, 0), corpus('task', 0, 0, 0), corpus('commit', 0, 0, 0, false), corpus('code', 0, 0, 0)] });
    const lines = indexSourceLines(input({ index }));
    for (const label of ['Conversations', 'Tasks', 'Commits', 'Source code']) {
      expect(lineFor(lines, label), label).toMatchObject({ value: 'Not yet indexed', tone: 'muted' });
    }
  });

  it('read a corpus the summary does not list at all as not yet indexed', () => {
    const index = indexOf({ corpora: [] });
    expect(lineFor(indexSourceLines(input({ index })), 'Tasks')).toMatchObject({ value: 'Not yet indexed', tone: 'muted' });
  });

  it('say Off for source code switched off with nothing held', () => {
    const index = indexOf({ corpora: [corpus('code', 0, 0, 0)] });
    expect(lineFor(indexSourceLines(input({ index, codeOn: false })), 'Source code')).toEqual(expect.objectContaining({ value: 'Off', tone: 'muted' }));
  });

  it('put the waiting tag in place of the value, the one the Settings card shows', () => {
    const lines = indexSourceLines(input({ requirements: { summaries: 'Needs a supported agent', code: 'Needs an agent' } }));
    expect(lineFor(lines, 'Task summaries')).toMatchObject({ requirement: 'Needs a supported agent' });
    expect(lineFor(lines, 'Task summaries').value).toBeUndefined();
    expect(lineFor(lines, 'Source code')).toMatchObject({ requirement: 'Needs an agent' });
  });

  it('read the summaries share while some are still to write', () => {
    const index = indexOf({ summaries: { written: 300, finishedTasks: 412, skipped: 0 } });
    expect(lineFor(indexSourceLines(input({ index })), 'Task summaries')).toMatchObject({ value: '72%', percent: 72 });
  });

  it('say how many were skipped once the pass has passed over the rest', () => {
    const index = indexOf({ summaries: { written: 410, finishedTasks: 412, skipped: 2 } });
    expect(lineFor(indexSourceLines(input({ index })), 'Task summaries')).toMatchObject({ value: `${counted(410)} of ${counted(412)}, ${counted(2)} skipped` });
  });

  it('keep the summaries already written with a check when switched off', () => {
    expect(lineFor(indexSourceLines(input({ summariesOn: false })), 'Task summaries')).toMatchObject({ value: counted(674), tone: 'ready' });
  });

  it('carry the info texts and test ids the panel spec reads', () => {
    const lines = indexSourceLines(input());
    expect(lineFor(lines, 'Task summaries').info).toMatch(/Done task/);
    expect(lineFor(lines, 'Source code').info).toMatch(/default branch/);
    expect(lines.map((line) => line.testId)).toEqual([
      'knowledge-graph-index-source-conversations',
      'knowledge-graph-index-source-tasks',
      'knowledge-graph-index-source-commits',
      'knowledge-graph-index-source-summaries',
      'knowledge-graph-index-source-code',
    ]);
  });
});

describe('the map lines', () => {
  it('count the links, then what the index holds beyond the sources', () => {
    const lines = indexMapLines({ edgeCount: 3438, coverage: coverageOf(), storageBytes: 412 * 1024 * 1024 });
    expect(lines.map((line) => [line.label, line.value])).toEqual([
      ['Links', counted(3438)],
      ['Transcript gone', counted(714)],
      ['Size on disk', '412 MB'],
    ]);
    expect(lines[0].info).toMatch(/exact/);
  });

  it('show the not-yet-indexed and failed counts only when there are some, and a failure as a problem', () => {
    const quiet = indexMapLines({ edgeCount: 1, coverage: coverageOf({ sourceMissingButSearchable: bucket(0) }), storageBytes: 0 });
    expect(quiet.map((line) => line.label)).toEqual(['Links']);

    const lines = indexMapLines({
      edgeCount: 1,
      coverage: coverageOf({ notYetIndexed: bucket(12), failed: bucket(3) }),
      storageBytes: 0,
    });
    expect(lines.find((line) => line.label === 'Not yet indexed')).toMatchObject({ value: counted(12) });
    expect(lines.find((line) => line.label === 'Failed to index')).toMatchObject({ tone: 'caution', problem: counted(3) });
  });
});

describe('the building card\'s progress row', () => {
  it('names what the first build is doing, with its percent', () => {
    expect(buildProgressRow({ pass: 1, stage: 'reading', percent: 41 })).toEqual({ label: 'Reading conversations', value: '41%', percent: 41 });
    expect(buildProgressRow({ pass: 1, stage: 'placing', percent: 96 })).toEqual({ label: 'Placing conversations', value: '96%', percent: 96 });
    expect(buildProgressRow({ pass: 1, stage: 'naming', percent: 99 })).toEqual({ label: 'Naming regions', value: '99%', percent: 99 });
  });

  it('reads as just begun before the first figure arrives, and never as 100', () => {
    expect(buildProgressRow(null)).toEqual({ label: 'Reading conversations', value: '0%', percent: 0 });
    expect(buildProgressRow({ pass: 1, stage: 'naming', percent: 140 }).value).toBe('99%');
  });
});

describe('a scope\'s first build progress', () => {
  function building(percent: number | null): KnowledgeGraphSnapshot {
    return {
      projectId: `project-${percent}`,
      projection: null,
      coverage: coverageOf(),
      index: indexOf(),
      building: true,
      buildProgress: percent === null ? null : { pass: 1, stage: 'reading', percent },
      stale: false,
      semanticAvailable: true,
    };
  }

  it('is the least advanced project\'s, so the bar never says more than the slowest map has done', () => {
    expect(leastBuildProgress([building(70), building(30), building(55)])?.percent).toBe(30);
  });

  it('reads as just begun while any project building has sent no figure', () => {
    expect(leastBuildProgress([building(70), building(null)])).toBeNull();
  });

  it('ignores a project with a map or none building', () => {
    const drawn = { ...building(10), projection: {} as never };
    const idle = { ...building(5), building: false };
    expect(leastBuildProgress([drawn, idle, building(80)])?.percent).toBe(80);
  });
});
