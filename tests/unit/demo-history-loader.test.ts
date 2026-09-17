/**
 * loadDemoHistory (tests/captures/helpers/demo-scrollback.ts) reads every fixture under
 * <fixturesDir>/history/, keys the result by each fixture's own `project` field rather than the
 * file name, and throws when a fixture carries no commits. This pins that contract against a
 * temporary fixtures directory instead of the real 39MB fixture set.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadDemoHistory } from '../../tests/captures/helpers/demo-scrollback';
import type { DemoHistory } from '../../tests/captures/helpers/demo-dataset';

let temporaryFixturesDir: string | undefined;

function createTemporaryFixturesDir(): string {
  temporaryFixturesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-history-loader-'));
  return temporaryFixturesDir;
}

function writeHistoryFixture(fixturesDir: string, fileName: string, history: DemoHistory): void {
  const historyDir = path.join(fixturesDir, 'history');
  fs.mkdirSync(historyDir, { recursive: true });
  fs.writeFileSync(path.join(historyDir, fileName), JSON.stringify(history));
}

function buildSampleHistory(overrides: Partial<DemoHistory> = {}): DemoHistory {
  return {
    project: 'sample-project',
    branch: 'main',
    tipHash: 'a1b2c3d4e5f6',
    commits: [
      {
        hash: 'a1b2c3d4e5f6',
        shortHash: 'a1b2c3d',
        parents: [],
        authorName: 'Sample Author',
        authorTimestamp: '2026-01-01T00:00:00.000Z',
        subject: 'Initial commit',
      },
    ],
    diffs: {
      a1b2c3d4e5f6: { files: [], totalInsertions: 0, totalDeletions: 0 },
    },
    blame: {},
    ...overrides,
  };
}

afterEach(() => {
  if (temporaryFixturesDir) fs.rmSync(temporaryFixturesDir, { recursive: true, force: true });
  temporaryFixturesDir = undefined;
});

describe('loadDemoHistory', () => {
  it('keys a fixture by its own project field, passing every field through unchanged', () => {
    const fixturesDir = createTemporaryFixturesDir();
    const sampleHistory = buildSampleHistory();
    writeHistoryFixture(fixturesDir, 'anything.json', sampleHistory);

    const histories = loadDemoHistory(fixturesDir);

    expect(Object.keys(histories)).toEqual(['sample-project']);
    expect(histories['sample-project']).toEqual(sampleHistory);
  });

  it('throws when a fixture carries no commits', () => {
    const fixturesDir = createTemporaryFixturesDir();
    writeHistoryFixture(fixturesDir, 'empty-commits.json', buildSampleHistory({ commits: [] }));

    expect(() => loadDemoHistory(fixturesDir)).toThrow(
      '[demo] empty-commits.json carries no commits; re-run node scripts/capture-demo-history.mjs',
    );
  });

  it('returns one key per fixture and ignores a non-json file in the history directory', () => {
    const fixturesDir = createTemporaryFixturesDir();
    const firstHistory = buildSampleHistory({ project: 'first-project' });
    const secondHistory = buildSampleHistory({ project: 'second-project' });
    writeHistoryFixture(fixturesDir, 'first.json', firstHistory);
    writeHistoryFixture(fixturesDir, 'second.json', secondHistory);
    fs.writeFileSync(path.join(fixturesDir, 'history', 'readme.txt'), 'not a fixture');

    const histories = loadDemoHistory(fixturesDir);

    expect(Object.keys(histories).sort()).toEqual(['first-project', 'second-project']);
    expect(histories['first-project']).toEqual(firstHistory);
    expect(histories['second-project']).toEqual(secondHistory);
  });
});
