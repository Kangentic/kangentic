import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import { SessionFileManager } from '../../src/main/pty/lifecycle/session-file-manager';
import type { SessionHistoryReader } from '../../src/main/pty/readers/session-history-reader';
import type { StatusFileReader } from '../../src/main/pty/readers/status-file-reader';

function makeReaderMocks() {
  const calls: string[] = [];
  const record = (label: string) => () => { calls.push(label); };
  const sessionHistoryReader = {
    detach: vi.fn(record('history.detach')),
  } as unknown as SessionHistoryReader;
  const statusFileReader = {
    detach: vi.fn(record('status.detach')),
    detachWithoutCleanup: vi.fn(record('status.detachWithoutCleanup')),
  } as unknown as StatusFileReader;
  return { sessionHistoryReader, statusFileReader, calls };
}

describe('SessionFileManager', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('register', () => {
    it('derives session dir + merged settings path from status output path', () => {
      const mocks = makeReaderMocks();
      const manager = new SessionFileManager(mocks.sessionHistoryReader, mocks.statusFileReader);
      // Registering then detaching with delete lets us verify the paths were saved.
      manager.register({
        sessionId: 's1',
        statusOutputPath: '/proj/.kangentic/sessions/s1/status.json',
      });
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {});
      const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation(() => {});
      manager.detachAndDelete('s1');
      expect(unlinkSpy).toHaveBeenCalledWith('/proj/.kangentic/sessions/s1/settings.json');
      expect(rmSpy).toHaveBeenCalledWith('/proj/.kangentic/sessions/s1', { recursive: true, force: true });
    });

    it('leaves paths null when no status output path is provided', () => {
      const mocks = makeReaderMocks();
      const manager = new SessionFileManager(mocks.sessionHistoryReader, mocks.statusFileReader);
      manager.register({ sessionId: 's1', statusOutputPath: null });
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {});
      const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation(() => {});
      manager.detachAndDelete('s1');
      expect(unlinkSpy).not.toHaveBeenCalled();
      expect(rmSpy).not.toHaveBeenCalled();
    });
  });

  describe('detachPreservingFiles', () => {
    it('detaches readers without deleting files', () => {
      const mocks = makeReaderMocks();
      const manager = new SessionFileManager(mocks.sessionHistoryReader, mocks.statusFileReader);
      manager.register({ sessionId: 's1', statusOutputPath: '/proj/.kangentic/sessions/s1/status.json' });
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {});
      const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation(() => {});

      manager.detachPreservingFiles('s1');

      expect(mocks.calls).toEqual(['history.detach', 'status.detachWithoutCleanup']);
      expect(unlinkSpy).not.toHaveBeenCalled();
      expect(rmSpy).not.toHaveBeenCalled();
    });

    it('nullifies paths so a later detachAndDelete cannot race with resume', () => {
      const mocks = makeReaderMocks();
      const manager = new SessionFileManager(mocks.sessionHistoryReader, mocks.statusFileReader);
      manager.register({ sessionId: 's1', statusOutputPath: '/proj/.kangentic/sessions/s1/status.json' });
      manager.detachPreservingFiles('s1');

      // After path nullify, a subsequent delete should be a no-op for the
      // files even though the session entry still exists.
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {});
      const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation(() => {});
      manager.detachAndDelete('s1');
      expect(unlinkSpy).not.toHaveBeenCalled();
      expect(rmSpy).not.toHaveBeenCalled();
    });
  });

  describe('detachOnPtyExit', () => {
    it('only detaches status reader without cleanup; leaves history reader and paths alone', () => {
      const mocks = makeReaderMocks();
      const manager = new SessionFileManager(mocks.sessionHistoryReader, mocks.statusFileReader);
      manager.register({ sessionId: 's1', statusOutputPath: '/proj/.kangentic/sessions/s1/status.json' });

      manager.detachOnPtyExit('s1');

      expect(mocks.calls).toEqual(['status.detachWithoutCleanup']);
      // History reader stays attached for suspend()'s scrollback fallback.
      expect(mocks.sessionHistoryReader.detach).not.toHaveBeenCalled();

      // Paths still intact: a subsequent full delete cleans them up.
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {});
      manager.detachAndDelete('s1');
      expect(unlinkSpy).toHaveBeenCalledWith('/proj/.kangentic/sessions/s1/settings.json');
    });
  });

  describe('detachAndDelete', () => {
    it('deletes files and detaches both readers with full cleanup', () => {
      const mocks = makeReaderMocks();
      const manager = new SessionFileManager(mocks.sessionHistoryReader, mocks.statusFileReader);
      manager.register({ sessionId: 's1', statusOutputPath: '/proj/.kangentic/sessions/s1/status.json' });
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {});
      const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation(() => {});

      manager.detachAndDelete('s1');

      expect(unlinkSpy).toHaveBeenCalledWith('/proj/.kangentic/sessions/s1/settings.json');
      expect(rmSpy).toHaveBeenCalledWith('/proj/.kangentic/sessions/s1', { recursive: true, force: true });
      expect(mocks.calls).toEqual(['history.detach', 'status.detach']);
    });

    it('swallows fs errors when files are already gone', () => {
      const mocks = makeReaderMocks();
      const manager = new SessionFileManager(mocks.sessionHistoryReader, mocks.statusFileReader);
      manager.register({ sessionId: 's1', statusOutputPath: '/proj/.kangentic/sessions/s1/status.json' });
      vi.spyOn(fs, 'unlinkSync').mockImplementation(() => { throw new Error('ENOENT'); });
      vi.spyOn(fs, 'rmSync').mockImplementation(() => { throw new Error('ENOENT'); });

      expect(() => manager.detachAndDelete('s1')).not.toThrow();
    });
  });

  describe('removeSession', () => {
    it('drops path state without touching disk', () => {
      const mocks = makeReaderMocks();
      const manager = new SessionFileManager(mocks.sessionHistoryReader, mocks.statusFileReader);
      manager.register({ sessionId: 's1', statusOutputPath: '/proj/.kangentic/sessions/s1/status.json' });
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {});
      const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation(() => {});

      manager.removeSession('s1');

      expect(unlinkSpy).not.toHaveBeenCalled();
      expect(rmSpy).not.toHaveBeenCalled();
      // After removal, detachAndDelete has nothing to do - does not touch fs.
      manager.detachAndDelete('s1');
      expect(unlinkSpy).not.toHaveBeenCalled();
    });
  });
});
