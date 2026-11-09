/**
 * A Command Terminal's Browser pane ends with the terminal, and survives a
 * respawn of its slot.
 *
 * A task's browser is cleaned up off its `sessions` row, which a Command
 * Terminal does not have, so before this its offscreen page, its Browser
 * window and its saved URL and layout outlived it, and the next terminal in the
 * slot inherited them. A branch switch or a resume in place also ends the
 * slot's session, through the same kill as Stop, and must keep the page.
 */
import { EventEmitter } from 'node:events';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../src/main/browser/browser-pane-registry', () => ({
  browserPaneRegistry: { getByTaskId: vi.fn(() => []), markDeliberateClose: vi.fn() },
}));
vi.mock('../../src/main/browser/browser-lane-manager', () => ({ destroyLanesForTask: vi.fn(() => 0) }));
vi.mock('../../src/main/browser/browser-url-store', () => ({ browserUrlStore: { clear: vi.fn() } }));
vi.mock('../../src/main/browser/command-terminal-browser-store', () => ({ commandTerminalBrowserStore: { clear: vi.fn() } }));
vi.mock('../../src/main/browser/annotation-drafts', () => ({ discardAnnotationDraft: vi.fn(async () => undefined) }));
vi.mock('../../src/main/browser/viewport-override', () => ({ releaseViewportOverridesForSession: vi.fn(async () => undefined) }));
vi.mock('../../src/main/pop-out/pop-out-window-manager', () => ({
  popOutWindowManager: { has: vi.fn(() => false), close: vi.fn() },
}));
vi.mock('../../src/main/pop-out/window-broadcast', () => ({ broadcast: vi.fn() }));
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({
  resolveProjectContext: vi.fn(() => ({ projectId: 'proj-1', projectPath: '/projects/app' })),
}));

import { browserPaneRegistry } from '../../src/main/browser/browser-pane-registry';
import { destroyLanesForTask } from '../../src/main/browser/browser-lane-manager';
import { browserUrlStore } from '../../src/main/browser/browser-url-store';
import { commandTerminalBrowserStore } from '../../src/main/browser/command-terminal-browser-store';
import { discardAnnotationDraft } from '../../src/main/browser/annotation-drafts';
import { popOutWindowManager } from '../../src/main/pop-out/pop-out-window-manager';
import { broadcast } from '../../src/main/pop-out/window-broadcast';
import {
  installCommandTerminalBrowserCleanup,
  markCommandTerminalRespawn,
  RESPAWN_SETTLE_MS,
} from '../../src/main/ipc/helpers/command-terminal-browser';
import { commandTerminalBrowserOwner } from '../../src/shared/browser-owner';
import { IPC } from '../../src/shared/ipc-channels';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { Session } from '../../src/shared/types';

const OWNER = commandTerminalBrowserOwner('proj-1', 'slot-2');

function terminalSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'terminal-session',
    taskId: 'synthetic-tag',
    projectId: 'proj-1',
    pid: null,
    status: 'running',
    shell: 'bash',
    cwd: '/projects/app',
    startedAt: new Date().toISOString(),
    exitCode: null,
    resuming: false,
    transient: true,
    commandTerminalSlot: 'slot-2',
    ...overrides,
  } as Session;
}

describe('installCommandTerminalBrowserCleanup', () => {
  let sessionManager: EventEmitter;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionManager = new EventEmitter();
    const context = {
      sessionManager,
      mainWindow: { isDestroyed: () => false },
    } as unknown as IpcContext;
    installCommandTerminalBrowserCleanup(context);
  });

  it("ends the slot's page, lanes, Browser window, saved URL, layout and annotations when the terminal ends", () => {
    vi.mocked(popOutWindowManager.has).mockReturnValue(true);
    vi.mocked(browserPaneRegistry.getByTaskId).mockReturnValue([{ sessionId: 'pane_12345678', kind: 'pane' }] as never);

    sessionManager.emit('session-removed', 'terminal-session', terminalSession());

    expect(browserPaneRegistry.markDeliberateClose).toHaveBeenCalledWith(['pane_12345678']);
    expect(broadcast).toHaveBeenCalledWith(expect.anything(), IPC.BROWSER_PANE_CLOSE_REQUEST, 'proj-1', [OWNER]);
    expect(popOutWindowManager.close).toHaveBeenCalledWith('browser', { projectId: 'proj-1', taskId: OWNER });
    expect(destroyLanesForTask).toHaveBeenCalledWith(OWNER);
    expect(browserUrlStore.clear).toHaveBeenCalledWith('/projects/app', OWNER);
    expect(commandTerminalBrowserStore.clear).toHaveBeenCalledWith('/projects/app', 'slot-2');
    expect(discardAnnotationDraft).toHaveBeenCalledWith('/projects/app', OWNER, { retire: true });
  });

  it('keeps everything through a respawn of the slot (a branch switch or a resume in place)', () => {
    markCommandTerminalRespawn('terminal-session');

    sessionManager.emit('session-removed', 'terminal-session', terminalSession());

    expect(broadcast).not.toHaveBeenCalled();
    expect(destroyLanesForTask).not.toHaveBeenCalled();
    expect(browserUrlStore.clear).not.toHaveBeenCalled();
    expect(commandTerminalBrowserStore.clear).not.toHaveBeenCalled();

    // The mark is spent: the slot's next session ending for good cleans up.
    sessionManager.emit('session-removed', 'terminal-session', terminalSession());
    expect(destroyLanesForTask).toHaveBeenCalledWith(OWNER);
  });

  it('keeps everything for a terminal a pty host crash took down and the restore brings back', () => {
    // A second install with the restore's answer: this terminal did not end.
    const restoringManager = new EventEmitter();
    installCommandTerminalBrowserCleanup(
      { sessionManager: restoringManager, mainWindow: { isDestroyed: () => false } } as unknown as IpcContext,
      { willRestore: (session) => session.id === 'lost-terminal' },
    );

    restoringManager.emit('session-removed', 'lost-terminal', terminalSession({ id: 'lost-terminal' }));
    expect(destroyLanesForTask).not.toHaveBeenCalled();
    expect(commandTerminalBrowserStore.clear).not.toHaveBeenCalled();

    // Its converse: a terminal the restore does not bring back ends its browser.
    restoringManager.emit('session-removed', 'gone-terminal', terminalSession({ id: 'gone-terminal' }));
    expect(destroyLanesForTask).toHaveBeenCalledWith(OWNER);
  });

  it("touches nothing for a task's agent or a workflow's agent", () => {
    sessionManager.emit('session-removed', 'task-session', terminalSession({ id: 'task-session', transient: false, commandTerminalSlot: null }));
    sessionManager.emit('session-removed', 'workflow-session', terminalSession({ id: 'workflow-session', workflowId: 'wf-1' }));

    expect(broadcast).not.toHaveBeenCalled();
    expect(destroyLanesForTask).not.toHaveBeenCalled();
  });
});

describe('a respawn whose next start has not landed yet', () => {
  let sessionManager: EventEmitter & { findLiveCommandTerminalSession: ReturnType<typeof vi.fn> };
  let slotStarting: boolean;
  let slotCounter = 0;
  let slot: string;
  let owner: string;

  function respawnedSession(id: string): Session {
    return terminalSession({ id, commandTerminalSlot: slot });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    slotCounter += 1;
    // A slot of its own per test: the pending-check map is module state.
    slot = `slot-${(slotCounter % 4) + 1}`;
    owner = commandTerminalBrowserOwner('proj-1', slot);
    slotStarting = false;
    sessionManager = Object.assign(new EventEmitter(), {
      findLiveCommandTerminalSession: vi.fn(() => undefined),
    });
    installCommandTerminalBrowserCleanup(
      { sessionManager, mainWindow: { isDestroyed: () => false } } as unknown as IpcContext,
      { isSlotStarting: () => slotStarting },
    );
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('ends the browser once the settle window passes with no terminal and no start in the slot', () => {
    markCommandTerminalRespawn('respawned');
    sessionManager.emit('session-removed', 'respawned', respawnedSession('respawned'));

    vi.advanceTimersByTime(RESPAWN_SETTLE_MS - 1);
    expect(destroyLanesForTask).not.toHaveBeenCalled();
    expect(commandTerminalBrowserStore.clear).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(destroyLanesForTask).toHaveBeenCalledWith(owner);
    expect(commandTerminalBrowserStore.clear).toHaveBeenCalledWith('/projects/app', slot);
    expect(browserUrlStore.clear).toHaveBeenCalledWith('/projects/app', owner);
  });

  it('re-arms while a start holds the slot, and keeps the browser when the terminal then arrives', () => {
    markCommandTerminalRespawn('respawned');
    sessionManager.emit('session-removed', 'respawned', respawnedSession('respawned'));
    slotStarting = true;

    vi.advanceTimersByTime(RESPAWN_SETTLE_MS);
    expect(destroyLanesForTask).not.toHaveBeenCalled();

    // The start lands: a live terminal is in the slot at the next check.
    slotStarting = false;
    sessionManager.findLiveCommandTerminalSession.mockReturnValue({ id: 'next' });
    vi.advanceTimersByTime(RESPAWN_SETTLE_MS);
    expect(destroyLanesForTask).not.toHaveBeenCalled();
    expect(commandTerminalBrowserStore.clear).not.toHaveBeenCalled();
  });

  it('ends the browser when a start that held the slot failed and left it empty', () => {
    markCommandTerminalRespawn('respawned');
    sessionManager.emit('session-removed', 'respawned', respawnedSession('respawned'));
    slotStarting = true;
    vi.advanceTimersByTime(RESPAWN_SETTLE_MS);
    expect(destroyLanesForTask).not.toHaveBeenCalled();

    slotStarting = false;
    vi.advanceTimersByTime(RESPAWN_SETTLE_MS);
    expect(destroyLanesForTask).toHaveBeenCalledWith(owner);
  });

  it('keeps the browser of a respawn that succeeded', () => {
    markCommandTerminalRespawn('respawned');
    sessionManager.emit('session-removed', 'respawned', respawnedSession('respawned'));
    sessionManager.findLiveCommandTerminalSession.mockReturnValue({ id: 'next' });

    vi.advanceTimersByTime(RESPAWN_SETTLE_MS * 3);
    expect(destroyLanesForTask).not.toHaveBeenCalled();
    expect(commandTerminalBrowserStore.clear).not.toHaveBeenCalled();
  });

  it('cancels the pending check when the slot later ends normally, so the end runs once', () => {
    markCommandTerminalRespawn('respawned');
    sessionManager.emit('session-removed', 'respawned', respawnedSession('respawned'));

    sessionManager.emit('session-removed', 'next-terminal', respawnedSession('next-terminal'));
    expect(destroyLanesForTask).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(RESPAWN_SETTLE_MS * 3);
    expect(destroyLanesForTask).toHaveBeenCalledTimes(1);
    expect(commandTerminalBrowserStore.clear).toHaveBeenCalledTimes(1);
  });
});
