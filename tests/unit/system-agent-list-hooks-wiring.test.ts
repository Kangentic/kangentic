/**
 * What registerSystemHandlers (src/main/ipc/handlers/system.ts) hands the agent inventory:
 * the hooks a deferred in-use read reports through, and the detectors' first-live-detection
 * listener. agent-list.ts and agent-detector.ts are tested with their hooks injected, so a
 * call site that stops wiring them breaks none of those suites.
 *
 * The real agent-list and agent-detector modules run. Only the two setters are wrapped, to
 * hand the test what system.ts passed them.
 *
 * Red-green: delete the `broadcast(...)` line in the hook and the first test fails; delete
 * `noteInstalledAgentsChanged()` and the second fails; delete or repoint the
 * `setFirstLiveDetectionListener(agentNowInUse)` line and the third fails; drop
 * `failureReporter` and the last fails.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const captured = vi.hoisted(() => ({
  hooks: null as null | { onChanged?: () => void; failureReporter?: unknown },
  firstLiveDetectionListener: undefined as undefined | (() => void) | null,
}));

vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '0.0.0'), getPath: vi.fn(() => '/tmp') },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  Notification: { isSupported: vi.fn(() => false) },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn(), openExternal: vi.fn() },
}));

vi.mock('../../src/main/agent/agent-list', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/agent/agent-list')>();
  return {
    ...actual,
    setAgentListHooks: (hooks: Parameters<typeof actual.setAgentListHooks>[0]) => {
      captured.hooks = hooks;
      actual.setAgentListHooks(hooks);
    },
  };
});

vi.mock('../../src/main/agent/shared/agent-detector', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/agent/shared/agent-detector')>();
  return {
    ...actual,
    setFirstLiveDetectionListener: (listener: (() => void) | null) => {
      captured.firstLiveDetectionListener = listener;
      actual.setFirstLiveDetectionListener(listener);
    },
  };
});

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { list: () => [], getOrThrow: vi.fn(), get: () => null, has: () => false },
}));
vi.mock('../../src/main/git/worktree-manager', () => ({ WorktreeManager: class {} }));
vi.mock('../../src/main/git/git-checks', () => ({ isGitRepo: vi.fn(() => false) }));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn() }));
vi.mock('../../src/main/db/repositories/handoff-repository', () => ({
  HandoffRepository: class { listByTaskId = vi.fn(() => []); },
}));
vi.mock('../../src/main/ipc/handlers/projects', () => ({ syncProjectMcpConfig: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: vi.fn(() => ({ pid: 1234, unref: vi.fn() })) }));

import { registerSystemHandlers } from '../../src/main/ipc/handlers/system';
import { agentNowInUse, resetAgentListForTests } from '../../src/main/agent/agent-list';
import { setAccountsConfigListener } from '../../src/main/accounts/accounts-config-changed';
import { IPC } from '../../src/shared/ipc-channels';

function makeContext() {
  return {
    configManager: {
      load: vi.fn(() => ({ agent: { cliPaths: {} }, terminal: { shell: null }, mcpServer: { enabled: false } })),
      getEffectiveConfig: vi.fn(() => ({ agent: { cliPaths: {} }, terminal: { shell: null } })),
      save: vi.fn(),
      saveProjectOverrides: vi.fn(),
      loadProjectOverrides: vi.fn(() => null),
    },
    mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
    currentProjectPath: null,
    currentProjectId: null,
  };
}

describe('registerSystemHandlers wires the agent inventory hooks', () => {
  let context: ReturnType<typeof makeContext>;

  beforeEach(() => {
    captured.hooks = null;
    captured.firstLiveDetectionListener = undefined;
    resetAgentListForTests();
    context = makeContext();
    registerSystemHandlers(context as unknown as Parameters<typeof registerSystemHandlers>[0]);
  });

  afterEach(() => {
    setAccountsConfigListener(null);
    resetAgentListForTests();
  });

  it('tells the main window to list the agents again when a deferred read changed them', () => {
    expect(captured.hooks?.onChanged).toBeTypeOf('function');

    captured.hooks?.onChanged?.();

    expect(context.mainWindow.webContents.send).toHaveBeenCalledWith(IPC.AGENT_LIST_CHANGED);
  });

  it('lists the account cards again too, because a card exists only for an agent whose CLI was found', () => {
    const accountsListener = vi.fn();
    setAccountsConfigListener(accountsListener);

    captured.hooks?.onChanged?.();

    expect(accountsListener).toHaveBeenCalledTimes(1);
  });

  it('hands the detectors agentNowInUse as the listener for a first live detection', () => {
    expect(captured.firstLiveDetectionListener).toBe(agentNowInUse);
  });

  it('hands the inventory a failure reporter for a defect in a deferred read', () => {
    expect(captured.hooks?.failureReporter).toMatchObject({ report: expect.any(Function) });
  });
});
