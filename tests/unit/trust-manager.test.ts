/**
 * Unit tests for the ~/.claude.json writers: ensureClaudeSpawnConfig (a
 * spawn's changes in one pass), ensureWorktreeTrust and ensureMcpServerTrust.
 * All three share one reader and one temp-file writer, so a file that does not
 * parse is left untouched by every one of them.
 *
 * Uses real temp files (same pattern as hook-manager.test.ts).
 * Mocks os.homedir() to point at a temp directory.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Mock os.homedir() to redirect ~/.claude.json to a temp dir
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

import { ensureWorktreeTrust, ensureMcpServerTrust } from '../../src/main/agent/adapters/claude';
import { ensureClaudeSpawnConfig } from '../../src/main/agent/adapters/claude/trust-manager';

describe('ensureClaudeSpawnConfig: a spawn\'s changes in one pass', () => {
  it('trusts the directory, enables the MCP server and closes the diff panel in one write', async () => {
    fs.writeFileSync(claudeJsonPath(), JSON.stringify({ oauthAccount: { id: 'kept' } }));
    const worktree = '/projects/myrepo/.kangentic/worktrees/fix-bug-abcd1234';
    const renames = vi.spyOn(fs.promises, 'rename');
    try {
      await ensureClaudeSpawnConfig(worktree);

      const data = readClaudeJson();
      expect(data.oauthAccount).toEqual({ id: 'kept' });
      expect(data.diffSidebarOpen).toBe(false);
      const entry = Object.values(data.projects as Record<string, Record<string, unknown>>)[0];
      expect(entry.hasTrustDialogAccepted).toBe(true);
      expect(entry.enabledMcpjsonServers).toEqual(['kangentic']);
      expect(renames).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(`${claudeJsonPath()}.lock`)).toBe(false);
    } finally {
      // Restored even when an assertion fails, or the spy stays on the shared
      // fs.promises for the rest of the file.
      renames.mockRestore();
    }
  });

  it('does not write when everything is already set', async () => {
    const worktree = '/projects/myrepo/.kangentic/worktrees/fix-bug-abcd1234';
    await ensureClaudeSpawnConfig(worktree);
    const renames = vi.spyOn(fs.promises, 'rename');
    const writes = vi.spyOn(fs.promises, 'writeFile');
    try {
      await ensureClaudeSpawnConfig(worktree);

      expect(renames).not.toHaveBeenCalled();
      expect(writes).not.toHaveBeenCalled();
    } finally {
      renames.mockRestore();
      writes.mockRestore();
    }
  });

  it('leaves a file that does not parse untouched rather than replacing it', async () => {
    const torn = '{"oauthAccount": {"id": "half-writ';
    fs.writeFileSync(claudeJsonPath(), torn);

    await ensureClaudeSpawnConfig('/projects/myrepo');

    expect(fs.readFileSync(claudeJsonPath(), 'utf-8')).toBe(torn);
  });

  // File modes and links are POSIX facts: Windows has no owner/group/other
  // bits, and creating a link there needs a privilege. These run on the Linux
  // CI runner and on macOS.
  describe.skipIf(process.platform === 'win32')('on a POSIX file system', () => {
    it('writes the file back with the mode it had, so a private file holding auth stays private', async () => {
      // 0600 is the private mode the file carries. A write that fell back to
      // the default mode (0666 less the umask) would also read 0600 under umask
      // 077, so 0400 is checked too: no ordinary umask turns 0666 into a
      // read-only file, so it fails whenever the file's own mode is not kept.
      for (const mode of [0o600, 0o400]) {
        fs.rmSync(claudeJsonPath(), { force: true });
        fs.writeFileSync(claudeJsonPath(), JSON.stringify({ oauthAccount: { id: 'kept' } }));
        fs.chmodSync(claudeJsonPath(), mode);

        await ensureClaudeSpawnConfig(`/projects/myrepo-${mode.toString(8)}/.kangentic/worktrees/fix-bug-abcd1234`);

        expect(fs.statSync(claudeJsonPath()).mode & 0o777).toBe(mode);
        // A write really happened; the mode alone would also hold on an untouched file.
        const data = readClaudeJson();
        expect(data.oauthAccount).toEqual({ id: 'kept' });
        expect(Object.keys(data.projects as Record<string, unknown>)).toHaveLength(1);
        expect(fs.readdirSync(tmpHome).filter((name) => name.endsWith('.tmp'))).toEqual([]);
      }
    });

    it('keeps a symlinked file a symlink, and updates the file it points at', async () => {
      const dotfiles = path.join(tmpHome, 'dotfiles');
      fs.mkdirSync(dotfiles);
      const target = path.join(dotfiles, 'claude.json');
      fs.writeFileSync(target, JSON.stringify({ oauthAccount: { id: 'kept' } }));
      fs.chmodSync(target, 0o600);
      fs.symlinkSync(target, claudeJsonPath());

      await ensureClaudeSpawnConfig('/projects/myrepo/.kangentic/worktrees/fix-bug-abcd1234');

      // The rename landed on the target, not on the link.
      expect(fs.lstatSync(claudeJsonPath()).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(claudeJsonPath())).toBe(target);
      const data = JSON.parse(fs.readFileSync(target, 'utf-8')) as Record<string, unknown>;
      expect(data.oauthAccount).toEqual({ id: 'kept' });
      const entry = Object.values(data.projects as Record<string, Record<string, unknown>>)[0];
      expect(entry.hasTrustDialogAccepted).toBe(true);
      expect(fs.statSync(target).mode & 0o777).toBe(0o600);
      // No temporary file is left beside the target or beside the link.
      expect(fs.readdirSync(dotfiles)).toEqual(['claude.json']);
      expect(fs.readdirSync(tmpHome).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    });
  });

  // A rename onto a file another process holds open is refused on Windows (a
  // scanner or indexer, or a sibling Claude rewriting it), usually for a moment.
  // `renameRetryingWhileHeld` tries up to 5 times, 50 ms longer each wait, and
  // `ensureClaudeSpawnConfig` writes in place when it is still refused, rather
  // than failing the spawn. The refusal is injected on `fs.promises.rename`,
  // which the source reaches through the same object. Real timers: the file I/O
  // is real libuv work, which fake timers do not step through, and the waits
  // are 50 + 100 ms at most for the retry cases and 500 ms for the exhausted one.
  describe('a rename refused while the file is held open', () => {
    const worktree = '/projects/myrepo/.kangentic/worktrees/fix-bug-abcd1234';

    function renameRefusal(code: string | undefined): NodeJS.ErrnoException {
      const error: NodeJS.ErrnoException = new Error(`rename refused: ${code ?? 'no code'}`);
      if (code !== undefined) error.code = code;
      return error;
    }

    function leftoverTemporaryFiles(): string[] {
      return fs.readdirSync(tmpHome).filter((name) => name.endsWith('.tmp'));
    }

    function seedClaudeJson(): void {
      fs.writeFileSync(claudeJsonPath(), JSON.stringify({ oauthAccount: { id: 'kept' } }));
    }

    function expectSpawnConfigWritten(): void {
      const data = readClaudeJson();
      expect(data.oauthAccount).toEqual({ id: 'kept' });
      expect(data.diffSidebarOpen).toBe(false);
      const entry = Object.values(data.projects as Record<string, Record<string, unknown>>)[0];
      expect(entry.hasTrustDialogAccepted).toBe(true);
      expect(entry.enabledMcpjsonServers).toEqual(['kangentic']);
    }

    // Pins the retry loop. Before it, the first refusal threw out of the spawn.
    // The third rename is the real one, so a loop that gave up early (a lower
    // attempt cap) would write in place after two and leave the count at 2.
    it('retries and renames once the hold is released', async () => {
      seedClaudeJson();
      const renames = vi.spyOn(fs.promises, 'rename')
        .mockRejectedValueOnce(renameRefusal('EPERM'))
        .mockRejectedValueOnce(renameRefusal('EPERM'));
      try {
        await ensureClaudeSpawnConfig(worktree);

        expect(renames).toHaveBeenCalledTimes(3);
        expectSpawnConfigWritten();
        expect(leftoverTemporaryFiles()).toEqual([]);
        expect(fs.existsSync(`${claudeJsonPath()}.lock`)).toBe(false);
      } finally {
        renames.mockRestore();
      }
    });

    // The three codes Windows uses for "held". One refusal each, so the retry
    // is what lands the write; a code missing from the held set would throw.
    it.each(['EACCES', 'EBUSY'])('treats %s as held too, and retries', async (code) => {
      seedClaudeJson();
      const renames = vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(renameRefusal(code));
      try {
        await ensureClaudeSpawnConfig(worktree);

        expect(renames).toHaveBeenCalledTimes(2);
        expectSpawnConfigWritten();
        expect(leftoverTemporaryFiles()).toEqual([]);
      } finally {
        renames.mockRestore();
      }
    });

    // Pins the in-place fallback: with every attempt refused, the file is still
    // updated (the only way is the direct write) and the spawn does not throw.
    // The attempt cap of 5 is pinned too: a loop that never gave up would hang
    // here, one that gave up early would count fewer renames.
    it('writes the file in place, and does not throw, when every attempt is refused', async () => {
      seedClaudeJson();
      let temporaryFileSeenAtRename = false;
      const renames = vi.spyOn(fs.promises, 'rename').mockImplementation(async () => {
        temporaryFileSeenAtRename ||= leftoverTemporaryFiles().length > 0;
        throw renameRefusal('EPERM');
      });
      try {
        await expect(ensureClaudeSpawnConfig(worktree)).resolves.toBeUndefined();

        expect(renames).toHaveBeenCalledTimes(5);
        expectSpawnConfigWritten();
        // The temp file existed when the rename was refused, so its absence now
        // is the cleanup and not a file that was never written.
        expect(temporaryFileSeenAtRename).toBe(true);
        expect(leftoverTemporaryFiles()).toEqual([]);
      } finally {
        renames.mockRestore();
      }
    });

    // The last resort fails too: the rename stays held, and the in-place write
    // truncates the file and then fails part way, so the file is short. The temp
    // file is then the one complete copy, so it is KEPT and the error names it,
    // which the spawn preamble reports and the user can recover from.
    //
    // Red-green: drop `keepTemporary = true` (or remove the temp file in the
    // catch). The `finally` then deletes the temp file, so the leftover-file and
    // the file-the-message-names assertions go red, and the complete copy is gone
    // for good. If the message stops naming the temp path, the `toContain` and the
    // read of the named file go red. The injected write leaves a short file, the
    // case the copy is kept for.
    it('keeps the temp file, which holds the complete contents, and names it in the error, when the in-place write leaves the file short', async () => {
      seedClaudeJson();
      const writeRefusal = new Error('disk full');
      const shortContents = '{"oauthAccount":';
      const realWriteFile = fs.promises.writeFile.bind(fs.promises);
      // Decided by suffix: the target is reached through its real path, which can
      // differ from the home's own spelling (a short Windows name, a macOS link).
      const writes = vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (...args: Parameters<typeof fs.promises.writeFile>) => {
        const [file] = args;
        if (String(file).endsWith('.tmp')) return realWriteFile(...args);
        // Truncated, part written, then failed: what an in-place write that
        // runs out of disk leaves behind.
        await realWriteFile(file, shortContents, 'utf-8');
        throw writeRefusal;
      });
      const renames = vi.spyOn(fs.promises, 'rename').mockImplementation(async () => {
        throw renameRefusal('EPERM');
      });
      try {
        const failure = await ensureClaudeSpawnConfig(worktree).then(
          () => null,
          (error: unknown) => error as Error & { cause?: unknown },
        );

        expect(failure).not.toBeNull();
        if (!failure) return;
        expect(renames).toHaveBeenCalledTimes(5);
        expect(failure.cause).toBe(writeRefusal);
        const [temporaryFile] = leftoverTemporaryFiles();
        expect(leftoverTemporaryFiles()).toEqual([`.claude.json.kangentic-${process.pid}.tmp`]);
        expect(failure.message).toMatch(/its complete contents are in /);
        expect(failure.message).toContain(temporaryFile);
        // The path in the message is the file that holds the complete new JSON.
        const lead = 'its complete contents are in ';
        const namedPath = failure.message.slice(failure.message.indexOf(lead) + lead.length);
        const recovered = JSON.parse(fs.readFileSync(namedPath, 'utf-8')) as Record<string, unknown>;
        expect(recovered.oauthAccount).toEqual({ id: 'kept' });
        expect(recovered.diffSidebarOpen).toBe(false);
        const entry = Object.values(recovered.projects as Record<string, Record<string, unknown>>)[0];
        expect(entry.hasTrustDialogAccepted).toBe(true);
        expect(entry.enabledMcpjsonServers).toEqual(['kangentic']);
        // The target is the short file, and the lock was released on the way out.
        expect(fs.readFileSync(claudeJsonPath(), 'utf-8')).toBe(shortContents);
        expect(fs.existsSync(`${claudeJsonPath()}.lock`)).toBe(false);
      } finally {
        writes.mockRestore();
        renames.mockRestore();
      }
    });

    // The usual Windows failure: the file is held open, so the in-place write is
    // refused at open, before it truncates anything. The file is whole, so no
    // copy of the user's auth is left behind, and the error names none.
    //
    // Red-green: keep the temp file whatever the target's state (drop the
    // `isIntact` check) and the leftover-file assertion goes red.
    it('removes the temp file, and names none, when the in-place write is refused before it touches the file', async () => {
      seedClaudeJson();
      const seeded = fs.readFileSync(claudeJsonPath(), 'utf-8');
      const writeRefusal = Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      const realWriteFile = fs.promises.writeFile.bind(fs.promises);
      const writes = vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (...args: Parameters<typeof fs.promises.writeFile>) => {
        const [file] = args;
        if (!String(file).endsWith('.tmp')) throw writeRefusal;
        return realWriteFile(...args);
      });
      const renames = vi.spyOn(fs.promises, 'rename').mockImplementation(async () => {
        throw renameRefusal('EPERM');
      });
      try {
        const failure = await ensureClaudeSpawnConfig(worktree).then(
          () => null,
          (error: unknown) => error as Error & { cause?: unknown },
        );

        expect(failure).not.toBeNull();
        if (!failure) return;
        expect(failure.cause).toBe(writeRefusal);
        expect(failure.message).not.toMatch(/complete contents/);
        expect(leftoverTemporaryFiles()).toEqual([]);
        expect(fs.readFileSync(claudeJsonPath(), 'utf-8')).toBe(seeded);
        expect(fs.existsSync(`${claudeJsonPath()}.lock`)).toBe(false);
      } finally {
        writes.mockRestore();
        renames.mockRestore();
      }
    });

    // A file that does not exist is whole: a failed write cannot have made it
    // short, so `isIntact` reads a missing file as intact and no copy is kept. The
    // rename is refused through its retries and the in-place write is refused
    // too, with nothing on disk to protect.
    //
    // Red-green: make `isIntact` read ENOENT as not intact (return false for it).
    // The temp file is then kept, the error names it, and the leftover-file and
    // message assertions go red.
    it('removes the temp file, and names none, when the file does not exist and the in-place write is refused', async () => {
      expect(fs.existsSync(claudeJsonPath())).toBe(false);
      const writeRefusal = Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      const realWriteFile = fs.promises.writeFile.bind(fs.promises);
      const writes = vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (...args: Parameters<typeof fs.promises.writeFile>) => {
        const [file] = args;
        if (!String(file).endsWith('.tmp')) throw writeRefusal;
        return realWriteFile(...args);
      });
      let temporaryFileSeenAtRename = false;
      const renames = vi.spyOn(fs.promises, 'rename').mockImplementation(async () => {
        temporaryFileSeenAtRename ||= leftoverTemporaryFiles().length > 0;
        throw renameRefusal('EPERM');
      });
      try {
        const failure = await ensureClaudeSpawnConfig(worktree).then(
          () => null,
          (error: unknown) => error as Error & { cause?: unknown },
        );

        expect(failure).not.toBeNull();
        if (!failure) return;
        expect(renames).toHaveBeenCalledTimes(5);
        expect(failure.cause).toBe(writeRefusal);
        expect(failure.message).not.toMatch(/complete contents/);
        expect(failure.message).not.toContain('.tmp');
        // The temp file existed when the rename was refused, so its absence now
        // is the cleanup and not a file that was never written.
        expect(temporaryFileSeenAtRename).toBe(true);
        expect(leftoverTemporaryFiles()).toEqual([]);
        expect(fs.existsSync(claudeJsonPath())).toBe(false);
        expect(fs.existsSync(`${claudeJsonPath()}.lock`)).toBe(false);
      } finally {
        writes.mockRestore();
        renames.mockRestore();
      }
    });

    // A copy an earlier failed write kept (here from another run, another pid)
    // holds nothing the file does not once a later write lands whole, so that
    // write removes it.
    //
    // Red-green: drop the `removeKeptCopies` call and the leftover-file
    // assertion goes red.
    it('removes a copy an earlier failed write kept once a later write succeeds', async () => {
      seedClaudeJson();
      const keptCopy = `${claudeJsonPath()}.kangentic-99999.tmp`;
      fs.writeFileSync(keptCopy, '{"oauthAccount":{"id":"kept"}}');
      // Something else beside it that only looks alike is left alone.
      const unrelated = path.join(tmpHome, '.claude.json.backup');
      fs.writeFileSync(unrelated, '{}');

      await ensureClaudeSpawnConfig(worktree);

      expectSpawnConfigWritten();
      expect(leftoverTemporaryFiles()).toEqual([]);
      expect(fs.existsSync(keptCopy)).toBe(false);
      expect(fs.existsSync(unrelated)).toBe(true);
    });

    /** A kept copy as another process (a pid that is not this one) leaves it. */
    function copyOfAnotherProcess(pidOffset: number): string {
      return `${claudeJsonPath()}.kangentic-${process.pid + pidOffset}.tmp`;
    }

    // The sweep reads the directory on the first successful write of a run, then
    // not on every spawn. Each test has its own home, so its target is new to the
    // module's per-run record of swept files.
    //
    // Red-green: drop the `!sweptTargets.has(targetPath)` gate so every write
    // sweeps and the second write removes the copy planted after the first, so
    // the last assertion goes red. Drop the sweep and the first assertion goes red.
    it('sweeps kept copies on the first successful write of a run, and not again on the next one', async () => {
      seedClaudeJson();
      const plantedBeforeFirstWrite = copyOfAnotherProcess(1);
      fs.writeFileSync(plantedBeforeFirstWrite, '{}');

      await ensureClaudeSpawnConfig(worktree);

      // Proves the first write swept: the check below would also hold for a
      // sweep that never runs.
      expect(fs.existsSync(plantedBeforeFirstWrite)).toBe(false);

      const plantedAfterFirstWrite = copyOfAnotherProcess(2);
      fs.writeFileSync(plantedAfterFirstWrite, '{}');

      // Another worktree, so the file changes and a second write really happens.
      await ensureClaudeSpawnConfig('/projects/other-repo/.kangentic/worktrees/other-bug-ef567890');

      expect(Object.keys(readClaudeJson().projects as Record<string, unknown>)).toHaveLength(2);
      expect(fs.existsSync(plantedAfterFirstWrite)).toBe(true);
    });

    // A failed write that keeps a copy re-arms the sweep, so the next successful
    // write sweeps again. The copy has to be swept from a target that was already
    // swept (a first write succeeded), or there is nothing to re-arm: an unswept
    // target sweeps on its next success anyway. This write's own kept copy shares
    // its name with the next write's temp file, which that write overwrites and
    // renames away, so it cannot show the sweep. A copy another process left
    // after the first sweep can, and only a re-armed sweep removes it.
    //
    // Red-green: drop `sweptTargets.delete(targetPath)` from the keep path in
    // writeClaudeJson. The target stays recorded as swept, the final write does
    // not read the directory, and the other process's copy is still there.
    it('sweeps again after a failed write kept a copy, once a later write succeeds', async () => {
      seedClaudeJson();
      await ensureClaudeSpawnConfig(worktree);
      const plantedAfterSweep = copyOfAnotherProcess(1);
      fs.writeFileSync(plantedAfterSweep, '{}');

      // The write that fails part way and keeps its own copy (the setup of the
      // "leaves the file short" test above), for another worktree so it writes.
      const realWriteFile = fs.promises.writeFile.bind(fs.promises);
      const writes = vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (...args: Parameters<typeof fs.promises.writeFile>) => {
        const [file] = args;
        if (String(file).endsWith('.tmp')) return realWriteFile(...args);
        await realWriteFile(file, '{"oauthAccount":', 'utf-8');
        throw new Error('disk full');
      });
      const renames = vi.spyOn(fs.promises, 'rename').mockImplementation(async () => {
        throw renameRefusal('EPERM');
      });
      try {
        await expect(ensureClaudeSpawnConfig('/projects/second-repo/.kangentic/worktrees/second-bug-12345678'))
          .rejects.toThrow(/its complete contents are in /);
      } finally {
        writes.mockRestore();
        renames.mockRestore();
      }

      // The failing write kept its own copy and did not sweep the other one.
      const keptCopy = path.join(tmpHome, `.claude.json.kangentic-${process.pid}.tmp`);
      expect(fs.existsSync(keptCopy)).toBe(true);
      expect(fs.existsSync(plantedAfterSweep)).toBe(true);

      // Repaired as a user would: the kept copy holds the complete contents.
      fs.copyFileSync(keptCopy, claudeJsonPath());

      await ensureClaudeSpawnConfig('/projects/third-repo/.kangentic/worktrees/third-bug-90abcdef');

      expect(Object.keys(readClaudeJson().projects as Record<string, unknown>)).toHaveLength(3);
      expect(fs.existsSync(plantedAfterSweep)).toBe(false);
      expect(leftoverTemporaryFiles()).toEqual([]);
    });

    // Pins that only the held codes are retried: any other failure is a real
    // fault, so it reaches the spawn preamble (which reports it) and the file is
    // not rewritten behind it. The cleanup still removes the temp file.
    it.each([['EXDEV'], [undefined]])('throws on a rename error that is not a held one (code %s), without retrying, and leaves no temp file', async (code) => {
      seedClaudeJson();
      const seeded = fs.readFileSync(claudeJsonPath(), 'utf-8');
      let temporaryFileSeenAtRename = false;
      const refusal = renameRefusal(code);
      const renames = vi.spyOn(fs.promises, 'rename').mockImplementation(async () => {
        temporaryFileSeenAtRename ||= leftoverTemporaryFiles().length > 0;
        throw refusal;
      });
      try {
        await expect(ensureClaudeSpawnConfig(worktree)).rejects.toBe(refusal);

        expect(renames).toHaveBeenCalledTimes(1);
        expect(temporaryFileSeenAtRename).toBe(true);
        expect(leftoverTemporaryFiles()).toEqual([]);
        // Not written in place either: a non-held failure does not fall back.
        expect(fs.readFileSync(claudeJsonPath(), 'utf-8')).toBe(seeded);
        expect(fs.existsSync(`${claudeJsonPath()}.lock`)).toBe(false);
      } finally {
        renames.mockRestore();
      }
    });
  });
});

function claudeJsonPath(): string {
  return path.join(tmpHome, '.claude.json');
}

function readClaudeJson(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(claudeJsonPath(), 'utf-8'));
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-'));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('ensureWorktreeTrust', () => {
  it('creates ~/.claude.json with trust entry when file does not exist', async () => {
    const wtPath = '/projects/myrepo/.kangentic/worktrees/fix-bug-abcd1234';

    await ensureWorktreeTrust(wtPath);

    const data = readClaudeJson();
    expect(data.projects).toBeDefined();

    const projects = data.projects as Record<string, Record<string, unknown>>;
    // path.resolve + toForwardSlash may transform the path -- find the entry
    const entries = Object.values(projects);
    expect(entries).toHaveLength(1);
    expect(entries[0].hasTrustDialogAccepted).toBe(true);
    // The write ran under Claude's own ~/.claude.json.lock and released it.
    expect(fs.existsSync(`${claudeJsonPath()}.lock`)).toBe(false);
  });

  it('creates trust entry when file exists but has no projects key', async () => {
    fs.writeFileSync(claudeJsonPath(), JSON.stringify({ someOtherKey: 42 }));

    const wtPath = '/projects/myrepo/.kangentic/worktrees/fix-bug-abcd1234';
    await ensureWorktreeTrust(wtPath);

    const data = readClaudeJson();
    expect(data.someOtherKey).toBe(42); // preserved
    const projects = data.projects as Record<string, Record<string, unknown>>;
    const entries = Object.values(projects);
    expect(entries).toHaveLength(1);
    expect(entries[0].hasTrustDialogAccepted).toBe(true);
  });

  it('skips write if worktree is already trusted (idempotent)', async () => {
    const wtPath = '/projects/myrepo/.kangentic/worktrees/fix-bug-abcd1234';

    // First call -- creates entry
    await ensureWorktreeTrust(wtPath);

    const data = readClaudeJson();

    // Second call -- should skip
    await ensureWorktreeTrust(wtPath);
    const data2 = readClaudeJson();

    // Content should be identical
    expect(data2).toEqual(data);
  });

  it('copies enabledMcpjsonServers from parent project entry', async () => {
    // The worktree path encodes the parent as everything before /.kangentic/worktrees/
    const parentPath = path.resolve('/projects/myrepo');
    const parentKey = parentPath.replace(/\\/g, '/');
    const wtPath = path.join(parentPath, '.kangentic', 'worktrees', 'fix-bug-abcd1234');

    // Pre-populate parent entry with MCP servers
    const existing = {
      projects: {
        [parentKey]: {
          hasTrustDialogAccepted: true,
          enabledMcpjsonServers: ['server-a', 'server-b'],
          allowedTools: ['Read'],
        },
      },
    };
    fs.writeFileSync(claudeJsonPath(), JSON.stringify(existing));

    await ensureWorktreeTrust(wtPath);

    const data = readClaudeJson();
    const projects = data.projects as Record<string, Record<string, unknown>>;

    // Find the worktree entry (not the parent)
    const wtEntries = Object.entries(projects).filter(
      ([key]) => key.includes('.kangentic/worktrees/'),
    );
    expect(wtEntries).toHaveLength(1);
    const [, wtEntry] = wtEntries[0];
    expect(wtEntry.enabledMcpjsonServers).toEqual(['server-a', 'server-b']);
    expect(wtEntry.hasTrustDialogAccepted).toBe(true);
  });

  it('uses empty array when parent has no MCP servers', async () => {
    const parentPath = path.resolve('/projects/myrepo');
    const parentKey = parentPath.replace(/\\/g, '/');
    const wtPath = path.join(parentPath, '.kangentic', 'worktrees', 'fix-bug-abcd1234');

    // Parent exists but has no enabledMcpjsonServers
    const existing = {
      projects: {
        [parentKey]: {
          hasTrustDialogAccepted: true,
        },
      },
    };
    fs.writeFileSync(claudeJsonPath(), JSON.stringify(existing));

    await ensureWorktreeTrust(wtPath);

    const data = readClaudeJson();
    const projects = data.projects as Record<string, Record<string, unknown>>;
    const wtEntries = Object.entries(projects).filter(
      ([key]) => key.includes('.kangentic/worktrees/'),
    );
    expect(wtEntries).toHaveLength(1);
    expect(wtEntries[0][1].enabledMcpjsonServers).toEqual([]);
  });

  it('preserves existing worktree entry fields while setting hasTrustDialogAccepted', async () => {
    const wtPath = '/projects/myrepo/.kangentic/worktrees/fix-bug-abcd1234';
    const resolvedKey = path.resolve(wtPath).replace(/\\/g, '/');

    // Pre-populate with a partial worktree entry (missing hasTrustDialogAccepted)
    const existing = {
      projects: {
        [resolvedKey]: {
          allowedTools: ['Bash', 'Read'],
          customField: 'keep-me',
        },
      },
    };
    fs.writeFileSync(claudeJsonPath(), JSON.stringify(existing));

    await ensureWorktreeTrust(wtPath);

    const data = readClaudeJson();
    const projects = data.projects as Record<string, Record<string, unknown>>;
    const entry = projects[resolvedKey];
    expect(entry.hasTrustDialogAccepted).toBe(true);
    expect(entry.customField).toBe('keep-me');
    // allowedTools from spread defaults gets overridden by existing entry's spread
    expect(entry.allowedTools).toEqual(['Bash', 'Read']);
  });

  // The file holds the user's auth and MCP state, and a torn read (the CLI
  // mid-write) must never be written back as a file holding one trust entry.
  // It used to be: the parse failure read as `{}`.
  it('leaves malformed JSON untouched rather than replacing it, and does not throw', async () => {
    const malformed = '{ this is not valid JSON !!!';
    fs.writeFileSync(claudeJsonPath(), malformed);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(ensureWorktreeTrust('/projects/myrepo/.kangentic/worktrees/fix-bug-abcd1234')).resolves.toBeUndefined();

      expect(fs.readFileSync(claudeJsonPath(), 'utf-8')).toBe(malformed);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('leaves a file that parses to something other than an object untouched', async () => {
    fs.writeFileSync(claudeJsonPath(), '[]');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await ensureWorktreeTrust('/projects/myrepo/.kangentic/worktrees/fix-bug-abcd1234');

      expect(fs.readFileSync(claudeJsonPath(), 'utf-8')).toBe('[]');
    } finally {
      warn.mockRestore();
    }
  });

  it('writes through a temp file and a rename, so the CLI never reads a torn file', async () => {
    fs.writeFileSync(claudeJsonPath(), JSON.stringify({ oauthAccount: { id: 'kept' } }));
    const renames = vi.spyOn(fs.promises, 'rename');
    try {
      await ensureWorktreeTrust('/projects/myrepo/.kangentic/worktrees/fix-bug-abcd1234');

      expect(renames).toHaveBeenCalledTimes(1);
      expect(readClaudeJson().oauthAccount).toEqual({ id: 'kept' });
      expect(fs.readdirSync(tmpHome).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      renames.mockRestore();
    }
  });
});

describe('ensureMcpServerTrust', () => {
  it('adds kangentic to enabledMcpjsonServers when file does not exist', async () => {
    const projectPath = '/projects/myrepo';
    await ensureMcpServerTrust(projectPath);

    const data = readClaudeJson();
    const projects = data.projects as Record<string, Record<string, unknown>>;
    const entries = Object.values(projects);
    expect(entries).toHaveLength(1);
    expect(entries[0].enabledMcpjsonServers).toContain('kangentic');
  });

  it('adds kangentic to existing enabledMcpjsonServers without duplicating', async () => {
    const projectPath = '/projects/myrepo';
    const resolvedKey = path.resolve(projectPath).replace(/\\/g, '/');

    // Pre-populate with existing MCP servers
    const existing = {
      projects: {
        [resolvedKey]: {
          enabledMcpjsonServers: ['server-a', 'server-b'],
          hasTrustDialogAccepted: true,
        },
      },
    };
    fs.writeFileSync(claudeJsonPath(), JSON.stringify(existing));

    await ensureMcpServerTrust(projectPath);

    const data = readClaudeJson();
    const projects = data.projects as Record<string, Record<string, unknown>>;
    const entry = projects[resolvedKey];
    const servers = entry.enabledMcpjsonServers as string[];
    expect(servers).toContain('kangentic');
    expect(servers).toContain('server-a');
    expect(servers).toContain('server-b');
    expect(servers.filter((server) => server === 'kangentic')).toHaveLength(1);
  });

  it('is idempotent -- skips write if kangentic already present', async () => {
    const projectPath = '/projects/myrepo';
    const resolvedKey = path.resolve(projectPath).replace(/\\/g, '/');

    const existing = {
      projects: {
        [resolvedKey]: {
          enabledMcpjsonServers: ['kangentic'],
        },
      },
    };
    fs.writeFileSync(claudeJsonPath(), JSON.stringify(existing));

    // Record mtime before second call
    const statBefore = fs.statSync(claudeJsonPath()).mtimeMs;

    await ensureMcpServerTrust(projectPath);

    // Content should be unchanged
    const data = readClaudeJson();
    const projects = data.projects as Record<string, Record<string, unknown>>;
    const servers = projects[resolvedKey].enabledMcpjsonServers as string[];
    expect(servers).toEqual(['kangentic']);
  });

  it('creates project entry when none exists', async () => {
    fs.writeFileSync(claudeJsonPath(), JSON.stringify({ projects: {} }));

    const projectPath = '/projects/brand-new';
    await ensureMcpServerTrust(projectPath);

    const data = readClaudeJson();
    const projects = data.projects as Record<string, Record<string, unknown>>;
    const resolvedKey = path.resolve(projectPath).replace(/\\/g, '/');
    expect(projects[resolvedKey].enabledMcpjsonServers).toContain('kangentic');
  });

  it('leaves malformed JSON untouched rather than replacing it', async () => {
    const torn = '{"oauthAccount": {"id": "half-writ';
    fs.writeFileSync(claudeJsonPath(), torn);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(ensureMcpServerTrust('/projects/myrepo')).resolves.toBeUndefined();

      expect(fs.readFileSync(claudeJsonPath(), 'utf-8')).toBe(torn);
    } finally {
      warn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Concurrent access (serialization via withClaudeJsonLock)
// ---------------------------------------------------------------------------

describe('Concurrent trust writes', () => {
  it('5 concurrent ensureWorktreeTrust calls - all entries present', async () => {
    const paths = Array.from({ length: 5 }, (_, index) =>
      `/projects/myrepo/.kangentic/worktrees/task-${index}`,
    );

    await Promise.all(paths.map(worktreePath => ensureWorktreeTrust(worktreePath)));

    const data = readClaudeJson();
    const projects = data.projects as Record<string, Record<string, unknown>>;
    const entries = Object.values(projects);

    expect(entries).toHaveLength(5);
    for (const entry of entries) {
      expect(entry.hasTrustDialogAccepted).toBe(true);
    }
  });

  it('5 concurrent ensureMcpServerTrust calls - all kangentic entries present', async () => {
    const paths = Array.from({ length: 5 }, (_, index) =>
      `/projects/repo-${index}`,
    );

    await Promise.all(paths.map(projectPath => ensureMcpServerTrust(projectPath)));

    const data = readClaudeJson();
    const projects = data.projects as Record<string, Record<string, unknown>>;
    const entries = Object.values(projects);

    expect(entries).toHaveLength(5);
    for (const entry of entries) {
      expect((entry.enabledMcpjsonServers as string[])).toContain('kangentic');
    }
  });

  it('mixed concurrent trust + MCP calls - no entries lost', async () => {
    const trustPaths = Array.from({ length: 3 }, (_, index) =>
      `/projects/myrepo/.kangentic/worktrees/task-${index}`,
    );
    const mcpPaths = Array.from({ length: 3 }, (_, index) =>
      `/projects/mcp-repo-${index}`,
    );

    await Promise.all([
      ...trustPaths.map(worktreePath => ensureWorktreeTrust(worktreePath)),
      ...mcpPaths.map(projectPath => ensureMcpServerTrust(projectPath)),
    ]);

    const data = readClaudeJson();
    const projects = data.projects as Record<string, Record<string, unknown>>;
    const entries = Object.entries(projects);

    // Should have all 6 entries (3 trust + 3 MCP)
    expect(entries).toHaveLength(6);

    // Verify trust entries
    const trustEntries = entries.filter(([key]) => key.includes('.kangentic/worktrees/'));
    expect(trustEntries).toHaveLength(3);
    for (const [, entry] of trustEntries) {
      expect(entry.hasTrustDialogAccepted).toBe(true);
    }

    // Verify MCP entries
    const mcpEntries = entries.filter(([key]) => key.includes('mcp-repo'));
    expect(mcpEntries).toHaveLength(3);
    for (const [, entry] of mcpEntries) {
      expect((entry.enabledMcpjsonServers as string[])).toContain('kangentic');
    }
  });

  it('already-trusted path returns early without write (idempotent)', async () => {
    const worktreePath = '/projects/myrepo/.kangentic/worktrees/task-0';

    await ensureWorktreeTrust(worktreePath);
    const dataBefore = readClaudeJson();

    // Second call should be a no-op
    await ensureWorktreeTrust(worktreePath);
    const dataAfter = readClaudeJson();

    expect(dataAfter).toEqual(dataBefore);
  });
});
