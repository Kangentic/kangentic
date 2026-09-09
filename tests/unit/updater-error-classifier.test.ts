import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

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

import {
  isTransientUpdaterError,
  hasTransientNetworkCause,
  isElevationDeniedError,
} from '../../src/main/updater';

/**
 * The DESKTOP-F message, copied from the real Sentry event payload rather than
 * reconstructed. It is the double-rewrap shape: parseUpdateInfo's sentence
 * wrapping getLatestTagName's sentence wrapping the original HttpError.
 */
const DESKTOP_F_MESSAGE = [
  'Cannot parse releases feed: Error: Unable to find latest version on GitHub',
  ' (https://github.com/Kangentic/kangentic/releases/latest),',
  ' please ensure a production release exists: HttpError: 504 \n',
  '"method: GET url: https://github.com/Kangentic/kangentic/releases/tag/v0.38.0\n',
  'Data:\n<html><body><h1>504 Gateway Time-out</h1>\n</body></html>"',
].join('');

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

  describe('The rewrapped feed failure it cannot see', () => {
    // Documents WHY hasTransientNetworkCause has to exist. newError() assigns
    // its own code, so by the time this error is emitted the original
    // HTTP_ERROR_504 is gone and every code branch above misses.
    it('misses DESKTOP-F, because the wrapper overwrote the transient code', () => {
      const wrapped = makeError({
        code: 'ERR_UPDATER_INVALID_RELEASE_FEED',
        message: DESKTOP_F_MESSAGE,
      });
      expect(isTransientUpdaterError(wrapped)).toBe(false);
    });
  });
});

describe('hasTransientNetworkCause', () => {
  describe('Rewrapped transient feed failures', () => {
    it('classifies the verbatim DESKTOP-F error as transient', () => {
      const wrapped = makeError({
        code: 'ERR_UPDATER_INVALID_RELEASE_FEED',
        message: DESKTOP_F_MESSAGE,
      });
      expect(hasTransientNetworkCause(wrapped)).toBe(true);
    });

    it.each([
      'HttpError: 500',
      'HttpError: 502',
      'HttpError: 503',
      'HttpError: 504',
      'HttpError: 408',
      'HttpError: 429',
    ])('classifies a feed wrapper carrying "%s" as transient', (nested) => {
      const wrapped = makeError({
        code: 'ERR_UPDATER_INVALID_RELEASE_FEED',
        message: `Cannot parse releases feed: Error: ${nested} \nXML:\n<feed/>`,
      });
      expect(hasTransientNetworkCause(wrapped)).toBe(true);
    });

    it.each([
      'ECONNRESET',
      'ETIMEDOUT',
      'ENOTFOUND',
      'EAI_AGAIN',
      'ENETUNREACH',
      'ECONNREFUSED',
    ])('classifies a feed wrapper carrying a nested %s as transient', (nested) => {
      const wrapped = makeError({
        code: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND',
        message: `Unable to find latest version on GitHub (https://example.test),`
          + ` please ensure a production release exists: Error: connect ${nested} 140.82.0.1:443`,
      });
      expect(hasTransientNetworkCause(wrapped)).toBe(true);
    });
  });

  describe('Recognizes the wrapper by phrase when the code is absent', () => {
    // The disjunction that keeps this from silently no-opping in production if
    // `code` is ever dropped between the throw site and the 'error' emit. A
    // test that always sets `code` by hand would never catch that.
    it('classifies the DESKTOP-F message with NO code at all', () => {
      expect(hasTransientNetworkCause(makeError({ message: DESKTOP_F_MESSAGE }))).toBe(true);
    });

    it('classifies a codeless getLatestTagName wrapper', () => {
      const message = 'Unable to find latest version on GitHub (https://example.test),'
        + ' please ensure a production release exists: HttpError: 503';
      expect(hasTransientNetworkCause(makeError({ message }))).toBe(true);
    });
  });

  describe('Structural feed failures stay loud', () => {
    it('keeps a genuinely malformed feed loud (wrapper, but no transient cause)', () => {
      const wrapped = makeError({
        code: 'ERR_UPDATER_INVALID_RELEASE_FEED',
        message: 'Cannot parse releases feed: Error: Unexpected token < in JSON at position 0',
      });
      expect(hasTransientNetworkCause(wrapped)).toBe(false);
    });

    it('keeps a 404 feed lookup loud (no production release is a real bug)', () => {
      const wrapped = makeError({
        code: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND',
        message: 'Unable to find latest version on GitHub (https://example.test),'
          + ' please ensure a production release exists: HttpError: 404',
      });
      expect(hasTransientNetworkCause(wrapped)).toBe(false);
    });

    it.each([
      'ERR_UPDATER_INVALID_SIGNATURE',
      'ERR_UPDATER_NO_CHECKSUM',
      'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND',
      'ERR_UPDATER_INVALID_VERSION',
      'ERR_UPDATER_UNSUPPORTED_PROVIDER',
    ])('keeps %s loud even when its text mentions a 504', (code) => {
      const structural = makeError({
        code,
        message: 'validation failed after HttpError: 504 was retried',
      });
      expect(hasTransientNetworkCause(structural)).toBe(false);
    });

    it('keeps a bare transient error loud here (isTransientUpdaterError owns those)', () => {
      // Not a feed wrapper, so this predicate must decline it rather than
      // widen into a second, competing transient classifier.
      expect(hasTransientNetworkCause(makeError({ code: 'ECONNRESET' }))).toBe(false);
    });

    it('fails safe on an empty message', () => {
      expect(hasTransientNetworkCause(makeError({ message: '' }))).toBe(false);
    });
  });
});

/**
 * The cases above build their messages by hand, which means they would all keep
 * passing if electron-updater changed the text the predicate reads. These drive
 * the real library instead.
 *
 * Depending on builder-util-runtime is deliberate, and is the opposite call from
 * release-asset-manifest.test.ts declining to use js-yaml. There, the transitive
 * package was an incidental tool that could be swapped for a regex. Here it is
 * the SUBJECT: hasTransientNetworkCause exists solely to read text this library
 * formats, so pinning against the real formatter is the whole point. If an
 * electron-updater bump reshapes these exports or the message layout, this block
 * fails - which is the signal we want, because the predicate would otherwise go
 * quietly blind and DESKTOP-F would start arriving again.
 *
 * Caught a real defect on first run: the initial version passed its own message
 * to HttpError, producing "HttpError: status 504", and every case failed. The
 * production path is createHttpError, which formats
 * `${statusCode} ${statusMessage}`. Hand-written fixtures never would have shown
 * that the predicate depends on that specific formatter.
 */
const requireFromTest = createRequire(import.meta.url);
const { newError, createHttpError } = requireFromTest('builder-util-runtime') as {
  newError: (message: string, code: string) => Error;
  createHttpError: (
    response: { statusCode: number; statusMessage: string; headers: unknown },
    description?: unknown,
  ) => Error;
};

/** Reproduces GitHubProvider's double rewrap: httpExecutor, then :162, then :96. */
function buildRealWrappedFeedError(statusCode: number): Error {
  const original = createHttpError(
    { statusCode, statusMessage: 'Gateway Time-out', headers: { 'content-type': 'text/html' } },
    '<html><body><h1>Gateway Time-out</h1></body></html>',
  );
  const url = 'https://github.com/Kangentic/kangentic/releases/latest';
  const wrappedOnce = newError(
    `Unable to find latest version on GitHub (${url}), please ensure a production release`
      + ` exists: ${original.stack || original.message}`,
    'ERR_UPDATER_LATEST_VERSION_NOT_FOUND',
  );
  return newError(
    `Cannot parse releases feed: ${wrappedOnce.stack || wrappedOnce.message},\nXML:\n<feed/>`,
    'ERR_UPDATER_INVALID_RELEASE_FEED',
  );
}

describe('against errors built by the real builder-util-runtime', () => {
  it('confirms the rewrap keeps its own code and destroys the transient one', () => {
    const real = buildRealWrappedFeedError(504) as NodeJS.ErrnoException;
    // The premise the whole fix rests on. The outer code is the structural
    // wrapper's; the HTTP_ERROR_504 that isTransientUpdaterError would have
    // matched exists only on an inner error that never reaches the handler.
    expect(real.code).toBe('ERR_UPDATER_INVALID_RELEASE_FEED');
    expect(isTransientUpdaterError(real)).toBe(false);
    expect(hasTransientNetworkCause(real)).toBe(true);
  });

  it.each([500, 502, 503, 504, 408, 429])(
    'classifies a real %s feed chain as transient',
    (statusCode) => {
      expect(hasTransientNetworkCause(buildRealWrappedFeedError(statusCode))).toBe(true);
    },
  );

  it.each([400, 401, 403, 404, 410])('keeps a real %s feed chain loud', (statusCode) => {
    expect(hasTransientNetworkCause(buildRealWrappedFeedError(statusCode))).toBe(false);
  });
});

/**
 * DESKTOP-R. The five names are LinuxUpdater.determineSudoCommand's four PATH
 * probes plus its sudo fallback, and the message is BaseUpdater.spawnSyncLog's
 * template verbatim. The upstream-format guard at the bottom of this file is
 * what keeps both of those true.
 */
const ELEVATION_FRONT_ENDS = ['pkexec', 'gksudo', 'kdesudo', 'beesu', 'sudo'];

describe('isElevationDeniedError', () => {
  describe('A denied elevation prompt is suppressed', () => {
    it.each(ELEVATION_FRONT_ENDS)('catches a dismissed dialog under %s (126)', (frontEnd) => {
      expect(isElevationDeniedError(
        makeError({ message: `Command ${frontEnd} exited with code 126` }),
      )).toBe(true);
    });

    it.each(ELEVATION_FRONT_ENDS)('catches a failed authentication under %s (127)', (frontEnd) => {
      expect(isElevationDeniedError(
        makeError({ message: `Command ${frontEnd} exited with code 127` }),
      )).toBe(true);
    });

    it('catches the exact DESKTOP-R message', () => {
      // Copied from the Sentry event, not reconstructed.
      expect(isElevationDeniedError(
        makeError({ message: 'Command pkexec exited with code 126' }),
      )).toBe(true);
    });

    it('needs no code property, because the real error has none', () => {
      const real = makeError({ message: 'Command pkexec exited with code 126' });
      expect((real as NodeJS.ErrnoException).code).toBeUndefined();
      expect(isElevationDeniedError(real)).toBe(true);
    });
  });

  describe('A real install failure stays loud', () => {
    // The case that actually reaches production alongside DESKTOP-R: pkexec
    // authorized fine and the package manager underneath it failed, so pkexec
    // handed back that program's own exit code.
    it.each([1, 2, 100])(
      'reports a package manager failure propagated through pkexec (code %s)',
      (exitCode) => {
        expect(isElevationDeniedError(
          makeError({ message: `Command pkexec exited with code ${exitCode}` }),
        )).toBe(false);
      },
    );

    // Running as root skips elevation entirely and passes the package manager
    // itself as the command name.
    it.each([
      'Command dpkg exited with code 1',
      'Command dpkg exited with code 2',
      'Command apt-get exited with code 100',
      'Command rpm exited with code 1',
      'Command pacman exited with code 1',
    ])('reports %s', (message) => {
      expect(isElevationDeniedError(makeError({ message }))).toBe(false);
    });

    it.each([
      'Neither dpkg nor apt command found. Cannot install .deb package.',
      'Package manager foo not supported',
      "No update filepath provided, can't quit and install",
    ])('reports the other bare-Error message %s', (message) => {
      expect(isElevationDeniedError(makeError({ message }))).toBe(false);
    });
  });

  describe('The deliberate exit-1 gap', () => {
    // sudo(8) exits 1 for an authentication failure, a permission problem, OR a
    // command it could not execute, and gksudo/kdesudo exit 1 when cancelled.
    // Exit 1 is therefore indistinguishable from a command that ran and failed,
    // so these declines are NOT suppressed. This is a decision, not an
    // oversight: pkexec is what determineSudoCommand picks on any current
    // desktop, and it has distinct codes.
    it.each(['sudo', 'gksudo', 'kdesudo'])(
      'still reports a cancelled %s prompt, which is indistinguishable at exit 1',
      (frontEnd) => {
        expect(isElevationDeniedError(
          makeError({ message: `Command ${frontEnd} exited with code 1` }),
        )).toBe(false);
      },
    );
  });

  describe('Boundaries', () => {
    it.each([
      'Command pkexec exited with code 1267',
      'Command pkexec exited with code 12',
      'Command pkexec exited with code 26',
      'Command pkexec exited with code 1126',
    ])('does not match %s', (message) => {
      expect(isElevationDeniedError(makeError({ message }))).toBe(false);
    });

    it('does not match a front-end name that merely starts the same way', () => {
      expect(isElevationDeniedError(
        makeError({ message: 'Command pkexecutor exited with code 126' }),
      )).toBe(false);
    });

    it('tolerates an empty message', () => {
      expect(isElevationDeniedError(makeError({}))).toBe(false);
    });

    // The pattern is unanchored on purpose. Nothing wraps this message today,
    // but a future upstream reword that adds a prefix must not silently disarm
    // the filter, which is the DESKTOP-F failure mode.
    it('survives a hypothetical upstream prefix and suffix', () => {
      expect(isElevationDeniedError(makeError({
        message: 'Install failed: Command pkexec exited with code 126 (stderr: ...)',
      }))).toBe(true);
    });
  });

  describe('Precedence against the other two classifiers', () => {
    const desktopR = makeError({ message: 'Command pkexec exited with code 126' });

    it('is the only classifier that claims it, so the Aptabase count survives', () => {
      // isTransientUpdaterError returns ABOVE trackEvent, so if it matched, the
      // "how often is an update declined" volume view would silently vanish.
      expect(isTransientUpdaterError(desktopR)).toBe(false);
      expect(hasTransientNetworkCause(desktopR)).toBe(false);
      expect(isElevationDeniedError(desktopR)).toBe(true);
    });

    it('does not claim a transient feed failure', () => {
      expect(isElevationDeniedError(makeError({ message: DESKTOP_F_MESSAGE }))).toBe(false);
    });
  });
});

/**
 * isElevationDeniedError matches a third-party message template by hand, so it
 * goes quietly blind if electron-updater rewords that template or grows a new
 * sudo front-end. Every hand-written test above would stay green through either
 * change. These two read the installed package and fail instead, which is the
 * same trap the DESKTOP-F fix documented and the reason that fix drives the real
 * builder-util-runtime above.
 */
describe('against the installed electron-updater source', () => {
  const updaterOutDir = path.dirname(requireFromTest.resolve('electron-updater'));

  it('still throws the message template the pattern matches', () => {
    const baseUpdaterSource = fs.readFileSync(
      path.join(updaterOutDir, 'BaseUpdater.js'),
      'utf-8',
    );
    expect(baseUpdaterSource).toContain('`Command ${cmd} exited with code ${status}`');
  });

  it('still probes exactly the four sudo front-ends the pattern names', () => {
    const linuxUpdaterSource = fs.readFileSync(
      path.join(updaterOutDir, 'LinuxUpdater.js'),
      'utf-8',
    );
    const sudoListMatch = /const sudos = \[([^\]]*)\]/.exec(linuxUpdaterSource);
    expect(sudoListMatch).not.toBeNull();

    // Match each name independently rather than the bracketed literal: a patch
    // bump can reformat the array with no semantic change, and a literal match
    // would go red for nothing. The length assertion is what still catches a
    // fifth front-end being added.
    const probedFrontEnds = (sudoListMatch as RegExpExecArray)[1]
      .split(',')
      .map((entry) => entry.trim().replace(/^["']|["']$/g, ''))
      .filter((entry) => entry.length > 0);
    expect(probedFrontEnds).toHaveLength(4);
    for (const frontEnd of ['gksudo', 'kdesudo', 'pkexec', 'beesu']) {
      expect(probedFrontEnds).toContain(frontEnd);
    }
    // Plus the fallback when none of the four is on PATH. Quote-agnostic for
    // the same reason as above: the compiled output's quote style is not a
    // semantic change.
    expect(linuxUpdaterSource).toMatch(/return ['"]sudo['"]/);
  });
});
