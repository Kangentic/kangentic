/**
 * An image in the Changes panel for a project on an SSH host (#913): the working-tree side is read through the
 * host runner, with the same fingerprint and racy-window rules as a local file, and a host that cannot be asked
 * rejects instead of reading as an unreadable image.
 *
 * What a user loses if it breaks: a changed image that never refreshes (a stale fingerprint trusted), is re-sent
 * on every poll, or a down link that shows "unreadable" and replaces the picture the panel already had.
 *
 * Runs the real `DiffService.getImageContent` over a fake runner, so it needs no host and runs everywhere.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DiffService, RACY_FINGERPRINT_SUFFIX } from '../../src/main/git/diff-service';
import { RemoteGitUnavailableError, setRemoteGitResolver, type RemoteGitRunner, type RemoteWorkingFile } from '../../src/main/git/remote-git';
import type { GitFileImageInput } from '../../src/shared/types';

const IMAGE_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);

/** The empty stand-in folder; `gitAt` insists it exists, though no git runs in it. */
let directory: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-remote-image-'));
});

afterEach(() => {
  setRemoteGitResolver(null);
  fs.rmSync(directory, { recursive: true, force: true });
});

function serve(overrides: Partial<RemoteGitRunner>): void {
  const unexpected = (name: string) => async (): Promise<never> => { throw new Error(`${name} was not expected`); };
  const runner: RemoteGitRunner = {
    run: unexpected('run'),
    readObject: unexpected('readObject'),
    readWorkingFile: unexpected('readWorkingFile'),
    countUntracked: unexpected('countUntracked'),
    fingerprint: unexpected('fingerprint'),
    ...overrides,
  };
  setRemoteGitResolver(() => runner);
}

function serveFile(file: RemoteWorkingFile): void {
  serve({ readWorkingFile: async () => file });
}

/** An untracked image: only the working-tree side exists. */
const untracked = (knownModified?: string): GitFileImageInput => ({

  baseBranch: 'main',
  scope: 'working',
  projectPath: directory,
  worktreePath: directory,
  filePath: 'logo.png',
  status: 'U',
  ...(knownModified ? { knownFingerprints: { modified: knownModified } } : {}),
});

describe('a working-tree image on a host', () => {
  it('answers unchanged, without bytes, when the fingerprint the caller holds matches an old modification time', async () => {
    const mtimeMs = Date.now() - 60_000;
    serveFile({ kind: 'bytes', bytes: IMAGE_BYTES, mtimeMs });
    const fingerprint = `file:${IMAGE_BYTES.length}:${mtimeMs}`;

    const result = await new DiffService(directory).getImageContent(untracked(fingerprint));

    expect(result.modified).toEqual({ kind: 'unchanged', fingerprint });
  });

  it('reads a settled file the caller does not hold, and gives it a fingerprint with no racy suffix', async () => {
    const mtimeMs = Date.now() - 60_000;
    serveFile({ kind: 'bytes', bytes: IMAGE_BYTES, mtimeMs });

    const result = await new DiffService(directory).getImageContent(untracked('file:1:1'));

    expect(result.modified).toMatchObject({ kind: 'bytes', size: IMAGE_BYTES.length, fingerprint: `file:${IMAGE_BYTES.length}:${mtimeMs}` });
  });

  it('never answers unchanged for a file written inside the last two seconds, and marks its fingerprint racy', async () => {
    const mtimeMs = Date.now() - 100;
    serveFile({ kind: 'bytes', bytes: IMAGE_BYTES, mtimeMs });
    const settled = `file:${IMAGE_BYTES.length}:${mtimeMs}`;

    const result = await new DiffService(directory).getImageContent(untracked(settled));

    expect(result.modified?.kind).toBe('bytes');
    expect(result.modified).toMatchObject({ fingerprint: `${settled}${RACY_FINGERPRINT_SUFFIX}` });
  });

  it('answers too-large with the size the host reported, and a fingerprint, for a file over the cap', async () => {
    const mtimeMs = Date.now() - 60_000;
    serveFile({ kind: 'too-large', size: 99_000_000, mtimeMs });

    const result = await new DiffService(directory).getImageContent(untracked());

    expect(result.modified).toEqual({ kind: 'too-large', size: 99_000_000, fingerprint: `file:99000000:${mtimeMs}` });
  });

  it('reads a file the host does not have as unreadable', async () => {
    serveFile({ kind: 'missing' });
    const result = await new DiffService(directory).getImageContent(untracked());
    expect(result.modified).toEqual({ kind: 'unreadable' });
  });
});

describe('a host that cannot be asked for an image', () => {
  it('rejects for a working-tree side, and does not read it as unreadable', async () => {
    serve({ readWorkingFile: async () => { throw new RemoteGitUnavailableError('The link to the host is down.'); } });
    await expect(new DiffService(directory).getImageContent(untracked())).rejects.toBeInstanceOf(RemoteGitUnavailableError);
  });

  it('rejects for a revision side, and does not read it as unreadable', async () => {
    serve({ readObject: async () => { throw new RemoteGitUnavailableError('The link to the host is down.'); } });
    // A deleted file has only its original side, read from the index under the working scope.
    const deleted: GitFileImageInput = { ...untracked(), status: 'D' };
    await expect(new DiffService(directory).getImageContent(deleted)).rejects.toBeInstanceOf(RemoteGitUnavailableError);
  });
});
