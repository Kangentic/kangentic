/**
 * Custom notification sounds on a real folder. What a user loses without these: a
 * sound that stops working when they move the original, a huge file read into the
 * renderer, or a renderer able to name a path main will read.
 *
 * Tier: Unit.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const showOpenDialog = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ dialog: { showOpenDialog } }));

let dataDir: string;
let sourceDir: string;

async function loadModule() {
  return import('../../src/main/notifications/custom-sound');
}

function source(name: string, bytes: number): string {
  const filePath = path.join(sourceDir, name);
  fs.writeFileSync(filePath, Buffer.alloc(bytes, 7));
  return filePath;
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-sounds-'));
  sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-sounds-source-'));
  process.env.KANGENTIC_DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.KANGENTIC_DATA_DIR;
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(sourceDir, { recursive: true, force: true });
});

describe('custom notification sounds', () => {
  it('keeps its own copy, so the original can go', async () => {
    const { importCustomSound, readCustomSound } = await loadModule();
    const original = source('gong.wav', 64);

    expect(await importCustomSound('onAgentIdle', original)).toEqual({ status: 'picked', fileName: 'gong.wav' });
    fs.rmSync(original, { force: true });

    expect((await readCustomSound('onAgentIdle'))?.byteLength).toBe(64);
  });

  it('refuses another kind of file and names it', async () => {
    const { importCustomSound, readCustomSound } = await loadModule();
    const result = await importCustomSound('onAgentIdle', source('notes.txt', 8));

    expect(result).toMatchObject({ status: 'refused' });
    expect(result).toMatchObject({ reason: expect.stringContaining('notes.txt') });
    expect(await readCustomSound('onAgentIdle')).toBeNull();
  });

  it('refuses a file over 2 MB, says how big it is, and keeps the earlier sound', async () => {
    const { importCustomSound, readCustomSound } = await loadModule();
    await importCustomSound('onAgentIdle', source('small.wav', 16));

    const result = await importCustomSound('onAgentIdle', source('gong.wav', 3 * 1024 * 1024));

    expect(result).toMatchObject({ status: 'refused', reason: expect.stringContaining('3.0 MB') });
    expect((await readCustomSound('onAgentIdle'))?.byteLength).toBe(16);
  });

  it('replaces the event\'s earlier file when the new one has another extension', async () => {
    const { importCustomSound, readCustomSound } = await loadModule();
    await importCustomSound('onAgentIdle', source('first.mp3', 16));
    await importCustomSound('onAgentIdle', source('second.WAV', 32));

    const stored = fs.readdirSync(path.join(dataDir, 'notification-sounds'));
    expect(stored).toEqual(['onAgentIdle.wav']);
    expect((await readCustomSound('onAgentIdle'))?.byteLength).toBe(32);
  });

  it('keeps each event\'s sound apart', async () => {
    const { importCustomSound, readCustomSound } = await loadModule();
    await importCustomSound('onAgentIdle', source('a.wav', 16));

    expect(await readCustomSound('onAgentCrash')).toBeNull();
  });

  it('refuses a source path that does not exist, and keeps the earlier sound', async () => {
    const { importCustomSound, readCustomSound } = await loadModule();
    await importCustomSound('onAgentIdle', source('small.wav', 16));

    const result = await importCustomSound('onAgentIdle', path.join(sourceDir, 'moved-away.wav'));

    expect(result).toMatchObject({ status: 'refused' });
    expect((await readCustomSound('onAgentIdle'))?.byteLength).toBe(16);
  });

  it('refuses a folder named like a sound with the not-a-sound message, and keeps the earlier sound', async () => {
    const { importCustomSound, readCustomSound } = await loadModule();
    await importCustomSound('onAgentIdle', source('small.wav', 16));
    const folder = path.join(sourceDir, 'gong.wav');
    fs.mkdirSync(folder);

    const result = await importCustomSound('onAgentIdle', folder);

    expect(result).toMatchObject({ status: 'refused', reason: expect.stringContaining('gong.wav is not a wav') });
    expect((await readCustomSound('onAgentIdle'))?.byteLength).toBe(16);
  });

  it('leaves the earlier sound whole and no half-copied file behind when the copy fails midway', async () => {
    const { importCustomSound, readCustomSound } = await loadModule();
    await importCustomSound('onAgentIdle', source('small.wav', 16));
    const realCopyFile = fs.promises.copyFile;
    const copyFile = vi.spyOn(fs.promises, 'copyFile').mockImplementationOnce(async (_from, to) => {
      // A real failure part-way: bytes reach the destination, then the disk gives out.
      fs.writeFileSync(to as string, Buffer.alloc(4, 1));
      throw new Error('ENOSPC: no space left on device');
    });

    try {
      const result = await importCustomSound('onAgentIdle', source('bigger.wav', 64));

      expect(copyFile).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ status: 'refused', reason: 'ENOSPC: no space left on device' });
      expect((await readCustomSound('onAgentIdle'))?.byteLength).toBe(16);
      expect(fs.readdirSync(path.join(dataDir, 'notification-sounds'))).toEqual(['onAgentIdle.wav']);
    } finally {
      copyFile.mockRestore();
      expect(fs.promises.copyFile).toBe(realCopyFile);
    }
  });

  it('rethrows a read error that is not a missing file', async () => {
    const { readCustomSound } = await loadModule();
    // A folder where the file should be: readFile fails with EISDIR, not ENOENT.
    fs.mkdirSync(path.join(dataDir, 'notification-sounds', 'onAgentIdle.wav'), { recursive: true });

    await expect(readCustomSound('onAgentIdle')).rejects.toMatchObject({ code: 'EISDIR' });
  });

  it('refuses a key that is not an event, since the key names a file', async () => {
    const { importCustomSound, readCustomSound } = await loadModule();
    const escape = '../../secret' as Parameters<typeof readCustomSound>[0];

    await expect(readCustomSound(escape)).rejects.toThrow('Unknown notification event');
    await expect(importCustomSound(escape, source('a.wav', 8))).rejects.toThrow('Unknown notification event');
  });
});

describe('pickCustomSound', () => {
  const window = {} as import('electron').BrowserWindow;

  beforeEach(() => {
    showOpenDialog.mockReset();
  });

  it.each([
    ['the dialog is cancelled', { canceled: true, filePaths: ['/mock/ignored.wav'] }],
    ['the dialog closes with no file', { canceled: false, filePaths: [] }],
  ])('returns cancelled and copies nothing when %s', async (_label, dialogResult) => {
    showOpenDialog.mockResolvedValue(dialogResult);
    const { pickCustomSound } = await loadModule();

    expect(await pickCustomSound(window, 'onAgentIdle')).toEqual({ status: 'cancelled' });
    expect(fs.existsSync(path.join(dataDir, 'notification-sounds'))).toBe(false);
  });

  it('imports the chosen file', async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [source('gong.wav', 32)] });
    const { pickCustomSound, readCustomSound } = await loadModule();

    expect(await pickCustomSound(window, 'onAgentIdle')).toEqual({ status: 'picked', fileName: 'gong.wav' });
    expect((await readCustomSound('onAgentIdle'))?.byteLength).toBe(32);
  });

  it('refuses an unknown key before it opens the dialog', async () => {
    const { pickCustomSound } = await loadModule();
    const escape = '../../secret' as Parameters<typeof pickCustomSound>[1];

    await expect(pickCustomSound(window, escape)).rejects.toThrow('Unknown notification event');
    expect(showOpenDialog).not.toHaveBeenCalled();
  });
});
