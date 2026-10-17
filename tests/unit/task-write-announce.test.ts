/**
 * A desktop task write reaches everything outside the window that made it.
 *
 * Two audiences, one helper (`announceTaskWrite`):
 *
 * - The board-changed bus, for every write whichever window made it. A paired
 *   phone's read-board subscription, the Agent Monitor, the workflow engine and
 *   the retrieval record sweep listen there (why each needs it: the
 *   `announceTaskWrite` doc comment).
 * - The main window, for a write from ANOTHER window. The pop-out Agent Monitor
 *   is a separate renderer with its own stores, so main pushes the quiet
 *   `TASK_CHANGED_IN_OTHER_WINDOW` for any write whose sender is not the main
 *   window.
 *
 * The UI tier runs one renderer and cannot open a second window or pair a phone,
 * so this file is the guard for both halves:
 *   1. The helper emits on the bus for every sender, and pushes to the main
 *      window only for a foreign one.
 *   2. Every handler on the announced list calls it once, from a `finally`, with
 *      the project, change kind and task ids pinned for its channel below (a
 *      source scan).
 *   3. The list covers every renderer-driven task mutation, so a new one cannot
 *      ship without announcing itself (parity with the project-scoped set).
 *   4. BACKLOG_PROMOTE, which is off that list, announces its created tasks.
 * The TASK_MOVE wrapper's settle-time push, including a move that fails after it
 * committed, is driven through the real handler in task-move-shutdown.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }));

const { mockIsShuttingDown } = vi.hoisted(() => ({ mockIsShuttingDown: vi.fn(() => false) }));
vi.mock('../../src/main/shutdown-state', () => ({ isShuttingDown: mockIsShuttingDown }));

import {
  announceTaskBoardChange,
  announceTaskWrite,
  ANNOUNCED_TASK_WRITE_CHANNELS,
  type TaskBoardChange,
} from '../../src/main/ipc/helpers/task-write-announce';
import { IPC } from '../../src/shared/ipc-channels';
import { PROJECT_SCOPED_MUTATION_CHANNELS } from './helpers/project-scoped-mutation-channels';

const REPO_ROOT = path.resolve(__dirname, '../..');
const HANDLERS_DIR = path.join(REPO_ROOT, 'src/main/ipc/handlers');
const MAIN_WINDOW_WEB_CONTENTS_ID = 1;
const AN_EDIT: TaskBoardChange = { change: 'task-updated', ids: ['task-1'] };

function makeContext(options: { mainWindowDestroyed?: boolean } = {}) {
  const send = vi.fn();
  const emitBoardChanged = vi.fn();
  const webContents = { id: MAIN_WINDOW_WEB_CONTENTS_ID, send };
  const mainWindow = {
    isDestroyed: vi.fn(() => options.mainWindowDestroyed === true),
    // A destroyed BrowserWindow throws on `webContents`; the helper must ask
    // isDestroyed() first.
    get webContents() {
      if (options.mainWindowDestroyed) throw new Error('Object has been destroyed');
      return webContents;
    },
  };
  return { context: { mainWindow, boardEvents: { emitBoardChanged } }, send, emitBoardChanged };
}

function senderEvent(id: number, destroyed = false) {
  return {
    sender: {
      isDestroyed: () => destroyed,
      // A destroyed WebContents throws on its properties.
      get id() {
        if (destroyed) throw new Error('Object has been destroyed');
        return id;
      },
    },
  };
}

function announce(
  context: ReturnType<typeof makeContext>['context'],
  event: ReturnType<typeof senderEvent> | null,
  projectId: string | null,
  boardChange: TaskBoardChange | null = AN_EDIT,
): void {
  announceTaskWrite(context as never, event as never, projectId, boardChange);
}

describe('announceTaskWrite: the main window', () => {
  beforeEach(() => vi.clearAllMocks());

  it('pushes the project id to the main window once for a write from another window', () => {
    const { context, send } = makeContext();
    announce(context, senderEvent(7), 'proj-other');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(IPC.TASK_CHANGED_IN_OTHER_WINDOW, 'proj-other');
  });

  it('sends nothing for a write from the main window itself', () => {
    // The board updates optimistically and the in-app monitor resyncs the board
    // itself; a push here would reload the board after every drag.
    const { context, send } = makeContext();
    announce(context, senderEvent(MAIN_WINDOW_WEB_CONTENTS_ID), 'proj-open');
    expect(send).not.toHaveBeenCalled();
  });

  it('still pushes when the window that wrote closed before the write settled', () => {
    // The pop-out shut mid-move: the write happened, and reading the dead
    // sender's id must not throw out of TASK_MOVE's finally.
    const { context, send } = makeContext();
    expect(() => announce(context, senderEvent(7, true), 'proj-other')).not.toThrow();
    expect(send).toHaveBeenCalledWith(IPC.TASK_CHANGED_IN_OTHER_WINDOW, 'proj-other');
  });

  it('does nothing, and does not throw, once the main window is destroyed', () => {
    const { context, send } = makeContext({ mainWindowDestroyed: true });
    expect(() => announce(context, senderEvent(7), 'proj-other')).not.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it('does nothing without an IPC event or a project', () => {
    const { context, send } = makeContext();
    announce(context, null, 'proj-other');
    announce(context, senderEvent(7), null);
    expect(send).not.toHaveBeenCalled();
  });

  it('sends nothing once the app is quitting', () => {
    // A board reload then would only hit the closed database.
    mockIsShuttingDown.mockReturnValue(true);
    try {
      const { context, send } = makeContext();
      announce(context, senderEvent(7), 'proj-other');
      expect(send).not.toHaveBeenCalled();
    } finally {
      mockIsShuttingDown.mockReturnValue(false);
    }
  });

  it('never throws when the send fails, because every caller runs it from a finally', () => {
    // A throw there would replace the handler's own result or error.
    const { context, send } = makeContext();
    send.mockImplementationOnce(() => { throw new Error('Render frame was disposed'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(() => announce(context, senderEvent(7), 'proj-other')).not.toThrow();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('announceTaskWrite: the board-changed bus', () => {
  beforeEach(() => vi.clearAllMocks());

  it('emits the write on the bus for the main window\'s own write', () => {
    // The card menu writes from the main window. A paired phone, the Agent
    // Monitor and the workflow engine are not that window, so they still hear it.
    const { context, emitBoardChanged } = makeContext();
    announce(context, senderEvent(MAIN_WINDOW_WEB_CONTENTS_ID), 'proj-open', { change: 'task-updated', ids: ['task-9'] });
    expect(emitBoardChanged).toHaveBeenCalledTimes(1);
    expect(emitBoardChanged).toHaveBeenCalledWith({ projectId: 'proj-open', change: 'task-updated', ids: ['task-9'] });
  });

  it('emits for a write from another window, and with no IPC event at all', () => {
    const { context, emitBoardChanged } = makeContext();
    announce(context, senderEvent(7), 'proj-other', { change: 'task-deleted', ids: ['task-2'] });
    announce(context, null, 'proj-other', { change: 'task-created', ids: ['task-3'] });
    expect(emitBoardChanged.mock.calls).toEqual([
      [{ projectId: 'proj-other', change: 'task-deleted', ids: ['task-2'] }],
      [{ projectId: 'proj-other', change: 'task-created', ids: ['task-3'] }],
    ]);
  });

  it('still emits when the main window is destroyed, because the bus does not need it', () => {
    const { context, emitBoardChanged } = makeContext({ mainWindowDestroyed: true });
    announce(context, senderEvent(7), 'proj-other');
    expect(emitBoardChanged).toHaveBeenCalledTimes(1);
  });

  it('emits nothing for a null board change, which a handler that announced itself passes', () => {
    const { context, emitBoardChanged, send } = makeContext();
    announce(context, senderEvent(7), 'proj-other', null);
    expect(emitBoardChanged).not.toHaveBeenCalled();
    // The other-window half is independent of it.
    expect(send).toHaveBeenCalledWith(IPC.TASK_CHANGED_IN_OTHER_WINDOW, 'proj-other');
  });

  it('emits nothing without a project, or once the app is quitting', () => {
    const { context, emitBoardChanged } = makeContext();
    announce(context, senderEvent(7), null);
    mockIsShuttingDown.mockReturnValue(true);
    try {
      announce(context, senderEvent(7), 'proj-other');
    } finally {
      mockIsShuttingDown.mockReturnValue(false);
    }
    expect(emitBoardChanged).not.toHaveBeenCalled();
  });

  it('never throws when a bus listener throws, and still tells the main window', () => {
    // The bus dispatches synchronously, so a listener's throw would otherwise
    // escape the handler's finally and replace its result.
    const { context, emitBoardChanged, send } = makeContext();
    emitBoardChanged.mockImplementationOnce(() => { throw new Error('subscriber blew up'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(() => announce(context, senderEvent(7), 'proj-other')).not.toThrow();
      expect(warn).toHaveBeenCalled();
      expect(send).toHaveBeenCalledWith(IPC.TASK_CHANGED_IN_OTHER_WINDOW, 'proj-other');
    } finally {
      warn.mockRestore();
    }
  });

  it('announceTaskBoardChange is the bus half alone, with the same gates', () => {
    const { context, emitBoardChanged, send } = makeContext();
    announceTaskBoardChange(context as never, 'proj-open', { change: 'task-created', ids: ['task-4', 'task-5'] });
    announceTaskBoardChange(context as never, null, { change: 'task-created', ids: ['task-6'] });
    expect(emitBoardChanged.mock.calls).toEqual([[{ projectId: 'proj-open', change: 'task-created', ids: ['task-4', 'task-5'] }]]);
    expect(send).not.toHaveBeenCalled();
  });
});

/** Every `ipcMain.handle(IPC.X, ...)` registration under the handlers dir, with the source
 *  from that call to its own close: the first `});` or `);` back at the registration's
 *  two-space indent. Ending there rather than at the next registration keeps code after a
 *  file's last handler out of that handler's body. */
function handlerBodies(): Map<string, string[]> {
  const bodies = new Map<string, string[]>();
  for (const entry of fs.readdirSync(HANDLERS_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const source = fs.readFileSync(path.join(HANDLERS_DIR, entry.name), 'utf8');
    const pattern = /ipcMain\.handle\(\s*IPC\.([A-Z0-9_]+)\s*,/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const closing = /^ {2}\}?\);/m.exec(source.slice(match.index));
      const end = closing ? match.index + closing.index + closing[0].length : source.length;
      const list = bodies.get(match[1]) ?? [];
      list.push(source.slice(match.index, end));
      bodies.set(match[1], list);
    }
  }
  return bodies;
}

/** The announce as the first statement of a `finally`, comment lines allowed before it. */
const ANNOUNCE_IN_FINALLY = /finally\s*\{(?:\s*\/\/[^\n]*)*\s*announceTaskWrite\(\s*context\s*,\s*event\s*,/;

/** The third (project) and fourth (board change) arguments of the handler's one `announceTaskWrite` call. */
const ANNOUNCE_ARGUMENTS = /announceTaskWrite\(\s*context\s*,\s*event\s*,\s*([A-Za-z.]+)\s*,\s*(null|\{[^}]*\})\s*\)/;

/** The `ids` expression of a captured board change, which every handler writes last. A shorthand `ids` reads as `ids`. */
const IDS_EXPRESSION = /\bids(?:\s*:\s*(.+?))?\s*\}$/;

/**
 * What each announced handler tells the bus: the variable holding the project
 * the write resolved to, the change kind, and the task ids expression. `none`
 * means the handler passes `null` because its core already announces there,
 * and the reason says who does.
 */
type ExpectedAnnounce =
  | { projectId: string; change: string; ids: string }
  | { projectId: string; none: string };

const EXPECTED_ANNOUNCE: Record<(typeof ANNOUNCED_TASK_WRITE_CHANNELS)[number], ExpectedAnnounce> = {
  TASK_CREATE: { projectId: 'resolvedProjectId', change: 'task-created', ids: '[task.id]' },
  TASK_UPDATE: { projectId: 'resolvedProjectId', change: 'task-updated', ids: '[input.id]' },
  TASK_DELETE: { projectId: 'resolvedProjectId', change: 'task-deleted', ids: '[id]' },
  TASK_MOVE: { projectId: 'resolvedProjectId', none: 'handleTaskMove emits at the commit point and again at settle, for every caller' },
  TASK_UNARCHIVE: { projectId: 'resolvedProjectId', change: 'task-updated', ids: '[input.id]' },
  TASK_BULK_DELETE: { projectId: 'resolvedProjectId', change: 'task-deleted', ids: 'ids' },
  TASK_BULK_UNARCHIVE: { projectId: 'resolvedProjectId', change: 'task-updated', ids: 'ids' },
  TASK_SWITCH_BRANCH: { projectId: 'resolvedProjectId', change: 'task-updated', ids: '[input.taskId]' },
  TASK_UPDATE_FROM_BASE: { projectId: 'resolvedProjectId', change: 'task-updated', ids: '[input.taskId]' },
  TASK_SET_RUNTIME_OVERRIDE: { projectId: 'projectId', change: 'task-updated', ids: '[input.taskId]' },
  TASK_RESOLVE_PR: { projectId: 'resolvedProjectId', change: 'task-updated', ids: '[taskId]' },
  BACKLOG_DEMOTE: { projectId: 'projectId', change: 'task-deleted', ids: '[input.taskId]' },
};

describe('every announced handler announces', () => {
  const bodies = handlerBodies();

  it('finds the handler registrations (sanity check the scan)', () => {
    expect(bodies.size).toBeGreaterThan(50);
  });

  it.each([...ANNOUNCED_TASK_WRITE_CHANNELS])('%s announces once, from a finally, with its pinned board change', (channel) => {
    const registrations = bodies.get(channel) ?? [];
    // Exactly one: a rename or a second registration would let the scan read
    // the wrong body.
    expect(registrations, `no single ipcMain.handle(IPC.${channel}) under src/main/ipc/handlers`).toHaveLength(1);
    const body = registrations[0];
    // From a `finally`: a write can commit and then throw (a demote whose task
    // delete fails after its backlog row landed), and the board must still hear.
    expect(
      body,
      `The ${channel} handler must call announceTaskWrite(context, event, <resolved projectId>, <board change>) `
        + 'from a finally, so a paired phone and the detached Agent Monitor hear the write '
        + 'even when it fails after committing.',
    ).toMatch(ANNOUNCE_IN_FINALLY);
    // Once: a second call on another path is the success-only shape this replaces.
    expect(body.match(/announceTaskWrite\(/g)).toHaveLength(1);

    const announceArguments = ANNOUNCE_ARGUMENTS.exec(body);
    expect(announceArguments, `could not read the project and board change ${channel} passes`).not.toBeNull();
    const [, projectArgument, boardChange] = announceArguments ?? [];
    const expected = EXPECTED_ANNOUNCE[channel];
    expect(projectArgument, `${channel} announces for the project its write resolved to`).toBe(expected.projectId);
    if ('none' in expected) {
      expect(boardChange, `${channel} passes null because ${expected.none}`).toBe('null');
    } else {
      expect(boardChange, `${channel} tells the bus '${expected.change}'`).toContain(`change: '${expected.change}'`);
      const idsMatch = IDS_EXPRESSION.exec(boardChange ?? '');
      expect(idsMatch, `${channel}'s board change must end with its ids`).not.toBeNull();
      expect(idsMatch?.[1] ?? 'ids', `${channel} names the task ids it wrote`).toBe(expected.ids);
    }
  });

  it('BACKLOG_PROMOTE, which is off the list, puts the tasks it creates on the bus from a finally', () => {
    const registrations = bodies.get('BACKLOG_PROMOTE') ?? [];
    expect(registrations).toHaveLength(1);
    expect(registrations[0]).toMatch(
      /finally\s*\{[^}]*announceTaskBoardChange\(\s*context\s*,\s*projectId\s*,\s*\{\s*change:\s*'task-created'/,
    );
  });
});

describe('the announced list covers every renderer-driven task mutation', () => {
  /** Mutations deliberately not announced, each with the reason the module gives. */
  const NOT_ANNOUNCED: Record<string, string> = {
    TASK_SET_DETAIL_VIEW_STATE: 'a layout blob the board never shows, saved on a debounce while a pane resizes',
  };

  it('equals the project-scoped mutation set, minus SESSION_* and the named exemptions', () => {
    // SESSION_* state reaches the main window through main's own session pushes,
    // and the bus through the session-lifecycle feed.
    const expected = [...PROJECT_SCOPED_MUTATION_CHANNELS]
      .filter((channel) => !channel.startsWith('SESSION_'))
      .filter((channel) => !(channel in NOT_ANNOUNCED))
      .sort();
    expect([...ANNOUNCED_TASK_WRITE_CHANNELS].sort()).toEqual(expected);
  });

  it('names only real IPC channels', () => {
    for (const channel of ANNOUNCED_TASK_WRITE_CHANNELS) {
      expect(Object.keys(IPC)).toContain(channel);
    }
    for (const channel of Object.keys(NOT_ANNOUNCED)) {
      expect(PROJECT_SCOPED_MUTATION_CHANNELS.has(channel), `${channel} is no longer a mutation channel`).toBe(true);
    }
  });
});
