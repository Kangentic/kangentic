/**
 * Unit tests for `refreshTransientBranchesFromHead` on TransientSessionSlice.
 *
 * The branch a Command Terminal shows is a PER-PROJECT fact: every terminal of
 * a project runs in the same project root and shares one HEAD, which the
 * user's own git usage, task spawns, and the agents inside the terminals all
 * move. The slice action reads that HEAD once and rewrites every entry of the
 * project that disagrees, mirroring each change to main.
 *
 * Same set/get harness as tests/unit/transient-session-label.test.ts, with
 * `window.electronAPI.git.worktreeHead` and `.sessions.setTransientBranch`
 * stubbed on globalThis.
 *
 * Red-green: skipping the per-entry compare fails the "no IPC when unchanged"
 * case; dropping the detached-HEAD mapping fails the short-sha case; dropping
 * the in-flight guard fails the coalescing case.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/renderer/stores/project-store', () => ({
  useProjectStore: {
    getState: vi.fn(() => ({ currentProject: null })),
  },
}));

import {
  createTransientSessionSlice,
  transientKey,
  type TransientSessionEntry,
} from '../../src/renderer/stores/session-store/transient-session-slice';
import type { SessionStore } from '../../src/renderer/stores/session-store/types';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeSliceStore(initial?: { transientSessions?: Record<string, TransientSessionEntry> }) {
  let state: Pick<SessionStore, 'transientSessions'> & Record<string, unknown> = {
    transientSessions: initial?.transientSessions ?? {},
    sessions: [],
    _sessionByTaskId: new Map(),
    sessionUsage: {},
    sessionFirstOutput: {},
    sessionActivity: {},
    sessionEvents: {},
    seenIdleSessions: {},
    commandBarVisible: false,
  };

  const get = () => state as unknown as SessionStore;

  const set = (updater: Partial<SessionStore> | ((prev: SessionStore) => Partial<SessionStore>)) => {
    if (typeof updater === 'function') {
      const partial = updater(state as unknown as SessionStore);
      if (partial !== (state as unknown)) {
        state = { ...state, ...partial };
      }
    } else {
      state = { ...state, ...updater };
    }
  };

  const sliceCreator = createTransientSessionSlice(undefined);
  const slice = sliceCreator(set as unknown as Parameters<typeof sliceCreator>[0], get, {} as unknown as Parameters<typeof sliceCreator>[2]);

  return {
    slice,
    getState: () => state,
  };
}

function entry(overrides: Partial<TransientSessionEntry> & Pick<TransientSessionEntry, 'projectId' | 'slot' | 'sessionId'>): TransientSessionEntry {
  return { branch: null, ...overrides };
}

type HeadResult = { branch: string | null; sha: string | null };

interface ElectronApiStub {
  worktreeHead: ReturnType<typeof vi.fn>;
  setTransientBranch: ReturnType<typeof vi.fn>;
}

/** Stub the two bridge calls the refresh uses, on globalThis as the sibling suites do. */
function setupElectronApi(
  worktreeHeadImpl: (input: { path: string }) => Promise<HeadResult>,
  setTransientBranchImpl: (sessionId: string, branch: string) => Promise<void> = async () => {},
): ElectronApiStub {
  const worktreeHead = vi.fn(worktreeHeadImpl);
  const setTransientBranch = vi.fn(setTransientBranchImpl);
  const globalWindow = globalThis as unknown as { window: { electronAPI: unknown } };
  (globalThis as unknown as { window?: unknown }).window = globalWindow.window ?? {};
  globalWindow.window.electronAPI = {
    git: { worktreeHead },
    sessions: { setTransientBranch },
  };
  return { worktreeHead, setTransientBranch };
}

const PROJECT_PATH = '/mock/project';

function twoTerminalsAndAnotherProject(): Record<string, TransientSessionEntry> {
  return {
    [transientKey('proj-1', 'slot-1')]: entry({ projectId: 'proj-1', slot: 'slot-1', sessionId: 'sess-a', branch: 'main' }),
    [transientKey('proj-1', 'slot-2')]: entry({ projectId: 'proj-1', slot: 'slot-2', sessionId: 'sess-b', branch: 'main' }),
    [transientKey('proj-2', 'slot-1')]: entry({ projectId: 'proj-2', slot: 'slot-1', sessionId: 'sess-c', branch: 'main' }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  setupElectronApi(async () => ({ branch: null, sha: null }));
});

describe('refreshTransientBranchesFromHead', () => {
  it('rewrites every entry of the project to the live branch and mirrors each change once', async () => {
    const api = setupElectronApi(async () => ({ branch: 'feature/auth', sha: 'abc1234def' }));
    const { slice, getState } = makeSliceStore({ transientSessions: twoTerminalsAndAnotherProject() });

    await slice.refreshTransientBranchesFromHead('proj-1', PROJECT_PATH);

    expect(api.worktreeHead).toHaveBeenCalledTimes(1);
    expect(api.worktreeHead).toHaveBeenCalledWith({ path: PROJECT_PATH });
    expect(getState().transientSessions[transientKey('proj-1', 'slot-1')]?.branch).toBe('feature/auth');
    expect(getState().transientSessions[transientKey('proj-1', 'slot-2')]?.branch).toBe('feature/auth');
    // Another project's terminals sit on a different checkout; untouched.
    expect(getState().transientSessions[transientKey('proj-2', 'slot-1')]?.branch).toBe('main');
    expect(api.setTransientBranch).toHaveBeenCalledTimes(2);
    expect(api.setTransientBranch).toHaveBeenCalledWith('sess-a', 'feature/auth');
    expect(api.setTransientBranch).toHaveBeenCalledWith('sess-b', 'feature/auth');
  });

  it('issues no IPC when HEAD already matches every entry', async () => {
    const api = setupElectronApi(async () => ({ branch: 'main', sha: 'abc1234def' }));
    const initialMap = twoTerminalsAndAnotherProject();
    const { slice, getState } = makeSliceStore({ transientSessions: initialMap });

    await slice.refreshTransientBranchesFromHead('proj-1', PROJECT_PATH);

    expect(getState().transientSessions).toStrictEqual(initialMap);
    expect(api.setTransientBranch).not.toHaveBeenCalled();
  });

  it('leaves the entries alone when HEAD is unknown (git error: branch and sha both null)', async () => {
    const api = setupElectronApi(async () => ({ branch: null, sha: null }));
    const initialMap = twoTerminalsAndAnotherProject();
    const { slice, getState } = makeSliceStore({ transientSessions: initialMap });

    await slice.refreshTransientBranchesFromHead('proj-1', PROJECT_PATH);

    expect(getState().transientSessions).toStrictEqual(initialMap);
    expect(api.setTransientBranch).not.toHaveBeenCalled();
  });

  it('shows a detached HEAD as its short sha, never as the branch it left', async () => {
    const api = setupElectronApi(async () => ({ branch: null, sha: 'abc1234def5678' }));
    const { slice, getState } = makeSliceStore({ transientSessions: twoTerminalsAndAnotherProject() });

    await slice.refreshTransientBranchesFromHead('proj-1', PROJECT_PATH);

    expect(getState().transientSessions[transientKey('proj-1', 'slot-1')]?.branch).toBe('abc1234');
    expect(api.setTransientBranch).toHaveBeenCalledWith('sess-a', 'abc1234');
  });

  it('skips the git read entirely when the project has no terminals paired', async () => {
    const api = setupElectronApi(async () => ({ branch: 'feature/auth', sha: 'abc1234def' }));
    const { slice } = makeSliceStore({
      transientSessions: {
        [transientKey('proj-2', 'slot-1')]: entry({ projectId: 'proj-2', slot: 'slot-1', sessionId: 'sess-c', branch: 'main' }),
      },
    });

    await slice.refreshTransientBranchesFromHead('proj-1', PROJECT_PATH);

    expect(api.worktreeHead).not.toHaveBeenCalled();
  });

  it('coalesces a fire that lands mid-read into exactly one more read', async () => {
    let resolveFirst!: (value: HeadResult) => void;
    const first = new Promise<HeadResult>((resolve) => { resolveFirst = resolve; });
    const api = setupElectronApi(vi.fn()
      .mockReturnValueOnce(first)
      .mockResolvedValue({ branch: 'develop', sha: 'def5678abc' }) as unknown as (input: { path: string }) => Promise<HeadResult>);
    const { slice, getState } = makeSliceStore({ transientSessions: twoTerminalsAndAnotherProject() });

    const inFlight = slice.refreshTransientBranchesFromHead('proj-1', PROJECT_PATH);
    // Three fires while the first read is pending collapse into one re-run.
    await slice.refreshTransientBranchesFromHead('proj-1', PROJECT_PATH);
    await slice.refreshTransientBranchesFromHead('proj-1', PROJECT_PATH);
    await slice.refreshTransientBranchesFromHead('proj-1', PROJECT_PATH);
    expect(api.worktreeHead).toHaveBeenCalledTimes(1);

    resolveFirst({ branch: 'feature/auth', sha: 'abc1234def' });
    await inFlight;

    expect(api.worktreeHead).toHaveBeenCalledTimes(2);
    // The re-run's reading is the one that stands.
    expect(getState().transientSessions[transientKey('proj-1', 'slot-1')]?.branch).toBe('develop');
  });

  it('a later separate call still issues a real read once the in-flight guard clears (finally deletion)', async () => {
    let resolveFirst!: (value: HeadResult) => void;
    const first = new Promise<HeadResult>((resolve) => { resolveFirst = resolve; });
    const api = setupElectronApi(vi.fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({ branch: 'develop', sha: 'def5678abc' })
      .mockResolvedValue({ branch: 'release/next', sha: '9998887776' }) as unknown as (input: { path: string }) => Promise<HeadResult>);
    const { slice, getState } = makeSliceStore({ transientSessions: twoTerminalsAndAnotherProject() });

    const inFlight = slice.refreshTransientBranchesFromHead('proj-1', PROJECT_PATH);
    // A fire that lands mid-read coalesces into exactly one more read (see the
    // sibling test above); resolving the first read settles the whole
    // in-flight chain.
    await slice.refreshTransientBranchesFromHead('proj-1', PROJECT_PATH);
    resolveFirst({ branch: 'feature/auth', sha: 'abc1234def' });
    await inFlight;

    expect(api.worktreeHead).toHaveBeenCalledTimes(2);
    expect(getState().transientSessions[transientKey('proj-1', 'slot-1')]?.branch).toBe('develop');

    // A THIRD, separate call issued after everything settled. If the finally
    // block's headRefreshRerun.delete(projectId) had not run, this call would
    // find a stale in-flight entry and return early with no read: the call
    // count would stay at 2 and the branch would stay stuck at 'develop'
    // instead of picking up this call's own read.
    await slice.refreshTransientBranchesFromHead('proj-1', PROJECT_PATH);

    expect(api.worktreeHead).toHaveBeenCalledTimes(3);
    expect(getState().transientSessions[transientKey('proj-1', 'slot-1')]?.branch).toBe('release/next');
    expect(getState().transientSessions[transientKey('proj-1', 'slot-2')]?.branch).toBe('release/next');
  });

  it('leaves the entries alone when the bridge call rejects', async () => {
    setupElectronApi(async () => { throw new Error('main went away'); });
    const initialMap = twoTerminalsAndAnotherProject();
    const { slice, getState } = makeSliceStore({ transientSessions: initialMap });

    await expect(slice.refreshTransientBranchesFromHead('proj-1', PROJECT_PATH)).resolves.toBeUndefined();

    expect(getState().transientSessions).toStrictEqual(initialMap);
  });

  it('swallows a rejected mirror call without an unhandled rejection', async () => {
    // A raw rejecting function, not a vi.fn: vi.fn's own call tracking attaches
    // a settle handler that counts as "handled" from Node's point of view (see
    // the identical note in transient-session-label.test.ts).
    const capturedRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => { capturedRejections.push(reason); };
    process.on('unhandledRejection', onUnhandledRejection);
    const globalWindow = globalThis as unknown as { window: { electronAPI: unknown } };
    globalWindow.window.electronAPI = {
      git: { worktreeHead: async () => ({ branch: 'feature/auth', sha: 'abc1234def' }) },
      sessions: { setTransientBranch: () => Promise.reject(new Error('network down')) },
    };

    try {
      const { slice, getState } = makeSliceStore({ transientSessions: twoTerminalsAndAnotherProject() });

      await slice.refreshTransientBranchesFromHead('proj-1', PROJECT_PATH);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(getState().transientSessions[transientKey('proj-1', 'slot-1')]?.branch).toBe('feature/auth');
      expect(capturedRejections).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });
});
