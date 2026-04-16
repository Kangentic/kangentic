import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: class {},
  ipcMain: { handle: vi.fn() },
}));
vi.mock('electron-updater', () => ({
  autoUpdater: {
    on: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
  },
}));
vi.mock('@aptabase/electron/main', () => ({
  initialize: vi.fn().mockResolvedValue(undefined),
  trackEvent: vi.fn().mockResolvedValue(undefined),
}));

import { isTransientUpdaterError } from '../../src/main/updater';

type ErrorShape = { code?: string; message?: string };

function makeError(shape: ErrorShape): Error {
  const error = new Error(shape.message ?? '');
  if (shape.code !== undefined) {
    (error as NodeJS.ErrnoException).code = shape.code;
  }
  return error;
}

describe('isTransientUpdaterError', () => {
  describe('Node fs / os transient codes', () => {
    it.each([
      'ECONNRESET',
      'ETIMEDOUT',
      'EAI_AGAIN',
      'ENOTFOUND',
      'ENETUNREACH',
      'EPIPE',
    ])('classifies %s as transient', (code) => {
      expect(isTransientUpdaterError(makeError({ code }))).toBe(true);
    });
  });

  describe('Chromium net errors (message-only)', () => {
    it.each([
      'net::ERR_NETWORK_CHANGED',
      'net::ERR_INTERNET_DISCONNECTED',
      'net::ERR_CONNECTION_RESET',
      'net::ERR_NAME_NOT_RESOLVED',
    ])('classifies "%s" as transient', (message) => {
      expect(isTransientUpdaterError(makeError({ message }))).toBe(true);
    });
  });

  describe('HttpError transient status codes', () => {
    it.each([
      'HTTP_ERROR_500',
      'HTTP_ERROR_502',
      'HTTP_ERROR_503',
      'HTTP_ERROR_504',
      'HTTP_ERROR_408',
      'HTTP_ERROR_429',
      'HTTP_ERROR_618',
    ])('classifies %s as transient', (code) => {
      expect(isTransientUpdaterError(makeError({ code }))).toBe(true);
    });
  });

  describe('Free-form transient messages', () => {
    it('classifies "Request has been aborted by the server" as transient', () => {
      expect(
        isTransientUpdaterError(makeError({ message: 'Request has been aborted by the server while pipe' }))
      ).toBe(true);
    });

    it('classifies MacUpdater "Cannot pipe" wrapper as transient', () => {
      expect(
        isTransientUpdaterError(
          makeError({ message: 'Cannot pipe "/Users/dev/Library/Caches/kangentic-updater/pending/update.zip": ENOENT' })
        )
      ).toBe(true);
    });
  });

  describe('Structural failures stay loud', () => {
    it('keeps bare ENOENT loud so differential-download regressions remain visible', () => {
      const message = "ENOENT: no such file or directory, open '/Users/dev/Library/Caches/kangentic-updater/pending/update.zip'";
      expect(isTransientUpdaterError(makeError({ code: 'ENOENT', message }))).toBe(false);
    });

    it.each([
      'HTTP_ERROR_400',
      'HTTP_ERROR_401',
      'HTTP_ERROR_403',
      'HTTP_ERROR_404',
      'HTTP_ERROR_410',
    ])('keeps 4xx HttpError %s loud (manifest/auth bug, not transient)', (code) => {
      expect(isTransientUpdaterError(makeError({ code }))).toBe(false);
    });

    it.each([
      'ERR_UPDATER_INVALID_SIGNATURE',
      'ERR_UPDATER_NO_CHECKSUM',
      'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND',
      'ERR_UPDATER_INVALID_VERSION',
      'ERR_UPDATER_UNSUPPORTED_PROVIDER',
    ])('keeps %s loud (electron-updater structural)', (code) => {
      expect(isTransientUpdaterError(makeError({ code }))).toBe(false);
    });

    it.each(['EACCES', 'EPERM', 'EROFS', 'ENOSPC'])(
      'keeps %s loud (persistent disk/permission)',
      (code) => {
        expect(isTransientUpdaterError(makeError({ code }))).toBe(false);
      }
    );

    it('fails safe on unknown errors (reports as app_error)', () => {
      expect(isTransientUpdaterError(new Error('something weird happened'))).toBe(false);
    });

    it('fails safe on Error with neither code nor recognizable message', () => {
      expect(isTransientUpdaterError(makeError({ message: '' }))).toBe(false);
    });
  });

  describe('Precedence', () => {
    it('code check wins over message check when both present', () => {
      const hybrid = makeError({ code: 'ECONNRESET', message: 'something unrelated' });
      expect(isTransientUpdaterError(hybrid)).toBe(true);
    });
  });
});
