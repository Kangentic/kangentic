/**
 * A task write the user makes from a window other than the main one reaches the
 * main window's board.
 *
 * The pop-out Agent Monitor is a separate renderer with its own stores. Its row
 * menu and the task details it hosts write through the same project-stamped IPC
 * as the board, so before this the main window's board never heard of those
 * writes: a card moved, archived, sent to the backlog or deleted from the pop-out
 * stayed where it was until something else reloaded the board. Main now pushes
 * the quiet `TASK_CHANGED_IN_OTHER_WINDOW` for any such write whose sender is
 * not the main window.
 *
 * The UI tier runs one renderer and cannot open a second window, so this file is
 * the only guard the pop-out half has:
 *   1. The helper pushes for a foreign sender, never for the main window's own.
 *   2. Every handler on the announced list calls it once, from a `finally` (a
 *      source scan).
 *   3. The list covers every renderer-driven task mutation, so a new one cannot
 *      ship without announcing itself (parity with the project-scoped set).
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
  announceTaskWriteFromOtherWindow,
  OTHER_WINDOW_ANNOUNCED_CHANNELS,
} from '../../src/main/ipc/helpers/other-window-task-writes';
import { IPC } from '../../src/shared/ipc-channels';
import { PROJECT_SCOPED_MUTATION_CHANNELS } from './helpers/project-scoped-mutation-channels';

const REPO_ROOT = path.resolve(__dirname, '../..');
const HANDLERS_DIR = path.join(REPO_ROOT, 'src/main/ipc/handlers');
const MAIN_WINDOW_WEB_CONTENTS_ID = 1;

function makeContext(options: { mainWindowDestroyed?: boolean } = {}) {
  const send = vi.fn();
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
  return { context: { mainWindow }, send };
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
): void {
  announceTaskWriteFromOtherWindow(context as never, event as never, projectId);
}

describe('announceTaskWriteFromOtherWindow', () => {
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
    mockIsShuttingDown.mockReturnValueOnce(true);
    const { context, send } = makeContext();
    announce(context, senderEvent(7), 'proj-other');
    expect(send).not.toHaveBeenCalled();
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
const ANNOUNCE_IN_FINALLY = /finally\s*\{(?:\s*\/\/[^\n]*)*\s*announceTaskWriteFromOtherWindow\(\s*context\s*,\s*event\s*,/;

describe('every announced handler announces', () => {
  const bodies = handlerBodies();

  it('finds the handler registrations (sanity check the scan)', () => {
    expect(bodies.size).toBeGreaterThan(50);
  });

  it.each([...OTHER_WINDOW_ANNOUNCED_CHANNELS])('%s announces once, from a finally', (channel) => {
    const registrations = bodies.get(channel) ?? [];
    // Exactly one: a rename or a second registration would let the scan read
    // the wrong body.
    expect(registrations, `no single ipcMain.handle(IPC.${channel}) under src/main/ipc/handlers`).toHaveLength(1);
    const body = registrations[0];
    // From a `finally`: a write can commit and then throw (a demote whose task
    // delete fails after its backlog row landed), and the board must still hear.
    expect(
      body,
      `The ${channel} handler must call announceTaskWriteFromOtherWindow(context, event, <resolved projectId>) `
        + 'from a finally, so a write from the detached Agent Monitor reaches the main window\'s board '
        + 'even when it fails after committing.',
    ).toMatch(ANNOUNCE_IN_FINALLY);
    // Once: a second call on another path is the success-only shape this replaces.
    expect(body.match(/announceTaskWriteFromOtherWindow\(/g)).toHaveLength(1);
  });
});

describe('the announced list covers every renderer-driven task mutation', () => {
  /** Mutations deliberately not announced, each with the reason the module gives. */
  const NOT_ANNOUNCED: Record<string, string> = {
    TASK_SET_DETAIL_VIEW_STATE: 'a layout blob the board never shows, saved on a debounce while a pane resizes',
  };

  it('equals the project-scoped mutation set, minus SESSION_* and the named exemptions', () => {
    // SESSION_* state reaches the main window through main's own session pushes.
    const expected = [...PROJECT_SCOPED_MUTATION_CHANNELS]
      .filter((channel) => !channel.startsWith('SESSION_'))
      .filter((channel) => !(channel in NOT_ANNOUNCED))
      .sort();
    expect([...OTHER_WINDOW_ANNOUNCED_CHANNELS].sort()).toEqual(expected);
  });

  it('names only real IPC channels', () => {
    for (const channel of OTHER_WINDOW_ANNOUNCED_CHANNELS) {
      expect(Object.keys(IPC)).toContain(channel);
    }
    for (const channel of Object.keys(NOT_ANNOUNCED)) {
      expect(PROJECT_SCOPED_MUTATION_CHANNELS.has(channel), `${channel} is no longer a mutation channel`).toBe(true);
    }
  });
});
