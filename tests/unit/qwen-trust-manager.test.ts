/**
 * Unit tests for ensureQwenWorktreeTrust() -- pre-populates Qwen Code's
 * trust entry in ~/.qwen/trustedFolders.json so agents skip the trust
 * prompt when the user has opted into security.folderTrust.enabled.
 *
 * Mirrors tests/unit/trust-manager.test.ts (the Claude variant) for the
 * Qwen schema: separate enable flag (settings.json) and per-folder map
 * (trustedFolders.json), with three trust-level strings.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Mock os.homedir() to redirect ~/.qwen/* to a temp dir per test
let tmpHome: string;
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    default: {
      ...actual,
      homedir: () => tmpHome,
    },
    homedir: () => tmpHome,
  };
});

import {
  ensureQwenWorktreeTrust,
  removeQwenWorktreeTrust,
  QwenAdapter,
} from '../../src/main/agent/adapters/qwen-code';
// Not re-exported through the barrel above; imported straight from the module so a
// test can occupy the shared lock the same way ensureWorktreeTrust and the
// relocation pass do. Node resolves this to the same module instance as the
// barrel import, so both share the one underlying lock chain.
import { withQwenTrustLock } from '../../src/main/agent/adapters/qwen-code/trust-manager';

function qwenDir(): string {
  return path.join(tmpHome, '.qwen');
}

function settingsPath(): string {
  return path.join(qwenDir(), 'settings.json');
}

function trustedFoldersPath(): string {
  return path.join(qwenDir(), 'trustedFolders.json');
}

function writeSettings(contents: unknown): void {
  fs.mkdirSync(qwenDir(), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(contents));
}

function enableFolderTrust(): void {
  writeSettings({ security: { folderTrust: { enabled: true } } });
}

function readTrustedFolders(): Record<string, string> {
  return JSON.parse(fs.readFileSync(trustedFoldersPath(), 'utf-8'));
}

function writeTrustedFolders(entries: Record<string, string>): void {
  fs.mkdirSync(qwenDir(), { recursive: true });
  fs.writeFileSync(trustedFoldersPath(), JSON.stringify(entries, null, 2));
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-trust-'));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('ensureQwenWorktreeTrust - folderTrust disabled (skip path)', () => {
  it('does nothing when ~/.qwen/settings.json does not exist', async () => {
    const worktreePath = '/projects/myrepo/.kangentic/worktrees/fix-bug-abcd1234';

    await ensureQwenWorktreeTrust(worktreePath);

    expect(fs.existsSync(trustedFoldersPath())).toBe(false);
    expect(fs.existsSync(qwenDir())).toBe(false);
  });

  it('does nothing when settings.json exists but folderTrust.enabled is missing', async () => {
    writeSettings({ theme: 'dark' });

    await ensureQwenWorktreeTrust('/projects/myrepo/.kangentic/worktrees/task-0');

    expect(fs.existsSync(trustedFoldersPath())).toBe(false);
  });

  it('does nothing when folderTrust.enabled is false', async () => {
    writeSettings({ security: { folderTrust: { enabled: false } } });

    await ensureQwenWorktreeTrust('/projects/myrepo/.kangentic/worktrees/task-0');

    expect(fs.existsSync(trustedFoldersPath())).toBe(false);
  });

  it('does nothing when settings.json is malformed', async () => {
    fs.mkdirSync(qwenDir(), { recursive: true });
    fs.writeFileSync(settingsPath(), '{ this is not valid JSON !!!');

    await ensureQwenWorktreeTrust('/projects/myrepo/.kangentic/worktrees/task-0');

    expect(fs.existsSync(trustedFoldersPath())).toBe(false);
  });
});

describe('ensureQwenWorktreeTrust - folderTrust enabled', () => {
  beforeEach(() => {
    enableFolderTrust();
  });

  it('creates ~/.qwen/trustedFolders.json with TRUST_FOLDER entry when file does not exist', async () => {
    const worktreePath = '/projects/myrepo/.kangentic/worktrees/fix-bug-abcd1234';

    await ensureQwenWorktreeTrust(worktreePath);

    const entries = readTrustedFolders();
    const keys = Object.keys(entries);
    expect(keys).toHaveLength(1);
    expect(entries[keys[0]]).toBe('TRUST_FOLDER');
  });

  it('writes the path resolved with forward slashes', async () => {
    const worktreePath = '/projects/myrepo/.kangentic/worktrees/fix-bug-abcd1234';

    await ensureQwenWorktreeTrust(worktreePath);

    const entries = readTrustedFolders();
    const key = Object.keys(entries)[0];
    // Forward slashes only (no backslashes), regardless of platform.
    expect(key).not.toContain('\\');
    // Path should be absolute - on POSIX starts with '/', on Windows starts with a drive letter.
    if (process.platform === 'win32') {
      expect(/^[A-Za-z]:\//.test(key)).toBe(true);
    } else {
      expect(key.startsWith('/')).toBe(true);
    }
  });

  it('preserves existing entries when adding a new one', async () => {
    fs.mkdirSync(qwenDir(), { recursive: true });
    fs.writeFileSync(
      trustedFoldersPath(),
      JSON.stringify({
        '/some/other/repo': 'TRUST_PARENT',
        '/another/repo': 'TRUST_FOLDER',
      }),
    );

    await ensureQwenWorktreeTrust('/projects/myrepo/.kangentic/worktrees/task-0');

    const entries = readTrustedFolders();
    expect(entries['/some/other/repo']).toBe('TRUST_PARENT');
    expect(entries['/another/repo']).toBe('TRUST_FOLDER');
    // The new entry is also present
    const newKey = Object.keys(entries).find((key) => key.includes('.kangentic/worktrees/task-0'));
    expect(newKey).toBeDefined();
    expect(entries[newKey!]).toBe('TRUST_FOLDER');
  });

  it('is idempotent when path is already TRUST_FOLDER', async () => {
    const worktreePath = '/projects/myrepo/.kangentic/worktrees/task-0';

    await ensureQwenWorktreeTrust(worktreePath);
    const dataBefore = readTrustedFolders();

    await ensureQwenWorktreeTrust(worktreePath);
    const dataAfter = readTrustedFolders();

    expect(dataAfter).toEqual(dataBefore);
  });

  it('does not downgrade an existing TRUST_PARENT to TRUST_FOLDER', async () => {
    const worktreePath = '/projects/myrepo/.kangentic/worktrees/task-0';
    const resolvedKey = path.resolve(worktreePath).replace(/\\/g, '/');

    fs.mkdirSync(qwenDir(), { recursive: true });
    fs.writeFileSync(
      trustedFoldersPath(),
      JSON.stringify({ [resolvedKey]: 'TRUST_PARENT' }),
    );

    await ensureQwenWorktreeTrust(worktreePath);

    const entries = readTrustedFolders();
    expect(entries[resolvedKey]).toBe('TRUST_PARENT');
  });

  it('respects an explicit DO_NOT_TRUST and does not overwrite it', async () => {
    const worktreePath = '/projects/myrepo/.kangentic/worktrees/task-0';
    const resolvedKey = path.resolve(worktreePath).replace(/\\/g, '/');

    fs.mkdirSync(qwenDir(), { recursive: true });
    fs.writeFileSync(
      trustedFoldersPath(),
      JSON.stringify({ [resolvedKey]: 'DO_NOT_TRUST' }),
    );

    await ensureQwenWorktreeTrust(worktreePath);

    const entries = readTrustedFolders();
    expect(entries[resolvedKey]).toBe('DO_NOT_TRUST');
  });

  it('treats malformed trustedFolders.json as empty and recovers', async () => {
    fs.mkdirSync(qwenDir(), { recursive: true });
    fs.writeFileSync(trustedFoldersPath(), '{ not valid JSON !!!');

    const worktreePath = '/projects/myrepo/.kangentic/worktrees/task-0';
    await ensureQwenWorktreeTrust(worktreePath);

    const entries = readTrustedFolders();
    const keys = Object.keys(entries);
    expect(keys).toHaveLength(1);
    expect(entries[keys[0]]).toBe('TRUST_FOLDER');
  });

  it('treats array-shaped trustedFolders.json as empty (defensive)', async () => {
    fs.mkdirSync(qwenDir(), { recursive: true });
    fs.writeFileSync(trustedFoldersPath(), JSON.stringify(['/should/be/object/not/array']));

    const worktreePath = '/projects/myrepo/.kangentic/worktrees/task-0';
    await ensureQwenWorktreeTrust(worktreePath);

    const entries = readTrustedFolders();
    expect(Array.isArray(entries)).toBe(false);
    const keys = Object.keys(entries);
    expect(keys).toHaveLength(1);
    expect(entries[keys[0]]).toBe('TRUST_FOLDER');
  });
});

describe('ensureQwenWorktreeTrust - write failure', () => {
  beforeEach(() => {
    enableFolderTrust();
  });

  it('rejects when trustedFolders.json path is occupied by a directory (write fails)', async () => {
    // Occupy trustedFolders.json with a directory so writeFileSync throws EISDIR
    // (Linux/macOS) or EPERM (Windows). The production code has no try/catch around
    // writeFileSync, so the error propagates up through withQwenTrustLock and the
    // returned promise rejects. This is the current documented behavior; a future
    // change that swallows the error should update this test intentionally.
    fs.mkdirSync(trustedFoldersPath(), { recursive: true });

    const worktreePath = '/projects/myrepo/.kangentic/worktrees/task-0';
    await expect(ensureQwenWorktreeTrust(worktreePath)).rejects.toThrow();
  });
});

describe('ensureQwenWorktreeTrust - UNC path (Windows only)', () => {
  // UNC paths require Windows because path.resolve() only recognises \\server\share
  // as a UNC root on win32. On POSIX, path.resolve('\\\\fileserver\\...') treats
  // backslashes as literals inside a filename.
  describe.runIf(process.platform === 'win32')(
    'resolves UNC worktree path to forward-slash key',
    () => {
      beforeEach(() => {
        enableFolderTrust();
      });

      it('writes //server/share/... key for a \\\\server\\share\\... worktree path', async () => {
        // UNC path with double-backslash prefix as Qwen Code sees it from a worktree.
        const uncWorktreePath =
          '\\\\fileserver\\share\\projects\\repo\\.kangentic\\worktrees\\task-0';

        await ensureQwenWorktreeTrust(uncWorktreePath);

        const entries = readTrustedFolders();
        // resolveForwardSlash(path.resolve(uncPath)) converts every \ to /,
        // so \\fileserver\share\... becomes //fileserver/share/...
        // This test locks in that key shape so any future change to UNC handling
        // fails loudly.
        const expectedKey =
          '//fileserver/share/projects/repo/.kangentic/worktrees/task-0';
        expect(entries[expectedKey]).toBe('TRUST_FOLDER');
      });
    },
  );
});

describe('ensureQwenWorktreeTrust - extra nested data in folderTrust settings', () => {
  // Guards against future isFolderTrustEnabled refactors that tighten the
  // schema check and accidentally reject otherwise-valid settings objects with
  // extra fields or nested sub-objects inside security.folderTrust.
  it('still enables trust when folderTrust object has extra unknown fields', async () => {
    writeSettings({
      security: {
        folderTrust: {
          enabled: true,
          extraField: 'ignored',
          nested: { depth: { value: true } },
        },
      },
    });

    const worktreePath = '/projects/myrepo/.kangentic/worktrees/task-0';
    await ensureQwenWorktreeTrust(worktreePath);

    expect(fs.existsSync(trustedFoldersPath())).toBe(true);
    const entries = readTrustedFolders();
    const matchingKey = Object.keys(entries).find((key) =>
      key.includes('.kangentic/worktrees/task-0'),
    );
    expect(matchingKey).toBeDefined();
    expect(entries[matchingKey!]).toBe('TRUST_FOLDER');
  });
});

describe('ensureQwenWorktreeTrust - symlinked worktree path (POSIX only)', () => {
  // Windows requires elevated privileges for fs.symlinkSync, so this group
  // is POSIX-only. The test documents (and locks in) that we trust by the
  // path we were given - the symlink path - not the real target path. This
  // only works correctly at runtime if Qwen Code also does NOT resolve
  // symlinks before its own trusted-folder lookup. If Qwen starts resolving
  // symlinks, this test will need to be updated alongside any Kangentic fix.
  describe.runIf(process.platform !== 'win32')(
    'writes the symlink path as the key, not the real target path',
    () => {
      beforeEach(() => {
        enableFolderTrust();
      });

      it('uses the symlink path as the trusted-folders key', async () => {
        // Create a real directory inside the temp home.
        const realWorktreeDir = path.join(tmpHome, 'real-worktree-dir');
        fs.mkdirSync(realWorktreeDir, { recursive: true });

        // Create a symlink that points at the real directory.
        const symlinkWorktreePath = path.join(tmpHome, 'symlink-worktree');
        fs.symlinkSync(realWorktreeDir, symlinkWorktreePath);

        await ensureQwenWorktreeTrust(symlinkWorktreePath);

        const entries = readTrustedFolders();

        // The key must be derived from the symlink path, not the real path.
        // resolveForwardSlash(path.resolve(symlinkPath)) on POSIX returns
        // the absolute symlink path with forward slashes.
        const expectedKey = symlinkWorktreePath.replace(/\\/g, '/');
        expect(entries[expectedKey]).toBe('TRUST_FOLDER');

        // The real path is NOT registered - trust follows the path we passed.
        const realPathKey = realWorktreeDir.replace(/\\/g, '/');
        expect(entries[realPathKey]).toBeUndefined();
      });
    },
  );
});

describe('Concurrent qwen trust writes (lock serialization)', () => {
  beforeEach(() => {
    enableFolderTrust();
  });

  it('5 concurrent calls with distinct paths - all entries present', async () => {
    const paths = Array.from({ length: 5 }, (_, index) =>
      `/projects/myrepo/.kangentic/worktrees/task-${index}`,
    );

    await Promise.all(paths.map((worktreePath) => ensureQwenWorktreeTrust(worktreePath)));

    const entries = readTrustedFolders();
    const keys = Object.keys(entries);
    expect(keys).toHaveLength(5);
    for (const key of keys) {
      expect(entries[key]).toBe('TRUST_FOLDER');
    }
  });

  it('20 concurrent calls (10 distinct paths, doubled) - exactly 10 entries, no duplicates lost', async () => {
    const distinctPaths = Array.from({ length: 10 }, (_, index) =>
      `/projects/myrepo/.kangentic/worktrees/task-${index}`,
    );
    // Submit each path twice in interleaved order to stress the lock.
    const work = [...distinctPaths, ...distinctPaths].map((worktreePath) =>
      ensureQwenWorktreeTrust(worktreePath),
    );

    await Promise.all(work);

    const entries = readTrustedFolders();
    const keys = Object.keys(entries);
    expect(keys).toHaveLength(10);
    for (const key of keys) {
      expect(entries[key]).toBe('TRUST_FOLDER');
    }
  });
});

describe('removeQwenWorktreeTrust', () => {
  // ensureQwenWorktreeTrust has no ancestor check, so with folder trust on it
  // writes one key per task worktree. Without removal on cleanup the file grows
  // by a dead entry per task forever - the same accumulation that reached 473
  // entries in Codex's config.toml before its equivalent cleanup existed.
  //
  // Paths are built host-absolute (path.resolve) so the literals still resolve
  // on Windows and on CI's Linux runner.
  const WORKTREE = path.join(path.resolve('/repo'), '.kangentic', 'worktrees', '3');

  it('drops the entry for a removed worktree', async () => {
    enableFolderTrust();
    await ensureQwenWorktreeTrust(WORKTREE);
    expect(Object.keys(readTrustedFolders())).toHaveLength(1);

    await removeQwenWorktreeTrust(WORKTREE);
    expect(Object.keys(readTrustedFolders())).toHaveLength(0);
  });

  it('does not grow the file across repeated create/remove cycles', async () => {
    enableFolderTrust();
    for (let taskIndex = 0; taskIndex < 25; taskIndex += 1) {
      const worktree = path.join(path.resolve('/repo'), '.kangentic', 'worktrees', String(taskIndex));
      await ensureQwenWorktreeTrust(worktree);
      await removeQwenWorktreeTrust(worktree);
    }
    expect(Object.keys(readTrustedFolders())).toHaveLength(0);
  });

  it('leaves other projects untouched', async () => {
    enableFolderTrust();
    const otherProject = path.resolve('/other/project');
    writeTrustedFolders({ [otherProject]: 'TRUST_FOLDER' });
    await ensureQwenWorktreeTrust(WORKTREE);
    await removeQwenWorktreeTrust(WORKTREE);
    expect(readTrustedFolders()[otherProject]).toBe('TRUST_FOLDER');
  });

  it('never removes a user decision', async () => {
    // TRUST_PARENT / DO_NOT_TRUST are the user's, not ours: a later worktree
    // at the same path must still honor them.
    for (const level of ['TRUST_PARENT', 'DO_NOT_TRUST']) {
      writeTrustedFolders({ [WORKTREE]: level });
      await removeQwenWorktreeTrust(WORKTREE);
      expect(readTrustedFolders()[WORKTREE]).toBe(level);
    }
  });

  it('is a no-op when there is no file or no matching entry', async () => {
    await expect(removeQwenWorktreeTrust(WORKTREE)).resolves.toBeUndefined();

    const otherProject = path.resolve('/other/project');
    // "3" is the WORKTREE's own basename, and a relative key in a hand-edited
    // file. It must survive whatever the process cwd happens to be, which is
    // what the isAbsolute guard in the matcher is for: path.resolve would
    // otherwise expand it against cwd and could match by accident.
    writeTrustedFolders({ [otherProject]: 'TRUST_FOLDER', '3': 'TRUST_FOLDER' });
    await removeQwenWorktreeTrust(WORKTREE);
    expect(readTrustedFolders()[otherProject]).toBe('TRUST_FOLDER');
    expect(readTrustedFolders()['3']).toBe('TRUST_FOLDER');
  });

  it('removes even when security.folderTrust.enabled is off', async () => {
    // The deliberate asymmetry with ensureQwenWorktreeTrust, which skips
    // entirely when the flag is unset. The flag lives in a separate,
    // user-editable file, so gating the reap on it would leak every entry a
    // user wrote before they turned folder trust back off.
    writeTrustedFolders({ [WORKTREE]: 'TRUST_FOLDER' });
    expect(fs.existsSync(settingsPath())).toBe(false);

    await removeQwenWorktreeTrust(WORKTREE);
    expect(Object.keys(readTrustedFolders())).toHaveLength(0);
  });

  it('matches a key stored with native separators and a trailing slash', async () => {
    // The relocation pass rewrites arbitrary keys and Qwen's own CLI writes
    // its own, so the file holds mixed separator styles. Matching is on the
    // resolved location, not the raw string.
    const nativeKey = `${WORKTREE}${path.sep}`;
    writeTrustedFolders({ [nativeKey]: 'TRUST_FOLDER' });

    await removeQwenWorktreeTrust(WORKTREE.replace(/\\/g, '/'));
    expect(Object.keys(readTrustedFolders())).toHaveLength(0);
  });

  it('is wired to the adapter via onWorktreeRemoved', async () => {
    enableFolderTrust();
    const adapter = new QwenAdapter();
    await adapter.ensureTrust(WORKTREE);
    expect(Object.keys(readTrustedFolders())).toHaveLength(1);

    await adapter.onWorktreeRemoved(WORKTREE);
    expect(Object.keys(readTrustedFolders())).toHaveLength(0);
  });

  it('never rejects when the write fails, and leaves the file untouched', async () => {
    // The counterpart to the ensure path's rejects.toThrow() above. By the time
    // this runs the worktree is gone, so a failed write may only leave a stale
    // entry behind - it must never fail the cleanup.
    enableFolderTrust();
    await ensureQwenWorktreeTrust(WORKTREE);

    // Occupy the backup destination with a directory so the atomic write's
    // copyFileSync throws and it aborts before touching the real file.
    fs.mkdirSync(`${trustedFoldersPath()}.kangentic-backup`, { recursive: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await expect(removeQwenWorktreeTrust(WORKTREE)).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
    expect(Object.keys(readTrustedFolders())).toHaveLength(1);
  });

  it('queues behind an operation already holding the shared lock instead of running ahead of it', async () => {
    // removeWorktreeTrustSync (and ensureWorktreeTrustSync) are wholly synchronous,
    // so a plain Promise.all of several concurrent removals cannot expose a missing
    // lock: each call's read, filter, and write completes before the next call even
    // starts, and JS never interleaves them regardless of whether withQwenTrustLock
    // wraps the call. Verified empirically - with the lock wrapper stripped from
    // removeWorktreeTrust, a Promise.all of 20 concurrent removals over 10 distinct
    // worktrees still left exactly 0 entries, and an interleaved ensure/remove pair
    // on the same path still ended with the entry gone, matching the locked result
    // in both cases.
    //
    // A held operation with a promise we control is the one thing that can actually
    // force two callers apart: this occupies the lock, then starts a removal, and
    // asserts the removal has NOT touched disk while the lock is still held. This
    // holds no matter how many microtask turns pass, since the removal is chained
    // behind a promise nothing but releaseHeldOperation() can settle. If
    // removeWorktreeTrust ever called removeWorktreeTrustSync directly instead of
    // going through withQwenTrustLock, the removal would run immediately and the
    // first assertion below would fail.
    writeTrustedFolders({ [WORKTREE]: 'TRUST_FOLDER' });

    let releaseHeldOperation: () => void = () => {};
    const heldOperationSettled = new Promise<void>((resolve) => {
      releaseHeldOperation = resolve;
    });
    const heldOperation = withQwenTrustLock(() => heldOperationSettled);

    const removalPromise = removeQwenWorktreeTrust(WORKTREE);
    try {
      // A macrotask turn drains the entire microtask queue first, so this is a
      // stronger check than a fixed count of `await Promise.resolve()` calls: any
      // amount of queued microtask work runs before this resolves.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(readTrustedFolders()[WORKTREE]).toBe('TRUST_FOLDER');
    } finally {
      // Always release, even if the assertion above throws - otherwise the shared
      // lock chain stays pending forever and hangs every later test in this file
      // that calls ensureQwenWorktreeTrust or removeQwenWorktreeTrust.
      releaseHeldOperation();
    }
    await heldOperation;
    await removalPromise;
    expect(readTrustedFolders()[WORKTREE]).toBeUndefined();
  });
});
