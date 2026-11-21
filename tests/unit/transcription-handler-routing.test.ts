/**
 * Where the transcription handlers send a session's pushes. Every window runs
 * its own push-to-talk, so partial and final text go to the window whose
 * `start` made the session, never to the main window by default, and model
 * progress goes to every window. Drives the real handlers over a fake `ipcMain`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

type Handler = (event: unknown, ...args: unknown[]) => unknown;

const { handlers, broadcast } = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  broadcast: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    on: () => undefined,
  },
  systemPreferences: {},
}));

vi.mock('../../src/main/pop-out/window-broadcast', () => ({ broadcast }));

import { registerTranscriptionHandlers } from '../../src/main/ipc/handlers/transcription';
import { IPC } from '../../src/shared/ipc-channels';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

function fakeSender() {
  return {
    sent: [] as unknown[][],
    isDestroyed: () => false,
    send(channel: string, ...args: unknown[]) { this.sent.push([channel, ...args]); },
    once: () => undefined,
    on: () => undefined,
  };
}

function register() {
  const service = Object.assign(new EventEmitter(), {
    active: new Set<string>(),
    counter: 0,
    async start() {
      const dictationSessionId = `dictation-${++service.counter}`;
      service.active.add(dictationSessionId);
      return { dictationSessionId, engineId: 'stub', modelId: null, needsDownload: false, sentenceCaseFinal: false };
    },
    async finalize(dictationSessionId: string) {
      service.active.delete(dictationSessionId);
      service.emit('final', dictationSessionId, 'done');
      return 'done';
    },
    cancel(dictationSessionId: string) { service.active.delete(dictationSessionId); },
    isActive(dictationSessionId: string) { return service.active.has(dictationSessionId); },
  });
  const mainWindowSend = vi.fn();
  const context = {
    transcriptionService: service,
    mainWindow: { isDestroyed: () => false, webContents: { send: mainWindowSend } },
  } as unknown as IpcContext;
  registerTranscriptionHandlers(context);
  return { service, mainWindowSend, context };
}

beforeEach(() => {
  handlers.clear();
  broadcast.mockClear();
});

describe('transcription push routing', () => {
  it('sends partial and final text to the window that started the session, not the main window', async () => {
    const { service, mainWindowSend } = register();
    const popOut = fakeSender();
    const started = await handlers.get(IPC.TRANSCRIBE_START)?.({ sender: popOut }, { language: 'en' }) as { dictationSessionId: string };

    service.emit('partial', started.dictationSessionId, 'hello');
    await handlers.get(IPC.TRANSCRIBE_STOP)?.({ sender: popOut }, started.dictationSessionId, 0);

    expect(popOut.sent).toEqual([
      [IPC.TRANSCRIBE_PARTIAL, started.dictationSessionId, 'hello'],
      [IPC.TRANSCRIBE_FINAL, started.dictationSessionId, 'done'],
    ]);
    expect(mainWindowSend).not.toHaveBeenCalled();
  });

  it('refuses a start from a second window while the first is recording', async () => {
    register();
    const first = fakeSender();
    const second = fakeSender();
    await handlers.get(IPC.TRANSCRIBE_START)?.({ sender: first }, { language: 'en' });
    expect(await handlers.get(IPC.TRANSCRIBE_START)?.({ sender: second }, { language: 'en' })).toEqual({ refused: 'other-window' });
  });

  it('lets a second window start once the first window stopped', async () => {
    register();
    const first = fakeSender();
    const second = fakeSender();
    const started = await handlers.get(IPC.TRANSCRIBE_START)?.({ sender: first }, { language: 'en' }) as { dictationSessionId: string };
    await handlers.get(IPC.TRANSCRIBE_STOP)?.({ sender: first }, started.dictationSessionId, 0);
    const outcome = await handlers.get(IPC.TRANSCRIBE_START)?.({ sender: second }, { language: 'en' });
    expect(outcome).toHaveProperty('dictationSessionId');
  });

  it('releases the owner when finalize throws, so later text reaches no window and another window can start', async () => {
    const { service } = register();
    service.finalize = async () => { throw new Error('finalize failed'); };
    const first = fakeSender();
    const second = fakeSender();
    const started = await handlers.get(IPC.TRANSCRIBE_START)?.({ sender: first }, { language: 'en' }) as { dictationSessionId: string };

    await expect(
      Promise.resolve(handlers.get(IPC.TRANSCRIBE_STOP)?.({ sender: first }, started.dictationSessionId, 0)),
    ).rejects.toThrow('finalize failed');

    service.emit('partial', started.dictationSessionId, 'late');
    expect(first.sent).toEqual([]);
    // The service still reports the session active, so only the release lets the second window in.
    expect(service.isActive(started.dictationSessionId)).toBe(true);
    expect(await handlers.get(IPC.TRANSCRIBE_START)?.({ sender: second }, { language: 'en' })).toHaveProperty('dictationSessionId');
  });

  it('releases the owner on cancel, so later text reaches no window', async () => {
    const { service } = register();
    const popOut = fakeSender();
    const started = await handlers.get(IPC.TRANSCRIBE_START)?.({ sender: popOut }, { language: 'en' }) as { dictationSessionId: string };

    await handlers.get(IPC.TRANSCRIBE_CANCEL)?.({ sender: popOut }, started.dictationSessionId);
    service.emit('partial', started.dictationSessionId, 'late');

    expect(popOut.sent).toEqual([]);
  });

  it('fans model progress out to every window through the pop-out broadcast', () => {
    const { service, context } = register();
    const progress = { modelId: 'model', status: 'downloading', downloadedBytes: 1, totalBytes: 2 };
    service.emit('model-progress', progress);
    expect(broadcast).toHaveBeenCalledWith(context.mainWindow, IPC.TRANSCRIBE_MODEL_PROGRESS, progress);
  });
});
