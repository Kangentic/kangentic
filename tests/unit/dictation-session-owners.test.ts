/**
 * Which window a dictation session's text goes to, and the refusal across
 * windows. Every window runs its own push-to-talk, so a pop-out's hold got no
 * text when main sent it to the main window alone.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  DictationSessionOwners,
  OTHER_WINDOW_HOLD_BOUND_MS,
  type DictationOwnerContents,
} from '../../src/main/transcription/dictation-session-owners';
import type { DictationStartResult } from '../../src/shared/types';

type Listener = () => void;

interface FakeWindow extends DictationOwnerContents {
  sent: unknown[][];
  destroyed: boolean;
  fire: (event: string) => void;
}

function fakeWindow(): FakeWindow {
  const listeners = new Map<string, Listener[]>();
  const add = (event: string, listener: Listener): void => {
    listeners.set(event, [...(listeners.get(event) ?? []), listener]);
  };
  const window = {
    sent: [] as unknown[][],
    destroyed: false,
    isDestroyed: () => window.destroyed,
    send: (channel: string, ...args: unknown[]) => { window.sent.push([channel, ...args]); },
    once: (event: string, listener: Listener) => { add(event, listener); return window; },
    on: (event: string, listener: Listener) => { add(event, listener); return window; },
    fire: (event: string) => { for (const listener of listeners.get(event) ?? []) listener(); },
  };
  return window as unknown as FakeWindow;
}

function started(dictationSessionId: string): DictationStartResult {
  return { dictationSessionId, engineId: 'stub' as DictationStartResult['engineId'], modelId: null, needsDownload: false, sentenceCaseFinal: false };
}

function setup() {
  const active = new Set<string>();
  const cancel = vi.fn((dictationSessionId: string) => { active.delete(dictationSessionId); });
  const owners = new DictationSessionOwners<FakeWindow>({ isActive: (id) => active.has(id), cancel });
  const begin = (dictationSessionId: string) => async () => {
    active.add(dictationSessionId);
    return started(dictationSessionId);
  };
  return { owners, active, cancel, begin };
}

describe('DictationSessionOwners', () => {
  it('sends a session text to the window that started it and to no other', async () => {
    const { owners, begin } = setup();
    const mainWindow = fakeWindow();
    const popOut = fakeWindow();
    await owners.start(popOut, begin('dictation-1'));

    owners.sendToOwner('dictation-1', 'transcribe:partial', 'dictation-1', 'hello');

    expect(popOut.sent).toEqual([['transcribe:partial', 'dictation-1', 'hello']]);
    expect(mainWindow.sent).toEqual([]);
  });

  it('refuses a second window while the first is recording, and allows it once that session ends', async () => {
    const { owners, active, begin } = setup();
    const first = fakeWindow();
    const second = fakeWindow();
    await owners.start(first, begin('dictation-1'));

    const startSecond = vi.fn(begin('dictation-2'));
    expect(await owners.start(second, startSecond)).toEqual({ refused: 'other-window' });
    expect(startSecond).not.toHaveBeenCalled();

    // Finalized or cancelled in the service: the refusal lifts even before release().
    active.delete('dictation-1');
    expect(await owners.start(second, begin('dictation-2'))).toEqual(started('dictation-2'));
  });

  it('refuses a second window while the first one start is still in flight', async () => {
    const { owners, begin } = setup();
    const first = fakeWindow();
    const second = fakeWindow();
    let finishFirst: () => void = () => undefined;
    const firstStart = owners.start(first, () => new Promise<DictationStartResult>((resolve) => {
      finishFirst = () => resolve(started('dictation-1'));
    }));

    expect(await owners.start(second, begin('dictation-2'))).toEqual({ refused: 'other-window' });
    finishFirst();
    await firstStart;
  });

  it('never refuses the window that holds the session, whose hook overlaps its own starts', async () => {
    const { owners, begin } = setup();
    const window = fakeWindow();
    await owners.start(window, begin('dictation-1'));
    expect(await owners.start(window, begin('dictation-2'))).toEqual(started('dictation-2'));
  });

  it.each(['destroyed', 'render-process-gone', 'did-navigate'])('cancels a window sessions when it is %s, so the engine is not pinned', async (event) => {
    const { owners, cancel, begin } = setup();
    const popOut = fakeWindow();
    const other = fakeWindow();
    await owners.start(popOut, begin('dictation-1'));

    popOut.fire(event);

    expect(cancel).toHaveBeenCalledWith('dictation-1');
    expect(owners.heldByAnotherWindow(other)).toBe(false);
  });

  it('cancels a session whose window went away while the engine started', async () => {
    const { owners, cancel } = setup();
    const popOut = fakeWindow();
    await owners.start(popOut, async () => {
      popOut.destroyed = true;
      return started('dictation-1');
    });
    expect(cancel).toHaveBeenCalledWith('dictation-1');
  });

  it('stops refusing other windows once a session outlives the worker cap, which never reaches main', async () => {
    // A session wedged in one window would otherwise refuse every other
    // window's press until that window ended it.
    const active = new Set<string>(['dictation-1']);
    let clock = 1_000;
    const owners = new DictationSessionOwners<FakeWindow>(
      { isActive: (id) => active.has(id), cancel: vi.fn() },
      () => clock,
    );
    const wedged = fakeWindow();
    const other = fakeWindow();
    await owners.start(wedged, async () => started('dictation-1'));

    clock += OTHER_WINDOW_HOLD_BOUND_MS;
    expect(owners.heldByAnotherWindow(other)).toBe(true);
    clock += 1;
    expect(owners.heldByAnotherWindow(other)).toBe(false);
    // Its text still reaches its own window.
    owners.sendToOwner('dictation-1', 'transcribe:final', 'dictation-1', 'late');
    expect(wedged.sent).toEqual([['transcribe:final', 'dictation-1', 'late']]);
  });

  it('rejects when the engine start fails and then stops counting that window as a start in flight', async () => {
    const { owners, begin } = setup();
    const failing = fakeWindow();
    const other = fakeWindow();

    await expect(owners.start(failing, async () => { throw new Error('engine failed'); })).rejects.toThrow('engine failed');

    expect(owners.heldByAnotherWindow(other)).toBe(false);
    expect(await owners.start(other, begin('dictation-2'))).toEqual(started('dictation-2'));
  });

  it('does not let a start in flight from a destroyed window refuse another window', async () => {
    const { owners } = setup();
    const closing = fakeWindow();
    const other = fakeWindow();
    let finish: () => void = () => undefined;
    const pending = owners.start(closing, () => new Promise<DictationStartResult>((resolve) => {
      finish = () => resolve(started('dictation-1'));
    }));

    closing.destroyed = true;
    expect(owners.heldByAnotherWindow(other)).toBe(false);

    finish();
    await pending;
  });

  it('prunes a session of the asking window that the service ended by itself', async () => {
    const { owners, active, begin } = setup();
    const window = fakeWindow();
    await owners.start(window, begin('dictation-1'));

    // The service ended it (a finalize timeout, a worker recycle): no release or cancel call.
    active.delete('dictation-1');
    expect(owners.heldByAnotherWindow(window)).toBe(false);

    owners.sendToOwner('dictation-1', 'transcribe:final', 'dictation-1', 'late');
    expect(window.sent).toEqual([]);
  });

  it('sends nothing after a session is released', async () => {
    const { owners, begin } = setup();
    const popOut = fakeWindow();
    await owners.start(popOut, begin('dictation-1'));
    owners.release('dictation-1');
    owners.sendToOwner('dictation-1', 'transcribe:final', 'dictation-1', 'late');
    expect(popOut.sent).toEqual([]);
  });
});
