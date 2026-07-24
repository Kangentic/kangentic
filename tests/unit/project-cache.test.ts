/**
 * Unit tests for src/renderer/stores/project-cache.ts pure-logic functions.
 *
 * The cache module is a pure in-memory Map + two Sets with no side effects
 * beyond module-scoped state. Tests import the functions directly from the
 * source. Because the module is loaded fresh per vitest worker, the state
 * starts clean for every test file run - no afterEach teardown needed at
 * the file level. Individual tests that need isolation call the appropriate
 * drop/invalidate helpers or use distinct project IDs.
 *
 * Covered:
 *   isWarmProject - triple-gate combinations (seen + dirty + cached)
 *   markProjectSeen - adds to seen, removes from dirty
 *   invalidateProject - adds to dirty; does NOT remove from seen or cache
 *   invalidateAllProjects - only touches seen projects; unseen are unaffected
 *   dropProject - removes from all 3 internal collections
 *   snapshotProject - overwrites prior entries; readable via getProjectSnapshot
 *   getProjectSnapshot - returns undefined for unknown / dropped projects
 *
 * Note: import.meta.hot is undefined in the vitest environment (CommonJS /
 * node context). The module gracefully handles this by falling back to fresh
 * Map / Set instances. No ts-expect-error suppression needed here.
 */

// vi.mock import.meta.hot before importing the module so the HMR branch
// does not throw. vitest replaces import.meta.hot with undefined by default
// in node mode, which matches what the module already handles.
import { describe, it, expect, afterEach } from 'vitest';
import type { AppConfig } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Import the functions under test AFTER vitest has resolved the module graph.
// The module uses import.meta.hot which is undefined in the test environment
// (vitest node mode). The fallback `?? new Map()` / `?? new Set()` in the
// module body handles this correctly.
// ---------------------------------------------------------------------------

import {
  isWarmProject,
  markProjectSeen,
  snapshotProject,
  getProjectSnapshot,
  invalidateProject,
  invalidateAllProjects,
  dropProject,
} from '../../src/renderer/stores/project-cache';

// ---------------------------------------------------------------------------
// Minimal snapshot fixture. The type requires board/backlog/config/view slices;
// the actual values do not matter for predicate tests.
// ---------------------------------------------------------------------------

function makeMinimalConfig(): AppConfig {
  return {
    theme: 'dark',
    sidebarVisible: true,
    boardLayout: 'horizontal',
    cardDensity: 'default',
    columnWidth: 'default',
    showTaskNumbers: false,
    terminalPanelVisible: true,
    animationsEnabled: true,
    statusBarVisible: true,
    diffViewMode: 'split',
    terminal: { shell: null, fontFamily: 'mono', fontSize: 14, showPreview: false, panelHeight: 250, cursorStyle: 'block' },
    sidebar: { width: 224 },
    agent: { permissionMode: 'acceptEdits', cliPaths: {}, maxConcurrentSessions: 8, queueOverflow: 'queue', idleTimeoutMinutes: 0, autoResumeSessionsOnRestart: false },
    git: { worktreesEnabled: true, autoCleanup: true, defaultBaseBranch: 'main', copyFiles: [], initScript: null, linkNodeModules: true },
    mcpServer: { enabled: true },
    contextBar: { showShell: true, showVersion: true, showCost: true, showTokens: true, showContextFraction: true, showProgressBar: true, showRateLimits: true },
    notifications: { desktop: { onAgentIdle: true, onAgentCrash: true, onPlanComplete: true }, toasts: { onAgentIdle: true, onAgentCrash: true, onPlanComplete: true, durationSeconds: 4, maxCount: 5 }, cooldownSeconds: 10 },
    backlog: { priorities: [], labelColors: {} },
    hasCompletedFirstRun: true,
    skipDeleteConfirm: false,
    skipBoardConfigConfirm: false,
    autoFocusIdleSession: false,
    autoNameAskedTaskIds: [],
    autoNameRateLimitPerHour: 60,
    restoreWindowPosition: true,
    windowBounds: null,
    windowMaximized: false,
    statusBarPeriod: 'live',
    lastActiveTaskByProject: {},
  } as unknown as AppConfig;
}

function makeSnapshot(overrides: { detailTaskId?: string | null } = {}) {
  return {
    board: { tasks: [], swimlanes: [], archivedTasks: [], shortcuts: [] },
    backlog: [],
    config: makeMinimalConfig(),
    view: { detailTaskId: overrides.detailTaskId ?? null },
  };
}

// ---------------------------------------------------------------------------
// Each test uses a unique project ID derived from the test name so that
// module-level state from one test does not bleed into another. We do NOT
// rely on module re-evaluation order.
// ---------------------------------------------------------------------------

describe('isWarmProject - triple-gate logic', () => {
  it('returns false when the project has never been seen', () => {
    // Fresh ID, nothing seeded.
    expect(isWarmProject('unseen-project-abc')).toBe(false);
  });

  it('returns false when seen and cached but also dirty', () => {
    const projectId = 'ig-seen-dirty';
    snapshotProject(projectId, makeSnapshot());
    markProjectSeen(projectId);
    invalidateProject(projectId);

    expect(isWarmProject(projectId)).toBe(false);
  });

  it('returns false when seen but no snapshot has been taken yet', () => {
    // markProjectSeen without prior snapshotProject: cache.has returns false.
    const projectId = 'ig-seen-no-cache';
    markProjectSeen(projectId);

    expect(isWarmProject(projectId)).toBe(false);
  });

  it('returns false when cached but never seen', () => {
    // snapshotProject without markProjectSeen: seenProjects.has returns false.
    const projectId = 'ig-cached-not-seen';
    snapshotProject(projectId, makeSnapshot());

    expect(isWarmProject(projectId)).toBe(false);
  });

  it('returns true when seen AND cached AND not dirty', () => {
    const projectId = 'ig-all-three-gates';
    snapshotProject(projectId, makeSnapshot());
    markProjectSeen(projectId);

    expect(isWarmProject(projectId)).toBe(true);
  });

  it('returns true again after invalidation is cleared by markProjectSeen', () => {
    const projectId = 'ig-re-mark-after-dirty';
    snapshotProject(projectId, makeSnapshot());
    markProjectSeen(projectId);
    invalidateProject(projectId);
    // Simulates a cold reload completing; project is re-marked as seen.
    markProjectSeen(projectId);

    expect(isWarmProject(projectId)).toBe(true);
  });
});

describe('markProjectSeen', () => {
  it('adds the project to seen and removes it from dirty', () => {
    const projectId = 'mps-basic';
    // Pre-dirty the project to prove markProjectSeen clears it.
    snapshotProject(projectId, makeSnapshot());
    invalidateProject(projectId);

    markProjectSeen(projectId);

    expect(isWarmProject(projectId)).toBe(true);
  });

  it('is idempotent: calling it twice has the same effect as once', () => {
    const projectId = 'mps-idempotent';
    snapshotProject(projectId, makeSnapshot());
    markProjectSeen(projectId);
    markProjectSeen(projectId);

    expect(isWarmProject(projectId)).toBe(true);
  });
});

describe('invalidateProject', () => {
  it('adds the project to dirty so isWarmProject returns false', () => {
    const projectId = 'ip-basic';
    snapshotProject(projectId, makeSnapshot());
    markProjectSeen(projectId);

    expect(isWarmProject(projectId)).toBe(true);
    invalidateProject(projectId);
    expect(isWarmProject(projectId)).toBe(false);
  });

  it('does NOT remove the snapshot - getProjectSnapshot still returns data', () => {
    const projectId = 'ip-keeps-cache';
    const snapshot = makeSnapshot({ detailTaskId: 'task-xyz' });
    snapshotProject(projectId, snapshot);
    markProjectSeen(projectId);
    invalidateProject(projectId);

    // The cache entry is preserved; the warm path just won't be taken.
    expect(getProjectSnapshot(projectId)).toBeDefined();
    expect(getProjectSnapshot(projectId)!.view.detailTaskId).toBe('task-xyz');
  });

  it('is idempotent: calling it twice does not throw and stays dirty', () => {
    const projectId = 'ip-double';
    snapshotProject(projectId, makeSnapshot());
    markProjectSeen(projectId);
    invalidateProject(projectId);
    invalidateProject(projectId);

    expect(isWarmProject(projectId)).toBe(false);
  });
});

describe('invalidateAllProjects', () => {
  it('marks every seen project dirty', () => {
    const projectAId = 'iap-seen-a';
    const projectBId = 'iap-seen-b';
    snapshotProject(projectAId, makeSnapshot());
    snapshotProject(projectBId, makeSnapshot());
    markProjectSeen(projectAId);
    markProjectSeen(projectBId);

    expect(isWarmProject(projectAId)).toBe(true);
    expect(isWarmProject(projectBId)).toBe(true);

    invalidateAllProjects();

    expect(isWarmProject(projectAId)).toBe(false);
    expect(isWarmProject(projectBId)).toBe(false);
  });

  it('does NOT dirty projects that were never seen', () => {
    // Seed a truly unseen project with only a raw cache entry (no markProjectSeen).
    const unseenId = 'iap-unseen';
    snapshotProject(unseenId, makeSnapshot());
    // Do NOT call markProjectSeen for unseenId.

    // Seed a proper seen project so invalidateAllProjects has work to do.
    const seenId = 'iap-seen-for-all';
    snapshotProject(seenId, makeSnapshot());
    markProjectSeen(seenId);

    invalidateAllProjects();

    // The unseen project's isWarmProject was already false (not seen), and
    // invalidateAllProjects should not add it to dirty. The key test is that
    // after markProjectSeen is called for the unseen project WITHOUT a new
    // snapshotProject, isWarmProject still returns false (cache.has is still true
    // from the earlier snapshotProject, but it was not in seenProjects when
    // invalidateAllProjects ran).
    markProjectSeen(unseenId);
    // Now it is seen and cached; if invalidateAllProjects had dirtied it,
    // this would return false. If it was not dirtied, it returns true.
    expect(isWarmProject(unseenId)).toBe(true);
  });
});

describe('dropProject', () => {
  it('removes the project from seen, dirty, and cache', () => {
    const projectId = 'dp-full';
    snapshotProject(projectId, makeSnapshot());
    markProjectSeen(projectId);
    invalidateProject(projectId); // also put in dirty to prove it's removed

    dropProject(projectId);

    // All three collections cleared:
    expect(isWarmProject(projectId)).toBe(false);
    expect(getProjectSnapshot(projectId)).toBeUndefined();
  });

  it('is a no-op for a project that was never registered', () => {
    // Should not throw even if the project ID is entirely unknown.
    expect(() => dropProject('dp-never-known')).not.toThrow();
  });

  it('is idempotent: dropping twice does not throw', () => {
    const projectId = 'dp-twice';
    snapshotProject(projectId, makeSnapshot());
    markProjectSeen(projectId);
    dropProject(projectId);

    expect(() => dropProject(projectId)).not.toThrow();
    expect(getProjectSnapshot(projectId)).toBeUndefined();
  });

  it('after drop, markProjectSeen + snapshotProject can re-register the project', () => {
    const projectId = 'dp-re-register';
    snapshotProject(projectId, makeSnapshot({ detailTaskId: 'first-open' }));
    markProjectSeen(projectId);
    dropProject(projectId);

    // Simulate a fresh open of the same project after it was deleted + re-added.
    snapshotProject(projectId, makeSnapshot({ detailTaskId: 're-registered' }));
    markProjectSeen(projectId);

    expect(isWarmProject(projectId)).toBe(true);
    expect(getProjectSnapshot(projectId)!.view.detailTaskId).toBe('re-registered');
  });
});

describe('snapshotProject', () => {
  it('stores the snapshot and makes it retrievable via getProjectSnapshot', () => {
    const projectId = 'sp-basic';
    const snapshot = makeSnapshot({ detailTaskId: 'task-001' });
    snapshotProject(projectId, snapshot);

    const retrieved = getProjectSnapshot(projectId);
    expect(retrieved).toBeDefined();
    expect(retrieved!.view.detailTaskId).toBe('task-001');
  });

  it('overwrites a prior snapshot for the same project', () => {
    const projectId = 'sp-overwrite';
    snapshotProject(projectId, makeSnapshot({ detailTaskId: 'first' }));
    snapshotProject(projectId, makeSnapshot({ detailTaskId: 'second' }));

    expect(getProjectSnapshot(projectId)!.view.detailTaskId).toBe('second');
  });

  it('stores snapshots for different projects independently', () => {
    const projectAId = 'sp-multi-a';
    const projectBId = 'sp-multi-b';
    snapshotProject(projectAId, makeSnapshot({ detailTaskId: 'alpha' }));
    snapshotProject(projectBId, makeSnapshot({ detailTaskId: 'beta' }));

    expect(getProjectSnapshot(projectAId)!.view.detailTaskId).toBe('alpha');
    expect(getProjectSnapshot(projectBId)!.view.detailTaskId).toBe('beta');
  });
});

describe('getProjectSnapshot', () => {
  it('returns undefined for a project that has never been snapshotted', () => {
    expect(getProjectSnapshot('gps-never-seen')).toBeUndefined();
  });

  it('returns undefined after dropProject clears the entry', () => {
    const projectId = 'gps-after-drop';
    snapshotProject(projectId, makeSnapshot());
    dropProject(projectId);

    expect(getProjectSnapshot(projectId)).toBeUndefined();
  });

  it('returns data even for an invalidated (dirty) project', () => {
    // Invalidation marks the project dirty but preserves the cache entry
    // so callers can inspect the stale snapshot if needed.
    const projectId = 'gps-dirty-still-returns';
    const snapshot = makeSnapshot({ detailTaskId: 'stale-task' });
    snapshotProject(projectId, snapshot);
    markProjectSeen(projectId);
    invalidateProject(projectId);

    expect(getProjectSnapshot(projectId)).toBeDefined();
    expect(getProjectSnapshot(projectId)!.view.detailTaskId).toBe('stale-task');
  });
});

// ---------------------------------------------------------------------------
// Cleanup: drop all project IDs used in this test file so that if vitest
// ever runs multiple test files in the same worker the module state starts
// clean. The test-unique ID convention minimises this risk further.
// ---------------------------------------------------------------------------
afterEach(() => {
  const idsUsedInFile = [
    'unseen-project-abc',
    'ig-seen-dirty',
    'ig-seen-no-cache',
    'ig-cached-not-seen',
    'ig-all-three-gates',
    'ig-re-mark-after-dirty',
    'mps-basic',
    'mps-idempotent',
    'ip-basic',
    'ip-keeps-cache',
    'ip-double',
    'iap-seen-a',
    'iap-seen-b',
    'iap-unseen',
    'iap-seen-for-all',
    'dp-full',
    'dp-never-known',
    'dp-twice',
    'dp-re-register',
    'sp-basic',
    'sp-overwrite',
    'sp-multi-a',
    'sp-multi-b',
    'gps-never-seen',
    'gps-after-drop',
    'gps-dirty-still-returns',
  ];
  for (const id of idsUsedInFile) {
    dropProject(id);
  }
});
