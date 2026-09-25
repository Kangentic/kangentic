/**
 * Real-filesystem recovery tests for FileWatcher.
 *
 * Separate from file-watcher.test.ts, which mocks `node:fs` wholesale.
 *
 * The Windows event flood that motivated the storm guard is platform-specific
 * (a directory watch whose target is deleted emits `rename` at ~150k/sec
 * forever, stopping only on close). These tests therefore assert the BEHAVIOUR
 * that has to hold on every platform - the watcher keeps reporting changes
 * across a delete and recreate of its directory - rather than any event count.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FileWatcher } from '../../src/main/pty/readers/file-watcher';

describe('FileWatcher recovery on a real filesystem', () => {
  let tempDir: string;
  const openWatchers: FileWatcher[] = [];

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-watcher-recovery-'));
  });

  afterEach(() => {
    for (const watcher of openWatchers) watcher.close();
    openWatchers.length = 0;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('timed out waiting for the expected change');
  }

  it('keeps reporting changes after its directory is deleted and recreated', async () => {
    const sessionDirectory = path.join(tempDir, 'session');
    const statusPath = path.join(sessionDirectory, 'status.json');
    fs.mkdirSync(sessionDirectory, { recursive: true });
    fs.writeFileSync(statusPath, '');

    let changeCount = 0;
    const watcher = new FileWatcher({
      filePath: statusPath,
      onChange: () => { changeCount += 1; },
      debounceMs: 10,
      pollIntervalMs: 50,
    });
    openWatchers.push(watcher);

    fs.writeFileSync(statusPath, '{"first":1}');
    await waitFor(() => changeCount > 0);
    const changesBeforeDelete = changeCount;

    // The directory vanishes under a live watcher: a prune sweep, a project
    // delete, or an external rm. On Windows this is what floods.
    fs.rmSync(sessionDirectory, { recursive: true, force: true });

    // repairMissingEventsDir does exactly this for a live session, and the
    // agent's next write recreates the file.
    fs.mkdirSync(sessionDirectory, { recursive: true });
    fs.writeFileSync(statusPath, '{"second":2}');

    await waitFor(() => changeCount > changesBeforeDelete);
    expect(changeCount).toBeGreaterThan(changesBeforeDelete);
  });

  it('reports the file appearing when it did not exist at construction', async () => {
    // This is the directory-fallback arm: the file is absent, so fs.watch on it
    // throws and the watcher falls back to the parent directory.
    const sessionDirectory = path.join(tempDir, 'late-session');
    const statusPath = path.join(sessionDirectory, 'status.json');
    fs.mkdirSync(sessionDirectory, { recursive: true });

    let changeCount = 0;
    const watcher = new FileWatcher({
      filePath: statusPath,
      onChange: () => { changeCount += 1; },
      debounceMs: 10,
      pollIntervalMs: 50,
      // The default mtime isStale cannot see a file that does not exist yet,
      // so mirror what StatusFileReader's events watcher does.
      isStale: () => fs.existsSync(statusPath),
    });
    openWatchers.push(watcher);

    fs.writeFileSync(statusPath, '{"late":true}');

    await waitFor(() => changeCount > 0);
    expect(changeCount).toBeGreaterThan(0);
  });
});
