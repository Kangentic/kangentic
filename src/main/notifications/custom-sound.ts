/**
 * An event's custom sound. Main keeps its own copy under the config directory, so
 * moving or deleting the original later breaks nothing. The renderer asks for bytes
 * by event key and never by path, because in dev it runs on a web origin that cannot
 * load `file://`, and so main only ever reads this one folder.
 */
import fs from 'node:fs';
import path from 'node:path';
import { dialog, type BrowserWindow } from 'electron';
import { msg } from '@lingui/core/runtime-macro';
import { PATHS } from '../config/paths';
import { translateText } from '../i18n/main-i18n';
import {
  CUSTOM_SOUND_EXTENSIONS,
  CUSTOM_SOUND_MAX_BYTES,
  NOTIFICATION_EVENT_KEYS,
} from '../../shared/notification-settings';
import type { CustomSoundPick, NotificationEventKey } from '../../shared/types';

function soundsFolder(): string {
  return path.join(PATHS.configDir, 'notification-sounds');
}

function soundPath(eventKey: NotificationEventKey, extension: string): string {
  return path.join(soundsFolder(), `${eventKey}.${extension}`);
}

/** The key names a file, and it arrives over IPC. */
function isEventKey(value: unknown): value is NotificationEventKey {
  return (NOTIFICATION_EVENT_KEYS as readonly unknown[]).includes(value);
}

/** Checks a chosen file and copies it in, replacing the event's earlier one. */
export async function importCustomSound(eventKey: NotificationEventKey, sourcePath: string): Promise<CustomSoundPick> {
  if (!isEventKey(eventKey)) throw new Error('Unknown notification event');

  const fileName = path.basename(sourcePath);
  const extension = path.extname(sourcePath).slice(1).toLowerCase();
  const notASoundFile = (): CustomSoundPick => ({
    status: 'refused',
    reason: translateText(msg`${{ fileName }} is not a wav, mp3, ogg or m4a file`),
  });
  if (!(CUSTOM_SOUND_EXTENSIONS as readonly string[]).includes(extension)) return notASoundFile();

  const targetPath = soundPath(eventKey, extension);
  // Copied beside the target and then renamed over it, so a copy that fails leaves the earlier sound whole.
  const stagedPath = `${targetPath}.importing`;
  try {
    const stats = await fs.promises.stat(sourcePath);
    if (!stats.isFile()) return notASoundFile();
    if (stats.size > CUSTOM_SOUND_MAX_BYTES) {
      const megabytes = (stats.size / (1024 * 1024)).toFixed(1);
      return { status: 'refused', reason: translateText(msg`${{ fileName }} is ${{ megabytes }} MB, over the 2 MB limit`) };
    }
    await fs.promises.mkdir(soundsFolder(), { recursive: true });
    await fs.promises.copyFile(sourcePath, stagedPath);
    await fs.promises.rename(stagedPath, targetPath);
    await Promise.all(CUSTOM_SOUND_EXTENSIONS
      .filter((otherExtension) => otherExtension !== extension)
      .map((otherExtension) => fs.promises.rm(soundPath(eventKey, otherExtension), { force: true })));
  } catch (error) {
    await fs.promises.rm(stagedPath, { force: true }).catch(() => undefined);
    return { status: 'refused', reason: error instanceof Error ? error.message : String(error) };
  }
  return { status: 'picked', fileName };
}

export async function pickCustomSound(window: BrowserWindow, eventKey: NotificationEventKey): Promise<CustomSoundPick> {
  if (!isEventKey(eventKey)) throw new Error('Unknown notification event');
  const picked = await dialog.showOpenDialog(window, {
    properties: ['openFile'],
    filters: [{ name: translateText(msg`Sound files`), extensions: [...CUSTOM_SOUND_EXTENSIONS] }],
  });
  const sourcePath = picked.filePaths[0];
  if (picked.canceled || !sourcePath) return { status: 'cancelled' };
  return importCustomSound(eventKey, sourcePath);
}

/** The event's copy, or null when it has none. */
export async function readCustomSound(eventKey: NotificationEventKey): Promise<ArrayBuffer | null> {
  if (!isEventKey(eventKey)) throw new Error('Unknown notification event');
  for (const extension of CUSTOM_SOUND_EXTENSIONS) {
    try {
      const bytes = await fs.promises.readFile(soundPath(eventKey, extension));
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return null;
}
