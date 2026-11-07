/**
 * The one place a notification sound plays. It runs in the main window's renderer:
 * main has no audio API, and a pop-out never plays one, so a sound is never heard
 * twice. Two gates keep a burst to one sound: a repeat of an event inside a short
 * window is dropped, as an event firing both a toast and a desktop notice would be,
 * and a sound never starts over one still playing.
 */
import chimeUrl from '../assets/sounds/chime.wav?url';
import fallUrl from '../assets/sounds/fall.wav?url';
import riseUrl from '../assets/sounds/rise.wav?url';
import tickUrl from '../assets/sounds/tick.wav?url';
import { type BUILT_IN_SOUNDS, EVENT_SOUND_MAX_MS, effectiveNotificationConfig, resolveEventSound } from '../../shared/notification-settings';
import type { NotificationConfig, NotificationEventKey, NotificationSound } from '../../shared/types';
import { useConfigStore } from '../stores/config-store';

const REPEAT_WINDOW_MS = 1500;

// Keyed by every sound `BUILT_IN_SOUNDS` lists, so a new one with no file fails to compile.
const BUILT_IN_URLS: Record<(typeof BUILT_IN_SOUNDS)[number], string> & Partial<Record<NotificationSound, string>> = {
  chime: chimeUrl,
  rise: riseUrl,
  fall: fallUrl,
  tick: tickUrl,
};

/**
 * Whether an event's sound may start now. Pure over its own state, so the gate's
 * timing is tested with no audio. `isPlaying` is asked last.
 */
export function createSoundGate(windowMs: number = REPEAT_WINDOW_MS) {
  const lastPlayedAt = new Map<NotificationEventKey, number>();
  return (eventKey: NotificationEventKey, now: number, isPlaying: boolean): boolean => {
    const last = lastPlayedAt.get(eventKey);
    if (last !== undefined && now - last < windowMs) return false;
    if (isPlaying) return false;
    lastPlayedAt.set(eventKey, now);
    return true;
  };
}

// hmr-safe: a Fast Refresh drops at most one repeat window; a sound already playing finishes on its own element.
const mayPlay = createSoundGate();
// hmr-safe: the same, and the worst a reset costs is one overlapping sound in dev.
let playing: { audio: HTMLAudioElement; finish: () => void } | null = null;
// hmr-safe: the same. It only lets a newer play abandon one still reading its file.
let latestPlay = 0;

function stopPlaying(): void {
  playing?.finish();
}

async function sourceFor(eventKey: NotificationEventKey, sound: NotificationSound): Promise<{ url: string; release: () => void } | null> {
  const builtIn = BUILT_IN_URLS[sound];
  if (builtIn) return { url: builtIn, release: () => {} };
  if (sound !== 'custom') return null;
  const bytes = await window.electronAPI.notifications.readSound(eventKey);
  if (!bytes) return null;
  const url = URL.createObjectURL(new Blob([bytes]));
  return { url, release: () => URL.revokeObjectURL(url) };
}

async function play(eventKey: NotificationEventKey, sound: NotificationSound): Promise<void> {
  latestPlay += 1;
  const thisPlay = latestPlay;
  const source = await sourceFor(eventKey, sound);
  if (!source) return;
  // A custom sound's bytes come over IPC, and a newer play may have started meanwhile.
  if (thisPlay !== latestPlay) {
    source.release();
    return;
  }
  const audio = new Audio(source.url);
  const finish = () => {
    audio.pause();
    source.release();
    clearTimeout(cutOff);
    audio.removeEventListener('ended', finish);
    audio.removeEventListener('error', finish);
    if (playing?.audio === audio) playing = null;
  };
  const cutOff = setTimeout(finish, EVENT_SOUND_MAX_MS);
  audio.addEventListener('ended', finish);
  audio.addEventListener('error', finish);
  playing = { audio, finish };
  try {
    await audio.play();
  } catch (error) {
    // A file that will not start raises no `error` event, and left unfinished it
    // would hold back every other sound until the cutoff.
    finish();
    throw error;
  }
}

function playSafely(eventKey: NotificationEventKey, sound: NotificationSound): void {
  play(eventKey, sound).catch((error: unknown) => {
    console.warn('[NOTIFICATION] could not play a sound', error);
  });
}

/** The notification settings with Mute applied, for every renderer read that decides a notice. */
export function notificationConfigNow(): NotificationConfig {
  return effectiveNotificationConfig(useConfigStore.getState().config.notifications);
}

/**
 * An event's toast went up, or main's push says its desktop notification left the
 * sound to this window. System has no audio file: the OS picks it and plays it with
 * a desktop notification, so this window has nothing to play for it.
 */
export function playEventSound(eventKey: NotificationEventKey): void {
  const sound = resolveEventSound(notificationConfigNow(), eventKey);
  if (sound === 'off' || sound === 'system') return;
  if (!mayPlay(eventKey, Date.now(), playing !== null)) return;
  playSafely(eventKey, sound);
}

/** The picker's Play: always heard, and it replaces whatever is playing. */
export function previewEventSound(eventKey: NotificationEventKey, sound: NotificationSound): void {
  stopPlaying();
  playSafely(eventKey, sound);
}
