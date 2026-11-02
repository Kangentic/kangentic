/**
 * The pass that brings a project's running Command Terminals back after a
 * restart or a pty host crash (src/main/ipc/handlers/command-terminal-restore.ts),
 * over a real migrated project database and the real history record. Only the
 * start is a stand-in: what a start does with a restore is pinned in
 * transient-session-resume.test.ts.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type DatabaseType from 'better-sqlite3';

const hoisted = vi.hoisted(() => ({
  startCommandTerminal: vi.fn(),
  reapTaskLeftovers: vi.fn(async () => undefined),
  stopBackgroundSession: vi.fn(async () => undefined),
  shuttingDown: false,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => hoisted.handlers.set(channel, handler) },
}));

vi.mock('../../src/main/shutdown-state', () => ({ isShuttingDown: () => hoisted.shuttingDown }));
vi.mock('../../src/main/ipc/helpers/task-cleanup', () => ({ reapTaskLeftovers: hoisted.reapTaskLeftovers }));
vi.mock('../../src/main/ipc/helpers/command-terminal-background-session', () => ({
  stopEndedCommandTerminalBackgroundSession: hoisted.stopBackgroundSession,
}));

vi.mock('../../src/main/ipc/handlers/transient-sessions', () => {
  class CommandTerminalStartError extends Error {
    constructor(readonly code: string, message: string) {
      super(message);
    }
  }
  return { CommandTerminalStartError, startCommandTerminal: hoisted.startCommandTerminal };
});

import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import { CommandTerminalHistoryRepository } from '../../src/main/db/repositories/command-terminal-history-repository';
import { CommandTerminalHistory } from '../../src/main/ipc/helpers/command-terminal-history';
import {
  claimCommandTerminalRestore,
  claimLostCommandTerminal,
  forgetCommandTerminalRestore,
  isRestorableAfterHostLoss,
  registerCommandTerminalRestoreHandlers,
  restoreLostCommandTerminals,
  startCommandTerminalRestore,
  waitForCommandTerminalRestore,
  type LostCommandTerminal,
} from '../../src/main/ipc/handlers/command-terminal-restore';
import { CommandTerminalStartError } from '../../src/main/ipc/handlers/transient-sessions';
import { IPC } from '../../src/shared/ipc-channels';
import { PTY_HOST_LOST_EXIT_CODE } from '../../src/shared/pty-host';
import type { Session, StoredCliTarget } from '../../src/shared/types';
import { openTestDatabase } from './helpers/test-database';

const PROJECT_ID = 'project-1';
const openDatabases: DatabaseType.Database[] = [];
const histories: CommandTerminalHistory[] = [];
const temporaryFolders: string[] = [];
const startMock = hoisted.startCommandTerminal;

class FakeSessions extends EventEmitter {
  readonly sessions = new Map<string, Session>();
  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }
  getSessionAgentName(): string {
    return 'claude';
  }
  cliTarget: StoredCliTarget | null = null;
  getSessionCliTarget(): StoredCliTarget | null {
    return this.cliTarget;
  }
  listSessions(): Session[] {
    return [...this.sessions.values()];
  }
}

interface SeedRow {
  id: string;
  slot?: string | null;
  tag?: string | null;
  grid?: { cols: number; rows: number } | null;
  ended?: boolean;
  touched?: boolean;
  updatedAt?: string;
}

/** The mocked class, typed as what the test throws. */
function startError(code: string): Error {
  return new (CommandTerminalStartError as never as new (code: string, message: string) => Error)(code, code);
}

function makeRig(options: { rows?: SeedRow[]; enabled?: boolean; folderGone?: boolean } = {}) {
  const database = openTestDatabase();
  openDatabases.push(database);
  runProjectMigrations(database);
  const repository = new CommandTerminalHistoryRepository(database);
  for (const row of options.rows ?? []) {
    const now = row.updatedAt ?? new Date().toISOString();
    database.prepare(`
      INSERT INTO command_terminal_history
        (agent_session_id, agent_name, cwd, started_at, touched_at, ended_at, updated_at, slot, task_tag, last_pty_cols, last_pty_rows)
      VALUES (?, 'claude', '/projects/demo', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, now, row.touched === false ? null : now, row.ended ? now : null, now,
      row.slot ?? null, row.tag ?? null, row.grid?.cols ?? null, row.grid?.rows ?? null,
    );
  }
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-restore-'));
  temporaryFolders.push(projectPath);
  if (options.folderGone) fs.rmSync(projectPath, { recursive: true, force: true });
  const sessions = new FakeSessions();
  const notifyChanged = vi.fn();
  const projectRepo = { getById: vi.fn((id: string) => (id === PROJECT_ID ? { id, path: projectPath } : undefined)) };
  const configManager = { load: vi.fn(() => ({ agent: { autoResumeSessionsOnRestart: options.enabled ?? true } })) };
  const context = {
    projectRepo,
    configManager,
    sessionManager: sessions,
    commandTerminalHistory: undefined as CommandTerminalHistory | undefined,
  };
  const history = new CommandTerminalHistory({
    sessionManager: sessions,
    getRepository: () => repository,
    conversationAvailable: async () => true,
    notifyChanged,
    conversationEnded: vi.fn(),
    searchText: async () => ({ indexingOff: false, hits: [] }),
    claimRestore: (projectId) => claimCommandTerminalRestore(context as never, projectId),
  });
  history.start();
  histories.push(history);
  context.commandTerminalHistory = history;
  return { context: context as never, history, repository, notifyChanged, sessions, projectRepo, configManager, projectPath };
}

const startedIds = (): string[] => startMock.mock.calls.map(([, input]) => input.resumeAgentSessionId);

beforeEach(() => {
  startMock.mockReset();
  startMock.mockImplementation(async (_context, input) => ({ slot: input.slot ?? 'slot-9', session: { id: 'session' } }));
  hoisted.reapTaskLeftovers.mockClear();
  hoisted.stopBackgroundSession.mockClear();
  hoisted.shuttingDown = false;
  hoisted.handlers.clear();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const history of histories.splice(0)) history.dispose();
  for (const database of openDatabases.splice(0)) database.close();
  for (const folder of temporaryFolders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

describe('claimCommandTerminalRestore', () => {
  it('claims synchronously, so a list in the same tick neither ends a row nor offers it', async () => {
    const { context, history, repository } = makeRig({ rows: [{ id: 'conversation-a', slot: 'slot-1' }] });
    claimCommandTerminalRestore(context, PROJECT_ID);
    expect(await history.list(PROJECT_ID)).toEqual([]);
    expect(repository.get('conversation-a')?.ended_at).toBeNull();
  });

  it('runs from a list too, which starts nothing: only a cold open spawns', async () => {
    const { history, repository } = makeRig({ rows: [{ id: 'conversation-a' }] });
    expect(await history.list(PROJECT_ID)).toEqual([]);
    expect(repository.get('conversation-a')?.ended_at).toBeNull();
    expect(startMock).not.toHaveBeenCalled();
  });

  it('leaves every row to the list with the setting off, so the terminals land in Earlier', async () => {
    const { context, history, repository } = makeRig({ enabled: false, rows: [{ id: 'conversation-a', slot: 'slot-1' }] });
    await startCommandTerminalRestore(context, PROJECT_ID);
    expect(startMock).not.toHaveBeenCalled();
    expect((await history.list(PROJECT_ID)).map((entry) => entry.agentSessionId)).toEqual(['conversation-a']);
    expect(repository.get('conversation-a')?.ended_at).not.toBeNull();
  });

  it('claims nothing for a project whose folder is gone', async () => {
    const { context } = makeRig({ folderGone: true, rows: [{ id: 'conversation-a' }] });
    await startCommandTerminalRestore(context, PROJECT_ID);
    expect(startMock).not.toHaveBeenCalled();
  });

  it('takes the newest the cap holds, and leaves an older one to the list', async () => {
    const rows = ['1', '2', '3', '4', '5'].map((minute) => ({
      id: `conversation-${minute}`,
      updatedAt: `2026-11-01T10:0${minute}:00.000Z`,
    }));
    const { context, history } = makeRig({ rows });
    await startCommandTerminalRestore(context, PROJECT_ID);
    expect(startedIds().sort()).toEqual(['conversation-2', 'conversation-3', 'conversation-4', 'conversation-5']);
    expect((await history.list(PROJECT_ID)).map((entry) => entry.agentSessionId)).toEqual(['conversation-1']);
  });

  it('skips a conversation a phone resumed first', async () => {
    const { context, history } = makeRig({ rows: [{ id: 'conversation-a' }, { id: 'conversation-b' }] });
    history.claimResume(PROJECT_ID, 'conversation-a');
    await startCommandTerminalRestore(context, PROJECT_ID);
    expect(startedIds()).toEqual(['conversation-b']);
  });

  it('gives a place the cap holds to the next row when one of the newest is held by something else', async () => {
    // Five open rows, the cap is four. A row another start holds takes no place
    // in it, so the fifth-newest row is claimed in its stead.
    const rows = ['1', '2', '3', '4', '5'].map((minute) => ({
      id: `conversation-${minute}`,
      updatedAt: `2026-11-01T10:0${minute}:00.000Z`,
    }));
    const { context, history } = makeRig({ rows });
    expect(history.claimResume(PROJECT_ID, 'conversation-4')).toBe(true);

    await startCommandTerminalRestore(context, PROJECT_ID);

    expect(startedIds().sort()).toEqual(['conversation-1', 'conversation-2', 'conversation-3', 'conversation-5']);
  });

  describe('when the claim cannot read its rows', () => {
    it('does not throw, warns, and leaves the rows to the list', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const { context, history, projectRepo } = makeRig({ rows: [{ id: 'conversation-a' }] });
      projectRepo.getById.mockImplementation(() => { throw new Error('index database unreadable'); });

      expect(() => claimCommandTerminalRestore(context, PROJECT_ID)).not.toThrow();
      await expect(history.list(PROJECT_ID)).resolves.toMatchObject([{ agentSessionId: 'conversation-a' }]);

      expect(warnSpy).toHaveBeenCalledWith('[COMMAND_TERMINAL] restore claim failed (non-fatal):', 'index database unreadable');
      expect(startMock).not.toHaveBeenCalled();
    });

    it('answers a waiter at once, not at the ceiling', async () => {
      vi.useFakeTimers();
      try {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const { context, configManager } = makeRig({ rows: [{ id: 'conversation-a' }] });
        configManager.load.mockImplementation(() => { throw new Error('config unreadable'); });
        let finished = false;
        const wait = waitForCommandTerminalRestore(context, PROJECT_ID).then(() => { finished = true; });

        // Far short of the 10 s ceiling.
        await vi.advanceTimersByTimeAsync(1);

        expect(finished).toBe(true);
        await wait;
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('puts the row back in Earlier and starts nothing when the folder goes between the claim and the start', async () => {
    const { context, history, projectPath } = makeRig({ rows: [{ id: 'conversation-a', slot: 'slot-1' }] });
    claimCommandTerminalRestore(context, PROJECT_ID);
    fs.rmSync(projectPath, { recursive: true, force: true });

    await startCommandTerminalRestore(context, PROJECT_ID);

    expect(startMock).not.toHaveBeenCalled();
    expect((await history.list(PROJECT_ID)).map((entry) => entry.agentSessionId)).toEqual(['conversation-a']);
    expect(history.claimResume(PROJECT_ID, 'conversation-a')).toBe(true);
  });
});

describe('startCommandTerminalRestore', () => {
  it('restores in the saved slot with the saved tag and grid', async () => {
    const { context } = makeRig({ rows: [{ id: 'conversation-a', slot: 'slot-3', tag: 'tag-a', grid: { cols: 180, rows: 44 } }] });
    await startCommandTerminalRestore(context, PROJECT_ID);
    expect(startMock).toHaveBeenCalledWith(
      context,
      { projectId: PROJECT_ID, slot: 'slot-3', resumeAgentSessionId: 'conversation-a' },
      { processTag: 'tag-a', grid: { cols: 180, rows: 44 } },
    );
  });

  it('runs once per launch', async () => {
    const { context } = makeRig({ rows: [{ id: 'conversation-a' }] });
    await startCommandTerminalRestore(context, PROJECT_ID);
    await startCommandTerminalRestore(context, PROJECT_ID);
    expect(startMock).toHaveBeenCalledTimes(1);
  });

  it('starts saved slots first, so a row from before the column cannot take one', async () => {
    const { context } = makeRig({
      rows: [
        { id: 'no-slot', updatedAt: '2026-11-01T10:04:00.000Z' },
        { id: 'slot-two', slot: 'slot-2', updatedAt: '2026-11-01T10:03:00.000Z' },
        { id: 'slot-one', slot: 'slot-1', updatedAt: '2026-11-01T10:02:00.000Z' },
      ],
    });
    await startCommandTerminalRestore(context, PROJECT_ID);
    expect(startedIds()).toEqual(['slot-one', 'slot-two', 'no-slot']);
  });

  it('falls back to the lowest free slot when its own is taken', async () => {
    const { context } = makeRig({ rows: [{ id: 'conversation-a', slot: 'slot-1' }] });
    startMock.mockRejectedValueOnce(startError('slot-taken'));
    await startCommandTerminalRestore(context, PROJECT_ID);
    expect(startMock).toHaveBeenCalledTimes(2);
    expect(startMock.mock.calls[1][1]).toMatchObject({ slot: undefined, resumeAgentSessionId: 'conversation-a' });
  });

  it('gives a refused conversation back to Earlier, quietly, and goes on to the next', async () => {
    const { context, history } = makeRig({
      rows: [
        { id: 'gone', slot: 'slot-1' },
        { id: 'kept', slot: 'slot-2' },
      ],
    });
    startMock.mockRejectedValueOnce(startError('conversation-gone'));
    await expect(startCommandTerminalRestore(context, PROJECT_ID)).resolves.toBeUndefined();
    expect(startedIds()).toEqual(['gone', 'kept']);
    expect((await history.list(PROJECT_ID)).map((entry) => entry.agentSessionId)).toEqual(['gone']);
  });

  it('settles a claim on any failure, never rejecting', async () => {
    const { context, history } = makeRig({ rows: [{ id: 'conversation-a' }] });
    startMock.mockRejectedValueOnce(new Error('agent CLI not found'));
    await expect(startCommandTerminalRestore(context, PROJECT_ID)).resolves.toBeUndefined();
    expect(history.claimResume(PROJECT_ID, 'conversation-a')).toBe(true);
  });

  it('drops a duplicate tag, which no two live sessions may share', async () => {
    const { context } = makeRig({
      rows: [
        { id: 'first', slot: 'slot-1', tag: 'shared-tag' },
        { id: 'second', slot: 'slot-2', tag: 'shared-tag' },
      ],
    });
    await startCommandTerminalRestore(context, PROJECT_ID);
    expect(startMock.mock.calls[0][2]).toMatchObject({ processTag: 'shared-tag' });
    expect(startMock.mock.calls[1][2]).toMatchObject({ processTag: null });
  });

  it('starts nothing once the app is quitting, and still settles its claims', async () => {
    const { context, history } = makeRig({ rows: [{ id: 'conversation-a' }] });
    claimCommandTerminalRestore(context, PROJECT_ID);
    hoisted.shuttingDown = true;
    await startCommandTerminalRestore(context, PROJECT_ID);
    expect(startMock).not.toHaveBeenCalled();
    expect(history.claimResume(PROJECT_ID, 'conversation-a')).toBe(true);
  });

  it('keeps rows that saved no slot in their listed order, newest first, after the ones that did', async () => {
    const { context } = makeRig({
      rows: [
        { id: 'no-slot-oldest', updatedAt: '2026-11-01T10:01:00.000Z' },
        { id: 'slot-two', slot: 'slot-2', updatedAt: '2026-11-01T10:02:00.000Z' },
        { id: 'no-slot-middle', updatedAt: '2026-11-01T10:03:00.000Z' },
        { id: 'no-slot-newest', updatedAt: '2026-11-01T10:04:00.000Z' },
      ],
    });
    await startCommandTerminalRestore(context, PROJECT_ID);
    expect(startedIds()).toEqual(['slot-two', 'no-slot-newest', 'no-slot-middle', 'no-slot-oldest']);
  });

  it('starts one at a time, so a row with no slot sees what the row before it took', async () => {
    const { context } = makeRig({ rows: [{ id: 'first', slot: 'slot-1' }, { id: 'second' }] });
    let release: () => void = () => undefined;
    startMock.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ slot: 'slot-1', session: { id: 'session' } });
    }));
    const pass = startCommandTerminalRestore(context, PROJECT_ID);
    await vi.waitFor(() => expect(startMock).toHaveBeenCalledTimes(1));
    release();
    await pass;
    expect(startMock).toHaveBeenCalledTimes(2);
  });
});

describe('waitForCommandTerminalRestore', () => {
  it('resolves once the start is over', async () => {
    const { context } = makeRig({ rows: [{ id: 'conversation-a' }] });
    let finished = false;
    const wait = waitForCommandTerminalRestore(context, PROJECT_ID).then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    await startCommandTerminalRestore(context, PROJECT_ID);
    await wait;
    expect(finished).toBe(true);
  });

  it('answers at once with nothing to restore', async () => {
    const { context } = makeRig();
    await expect(waitForCommandTerminalRestore(context, PROJECT_ID)).resolves.toBeUndefined();
  });

  it('never leaves the panel waiting past its ceiling', async () => {
    vi.useFakeTimers();
    try {
      const { context } = makeRig({ rows: [{ id: 'conversation-a' }] });
      const wait = waitForCommandTerminalRestore(context, PROJECT_ID);
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(wait).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('is what the IPC channel answers, and an unknown project opens nothing', async () => {
    const { context } = makeRig();
    registerCommandTerminalRestoreHandlers(context);
    const handler = hoisted.handlers.get(IPC.COMMAND_TERMINAL_RESTORE_WAIT);
    await expect(handler?.(null, PROJECT_ID)).resolves.toBeUndefined();
    await expect(handler?.(null, 'no-such-project')).resolves.toBeUndefined();
    await expect(handler?.(null, 42)).resolves.toBeUndefined();
  });

  it('forgets a deleted project, so one re-added at its id gets a pass', async () => {
    const { context, history } = makeRig({ rows: [{ id: 'conversation-a' }] });
    await startCommandTerminalRestore(context, PROJECT_ID);
    history.settleResume(PROJECT_ID, 'conversation-a', null);
    forgetCommandTerminalRestore(context, PROJECT_ID);
    await startCommandTerminalRestore(context, PROJECT_ID);
    expect(startMock).toHaveBeenCalledTimes(2);
  });
});

describe('a pty host crash', () => {
  function lostTerminal(overrides: Partial<Session> = {}): Session {
    return {
      id: 'terminal-1',
      taskId: 'tag-1',
      projectId: PROJECT_ID,
      status: 'exited',
      exitCode: PTY_HOST_LOST_EXIT_CODE,
      transient: true,
      agentSessionId: 'conversation-a',
      hasUserInput: true,
      ...overrides,
    } as Session;
  }

  it('restores a terminal it took down that someone used', () => {
    const { context } = makeRig();
    expect(isRestorableAfterHostLoss(context, lostTerminal())).toBe(true);
  });

  it.each([
    ['one that exited on its own', { exitCode: 1 }],
    ['one nobody used', { hasUserInput: undefined }],
    ['one with no conversation yet', { agentSessionId: null }],
    ['a workflow agent', { workflowId: 'workflow-1' }],
    ["a task's session", { transient: false }],
  ])('leaves %s', (_name, overrides) => {
    const { context } = makeRig();
    expect(isRestorableAfterHostLoss(context, lostTerminal(overrides))).toBe(false);
  });

  it('leaves everything with the setting off', () => {
    const { context } = makeRig({ enabled: false });
    expect(isRestorableAfterHostLoss(context, lostTerminal())).toBe(false);
  });

  function claimed(context: never, overrides: Partial<Session> = {}): LostCommandTerminal {
    const lost = claimLostCommandTerminal(
      context,
      lostTerminal({ commandTerminalSlot: 'slot-2', cwd: '/projects/demo', shell: 'pwsh', ...overrides }),
    );
    if (!lost) throw new Error('expected the terminal to be claimed');
    return lost;
  }

  it("claims in the removal's own emit, so the row never shows in Earlier while the host restarts", async () => {
    const { context, history } = makeRig({ rows: [{ id: 'conversation-a', ended: true }] });
    expect(claimed(context)).toMatchObject({ agentSessionId: 'conversation-a', claimed: true });
    expect(await history.list(PROJECT_ID)).toEqual([]);
  });

  it('claims nothing for a terminal that does not come back', () => {
    const { context } = makeRig({ rows: [{ id: 'conversation-a', ended: true }] });
    expect(claimLostCommandTerminal(context, lostTerminal({ hasUserInput: undefined }))).toBeNull();
    expect(claimLostCommandTerminal(context, undefined)).toBeNull();
  });

  it('restores what it claimed, in the saved slot, and reaps nothing', async () => {
    const { context } = makeRig({ rows: [{ id: 'conversation-a', ended: true, slot: 'slot-2', tag: 'tag-1' }] });
    await restoreLostCommandTerminals(context, PROJECT_ID, [claimed(context)]);
    expect(startMock).toHaveBeenCalledWith(
      context,
      { projectId: PROJECT_ID, slot: 'slot-2', resumeAgentSessionId: 'conversation-a' },
      { processTag: 'tag-1', grid: null },
    );
    expect(hoisted.reapTaskLeftovers).not.toHaveBeenCalled();
  });

  it('reaps what a refused restore left running: the reaper skipped it, and it has ended', async () => {
    const { context } = makeRig({ rows: [{ id: 'conversation-a', ended: true, slot: 'slot-2', tag: 'tag-1' }] });
    startMock.mockRejectedValueOnce(startError('conversation-gone'));
    await restoreLostCommandTerminals(context, PROJECT_ID, [claimed(context)]);
    await vi.waitFor(() => expect(hoisted.reapTaskLeftovers).toHaveBeenCalledTimes(1));
    expect(hoisted.reapTaskLeftovers).toHaveBeenCalledWith(
      context,
      '/projects/demo',
      [{ id: 'tag-1', worktree_path: null, title: 'Command Terminal 2' }],
      { wslDistros: [], skipStopScript: true },
    );
    // The CLI stops a conversation's background session before the reap, as at any end.
    expect(hoisted.stopBackgroundSession).toHaveBeenCalledTimes(1);
    expect(hoisted.stopBackgroundSession.mock.invocationCallOrder[0]).toBeLessThan(hoisted.reapTaskLeftovers.mock.invocationCallOrder[0]);
  });

  it('reaps a terminal whose claim was refused: a Resume click got there first', async () => {
    const { context, history } = makeRig({ rows: [{ id: 'conversation-a', ended: true }] });
    history.claimResume(PROJECT_ID, 'conversation-a');
    const lost = claimed(context);
    expect(lost.claimed).toBe(false);
    await restoreLostCommandTerminals(context, PROJECT_ID, [lost]);
    expect(startMock).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(hoisted.reapTaskLeftovers).toHaveBeenCalledTimes(1));
    // The claim is the other start's, and stays.
    expect(history.claimResume(PROJECT_ID, 'conversation-a')).toBe(false);
  });

  it('lets go of a claim whose row went, and reaps', async () => {
    const { context, history } = makeRig();
    const lost = claimed(context);
    await restoreLostCommandTerminals(context, PROJECT_ID, [lost]);
    expect(startMock).not.toHaveBeenCalled();
    expect(history.claimResume(PROJECT_ID, 'conversation-a')).toBe(true);
    await vi.waitFor(() => expect(hoisted.reapTaskLeftovers).toHaveBeenCalledTimes(1));
  });

  it('reaps nothing once the app is quitting, as for any end', async () => {
    const { context } = makeRig({ rows: [{ id: 'conversation-a', ended: true }] });
    const lost = claimed(context);
    hoisted.shuttingDown = true;
    await restoreLostCommandTerminals(context, PROJECT_ID, [lost]);
    expect(hoisted.reapTaskLeftovers).not.toHaveBeenCalled();
  });

  it("names the distro of a WSL shell, so the refused terminal's leftovers are reaped inside it", async () => {
    const { context } = makeRig({ rows: [{ id: 'conversation-a', ended: true, slot: 'slot-2', tag: 'tag-1' }] });
    const lost = claimed(context, { shell: 'wsl -d Ubuntu' });
    expect(lost.wslDistros).toEqual(['Ubuntu']);

    startMock.mockRejectedValueOnce(startError('conversation-gone'));
    await restoreLostCommandTerminals(context, PROJECT_ID, [lost]);

    await vi.waitFor(() => expect(hoisted.reapTaskLeftovers).toHaveBeenCalledTimes(1));
    expect(hoisted.reapTaskLeftovers).toHaveBeenCalledWith(
      context,
      '/projects/demo',
      expect.anything(),
      { wslDistros: ['Ubuntu'], skipStopScript: true },
    );
  });

  it('names no distro for a shell that is not WSL', () => {
    const { context } = makeRig({ rows: [{ id: 'conversation-a', ended: true }] });
    expect(claimed(context, { shell: 'bash' }).wslDistros).toEqual([]);
  });

  it("carries the CLI's place the registry holds into the background session stop", () => {
    const { context, sessions } = makeRig({ rows: [{ id: 'conversation-a', ended: true }] });
    sessions.cliTarget = { kind: 'wsl', distro: 'Ubuntu' };

    const lost = claimed(context);

    expect(lost.ended).toEqual({
      agentName: 'claude',
      agentSessionId: 'conversation-a',
      cwd: '/projects/demo',
      cliTarget: { kind: 'wsl', distro: 'Ubuntu' },
    });
  });

  it('has no CLI place when the registry holds none', () => {
    const { context } = makeRig({ rows: [{ id: 'conversation-a', ended: true }] });
    expect(claimed(context).ended.cliTarget).toBeNull();
  });

  it('warns and rejects nothing when the background session stop fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { context } = makeRig({ rows: [{ id: 'conversation-a', ended: true }] });
    hoisted.stopBackgroundSession.mockRejectedValueOnce(new Error('claude stop failed'));
    startMock.mockRejectedValueOnce(startError('conversation-gone'));

    // An unhandled rejection from the fire-and-forget reap fails the whole run.
    await expect(restoreLostCommandTerminals(context, PROJECT_ID, [claimed(context)])).resolves.toBeUndefined();

    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalledWith(
      '[COMMAND_TERMINAL] leftover reap failed (non-fatal):',
      'claude stop failed',
    ));
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  describe('the panel waiting during a host loss', () => {
    const flush = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));
    function trackSettled(promise: Promise<unknown>): () => boolean {
      let settled = false;
      void promise.then(() => { settled = true; });
      return () => settled;
    }

    it('holds until the restore has finished, and answers after it', async () => {
      const { context } = makeRig({ rows: [{ id: 'conversation-a', ended: true, slot: 'slot-2' }] });
      let releaseStart: () => void = () => undefined;
      startMock.mockImplementationOnce(() => new Promise((resolve) => {
        releaseStart = () => resolve({ slot: 'slot-2', session: { id: 'session' } });
      }));
      const lost = claimed(context);
      const wait = waitForCommandTerminalRestore(context, PROJECT_ID);
      const isWaitOver = trackSettled(wait);

      const restore = restoreLostCommandTerminals(context, PROJECT_ID, [lost]);
      await vi.waitFor(() => expect(startMock).toHaveBeenCalledTimes(1));
      await flush();
      expect(isWaitOver()).toBe(false);

      releaseStart();
      await restore;
      await wait;
      expect(isWaitOver()).toBe(true);
    });

    it('answers after a restore that refuses its row, too', async () => {
      const { context } = makeRig({ rows: [{ id: 'conversation-a', ended: true, slot: 'slot-2' }] });
      let refuseStart: () => void = () => undefined;
      startMock.mockImplementationOnce(() => new Promise((_resolve, reject) => {
        refuseStart = () => reject(startError('conversation-gone'));
      }));
      const lost = claimed(context);
      const wait = waitForCommandTerminalRestore(context, PROJECT_ID);
      const isWaitOver = trackSettled(wait);

      const restore = restoreLostCommandTerminals(context, PROJECT_ID, [lost]);
      await vi.waitFor(() => expect(startMock).toHaveBeenCalledTimes(1));
      await flush();
      expect(isWaitOver()).toBe(false);

      refuseStart();
      await restore;
      await wait;
      expect(isWaitOver()).toBe(true);
    });

    it('is released when the project is forgotten', async () => {
      const { context } = makeRig({ rows: [{ id: 'conversation-a', ended: true }] });
      claimed(context);
      const wait = waitForCommandTerminalRestore(context, PROJECT_ID);
      const isWaitOver = trackSettled(wait);
      await flush();
      expect(isWaitOver()).toBe(false);

      forgetCommandTerminalRestore(context, PROJECT_ID);

      await wait;
      expect(isWaitOver()).toBe(true);
    });

    it('is still answered at the ceiling when the restore never finishes', async () => {
      vi.useFakeTimers();
      try {
        const { context } = makeRig({ rows: [{ id: 'conversation-a', ended: true }] });
        claimed(context);
        const wait = waitForCommandTerminalRestore(context, PROJECT_ID);
        const isWaitOver = trackSettled(wait);

        await vi.advanceTimersByTimeAsync(9_999);
        expect(isWaitOver()).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        await wait;
        expect(isWaitOver()).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
