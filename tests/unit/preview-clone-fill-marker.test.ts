/**
 * `fillPreviewClone` writes a marker inside the clone's `.git` once the working
 * tree is filled, and the marker turns every later call into a no-op (so an
 * in-app restart cannot `reset --hard` over a resumed agent's edits).
 *
 * The marker must follow a SUCCESSFUL reset only. A fill whose `git reset --hard
 * HEAD` fails (here: a stale `.git/index.lock`, which makes git refuse) must
 * leave no marker, so the next boot retries the fill instead of keeping a clone
 * with an empty working tree forever.
 *
 * `.git` has to be a real, writable directory for this to prove anything. With
 * no `.git`, or a `.git` file, the marker write would fail on its own and the
 * marker would be absent whatever order the code ran in. Here the write could
 * always succeed, so an absent marker can only mean the code never reached it.
 *
 * preview-git-isolation.test.ts covers the marker's no-op effect on a second
 * call; the control case below pins its location, which the negative case's
 * absence check depends on.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// ephemeral-projects.ts pulls in electron's ipcMain and the project DB at import time;
// neither is exercised here.
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn() }));

import { fillPreviewClone } from '../../src/devtools/main/ephemeral-projects';

const MARKER_NAME = 'kangentic-preview-filled';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf-8' }).trim();
}

describe('fillPreviewClone marker', () => {
  let tempDir: string;
  let cloneDir: string;
  let markerPath: string;
  let lockPath: string;

  beforeEach(() => {
    // Canonical, because git reports real paths: macOS's tmpdir is a symlink into
    // /private, and a Windows tmpdir can be an 8.3 short name.
    tempDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'preview-clone-fill-marker-')));
    const sourceRepo = path.join(tempDir, 'source');
    fs.mkdirSync(sourceRepo);
    git(sourceRepo, ['init', '-b', 'main']);
    git(sourceRepo, ['config', 'core.autocrlf', 'false']);
    fs.writeFileSync(path.join(sourceRepo, 'tracked.txt'), 'committed\n');
    git(sourceRepo, ['add', '.']);
    git(sourceRepo, ['-c', 'user.email=dev@example.com', '-c', 'user.name=Dev', '-c', 'commit.gpgsign=false', 'commit', '-m', 'init']);

    // What createPreviewClone leaves: an independent --no-checkout clone, empty working tree.
    cloneDir = path.join(tempDir, 'preview-projects', 'project-1');
    git(tempDir, ['clone', '--no-checkout', '--local', sourceRepo, cloneDir]);
    git(cloneDir, ['config', 'core.autocrlf', 'false']);
    markerPath = path.join(cloneDir, '.git', MARKER_NAME);
    lockPath = path.join(cloneDir, '.git', 'index.lock');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.promises.rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('control: a successful fill fills the working tree and writes the marker inside .git', async () => {
    expect(fs.existsSync(path.join(cloneDir, 'tracked.txt'))).toBe(false);

    await fillPreviewClone(cloneDir);

    expect(fs.readFileSync(path.join(cloneDir, 'tracked.txt'), 'utf-8')).toBe('committed\n');
    expect(fs.existsSync(markerPath)).toBe(true);
  });

  it('writes no marker when git reset --hard fails, and resolves instead of throwing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A leftover lock: git refuses to take the index, on every platform.
    fs.writeFileSync(lockPath, '');

    await expect(fillPreviewClone(cloneDir)).resolves.toBeUndefined();

    // The fixture really failed the reset, rather than the call never trying.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Background working-tree fill failed'), expect.anything());
    expect(fs.existsSync(path.join(cloneDir, 'tracked.txt'))).toBe(false);
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it('retries on the next call once the failure is gone, so a failed fill is not remembered', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fs.writeFileSync(lockPath, '');
    await fillPreviewClone(cloneDir);
    expect(fs.existsSync(markerPath)).toBe(false);

    // The next boot: the lock is gone. A marker left by the failed call would
    // turn this into a no-op and leave the working tree empty.
    fs.rmSync(lockPath, { force: true });
    await fillPreviewClone(cloneDir);

    expect(fs.readFileSync(path.join(cloneDir, 'tracked.txt'), 'utf-8')).toBe('committed\n');
    expect(fs.existsSync(markerPath)).toBe(true);
  });
});
