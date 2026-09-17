/**
 * `resolveByWorktree` (tests/ui/mock-electron-api.js) is the shared lookup a per-worktree fixture
 * map (window.__mock*ByWorktree) goes through for git.branchSummary, git.commitGraph,
 * git.fileHistory, and git.blame, so the sample install can seed a scaffolded project's real
 * history per task. Before this refactor, git.commitGraph, git.fileHistory, and git.blame were
 * each declared as `async function ()`: the request argument was never read at all, so any
 * worktreePath or filePath the renderer sent was silently discarded and every task saw the same
 * empty default, no matter which worktree its Changes or History pane asked about.
 *
 * This drives the PUBLIC git.* methods through a `node:vm` evaluation of the real mock (mirroring
 * mock-electron-api-parity.test.ts's loadMockElectronApi), rather than calling the private
 * resolveByWorktree helper in isolation, so it pins the whole wiring: the request argument being
 * read at all, the helper's own last-segment-then-substring resolution order, and the per-file
 * gating that fileHistory/blame layer on top of it.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const MOCK_ELECTRON_API_PATH = path.resolve(__dirname, '..', 'ui', 'mock-electron-api.js');

type MockObject = Record<string, unknown>;

function isMockObject(value: unknown): value is MockObject {
  return typeof value === 'object' && value !== null;
}

interface CommitGraphResult {
  commits: unknown[];
  tipHash: string | null;
  baseHash: string | null;
  mergeBaseHash: string | null;
  currentBranch: string | null;
  truncated: boolean;
}

interface BranchSummaryResult {
  currentBranch: string | null;
  ahead: number;
  behind: number;
  lastCommit: unknown;
}

interface FileHistoryResult {
  commits: unknown[];
}

interface BlameResult {
  lines: unknown[];
}

interface GitBridge {
  branchSummary: (request: { worktreePath?: string }) => Promise<BranchSummaryResult>;
  commitGraph: (request: { worktreePath?: string }) => Promise<CommitGraphResult>;
  fileHistory: (request: { worktreePath?: string; filePath?: string }) => Promise<FileHistoryResult>;
  blame: (request: { worktreePath?: string; filePath?: string }) => Promise<BlameResult>;
}

interface LoadedMock {
  window: MockObject;
  git: GitBridge;
}

/**
 * Loads tests/ui/mock-electron-api.js the way a page would: a classic-script IIFE run in a fresh
 * `node:vm` context with a minimal `window`, so `window.__mock*ByWorktree` can be set on the SAME
 * window object the mock's git.* methods read from. Mirrors
 * mock-electron-api-parity.test.ts's loadMockElectronApi.
 */
function loadMockGitBridge(): LoadedMock {
  const source = fs.readFileSync(MOCK_ELECTRON_API_PATH, 'utf-8');
  const windowObject: MockObject = {};
  windowObject.window = windowObject;
  const sandbox: MockObject = {
    window: windowObject,
    document: undefined,
    crypto: webcrypto,
    setTimeout,
    clearTimeout,
    console,
  };
  vm.runInNewContext(source, sandbox, { filename: MOCK_ELECTRON_API_PATH, timeout: 5000 });
  const electronApi = windowObject.electronAPI;
  if (!isMockObject(electronApi) || !isMockObject(electronApi.git)) {
    throw new Error('mock-electron-api-worktree-fixtures: window.electronAPI.git was not assigned.');
  }
  return { window: windowObject, git: electronApi.git as unknown as GitBridge };
}

describe('git.* per-worktree fixture resolution (resolveByWorktree)', () => {
  it('prefers the EXACT last-segment match over a shorter folder name that is merely a substring of it, with either path separator', async () => {
    const { window, git } = loadMockGitBridge();
    // 'fix-websocket' is a substring of 'fix-websocket-abc123' and sorts first in Object.keys
    // order, so if the substring scan ran before (or instead of) the exact last-segment check,
    // it would win and this would resolve to the WRONG worktree's summary. This is exactly the
    // risk resolveByWorktree's own comment documents.
    window.__mockBranchSummaryByWorktree = {
      'fix-websocket': { currentBranch: 'wrong-prefix-match', ahead: 0, behind: 0, lastCommit: null },
      'fix-websocket-abc123': { currentBranch: 'fix-websocket-reconnection', ahead: 1, behind: 0, lastCommit: null },
    };
    const forwardSlashPath = 'C:/Users/dev/work/contoso-web/.kangentic/worktrees/fix-websocket-abc123';
    const forwardSlash = await git.branchSummary({ worktreePath: forwardSlashPath });
    expect(forwardSlash.currentBranch).toBe('fix-websocket-reconnection');

    const backslashPath = 'C:\\Users\\dev\\work\\contoso-web\\.kangentic\\worktrees\\fix-websocket-abc123';
    const backslash = await git.branchSummary({ worktreePath: backslashPath });
    expect(backslash.currentBranch).toBe('fix-websocket-reconnection');
  });

  it('falls back to a substring scan when the folder is neither the path\'s last nor second-to-last segment', async () => {
    const { window, git } = loadMockGitBridge();
    window.__mockCommitGraphByWorktree = {
      'auth-middleware-def456': { commits: [], tipHash: 'abc123', baseHash: 'abc123', mergeBaseHash: 'abc123', currentBranch: 'extract-auth-middleware', truncated: false },
    };
    // The worktree folder is neither the last segment ("routes.ts") nor the one before it
    // ("server"), so only the unanchored substring scan documented on resolveByWorktree can
    // resolve this.
    const worktreePath = 'C:/Users/dev/work/contoso-web/.kangentic/worktrees/auth-middleware-def456/server/routes.ts';
    const result = await git.commitGraph({ worktreePath });
    expect(result.tipHash).toBe('abc123');
  });

  it('returns the documented empty default, without throwing, when no worktree fixture matches', async () => {
    const { git } = loadMockGitBridge();
    const commitGraph = await git.commitGraph({ worktreePath: 'C:/Users/dev/work/contoso-web/.kangentic/worktrees/unseeded-folder' });
    expect(commitGraph).toEqual({ commits: [], tipHash: null, baseHash: null, mergeBaseHash: null, currentBranch: null, truncated: false });

    const branchSummary = await git.branchSummary({});
    expect(branchSummary).toEqual({ currentBranch: null, ahead: 0, behind: 0, lastCommit: null });
  });

  it('resolves fileHistory and blame per worktree AND per file, defaulting a file the worktree does not carry', async () => {
    const { window, git } = loadMockGitBridge();
    window.__mockFileHistoryByWorktree = {
      'api-types-ghi789': {
        'src/types/api.ts': { commits: [{ hash: 'h1', shortHash: 'h1', authorName: 'A', authorTimestamp: '2026-01-01T00:00:00.000Z', subject: 'add types' }] },
      },
    };
    window.__mockBlameByWorktree = {
      'api-types-ghi789': {
        'src/types/api.ts': { lines: [{ line: 1, hash: 'h1', shortHash: 'h1', author: 'A', date: '2026-01-01T00:00:00.000Z' }] },
      },
    };
    const worktreePath = 'C:/Users/dev/work/contoso-web/.kangentic/worktrees/api-types-ghi789';

    const history = await git.fileHistory({ worktreePath, filePath: 'src/types/api.ts' });
    expect(history.commits).toHaveLength(1);

    const blame = await git.blame({ worktreePath, filePath: 'src/types/api.ts' });
    expect(blame.lines).toHaveLength(1);

    // The worktree itself resolves, but this file is not one of ITS entries: the empty default,
    // not another file's history, must come back.
    const missingFile = await git.fileHistory({ worktreePath, filePath: 'src/other.ts' });
    expect(missingFile).toEqual({ commits: [] });
  });
});
