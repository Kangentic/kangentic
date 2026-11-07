/**
 * The bytes dictation writes into a terminal. The live preview is erased with
 * DELs, which eat what sits before the cursor, so an agent's cursor-to-end keys
 * lead every write. This drives the real handlers over a fake `ipcMain`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Handler = (event: unknown, ...args: unknown[]) => unknown;

const { handlers, listeners } = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  listeners: new Map<string, Handler>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    on: (channel: string, handler: Handler) => listeners.set(channel, handler),
  },
  systemPreferences: {},
}));

import { registerTranscriptionHandlers } from '../../src/main/ipc/handlers/transcription';
import { IPC } from '../../src/shared/ipc-channels';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

const CTRL_E = '\x05';

function register(promptEndKeys: string) {
  const write = vi.fn();
  const submitContent = vi.fn(() => Promise.resolve());
  const context = {
    transcriptionService: { on: vi.fn() },
    sessionManager: { write, getPromptEndKeys: () => promptEndKeys },
    terminalSubmit: { submitContent },
    mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } },
  } as unknown as IpcContext;
  registerTranscriptionHandlers(context);
  return { write, submitContent };
}

beforeEach(() => {
  handlers.clear();
  listeners.clear();
});

describe('TRANSCRIBE_LIVE_WRITE', () => {
  it('leads every write with the keys, the first partial included', () => {
    const { write } = register(CTRL_E);
    const liveWrite = listeners.get(IPC.TRANSCRIBE_LIVE_WRITE);
    liveWrite?.({}, 'session-1', 'first words');
    liveWrite?.({}, 'session-1', '\x7f\x7f\x7f\x7f\x7f\x7f\x7f\x7f\x7f\x7f\x7fsecond words');
    expect(write).toHaveBeenNthCalledWith(1, 'session-1', `${CTRL_E}first words`, 'user');
    expect(write).toHaveBeenNthCalledWith(2, 'session-1', `${CTRL_E}${'\x7f'.repeat(11)}second words`, 'user');
  });

  it('writes the payload as it is for an agent with no measured keys', () => {
    const { write } = register('');
    listeners.get(IPC.TRANSCRIBE_LIVE_WRITE)?.({}, 'session-1', '\x7f\x7fword');
    expect(write).toHaveBeenCalledWith('session-1', '\x7f\x7fword', 'user');
  });

  it('writes nothing for an empty payload', () => {
    const { write } = register(CTRL_E);
    listeners.get(IPC.TRANSCRIBE_LIVE_WRITE)?.({}, 'session-1', '');
    expect(write).not.toHaveBeenCalled();
  });
});

describe('TRANSCRIBE_SUBMIT', () => {
  it('moves the cursor and erases in one write, ahead of the paste', async () => {
    const { write, submitContent } = register(CTRL_E);
    await handlers.get(IPC.TRANSCRIBE_SUBMIT)?.({}, 'session-1', 'refined', 3);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('session-1', `${CTRL_E}\x7f\x7f\x7f`, 'user');
    expect(write.mock.invocationCallOrder[0]).toBeLessThan(submitContent.mock.invocationCallOrder[0]);
  });

  it('still moves the cursor with nothing to erase, so the paste lands after a draft', async () => {
    const { write } = register(CTRL_E);
    await handlers.get(IPC.TRANSCRIBE_SUBMIT)?.({}, 'session-1', 'refined', 0);
    expect(write).toHaveBeenCalledWith('session-1', CTRL_E, 'user');
  });

  it('writes nothing with no keys and nothing to erase', async () => {
    const { write } = register('');
    await handlers.get(IPC.TRANSCRIBE_SUBMIT)?.({}, 'session-1', 'refined', 0);
    expect(write).not.toHaveBeenCalled();
  });

  it('still pastes when the count is not a count', async () => {
    const { write, submitContent } = register(CTRL_E);
    await expect(handlers.get(IPC.TRANSCRIBE_SUBMIT)?.({}, 'session-1', 'refined', -1)).resolves.toBe(true);
    expect(write).toHaveBeenCalledWith('session-1', CTRL_E, 'user');
    expect(submitContent).toHaveBeenCalledTimes(1);
  });
});

describe('TRANSCRIBE_HOLD_TRACE', () => {
  it('logs at warn, the level a production build keeps, with no text in it', () => {
    register('');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    listeners.get(IPC.TRANSCRIBE_HOLD_TRACE)?.({}, {
      phase: 'end', reason: 'lifted-with-other-button', heldMs: 2400, buttons: 1, targetKind: 'terminal',
    });
    expect(warn).toHaveBeenCalledWith(
      '[dictation-hold] end reason=lifted-with-other-button heldMs=2400 buttons=1 target=terminal',
    );
    warn.mockRestore();
  });

  it('prints a dash for each field a press leaves empty', () => {
    register('');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    listeners.get(IPC.TRANSCRIBE_HOLD_TRACE)?.({}, {
      phase: 'press', reason: null, heldMs: null, buttons: null, targetKind: null,
    });
    expect(warn).toHaveBeenCalledWith('[dictation-hold] press reason=- heldMs=- buttons=- target=-');
    warn.mockRestore();
  });

  it('keeps one log line per trace and ignores a missing one', () => {
    register('');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    listeners.get(IPC.TRANSCRIBE_HOLD_TRACE)?.({}, null);
    expect(warn).not.toHaveBeenCalled();
    listeners.get(IPC.TRANSCRIBE_HOLD_TRACE)?.({}, {
      phase: 'end', reason: 'released\n[dictation-hold] forged', heldMs: 1, buttons: 0, targetKind: null,
    });
    expect(warn.mock.calls[0][0]).not.toContain('\n');
    warn.mockRestore();
  });

  it('logs nothing for a payload that is not a trace', () => {
    register('');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    listeners.get(IPC.TRANSCRIBE_HOLD_TRACE)?.({}, 'press');
    listeners.get(IPC.TRANSCRIBE_HOLD_TRACE)?.({}, { phase: 'hold', reason: null });
    listeners.get(IPC.TRANSCRIBE_HOLD_TRACE)?.({}, { reason: 'released' });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('prints a dash for any field outside its shape, so no payload text reaches the log', () => {
    register('');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    listeners.get(IPC.TRANSCRIBE_HOLD_TRACE)?.({}, {
      phase: 'end', reason: '\x1b[31mred', heldMs: 'long', buttons: Number.NaN, targetKind: 'guest',
    });
    expect(warn).toHaveBeenCalledWith('[dictation-hold] end reason=- heldMs=- buttons=- target=-');
    warn.mockRestore();
  });
});
