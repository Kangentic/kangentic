/**
 * The one place a notification sound plays, driven with a stand-in Audio. What a user
 * loses without these: a sound heard while Mute is on, a custom file whose object URL
 * is never released, a sound stuck playing that blocks every later one for the full
 * cutoff, and a slow custom preview that plays over the sound picked after it.
 * `createSoundGate` has its own tests in event-sound-gate.test.ts.
 *
 * Tier: Unit.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EVENT_SOUND_MAX_MS } from '../../src/shared/notification-settings';
import { DEFAULT_CONFIG, type NotificationConfig, type NotificationSound } from '../../src/shared/types';

const savedNotifications = vi.hoisted(() => ({ value: null as unknown as NotificationConfig }));
vi.mock('../../src/renderer/stores/config-store', () => ({
  useConfigStore: { getState: () => ({ config: { notifications: savedNotifications.value } }) },
}));

class FakeAudio {
  static instances: FakeAudio[] = [];
  static playResult: () => Promise<void> = () => Promise.resolve();
  readonly listeners = new Map<string, Set<() => void>>();
  readonly pause = vi.fn();
  readonly play = vi.fn(() => FakeAudio.playResult());
  constructor(readonly src: string) {
    FakeAudio.instances.push(this);
  }
  addEventListener(type: string, listener: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(listener);
  }
  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
  }
}

function saveSounds(sounds: Partial<NotificationConfig['sounds']>, muted = false): void {
  savedNotifications.value = {
    ...DEFAULT_CONFIG.notifications,
    muted,
    sounds: { ...DEFAULT_CONFIG.notifications.sounds, ...sounds },
    customSounds: { onAgentIdle: 'gong.wav', onAgentCrash: 'bell.wav' },
  };
}

/** Lets the awaits inside `play` settle. Timers are faked, promises are not. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

let readSound: ReturnType<typeof vi.fn>;
let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;

async function loadPlayer() {
  return import('../../src/renderer/utils/event-sound-player');
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  FakeAudio.instances = [];
  FakeAudio.playResult = () => Promise.resolve();
  readSound = vi.fn(async () => new ArrayBuffer(8));
  let urlCount = 0;
  createObjectURL = vi.fn(() => `blob:sound-${(urlCount += 1)}`);
  revokeObjectURL = vi.fn();
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('window', { electronAPI: { notifications: { readSound } } });
  vi.spyOn(URL, 'createObjectURL').mockImplementation(createObjectURL);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revokeObjectURL);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  saveSounds({ onAgentIdle: 'chime', onAgentCrash: 'rise' });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('playEventSound', () => {
  it.each<[string, NotificationSound, boolean]>([
    ['off', 'off', false],
    ['system, which the OS plays', 'system', false],
    ['a built-in choice while muted', 'chime', true],
    ['a custom choice while muted', 'custom', true],
  ])('creates no Audio and reads no file for %s', async (_label, sound, muted) => {
    saveSounds({ onAgentIdle: sound }, muted);
    const { playEventSound } = await loadPlayer();

    playEventSound('onAgentIdle');
    await flush();

    expect(FakeAudio.instances).toHaveLength(0);
    expect(readSound).not.toHaveBeenCalled();
  });

  it('plays a built-in sound', async () => {
    const { playEventSound } = await loadPlayer();

    playEventSound('onAgentIdle');
    await flush();

    expect(FakeAudio.instances).toHaveLength(1);
    expect(FakeAudio.instances[0].play).toHaveBeenCalledTimes(1);
    expect(readSound).not.toHaveBeenCalled();
  });

  it('reads a custom sound\'s bytes by event key, plays them, and releases the object URL when it ends', async () => {
    saveSounds({ onAgentIdle: 'custom' });
    const { playEventSound } = await loadPlayer();

    playEventSound('onAgentIdle');
    await flush();

    expect(readSound).toHaveBeenCalledWith('onAgentIdle');
    expect(FakeAudio.instances).toHaveLength(1);
    expect(FakeAudio.instances[0].src).toBe('blob:sound-1');
    expect(revokeObjectURL).not.toHaveBeenCalled();

    FakeAudio.instances[0].emit('ended');

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:sound-1');
  });

  it('plays nothing for a custom choice whose file is gone', async () => {
    saveSounds({ onAgentIdle: 'custom' });
    readSound.mockResolvedValue(null);
    const { playEventSound } = await loadPlayer();

    playEventSound('onAgentIdle');
    await flush();

    expect(FakeAudio.instances).toHaveLength(0);
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('cuts a sound off at EVENT_SOUND_MAX_MS, which frees the next one to start', async () => {
    const { playEventSound } = await loadPlayer();
    playEventSound('onAgentIdle');
    await flush();
    const first = FakeAudio.instances[0];

    // Still playing: another event's sound is held back.
    playEventSound('onAgentCrash');
    await flush();
    expect(FakeAudio.instances).toHaveLength(1);

    vi.advanceTimersByTime(EVENT_SOUND_MAX_MS - 1);
    expect(first.pause).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(first.pause).toHaveBeenCalledTimes(1);

    playEventSound('onAgentCrash');
    await flush();
    expect(FakeAudio.instances).toHaveLength(2);
  });

  it('finishes a sound whose play() rejects, so another event\'s sound is not held back until the cutoff', async () => {
    FakeAudio.playResult = () => Promise.reject(new Error('NotSupportedError'));
    const { playEventSound } = await loadPlayer();

    playEventSound('onAgentIdle');
    await flush();
    expect(FakeAudio.instances).toHaveLength(1);
    expect(FakeAudio.instances[0].pause).toHaveBeenCalledTimes(1);

    // No timer has advanced: only the rejection can have freed the slot.
    FakeAudio.playResult = () => Promise.resolve();
    playEventSound('onAgentCrash');
    await flush();

    expect(FakeAudio.instances).toHaveLength(2);
    expect(console.warn).toHaveBeenCalled();
  });
});

describe('previewEventSound', () => {
  it('stops what is playing and plays the previewed sound at once', async () => {
    const { playEventSound, previewEventSound } = await loadPlayer();
    playEventSound('onAgentIdle');
    await flush();
    const playing = FakeAudio.instances[0];

    previewEventSound('onAgentCrash', 'fall');
    await flush();

    expect(playing.pause).toHaveBeenCalledTimes(1);
    expect(FakeAudio.instances).toHaveLength(2);
    expect(FakeAudio.instances[1].play).toHaveBeenCalledTimes(1);
  });

  it('abandons a custom preview still reading its file when a newer play starts, and releases its source', async () => {
    let resolveBytes: (bytes: ArrayBuffer) => void = () => undefined;
    readSound.mockImplementationOnce(() => new Promise<ArrayBuffer>((resolve) => { resolveBytes = resolve; }));
    const { previewEventSound } = await loadPlayer();

    previewEventSound('onAgentIdle', 'custom');
    await flush();
    expect(readSound).toHaveBeenCalledTimes(1);
    expect(FakeAudio.instances).toHaveLength(0);

    previewEventSound('onAgentCrash', 'tick');
    await flush();
    expect(FakeAudio.instances).toHaveLength(1);
    const newerSrc = FakeAudio.instances[0].src;

    resolveBytes(new ArrayBuffer(8));
    await flush();

    // Only the newer sound plays, and the abandoned file's object URL is released.
    expect(FakeAudio.instances).toHaveLength(1);
    expect(FakeAudio.instances[0].src).toBe(newerSrc);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:sound-1');
  });
});
