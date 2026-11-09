/**
 * What a user loses without this file: an agent that files a task into another
 * project through the MCP tools has its priority checked against the wrong
 * board's scale, or the call fails outright when the config cannot be read.
 * It pins `getBacklogDisplayConfig` on the context `buildCommandContextForProject`
 * builds: the project's own scale and label colors, the seeded scale for an
 * empty or unreadable config, and a read bound to the context's own project path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stubs for the Electron and native imports of mcp-project-context.ts, so the
// unit scope stays free of a real Electron process and SQLite. Same set as
// tests/unit/mcp-project-context.test.ts.
vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => ({})),
}));
vi.mock('../../src/main/ipc/helpers', () => ({
  autoSpawnForTask: vi.fn(() => Promise.resolve()),
  reapTaskLeftovers: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../src/main/ipc/helpers/task-windows', () => ({
  closeTaskWindows: vi.fn(),
}));
vi.mock('../../src/main/ipc/handlers/task-move', () => ({
  handleTaskMove: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({
  getProjectRepos: vi.fn(() => ({})),
}));
vi.mock('../../src/main/automations/turn-end/deliver-message', () => ({
  deliverMessageAfterMove: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../src/main/git/worktree-manager', () => ({
  prepareWorktreeForRemoval: vi.fn(() => Promise.resolve()),
  WorktreeManager: vi.fn(),
}));
vi.mock('../../src/shared/ipc-channels', () => ({
  IPC: new Proxy({}, { get: (_target, prop) => String(prop) }),
}));
vi.mock('../../src/main/diagnostics/ipc-recorder', () => ({
  recordPush: vi.fn(),
}));
vi.mock('../../src/main/ipc/handlers/strategy-propagation', () => ({
  propagateBoardProfileChange: vi.fn(),
  propagateStrategyToLiveSessions: vi.fn(),
  buildColumnStrategyChanges: vi.fn(() => []),
}));
vi.mock('../../src/main/ipc/handlers/task-runtime-override', () => ({
  applyTaskSettingsToLiveSession: vi.fn(),
}));
vi.mock('../../src/main/ipc/task-lifecycle-lock', () => ({
  withTaskLock: vi.fn((_taskId: string, work: () => Promise<unknown>) => work()),
}));
vi.mock('../../src/main/retrieval/retrieval-client', () => ({
  retrievalClient: { call: vi.fn() },
}));
vi.mock('../../src/main/ipc/helpers/task-report', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/ipc/helpers/task-report')>()),
  readTaskReport: vi.fn(),
}));
vi.mock('../../src/main/ipc/handlers/git-diff', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/ipc/handlers/git-diff')>()),
  readTaskChanges: vi.fn(),
}));
vi.mock('../../src/main/agent/mcp-http/project-resolver', () => ({
  RequestResolver: function RequestResolver() { /* unused here */ },
}));

import { buildCommandContextForProject } from '../../src/main/agent/mcp-project-context';
import { priorityScaleOf } from '../../src/main/agent/commands/label-and-priority';
import { DEFAULT_PRIORITY_CONFIG } from '../../src/shared/types';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { Project } from '../../src/shared/types';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_PATH = '/projects/example';

function makeProject(): Project {
  return {
    id: PROJECT_ID,
    name: 'Example Project',
    path: PROJECT_PATH,
    github_url: null,
    default_agent: 'claude',
    group_id: null,
    position: 0,
    last_opened: '2026-01-01T00:00:00Z',
    created_at: '2026-01-01T00:00:00Z',
  } as Project;
}

function makeContextWith(getEffectiveConfig: ReturnType<typeof vi.fn>) {
  const project = makeProject();
  const ipcContext = {
    projectRepo: { getById: vi.fn(() => project), list: vi.fn(() => [project]) },
    configManager: { getEffectiveConfig },
  } as unknown as IpcContext;
  const context = buildCommandContextForProject(ipcContext, PROJECT_ID);
  if (!context) throw new Error('expected a command context for a known project');
  return context;
}

describe('buildCommandContextForProject - getBacklogDisplayConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the project\'s custom scale and label colors as they are', () => {
    const customScale = [
      { label: 'Low', color: '#10b981' },
      { label: 'Medium', color: '#f59e0b' },
      { label: 'High', color: '#ef4444' },
    ];
    const context = makeContextWith(vi.fn(() => ({
      backlog: { priorities: customScale, labelColors: { ui: '#3b82f6' } },
    })));

    const displayConfig = context.getBacklogDisplayConfig!();

    expect(displayConfig.priorities).toEqual(customScale);
    expect(displayConfig.labelColors).toEqual({ ui: '#3b82f6' });
    expect(priorityScaleOf(context)).toEqual(customScale);
  });

  it('reads a config with no backlog as an empty scale, which resolves to the seeded one', () => {
    const context = makeContextWith(vi.fn(() => ({})));

    expect(context.getBacklogDisplayConfig!()).toEqual({ priorities: [], labelColors: {} });
    expect(priorityScaleOf(context)).toEqual(DEFAULT_PRIORITY_CONFIG);
  });

  it('does not throw when the config is unreadable, and falls back to the seeded scale', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const context = makeContextWith(vi.fn(() => { throw new Error('config unreadable'); }));

      expect(() => context.getBacklogDisplayConfig!()).not.toThrow();
      expect(context.getBacklogDisplayConfig!()).toEqual({ priorities: [], labelColors: {} });
      expect(priorityScaleOf(context)).toEqual(DEFAULT_PRIORITY_CONFIG);
    } finally {
      warn.mockRestore();
    }
  });

  it('reads the config of the context\'s own project path', () => {
    const getEffectiveConfig = vi.fn(() => ({ backlog: { priorities: [], labelColors: {} } }));
    const context = makeContextWith(getEffectiveConfig);

    context.getBacklogDisplayConfig!();

    expect(getEffectiveConfig).toHaveBeenCalledWith(PROJECT_PATH);
  });
});
