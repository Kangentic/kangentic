/**
 * Regression lock for loadRecordings' per-directory memo in
 * tests/captures/helpers/demo-scrollback.ts.
 *
 * Seven public accessors (loadDemoScrollback, loadDemoPeeks, loadDemoEnds,
 * loadDemoOpenFrames, loadDemoPeekTimelines, loadDemoChanges, and the sessions
 * half of loadDemoRecordings) all walk the SAME fixture directory through the
 * module-local loadRecordings(), and one `npm run build:demo` calls seven of
 * them - so before the memo, the always-on demo CI job parsed the 39MB fixture
 * set seven times per build. The cache is a module-level Map keyed by the
 * resolved fixtures directory, so each test below uses its own freshly
 * mkdtemp'd directory: the cache can never have a stale entry for a path this
 * test has not touched yet, and no cross-test reset is needed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadDemoScrollback, loadDemoPeeks, loadDemoRecordings } from '../captures/helpers/demo-scrollback';

function makeFixturesDir(sessionId: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-demo-scrollback-cache-'));
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({ captures: [{ file: `${sessionId}.json`, sessionId, agent: 'claude', project: 'demo' }] }),
  );
  fs.writeFileSync(
    path.join(dir, `${sessionId}.json`),
    JSON.stringify({ agent: 'claude', serialized: 'hello world', rawBytes: 42, peek: ['hello world'] }),
  );
  return dir;
}

describe('loadRecordings memo', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads the fixture files from disk on the first accessor call and not on the second', () => {
    const fixturesDir = makeFixturesDir('sess-cache-a');
    const readSpy = vi.spyOn(fs, 'readFileSync');

    const scrollback = loadDemoScrollback(fixturesDir);
    expect(scrollback['sess-cache-a']).toBe('hello world');
    const readsAfterFirstCall = readSpy.mock.calls.length;
    // Sanity: the first call really did hit disk (manifest.json + the one
    // recording file), so a later assertion of "no growth" is not vacuous.
    expect(readsAfterFirstCall).toBeGreaterThanOrEqual(2);

    const peeks = loadDemoPeeks(fixturesDir);
    expect(peeks['sess-cache-a']).toEqual(['hello world']);

    // A second accessor over the SAME directory must be served from the memo:
    // no additional fs.readFileSync calls at all.
    expect(readSpy.mock.calls.length).toBe(readsAfterFirstCall);
  });

  it('keys the memo per directory, so a different fixtures directory still reads its own files', () => {
    const firstDir = makeFixturesDir('sess-cache-b');
    const secondDir = makeFixturesDir('sess-cache-c');
    const readSpy = vi.spyOn(fs, 'readFileSync');

    loadDemoScrollback(firstDir);
    const readsAfterFirstDir = readSpy.mock.calls.length;
    expect(readsAfterFirstDir).toBeGreaterThanOrEqual(2);

    const secondScrollback = loadDemoScrollback(secondDir);
    expect(secondScrollback['sess-cache-c']).toBe('hello world');
    // A directory the memo has not seen before must not be served stale data
    // from the first directory's entry.
    expect(readSpy.mock.calls.length).toBeGreaterThan(readsAfterFirstDir);
  });
});

describe('loadDemoRecordings entryOf shape parity', () => {
  it('builds the same DemoRecordingEntry field set for a session, a spawn, and a terminal recording', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-demo-scrollback-entryof-'));
    const record = (label: string): object => ({
      agent: 'claude',
      serialized: `${label}-serialized`,
      rawBytes: 10,
      peek: [`${label}-peek`],
      stream: [{ t: 0, data: label }],
      cols: 80,
      rows: 24,
      stopReason: 'idle',
      frameTimeline: [{ t: 0, frame: `${label}-frame` }],
    });
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ captures: [{ file: 'sess-shape.json', sessionId: 'sess-shape', agent: 'claude', project: 'demo' }] }),
    );
    fs.writeFileSync(path.join(dir, 'sess-shape.json'), JSON.stringify(record('session')));
    fs.writeFileSync(path.join(dir, 'spawn-task1-default.json'), JSON.stringify(record('spawn')));
    fs.writeFileSync(path.join(dir, 'terminal-proj1.json'), JSON.stringify(record('terminal')));

    const index = loadDemoRecordings(dir);

    const sessionEntry = index.sessions['sess-shape'];
    const spawnEntry = index.spawns['task1:default'];
    const terminalEntry = index.terminals['proj1'];
    expect(sessionEntry).toBeDefined();
    expect(spawnEntry).toBeDefined();
    expect(terminalEntry).toBeDefined();

    const expectedFields = ['cols', 'file', 'frameTimeline', 'peek', 'rows', 'serialized', 'stopReason', 'stream'].sort();
    expect(Object.keys(sessionEntry).sort()).toEqual(expectedFields);
    expect(Object.keys(spawnEntry).sort()).toEqual(expectedFields);
    expect(Object.keys(terminalEntry).sort()).toEqual(expectedFields);
  });
});
