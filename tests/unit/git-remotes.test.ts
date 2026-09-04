import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  stdout: '',
  rawError: null as Error | null,
  constructError: null as Error | null,
  rawCalls: 0,
}));

vi.mock('simple-git', () => ({
  simpleGit: () => {
    // simpleGit() itself throws synchronously when the directory is missing,
    // which is why the production constructor call sits inside the try.
    if (state.constructError) throw state.constructError;
    return {
      raw: async () => {
        state.rawCalls += 1;
        if (state.rawError) throw state.rawError;
        return state.stdout;
      },
    };
  },
}));

const { readRemoteUrls, invalidateRemoteUrlsCache } = await import('../../src/main/git/git-remotes');

const AZURE = 'git@ssh.dev.azure.com:v3/SOA-DCCED/AOGCC%20AKWISE/AKWISE';
const GITHUB = 'https://github.com/owner/repo.git';

beforeEach(() => {
  state.stdout = '';
  state.rawError = null;
  state.constructError = null;
  state.rawCalls = 0;
  invalidateRemoteUrlsCache();
});

describe('readRemoteUrls', () => {
  it('parses `git remote -v` and drops the push twin of each pair', async () => {
    state.stdout = `origin\t${AZURE} (fetch)\norigin\t${AZURE} (push)\n`;
    await expect(readRemoteUrls('/repo')).resolves.toEqual([AZURE]);
  });

  // Ownership is decided on the primary remote, so origin has to come first.
  it('orders origin first, whatever git printed', async () => {
    state.stdout = [
      `upstream\t${GITHUB} (fetch)`,
      `upstream\t${GITHUB} (push)`,
      `origin\t${AZURE} (fetch)`,
      `origin\t${AZURE} (push)`,
    ].join('\n');
    await expect(readRemoteUrls('/repo')).resolves.toEqual([AZURE, GITHUB]);
  });

  it('tolerates CRLF line endings', async () => {
    state.stdout = `origin\t${AZURE} (fetch)\r\norigin\t${AZURE} (push)\r\n`;
    await expect(readRemoteUrls('/repo')).resolves.toEqual([AZURE]);
  });

  // A real repo with no remotes, distinct from "could not read".
  it('returns [] for a repo with no remotes', async () => {
    state.stdout = '';
    await expect(readRemoteUrls('/repo')).resolves.toEqual([]);
  });

  it('returns null when git errors', async () => {
    state.rawError = new Error('not a git repository');
    await expect(readRemoteUrls('/repo')).resolves.toBeNull();
  });

  it('returns null when the directory is missing', async () => {
    state.constructError = new Error('ENOENT');
    await expect(readRemoteUrls('/gone')).resolves.toBeNull();
  });

  /**
   * NEVER REJECTS. A rejection would reach pr-linking.ts as a non-PRResolver
   * error, which is the one shape that can clear a task's PR link.
   */
  it('never rejects, whatever git does', async () => {
    state.rawError = new Error('boom');
    await expect(readRemoteUrls('/repo')).resolves.toBeNull();

    invalidateRemoteUrlsCache();
    state.rawError = null;
    state.constructError = new Error('boom');
    await expect(readRemoteUrls('/repo')).resolves.toBeNull();
  });

  it('caches, so a sweep over many tasks in one repo spawns one git', async () => {
    state.stdout = `origin\t${AZURE} (fetch)\n`;
    await readRemoteUrls('/repo');
    await readRemoteUrls('/repo');
    expect(state.rawCalls).toBe(1);
  });

  it('invalidation forces a re-read', async () => {
    state.stdout = `origin\t${AZURE} (fetch)\n`;
    await readRemoteUrls('/repo');
    invalidateRemoteUrlsCache('/repo');
    await readRemoteUrls('/repo');
    expect(state.rawCalls).toBe(2);
  });

  it('concurrent callers share one git invocation', async () => {
    state.stdout = `origin\t${AZURE} (fetch)\n`;
    const [first, second] = await Promise.all([readRemoteUrls('/repo'), readRemoteUrls('/repo')]);
    expect(state.rawCalls).toBe(1);
    expect(first).toEqual(second);
  });

  it('returns null for an empty path without touching git', async () => {
    await expect(readRemoteUrls('')).resolves.toBeNull();
    expect(state.rawCalls).toBe(0);
  });

  /**
   * THE FIX under test: the line parser's URL group used to be `\S+`, which
   * cannot match a remote URL containing a space. A local-filesystem remote
   * under a path with a space (a "My Repos" folder, or any "OneDrive -
   * <Company>" sync folder) produced a line the old regex matched no part
   * of, so the whole line was silently dropped - and a repo whose ONLY
   * remote was that one read back as `[]`, indistinguishable from "no
   * remotes configured", which makes dispatch confidently (and wrongly)
   * report that no connector owns the repo. The URL group is now `.+?`
   * (non-greedy, with the fetch/push marker captured and filtered instead of
   * baked into the pattern), so a spacey URL round-trips intact.
   *
   * Deliberately a generic placeholder path, never a real user's home
   * directory (.claude/rules/no-personal-info.md), and a plain string
   * literal rather than any `path.*` call, since backslashes are literal
   * characters on Linux CI (.claude/rules/cross-platform-parity.md).
   */
  describe('remote URLs containing spaces', () => {
    const SPACEY_FETCH_URL = 'C:\\Users\\dev\\My Repos\\thing';

    it('keeps a remote URL that contains spaces intact, rather than dropping the line', async () => {
      state.stdout = `origin\t${SPACEY_FETCH_URL} (fetch)\norigin\t${SPACEY_FETCH_URL} (push)\n`;
      await expect(readRemoteUrls('/repo')).resolves.toEqual([SPACEY_FETCH_URL]);
    });

    it('drops the push twin of a spacey remote, even when its text differs from the fetch URL', async () => {
      // A different push URL (rather than a byte-identical twin) proves the
      // push LINE itself is filtered by its captured (push) marker, not
      // merely deduplicated because both lines happened to read the same.
      const pushUrl = `${SPACEY_FETCH_URL}-push-mirror`;
      state.stdout = `origin\t${SPACEY_FETCH_URL} (fetch)\norigin\t${pushUrl} (push)\n`;
      await expect(readRemoteUrls('/repo')).resolves.toEqual([SPACEY_FETCH_URL]);
    });
  });
});
