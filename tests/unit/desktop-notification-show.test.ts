/**
 * showDesktopNotification (src/main/ipc/handlers/system.ts): what the OS toast is built with, and
 * what happens to it.
 *
 * - One live toast per task: `id` is the task id, so a newer toast for the task replaces the stale
 *   one in Action Center / Notification Center instead of stacking. The Command Terminal sentinel
 *   takes no id, or every Command Terminal in every project would collapse into one toast.
 * - `failed` is handled: since Electron 42 macOS uses UNNotification, which an unsigned build or a
 *   denied permission refuses with `failed` and never `close`, so the toast vanished silently and
 *   its object leaked from the keep-alive set.
 * - A click restores and focuses the window and tells the renderer which task.
 *
 * Tier: Unit (vitest, Electron mocked).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Listener = (...args: unknown[]) => void;

const { constructed } = vi.hoisted(() => {
  const constructed: Array<{ options: Record<string, unknown>; listeners: Map<string, Listener>; shown: number }> = [];
  return { constructed };
});

vi.mock('electron', () => {
  class FakeNotification {
    static isSupported = vi.fn(() => true);
    private readonly record: { options: Record<string, unknown>; listeners: Map<string, Listener>; shown: number };
    constructor(options: Record<string, unknown>) {
      this.record = { options, listeners: new Map(), shown: 0 };
      constructed.push(this.record);
    }
    on(event: string, listener: Listener): this {
      this.record.listeners.set(event, listener);
      return this;
    }
    show(): void {
      this.record.shown += 1;
    }
  }
  return {
    app: { getVersion: vi.fn(() => '0.0.0'), getPath: vi.fn(() => '/tmp') },
    ipcMain: { handle: vi.fn(), on: vi.fn() },
    BrowserWindow: { getAllWindows: vi.fn(() => []) },
    Notification: FakeNotification,
    dialog: { showOpenDialog: vi.fn() },
    shell: { openPath: vi.fn(), openExternal: vi.fn() },
    globalShortcut: { isRegistered: vi.fn(), register: vi.fn(), unregister: vi.fn() },
    clipboard: {},
    nativeImage: {},
  };
});

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { list: vi.fn(() => []), get: vi.fn(() => null), getOrThrow: vi.fn(), has: vi.fn(() => false) },
}));
vi.mock('../../src/main/git/worktree-manager', () => ({ WorktreeManager: class {} }));
vi.mock('../../src/main/git/git-checks', () => ({ isGitRepo: vi.fn(() => false) }));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn() }));
vi.mock('../../src/main/db/repositories/handoff-repository', () => ({
  HandoffRepository: class { listByTaskId = vi.fn(() => []); },
}));
vi.mock('node:child_process', () => ({ spawn: vi.fn(), exec: vi.fn(), execFile: vi.fn() }));
vi.mock('../../src/main/config/apply-runtime-config', () => ({ applyRuntimeConfig: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/projects', () => ({ syncProjectMcpConfig: vi.fn() }));

import { notificationIdentity, showDesktopNotification } from '../../src/main/ipc/handlers/system';
import { COMMAND_TERMINAL_NOTIFICATION_TASK_ID } from '../../src/shared/notification-constants';
import { IPC } from '../../src/shared/ipc-channels';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

const TASK_ID = '0b6f1d2e-aaaa-4c3b-9d7e-1234567890ab';
const PROJECT_ID = '7d0c2f69-ba02-460b-9858-65e0f186afc2';

function makeContext() {
  const mainWindow = {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => true),
    isFocused: vi.fn(() => true),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    once: vi.fn(),
    webContents: { send: vi.fn() },
  };
  return { context: { mainWindow } as unknown as IpcContext, mainWindow };
}

beforeEach(() => {
  constructed.length = 0;
});

describe('notificationIdentity', () => {
  it('keys a task toast by the task id and groups it by project', () => {
    expect(notificationIdentity({ title: 't', body: 'b', projectId: PROJECT_ID, taskId: TASK_ID })).toEqual({
      id: TASK_ID,
      groupId: PROJECT_ID,
    });
  });

  it('gives the Command Terminal sentinel no id, so its toasts never collapse into one', () => {
    const identity = notificationIdentity({
      title: 't',
      body: 'b',
      projectId: PROJECT_ID,
      taskId: COMMAND_TERMINAL_NOTIFICATION_TASK_ID,
    });
    expect(identity.id).toBeUndefined();
    expect(identity.groupId).toBe(PROJECT_ID);
  });

  it('stays inside the 64 characters Windows allows for a toast Tag and Group', () => {
    const identity = notificationIdentity({ title: 't', body: 'b', projectId: PROJECT_ID, taskId: TASK_ID });
    expect((identity.id ?? '').length).toBeLessThanOrEqual(64);
    expect(identity.groupId.length).toBeLessThanOrEqual(64);
  });
});

describe('showDesktopNotification', () => {
  it('builds the toast with its title, body and task identity, and shows it', () => {
    const { context } = makeContext();
    showDesktopNotification(context, { title: 'Agent finished', body: 'Fix login', projectId: PROJECT_ID, taskId: TASK_ID });

    expect(constructed).toHaveLength(1);
    expect(constructed[0].options).toEqual({ title: 'Agent finished', body: 'Fix login', id: TASK_ID, groupId: PROJECT_ID });
    expect(constructed[0].shown).toBe(1);
  });

  it('handles failed, so a refused toast is logged instead of vanishing', () => {
    const { context } = makeContext();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    showDesktopNotification(context, { title: 't', body: 'b', projectId: PROJECT_ID, taskId: TASK_ID });

    const failed = constructed[0].listeners.get('failed');
    expect(failed, 'no failed listener').toBeTypeOf('function');
    failed?.({}, 'Notifications are not allowed for this app');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[NOTIFICATION]'), 'Notifications are not allowed for this app');
    warn.mockRestore();
  });

  it('restores and focuses the window on click and tells the renderer which task', () => {
    const { context, mainWindow } = makeContext();
    showDesktopNotification(context, { title: 't', body: 'b', projectId: PROJECT_ID, taskId: TASK_ID });

    constructed[0].listeners.get('click')?.();
    expect(mainWindow.restore).toHaveBeenCalled();
    expect(mainWindow.show).toHaveBeenCalled();
    expect(mainWindow.focus).toHaveBeenCalled();
    expect(mainWindow.webContents.send).toHaveBeenCalledWith(IPC.NOTIFICATION_CLICKED, PROJECT_ID, TASK_ID);
  });
});
