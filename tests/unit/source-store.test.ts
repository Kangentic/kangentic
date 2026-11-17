/**
 * Unit tests for src/main/boards/shared/source-store.ts (ImportSourceStore).
 *
 * No dedicated test file existed for this class before this one. Every other
 * test that touches it (import-reconcile.test.ts, backlog-import-execute-
 * hydrate.test.ts, backlog-import-promote-dedup.test.ts,
 * backlog-promote-abort.test.ts) mocks ImportSourceStore wholesale, so the
 * real writeConfig() path - including the .kangentic directory creation that
 * used to be an explicit fs.mkdirSync before this diff folded it into
 * safeWriteJson (.claude/rules/guarded-sync-writes.md) - had zero real-disk
 * coverage anywhere in the suite.
 *
 * Uses a real temp directory per test, mirroring
 * tests/unit/browser-url-store.test.ts's technique, so directory creation
 * and the read/write round trip both happen on a real filesystem rather than
 * through a mock.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ImportSourceStore, registerSourceUrlParser } from '../../src/main/boards/shared/source-store';
import type { ExternalSource } from '../../src/shared/types';

// This file never imports the Trello adapter, and each test file runs in its
// own module graph, so the stand-in parser below is the only 'trello' parser
// registered here.
const TEST_SOURCE: ExternalSource = 'trello';

registerSourceUrlParser(TEST_SOURCE, {
  parse: (url) => ({ repository: url.replace(/^https?:\/\//, '') }),
  buildLabel: (repository) => `Trello: ${repository}`,
});

let tmpDir: string;
let store: ImportSourceStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-store-'));
  store = new ImportSourceStore(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ImportSourceStore against a real project directory', () => {
  it('creates the .kangentic directory on the first add, when it does not exist yet', () => {
    // tmpDir has no .kangentic subdir yet.
    store.add(TEST_SOURCE, 'https://trello.com/b/abc123');
    const configPath = path.join(tmpDir, '.kangentic', 'config.json');
    expect(fs.existsSync(configPath)).toBe(true);
  });

  it('persists an added source that list() reads back from disk', () => {
    const added = store.add(TEST_SOURCE, 'https://trello.com/b/abc123');
    const listed = store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual(added);
    expect(listed[0].repository).toBe('trello.com/b/abc123');
  });

  it('preserves other config.json keys already on disk (merges, does not clobber)', () => {
    const dir = path.join(tmpDir, '.kangentic');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ someOtherSetting: 'keep-me' }));

    store.add(TEST_SOURCE, 'https://trello.com/b/abc123');

    const raw = fs.readFileSync(path.join(dir, 'config.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { someOtherSetting?: string; importSources?: unknown[] };
    expect(parsed.someOtherSetting).toBe('keep-me');
    expect(parsed.importSources).toHaveLength(1);
  });

  it('remove() deletes a persisted source', () => {
    const added = store.add(TEST_SOURCE, 'https://trello.com/b/abc123');
    store.remove(added.id);
    expect(store.list()).toEqual([]);
  });

  it('updateLabel() persists the new label', () => {
    const added = store.add(TEST_SOURCE, 'https://trello.com/b/abc123');
    store.updateLabel(added.id, 'My Renamed Board');
    expect(store.list()[0].label).toBe('My Renamed Board');
  });

  it('add() is idempotent for the same source+repository and does not write a duplicate', () => {
    const first = store.add(TEST_SOURCE, 'https://trello.com/b/abc123');
    const second = store.add(TEST_SOURCE, 'https://trello.com/b/abc123');
    expect(second).toEqual(first);
    expect(store.list()).toHaveLength(1);
  });
});

describe('ImportSourceStore.add with a prepared source', () => {
  const url = 'https://trello.com/b/typed-query';

  it('stores the prepared label and the completed repository, not the parsed ones', () => {
    const added = store.add(TEST_SOURCE, url, { label: 'Sprint board', repository: 'site.example|project = X' });

    expect(added.label).toBe('Sprint board');
    expect(added.repository).toBe('site.example|project = X');
    expect(store.list()[0]).toMatchObject({ label: 'Sprint board', repository: 'site.example|project = X', url });
  });

  it('returns the existing source for the same completed repository, without a duplicate', () => {
    const prepared = { label: 'Sprint board', repository: 'site.example|project = X' };
    const first = store.add(TEST_SOURCE, url, prepared);
    // A different typed URL that completes to the same repository is the same source.
    const second = store.add(TEST_SOURCE, 'https://trello.com/b/other-spelling', { label: 'Renamed', repository: prepared.repository });

    expect(second).toEqual(first);
    expect(store.list()).toHaveLength(1);
  });

  it('dedupes on the completed repository, not on what the URL parser reads', () => {
    store.add(TEST_SOURCE, url, { label: 'A', repository: 'site.example|one' });
    store.add(TEST_SOURCE, url, { label: 'B', repository: 'site.example|two' });

    expect(store.list().map((source) => source.repository)).toEqual(['site.example|one', 'site.example|two']);
  });

  it('falls back to the URL parser label when the prepared label is blank', () => {
    const added = store.add(TEST_SOURCE, url, { label: '   ', repository: 'site.example|project = X' });

    expect(added.label).toBe('Trello: site.example|project = X');
  });
});
