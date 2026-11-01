/**
 * The removed-worktrees walker retries the codes Windows returns for a moment
 * while antivirus or the search indexer still holds a handle. A parent's
 * `rmdir` right after its children went can read ENOTEMPTY; without a retry
 * one such moment left the whole copy for the next project open.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import type nodeFs from 'node:fs';

const { failures, afterListing } = vi.hoisted(() => ({
  /** Directory path -> how many more `rmdir` calls on it fail, and with what code. */
  failures: new Map<string, { remaining: number; code: string }>(),
  /** Called after a `readdir` of `directory` resolves, before its caller resumes. */
  afterListing: { directory: '', hook: null as (() => void) | null },
}));

vi.mock('../../src/main/git/original-fs', async () => {
  const actual = await vi.importActual<typeof nodeFs>('node:fs');
  const promises = {
    ...actual.promises,
    rmdir: async (directoryPath: string) => {
      const failure = failures.get(path.resolve(directoryPath));
      if (failure && failure.remaining > 0) {
        failure.remaining -= 1;
        throw Object.assign(new Error(`${failure.code}: simulated`), { code: failure.code });
      }
      return actual.promises.rmdir(directoryPath);
    },
    readdir: async (directoryPath: string) => {
      const names = await actual.promises.readdir(directoryPath);
      if (afterListing.hook && path.resolve(directoryPath) === afterListing.directory) afterListing.hook();
      return names;
    },
  };
  return { default: { ...actual, promises } };
});

import fs from 'node:fs';
import {
  deleteTreeWithoutFollowingLinks,
  removedWorktreesRootFor,
  scheduleRemovedWorktreeDeletion,
  _whenRemovedWorktreeDeletionIdleForTests,
} from '../../src/main/git/removed-worktrees';

let scratch = '';

afterEach(async () => {
  failures.clear();
  afterListing.hook = null;
  afterListing.directory = '';
  if (scratch) await fs.promises.rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  scratch = '';
});

function makeTree(): { tree: string; inner: string } {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-removed-transient-'));
  const tree = path.join(scratch, 'tree');
  const inner = path.join(tree, 'node_modules', 'pkg');
  fs.mkdirSync(inner, { recursive: true });
  fs.writeFileSync(path.join(inner, 'index.js'), '\n');
  return { tree, inner };
}

const noStop = { beforeBatch: async () => true, onRemoved: () => undefined };

describe('the walker and a directory that is briefly held', () => {
  it('retries a parent rmdir that reads ENOTEMPTY for a moment, and the tree still goes', async () => {
    const { tree, inner } = makeTree();
    failures.set(path.resolve(inner), { remaining: 2, code: 'ENOTEMPTY' });

    await expect(deleteTreeWithoutFollowingLinks(tree, noStop)).resolves.toBe('deleted');
    expect(fs.existsSync(tree)).toBe(false);
    expect(failures.get(path.resolve(inner))?.remaining).toBe(0);
  });

  it('gives up on a directory that stays held, leaving it for the next sweep', async () => {
    const { tree, inner } = makeTree();
    failures.set(path.resolve(inner), { remaining: 100, code: 'EBUSY' });

    await expect(deleteTreeWithoutFollowingLinks(tree, noStop)).rejects.toMatchObject({ code: 'EBUSY' });
    expect(fs.existsSync(inner)).toBe(true);
  });

  it('a copy set aside as the drain ends is deleted too, whichever microtask the schedule lands on', async () => {
    // The drain lists the folder, finds nothing, and ends. A Done move that
    // sets a copy aside and schedules in that moment must not lose it to the
    // next project open. The schedule is placed 0 to 24 microtasks after the
    // drain's last listing, which covers the steps between its last check and
    // its exit; the rename and the schedule are synchronous, so each lands
    // exactly there.
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-removed-late-'));
    const projectPath = path.join(scratch, 'project');
    const root = removedWorktreesRootFor(projectPath);
    fs.mkdirSync(root, { recursive: true });
    afterListing.directory = path.resolve(root);

    for (let hops = 0; hops < 25; hops += 1) {
      const staged = path.join(scratch, `staged-${hops}`);
      fs.mkdirSync(path.join(staged, 'node_modules'), { recursive: true });
      fs.writeFileSync(path.join(staged, 'node_modules', 'index.js'), '\n');
      let markFired: () => void = () => undefined;
      const fired = new Promise<void>((resolve) => { markFired = resolve; });
      let armed = true;
      afterListing.hook = () => {
        if (!armed) return;
        armed = false;
        let remaining = hops;
        const step = (): void => {
          if (remaining > 0) {
            remaining -= 1;
            queueMicrotask(step);
            return;
          }
          fs.renameSync(staged, path.join(root, `late-${hops}`));
          scheduleRemovedWorktreeDeletion(projectPath);
          markFired();
        };
        queueMicrotask(step);
      };

      scheduleRemovedWorktreeDeletion(projectPath);
      await fired;
      await _whenRemovedWorktreeDeletionIdleForTests(projectPath);
      expect({ hops, left: fs.readdirSync(root) }).toEqual({ hops, left: [] });
    }
  });

  it('does not retry a failure that is not transient', async () => {
    const { tree, inner } = makeTree();
    failures.set(path.resolve(inner), { remaining: 1, code: 'EIO' });

    await expect(deleteTreeWithoutFollowingLinks(tree, noStop)).rejects.toMatchObject({ code: 'EIO' });
    // One attempt, no retry.
    expect(failures.get(path.resolve(inner))?.remaining).toBe(0);
    expect(fs.existsSync(inner)).toBe(true);
  });
});
