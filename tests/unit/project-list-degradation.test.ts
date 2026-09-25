/**
 * Unit tests for the degraded project-list read path in
 * src/main/ipc/handlers/projects.ts.
 *
 * Regression cover for Sentry DESKTOP-A / DESKTOP-B. Both handlers were bare
 * one-liners:
 *
 *   ipcMain.handle(IPC.PROJECT_LIST, () => context.projectRepo.list());
 *
 * so a SqliteError on the global index.db crossed IPC untouched and the
 * renderer got `Error invoking remote method 'project:list': SqliteError: disk
 * I/O error`. That message names the channel and says nothing about the file,
 * the cause, or what the user can do about it. Worse, the rejection stranded
 * project-store's `loading` flag at true, so the app sat on its spinner
 * forever.
 *
 * Split from global-db-degradation.test.ts because the two need opposite mock
 * universes: that file runs the REAL database module against a mocked
 * better-sqlite3, this one mocks the database module wholesale so a repository
 * can be made to throw on demand.
 *
 * The mock set below is carried over from project-probe-path-handler.test.ts,
 * which is the established way to import this module under test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '0.0.0'), getPath: vi.fn(() => '/tmp') },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedHandlers.set(channel, handler);
    }),
    on: vi.fn(),
  },
  Notification: { isSupported: vi.fn(() => false) },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn(), openExternal: vi.fn() },
}));

vi.mock('../../src/main/git/git-checks', () => ({
  isGitRepo: vi.fn(() => false),
  isInsideWorktree: vi.fn(() => false),
  isKangenticWorktree: vi.fn(() => false),
  ensureGitRepo: vi.fn(),
}));
vi.mock('../../src/main/git/worktree-head', () => ({
  readWorktreeHeadUnqueued: vi.fn(async () => ({ branch: null, sha: null })),
}));
vi.mock('../../src/main/git/original-fs', () => ({
  default: {
    existsSync: vi.fn(() => true),
    statSync: vi.fn(() => ({ isDirectory: () => true })),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
    readdirSync: vi.fn(() => []),
    rmSync: vi.fn(),
    promises: { stat: vi.fn(async () => ({ isDirectory: () => true })) },
  },
}));
vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: {
    list: vi.fn(() => ['claude']),
    get: vi.fn(() => null),
    getOrThrow: vi.fn(),
    has: vi.fn(() => false),
  },
}));
vi.mock('../../src/main/git/worktree-manager', () => ({
  WorktreeManager: class { static clearQueue = vi.fn(); },
}));
vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => ({})),
  closeProjectDb: vi.fn(),
}));
vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class { list = vi.fn(() => []); },
}));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {},
}));
vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({
  SwimlaneRepository: class {},
}));
vi.mock('../../src/main/db/repositories/transcript-repository', () => ({
  TranscriptRepository: class {},
}));
vi.mock('../../src/main/transition-engine/session-startup', () => ({
  resumeSuspendedSessions: vi.fn(async () => {}),
  autoSpawnTasks: vi.fn(async () => {}),
}));
vi.mock('../../src/main/transition-engine/resource-cleanup', () => ({
  cleanupStaleResourcesAsync: vi.fn(async () => {}),
  pruneOrphanedWorktreeTasks: vi.fn(),
}));
vi.mock('../../src/main/config/paths', () => ({
  PATHS: { projectDb: vi.fn((id: string) => `/tmp/${id}.db`) },
}));
vi.mock('../../src/main/config/apply-runtime-config', () => ({
  applyRuntimeConfig: vi.fn(),
}));
vi.mock('../../src/main/ipc/helpers', () => ({ ensureGitignore: vi.fn() }));
vi.mock('../../src/main/ipc/helpers/project-entry-search', () => ({
  searchProjectEntries: vi.fn(async () => ({ entries: [], truncated: false })),
}));
vi.mock('../../src/main/analytics/analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('../../src/main/shutdown-state', () => ({ isShuttingDown: vi.fn(() => false) }));

import { registerProjectHandlers } from '../../src/main/ipc/handlers/projects';
import { setGlobalDbFailureNotifier } from '../../src/main/db/soft-db';
import { IPC } from '../../src/shared/ipc-channels';

const DISK_IO_ERROR = Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' });

function throwingRepo() {
  return {
    list: () => { throw DISK_IO_ERROR; },
    getById: () => { throw DISK_IO_ERROR; },
  };
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  capturedHandlers.clear();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  // This file imports soft-db once at module scope, so a notifier registered by
  // one test stays registered for every test after it. Vitest's per-file
  // isolation stops that crossing into another file; it does not stop it
  // crossing into the next test here.
  setGlobalDbFailureNotifier(() => {});
});

describe('the project-list handlers with an unreadable global database', () => {
  it('resolves an empty list instead of rejecting', async () => {
    registerProjectHandlers({
      projectRepo: throwingRepo(),
      projectGroupRepo: throwingRepo(),
    } as never);

    const listProjects = capturedHandlers.get(IPC.PROJECT_LIST);
    const listGroups = capturedHandlers.get(IPC.PROJECT_GROUP_LIST);
    expect(listProjects, 'project:list was never registered').toBeDefined();
    expect(listGroups, 'projectGroup:list was never registered').toBeDefined();

    await expect(
      Promise.resolve(listProjects!()),
      "a raw rejection reaches the renderer as \"Error invoking remote method 'project:list'\" with a stack trace attached, and strands project-store's loading flag at true",
    ).resolves.toEqual([]);
    await expect(Promise.resolve(listGroups!())).resolves.toEqual([]);
  });

  it('answers null for the current project instead of rejecting', async () => {
    registerProjectHandlers({
      projectRepo: throwingRepo(),
      projectGroupRepo: throwingRepo(),
      currentProjectId: 'project-1',
    } as never);

    const getCurrent = capturedHandlers.get(IPC.PROJECT_GET_CURRENT);
    await expect(Promise.resolve(getCurrent!())).resolves.toBeNull();
  });

  it('tells the user, once, that the database is unreadable', async () => {
    const notifier = vi.fn();
    setGlobalDbFailureNotifier(notifier);
    registerProjectHandlers({
      projectRepo: throwingRepo(),
      projectGroupRepo: throwingRepo(),
      currentProjectId: 'project-1',
    } as never);

    capturedHandlers.get(IPC.PROJECT_LIST)!();
    capturedHandlers.get(IPC.PROJECT_GROUP_LIST)!();

    expect(
      notifier.mock.calls.map(([, operation]) => operation),
      'both list reads must notify. Degrading to an empty list without saying anything is the "app looks broken with no explanation" failure this change exists to close; the notifier itself debounces to one dialog.',
    ).toEqual(['project:list', 'projectGroup:list']);

    // getCurrent deliberately does NOT notify: project:list already speaks for
    // the pair, and it answers null on the cold-boot path anyway.
    capturedHandlers.get(IPC.PROJECT_GET_CURRENT)!();
    expect(notifier).toHaveBeenCalledTimes(2);
  });

  it('still returns real data when the database is healthy', async () => {
    // The guard must not swallow the happy path.
    const projects = [{ id: 'project-1', path: '/mock/one' }];
    registerProjectHandlers({
      projectRepo: { list: () => projects },
      projectGroupRepo: { list: () => [] },
    } as never);

    await expect(Promise.resolve(capturedHandlers.get(IPC.PROJECT_LIST)!())).resolves.toBe(projects);
  });
});

/**
 * The self-maintaining half. The bug shipped as a one-liner, and the next
 * one-line global read added to this file would reintroduce it silently. This
 * scan makes that fail CI instead.
 *
 * Scoped to READ methods on the two GLOBAL repositories. A handler that also
 * calls a write method is excluded: those are larger flows (PROJECT_OPEN reads
 * getById then writes updateLastOpened) where the read is not the thing being
 * answered and the write has to keep throwing anyway.
 *
 * Matching `.list()` alone was not enough - it would have waved through a
 * one-liner like `(_, id) => context.projectRepo.getById(id)`, which is exactly
 * the shape PROJECT_GET_CURRENT has.
 *
 * Per-project repositories are out of scope; they degrade through their own
 * paths.
 */
describe('projects.ts keeps its global-database list reads soft', () => {
  const SOURCE = fs.readFileSync(
    path.resolve(__dirname, '../../src/main/ipc/handlers/projects.ts'),
    'utf-8',
  );

  /**
   * Handler bodies, sliced from each `ipcMain.handle(` to the file's 2-space
   * close. Brace-balancing would have to understand string literals; this
   * anchor matches the other static scans in tests/unit, and the sanity check
   * below fails loudly if the formatting ever moves out from under it.
   *
   * Both close forms are accepted. A handler whose body is a block ends `});`,
   * one whose body is a single expression ends `));` - the softened list reads
   * are the second kind, and matching only the first walked straight past them
   * into the NEXT handler, which quietly made this scan assert the wrong thing.
   */
  function handlerBodies(): { channel: string; body: string }[] {
    const bodies: { channel: string; body: string }[] = [];
    const pattern = /ipcMain\.handle\((IPC\.\w+)/g;
    for (const match of SOURCE.matchAll(pattern)) {
      const start = match.index;
      const closes = ['\n  });', '\n  ));']
        .map((marker) => SOURCE.indexOf(marker, start))
        .filter((index) => index !== -1);
      const closeIndex = closes.length > 0 ? Math.min(...closes) : SOURCE.length;
      bodies.push({ channel: match[1], body: SOURCE.slice(start, closeIndex) });
    }
    return bodies;
  }

  it('finds the handlers it means to scan, and slices them apart', () => {
    // An anchor that silently matches nothing - or that runs two handlers
    // together - is a scan that passes forever.
    const bodies = handlerBodies();
    const channels = bodies.map((entry) => entry.channel);
    expect(channels.length).toBeGreaterThan(15);
    expect(channels).toContain('IPC.PROJECT_LIST');
    expect(channels).toContain('IPC.PROJECT_GROUP_LIST');

    // No body may contain a second handler registration. That is exactly the
    // over-capture that made the write scan below read PROJECT_CREATE's body as
    // part of PROJECT_LIST's.
    for (const entry of bodies) {
      expect(
        entry.body.match(/ipcMain\.handle\(/g)?.length ?? 0,
        `the slice for ${entry.channel} ran past its own close and swallowed the next handler`,
      ).toBe(1);
    }
  });

  // `softly<Project | null>(` is as softened as `softly(`. Matching the bare
  // literal missed the explicitly-typed call and reported it as an offender.
  const SOFTENED = /\bsoftly\s*[<(]/;
  const GLOBAL_REPO = String.raw`context\.(projectRepo|projectGroupRepo)`;
  const READ = new RegExp(`${GLOBAL_REPO}\\.(list|getById|getLastOpened)\\(`);
  const WRITE = new RegExp(
    `${GLOBAL_REPO}\\.(create|delete|update|rename|reorder|setGroup|setCollapsed|setDefault\\w*|updateLastOpened)\\(`,
  );

  it('routes every read-only global-repo handler through softly()', () => {
    const offenders = handlerBodies()
      .filter((entry) => READ.test(entry.body) && !WRITE.test(entry.body))
      .filter((entry) => !SOFTENED.test(entry.body))
      .map((entry) => entry.channel);

    expect(
      offenders,
      'a global-database read that is not wrapped in softly() rejects across IPC on a SQLITE_IOERR, which is Sentry DESKTOP-A/B. Wrap it (see src/main/db/soft-db.ts) or move the read out of the handler body.',
    ).toEqual([]);
  });

  it('does not soften writes', () => {
    // The other half of the rule. .claude/rules/project-scoped-ipc.md: a failed
    // mutation must not report success. A create/delete/rename that swallowed
    // its error would tell the renderer it worked.
    const softenedWrites = handlerBodies()
      .filter((entry) => SOFTENED.test(entry.body) && WRITE.test(entry.body))
      .map((entry) => entry.channel);

    expect(
      softenedWrites,
      'a write must keep throwing: swallowing it reports a success that never happened',
    ).toEqual([]);
  });
});
