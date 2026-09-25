/**
 * Unit tests for src/main/browser/jar-seeder.ts.
 *
 * The seeder shares a project's non-localhost (IdP) login across task jars
 * via the project identity jar, while never copying localhost. The load-bearing
 * properties: the load-boundary sync copies non-local and never local, is a no-op
 * for the hub (identity/legacy) partitions, the write-back mirrors non-local ADDS
 * (only) into the identity jar and is suppressed during a programmatic sync so it
 * cannot echo, and concurrent syncs of one partition coalesce. Electron's
 * `session` is faked per partition; the copy primitive under the hood is the real
 * pure implementation from cookie-seed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  browserPartitionForProjectIdentity,
  browserPartitionForTask,
} from '../../src/shared/browser-partition';

const { fromPartition, sessions } = vi.hoisted(() => {
  const sessions = new Map<string, ReturnType<typeof makeFakeSession>>();
  function makeFakeSession() {
    let changedListener: ((...args: unknown[]) => void) | null = null;
    const store: Record<string, unknown>[] = [];
    const api = {
      _store: store,
      _fire(cookie: unknown, cause: string, removed: boolean) {
        if (changedListener) changedListener({}, cookie, cause, removed);
      },
      cookies: {
        get: vi.fn(async () => store.slice()),
        set: vi.fn(async () => undefined),
        flushStore: vi.fn(async () => undefined),
        on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
          if (event === 'changed') changedListener = listener;
        }),
      },
    };
    return api;
  }
  const fromPartition = vi.fn((partition: string) => {
    let existing = sessions.get(partition);
    if (!existing) {
      existing = makeFakeSession();
      sessions.set(partition, existing);
    }
    return existing;
  });
  return { fromPartition, sessions, makeFakeSession };
});

vi.mock('electron', () => ({
  session: { fromPartition: (partition: string) => fromPartition(partition) },
}));

import {
  installIdentityWriteback,
  syncJarFromIdentity,
} from '../../src/main/browser/jar-seeder';

// Unique project id per test so the module-scope "installed" guards never
// collide across tests. UUID-shaped so the partition deriver normalizes it.
let projectCounter = 0;
function freshProject(): string {
  projectCounter += 1;
  return `${String(projectCounter).padStart(8, '0')}-0000-0000-0000-000000000000`;
}
const TASK_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function cookie(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    name: 'c',
    value: 'v',
    domain: '.google.com',
    path: '/',
    secure: true,
    httpOnly: true,
    hostOnly: false,
    session: false,
    sameSite: 'unspecified',
    expirationDate: 1_900_000_000,
    ...overrides,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  sessions.clear();
});

describe('syncJarFromIdentity', () => {
  it('copies the identity jar non-local cookies into a task jar, excluding localhost', async () => {
    const projectId = freshProject();
    const identityPartition = browserPartitionForProjectIdentity(projectId);
    const taskPartition = browserPartitionForTask(projectId, TASK_ID);

    // Prime the identity jar (created on first fromPartition) with one shareable
    // cookie and one localhost cookie that must NOT be copied.
    fromPartition(identityPartition)._store.push(
      cookie({ name: 'SID', domain: '.google.com' }),
      cookie({ name: 'devsid', domain: 'localhost', secure: false }),
    );

    await syncJarFromIdentity(taskPartition, projectId);

    const targetSet = fromPartition(taskPartition).cookies.set;
    expect(targetSet).toHaveBeenCalledTimes(1);
    expect(targetSet.mock.calls[0][0]).toMatchObject({ name: 'SID' });
  });

  it('is a no-op when the partition IS the identity jar', async () => {
    const projectId = freshProject();
    const identityPartition = browserPartitionForProjectIdentity(projectId);
    await syncJarFromIdentity(identityPartition, projectId);
    // The identity session's get is never called because the sync short-circuits.
    expect(fromPartition(identityPartition).cookies.get).not.toHaveBeenCalled();
  });

  it('is a no-op when there is no project id', async () => {
    const taskPartition = browserPartitionForTask(freshProject(), TASK_ID);
    await syncJarFromIdentity(taskPartition, null);
    expect(fromPartition(taskPartition).cookies.get).not.toHaveBeenCalled();
  });

  it('coalesces concurrent syncs of the same partition into one copy', async () => {
    const projectId = freshProject();
    const identityPartition = browserPartitionForProjectIdentity(projectId);
    const taskPartition = browserPartitionForTask(projectId, TASK_ID);
    fromPartition(identityPartition)._store.push(cookie({ name: 'SID' }));

    await Promise.all([
      syncJarFromIdentity(taskPartition, projectId),
      syncJarFromIdentity(taskPartition, projectId),
    ]);

    // The identity jar was read exactly once despite two concurrent syncs.
    expect(fromPartition(identityPartition).cookies.get).toHaveBeenCalledTimes(1);
  });

  it('installs the write-back listener as part of the sync, so a later sign-in still mirrors to identity', async () => {
    const projectId = freshProject();
    const identityPartition = browserPartitionForProjectIdentity(projectId);
    const taskPartition = browserPartitionForTask(projectId, TASK_ID);

    await syncJarFromIdentity(taskPartition, projectId);

    // Nothing exercises installIdentityWriteback directly here - the ONLY way
    // this cookie add can reach the identity jar is if syncJarFromIdentity
    // itself installed the listener.
    const taskJar = fromPartition(taskPartition);
    taskJar._fire(cookie({ name: 'SID_LATER' }), 'explicit', false);
    await flush();

    const identitySet = fromPartition(identityPartition).cookies.set;
    expect(identitySet).toHaveBeenCalledTimes(1);
    expect(identitySet.mock.calls[0][0]).toMatchObject({ name: 'SID_LATER' });
  });

  it('installs the write-back listener even when the seed copy fails', async () => {
    const projectId = freshProject();
    const identityPartition = browserPartitionForProjectIdentity(projectId);
    const taskPartition = browserPartitionForTask(projectId, TASK_ID);

    // The seed copy reads the identity jar first; make that read fail so the
    // copy itself never completes.
    fromPartition(identityPartition).cookies.get.mockRejectedValueOnce(
      new Error('identity jar read failed'),
    );

    // syncJarFromIdentity never throws: runSync's own try/catch swallows the
    // copy failure and only logs a warning.
    await expect(syncJarFromIdentity(taskPartition, projectId)).resolves.toBeUndefined();

    // Pins the install-before-copy ordering in runSync: installation must not
    // depend on the copy succeeding. Reverting to install-after-copy (inside
    // the same try) means the copy's thrown error skips the install line
    // entirely, and this mirror would never reach the identity jar.
    const taskJar = fromPartition(taskPartition);
    taskJar._fire(cookie({ name: 'SID_AFTER_FAILED_COPY' }), 'explicit', false);
    await flush();

    const identitySet = fromPartition(identityPartition).cookies.set;
    expect(identitySet).toHaveBeenCalledTimes(1);
    expect(identitySet.mock.calls[0][0]).toMatchObject({ name: 'SID_AFTER_FAILED_COPY' });
  });

  it('installs the write-back listener only once across repeated syncs of the same partition', async () => {
    const projectId = freshProject();
    const taskPartition = browserPartitionForTask(projectId, TASK_ID);

    await syncJarFromIdentity(taskPartition, projectId);
    await syncJarFromIdentity(taskPartition, projectId);

    // The fake session keeps a single listener slot, so this counts
    // installation attempts, not mirrored writes.
    expect(fromPartition(taskPartition).cookies.on).toHaveBeenCalledTimes(1);
  });
});

describe('installIdentityWriteback', () => {
  it('mirrors a non-local cookie ADD into the identity jar', async () => {
    const projectId = freshProject();
    const identityPartition = browserPartitionForProjectIdentity(projectId);
    const taskPartition = browserPartitionForTask(projectId, TASK_ID);

    installIdentityWriteback(taskPartition, projectId);
    fromPartition(taskPartition)._fire(cookie({ name: 'SID' }), 'explicit', false);
    await flush();

    const identitySet = fromPartition(identityPartition).cookies.set;
    expect(identitySet).toHaveBeenCalledTimes(1);
    expect(identitySet.mock.calls[0][0]).toMatchObject({ name: 'SID' });
  });

  it('never mirrors a localhost cookie or a removal', async () => {
    const projectId = freshProject();
    const identityPartition = browserPartitionForProjectIdentity(projectId);
    const taskPartition = browserPartitionForTask(projectId, TASK_ID);

    installIdentityWriteback(taskPartition, projectId);
    fromPartition(taskPartition)._fire(cookie({ name: 'devsid', domain: 'localhost', secure: false }), 'explicit', false);
    fromPartition(taskPartition)._fire(cookie({ name: 'SID' }), 'explicit', true); // removed
    await flush();

    expect(fromPartition(identityPartition).cookies.set).not.toHaveBeenCalled();
  });

  it('is a no-op for the identity/legacy partitions', () => {
    const projectId = freshProject();
    const identityPartition = browserPartitionForProjectIdentity(projectId);
    installIdentityWriteback(identityPartition, projectId);
    installIdentityWriteback('persist:kangentic-browser', projectId);
    expect(fromPartition(identityPartition).cookies.on).not.toHaveBeenCalled();
  });

  it('does not echo a cookie the sync itself wrote back into the identity jar', async () => {
    const projectId = freshProject();
    const identityPartition = browserPartitionForProjectIdentity(projectId);
    const taskPartition = browserPartitionForTask(projectId, TASK_ID);
    fromPartition(identityPartition)._store.push(cookie({ name: 'SID' }));

    // Sync installs the writeback and copies SID in. Simulate the task jar's own
    // change event firing DURING that copy: it must be suppressed.
    const taskJar = fromPartition(taskPartition);
    taskJar.cookies.set.mockImplementation(async () => {
      taskJar._fire(cookie({ name: 'SID' }), 'explicit', false);
    });

    await syncJarFromIdentity(taskPartition, projectId);
    await flush();

    // The identity jar must NOT have been written to by the echoed change (only
    // its get was called, for the copy source).
    expect(fromPartition(identityPartition).cookies.set).not.toHaveBeenCalled();
  });
});

describe('identity flush debounce', () => {
  it('flushes the identity jar once, 2s after a write-back mirror, and coalesces rapid mirrors into one flush', async () => {
    vi.useFakeTimers();
    try {
      const projectId = freshProject();
      const identityPartition = browserPartitionForProjectIdentity(projectId);
      const taskPartition = browserPartitionForTask(projectId, TASK_ID);

      installIdentityWriteback(taskPartition, projectId);
      const taskJar = fromPartition(taskPartition);
      const identityFlush = fromPartition(identityPartition).cookies.flushStore;

      taskJar._fire(cookie({ name: 'SID' }), 'explicit', false);
      // Let the mirror's cookies.set().then() microtask schedule the debounce
      // timer before asserting nothing has flushed yet.
      await vi.advanceTimersByTimeAsync(0);
      expect(identityFlush).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1999);
      expect(identityFlush).not.toHaveBeenCalled();

      // A second rapid mirror just under the debounce window restarts it
      // rather than scheduling a second flush.
      taskJar._fire(cookie({ name: 'SID' }), 'explicit', false);
      await vi.advanceTimersByTimeAsync(1999);
      expect(identityFlush).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(identityFlush).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
