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
  isReadOnlyVolumeError,
  isPackageManagerMissingError,
  isResourceUnavailableError,
  isPrereleaseWithNoMatchingRelease,
  isSignatureRequirementError,
  signatureRequirementReport,
  stripUrlQueries,
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

/**
 * DESKTOP-1A, copied verbatim from the Sentry event rather than trimmed to the
 * sentence the pattern matches. Squirrel.Mac appends a recovery suggestion, and
 * keeping it here is what proves the predicate survives that tail.
 */
const DESKTOP_1A_MESSAGE = [
  'Cannot update while running on a read-only volume.',
  ' The application is on a read-only volume.',
  ' Please move the application and try again.',
  " If you're on macOS Sierra or later, you'll need to move the application",
  ' out of the Downloads directory.',
  ' See https://github.com/Squirrel/Squirrel.Mac/issues/182 for more information.',
].join('');

/**
 * DESKTOP-1B, verbatim. The apostrophe is U+2019, which is exactly why the
 * predicate matches the strerror half and not this NSError boilerplate: a
 * fixture may carry the character, a source pattern should not have to.
 */
const DESKTOP_1B_MESSAGE =
  'The operation couldn’t be completed. Resource temporarily unavailable';

/** DESKTOP-R's no-package-manager event, verbatim. DebUpdater writes exactly this. */
const PACKAGE_MANAGER_MISSING_MESSAGE =
  'Neither dpkg nor apt command found. Cannot install .deb package.';

/** DESKTOP-17, verbatim. The provider writes exactly this, with no detail. */
const DESKTOP_17_MESSAGE = 'No published versions on GitHub';

/**
 * DESKTOP-2R, from the Sentry event with the home directory put back as a
 * placeholder (the app had already rewritten it to `~`). `update.<random>` is
 * ShipIt's staging folder, new on every attempt, which is what split one
 * failure into DESKTOP-2R and DESKTOP-2T.
 */
const signatureRequirementMessage = (stagingFolder: string): string =>
  `Code signature at URL file:///Users/dev/Library/Caches/com.kangentic.app.ShipIt/${stagingFolder}/Kangentic.app/`
  + ' did not pass validation: code failed to satisfy specified code requirement(s)';
const DESKTOP_2R_MESSAGE = signatureRequirementMessage('update.1VC5jWG');

/** The release DESKTOP-17 arrived from, prerelease component and all. */
const PRERELEASE_VERSION = '0.41.0-dev.1';

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

  /**
   * DESKTOP-24. `doDownload` hands its callback a plain Error, so the HTTP_ERROR_ cases above
   * only pass because they set a code by hand: a real download failure has none,
   * and these go through the message. The URL is a placeholder.
   */
  describe('A download failure, which carries no code', () => {
    const downloadFailure = (status: number): Error => makeError({
      message: `Cannot download "https://assets.example.test/app.zip?sig=fake&jwt=fake", status ${status}: Status text`,
    });

    it.each([618, 500, 502, 503, 504, 408, 429])('classifies status %s as transient', (status) => {
      const error = downloadFailure(status);
      expect((error as NodeJS.ErrnoException).code).toBeUndefined();
      expect(isTransientUpdaterError(error)).toBe(true);
    });

    it.each([400, 401, 403, 404, 410])('keeps status %s loud', (status) => {
      expect(isTransientUpdaterError(downloadFailure(status))).toBe(false);
    });

    it('does not read a status out of the URL itself', () => {
      const error = makeError({
        message: 'Cannot download "https://assets.example.test/status 503:/app.zip", status 404: Not Found',
      });
      expect(isTransientUpdaterError(error)).toBe(false);
    });

    it('does not claim another sentence that ends in the same status', () => {
      expect(isTransientUpdaterError(makeError({ message: 'Unexpected status 503: Busy' }))).toBe(false);
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

describe('stripUrlQueries', () => {
  it('removes a signed query and keeps the host, the path and the rest of the sentence', () => {
    expect(stripUrlQueries(
      'Cannot download "https://assets.example.test/1/app.zip?sp=r&sig=fake%2Bvalue&jwt=a.b.c", status 403: Forbidden',
    )).toBe('Cannot download "https://assets.example.test/1/app.zip", status 403: Forbidden');
  });

  it('removes a fragment, and handles every URL in the text', () => {
    expect(stripUrlQueries('from http://a.example.test/x#token to https://b.example.test/y?q=1 done'))
      .toBe('from http://a.example.test/x to https://b.example.test/y done');
  });

  it('stops at a single quote too', () => {
    expect(stripUrlQueries("open 'https://a.example.test/x?sig=fake' failed"))
      .toBe("open 'https://a.example.test/x' failed");
  });

  it('leaves text with no URL query unchanged', () => {
    for (const text of ['Is this a question? Yes', 'https://a.example.test/x', 'status 618: expired', '']) {
      expect(stripUrlQueries(text)).toBe(text);
    }
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

    // This predicate leaves all three alone. isPackageManagerMissingError, a later
    // gate in the handler, takes the first, so that one is not filed to Sentry.
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

describe('isReadOnlyVolumeError', () => {
  it('matches the production DESKTOP-1A message', () => {
    expect(isReadOnlyVolumeError(makeError({ message: DESKTOP_1A_MESSAGE }))).toBe(true);
  });

  it('matches the leading sentence without the recovery suggestion', () => {
    // Squirrel's tail names Downloads, Sierra and a URL, none of which
    // identifies the condition. Losing it must not lose the match.
    expect(isReadOnlyVolumeError(makeError({
      message: 'Cannot update while running on a read-only volume.',
    }))).toBe(true);
  });

  it('needs no code, since the error arrives from Squirrel with none', () => {
    const error = makeError({ message: DESKTOP_1A_MESSAGE });
    expect((error as NodeJS.ErrnoException).code).toBeUndefined();
    expect(isReadOnlyVolumeError(error)).toBe(true);
  });

  it.each([
    ['a genuine install failure', 'Command pkexec exited with code 1'],
    ['a read-only DATA directory, which is a different bug', 'EROFS: read-only file system'],
    ['an empty message', ''],
  ])('does not claim %s', (_label, message) => {
    expect(isReadOnlyVolumeError(makeError({ message }))).toBe(false);
  });

  it('does not claim the other two new conditions', () => {
    expect(isReadOnlyVolumeError(makeError({ message: DESKTOP_1B_MESSAGE }))).toBe(false);
    expect(isReadOnlyVolumeError(makeError({ message: DESKTOP_17_MESSAGE }))).toBe(false);
  });

  it('is not claimed by the classifiers that already ran', () => {
    // The gate order only holds if the earlier predicates pass this through.
    const error = makeError({ message: DESKTOP_1A_MESSAGE });
    expect(isTransientUpdaterError(error)).toBe(false);
    expect(hasTransientNetworkCause(error)).toBe(false);
    expect(isElevationDeniedError(error)).toBe(false);
  });
});

describe('isPackageManagerMissingError', () => {
  it('matches the production message, which has no code', () => {
    const error = makeError({ message: PACKAGE_MANAGER_MISSING_MESSAGE });
    expect((error as NodeJS.ErrnoException).code).toBeUndefined();
    expect(isPackageManagerMissingError(error)).toBe(true);
  });

  it('survives a hypothetical upstream prefix and suffix', () => {
    expect(isPackageManagerMissingError(makeError({
      message: `Install failed: ${PACKAGE_MANAGER_MISSING_MESSAGE} (see log)`,
    }))).toBe(true);
  });

  it.each([
    ['a package manager that ran and failed', 'Command dpkg exited with code 1'],
    ['a denied elevation prompt', 'Command pkexec exited with code 126'],
    ['a missing installer file', "No update filepath provided, can't quit and install"],
    ['an empty message', ''],
  ])('does not claim %s', (_label, message) => {
    expect(isPackageManagerMissingError(makeError({ message }))).toBe(false);
  });

  it('is not claimed by any classifier that runs before or beside it', () => {
    // isTransientUpdaterError sits above trackEvent, so a match there would
    // delete the count. The others would take the toast with them.
    const error = makeError({ message: PACKAGE_MANAGER_MISSING_MESSAGE });
    expect(isTransientUpdaterError(error)).toBe(false);
    expect(hasTransientNetworkCause(error)).toBe(false);
    expect(isElevationDeniedError(error)).toBe(false);
    expect(isReadOnlyVolumeError(error)).toBe(false);
  });
});

describe('isResourceUnavailableError', () => {
  it('matches the production DESKTOP-1B message', () => {
    expect(isResourceUnavailableError(makeError({ message: DESKTOP_1B_MESSAGE }))).toBe(true);
  });

  it('matches on the strerror half alone, with no NSError boilerplate', () => {
    expect(isResourceUnavailableError(makeError({
      message: 'Resource temporarily unavailable',
    }))).toBe(true);
  });

  it('does not depend on the U+2019 apostrophe', () => {
    // The whole reason the pattern ignores the first sentence: macOS could
    // render it with a straight quote, or localize it away entirely.
    expect(isResourceUnavailableError(makeError({
      message: "The operation couldn't be completed. Resource temporarily unavailable",
    }))).toBe(true);
  });

  it.each([
    ['a different NSError with the same boilerplate', 'The operation couldn’t be completed. No such file or directory'],
    ['an empty message', ''],
  ])('does not claim %s', (_label, message) => {
    expect(isResourceUnavailableError(makeError({ message }))).toBe(false);
  });

  it('does not claim the other two new conditions', () => {
    expect(isResourceUnavailableError(makeError({ message: DESKTOP_1A_MESSAGE }))).toBe(false);
    expect(isResourceUnavailableError(makeError({ message: DESKTOP_17_MESSAGE }))).toBe(false);
  });

  it('is not claimed by the classifiers that already ran', () => {
    const error = makeError({ message: DESKTOP_1B_MESSAGE });
    expect(isTransientUpdaterError(error)).toBe(false);
    expect(hasTransientNetworkCause(error)).toBe(false);
    expect(isElevationDeniedError(error)).toBe(false);
  });
});

describe('isSignatureRequirementError', () => {
  it('matches the production DESKTOP-2R message, which has no code', () => {
    const error = makeError({ message: DESKTOP_2R_MESSAGE });
    expect((error as NodeJS.ErrnoException).code).toBeUndefined();
    expect(isSignatureRequirementError(error)).toBe(true);
  });

  it('survives a hypothetical prefix and suffix', () => {
    expect(isSignatureRequirementError(makeError({
      message: `Error: ${DESKTOP_2R_MESSAGE} (errSecCSReqFailed)`,
    }))).toBe(true);
  });

  it.each([
    ['a read-only volume', DESKTOP_1A_MESSAGE],
    ['an EAGAIN', DESKTOP_1B_MESSAGE],
    ['a missing package manager', PACKAGE_MANAGER_MISSING_MESSAGE],
    ['an unrelated signature failure', 'ERR_UPDATER_INVALID_SIGNATURE'],
    ['an empty message', ''],
  ])('does not claim %s', (_label, message) => {
    expect(isSignatureRequirementError(makeError({ message }))).toBe(false);
  });

  it('is not claimed by any classifier that runs before or beside it', () => {
    // The gate stays reported, so a classifier above it that matched would
    // silently turn a possible bad release into a count.
    const error = makeError({ message: DESKTOP_2R_MESSAGE });
    expect(isTransientUpdaterError(error)).toBe(false);
    expect(hasTransientNetworkCause(error)).toBe(false);
    expect(isElevationDeniedError(error)).toBe(false);
    expect(isReadOnlyVolumeError(error)).toBe(false);
    expect(isPackageManagerMissingError(error)).toBe(false);
    expect(isResourceUnavailableError(error)).toBe(false);
  });
});

describe('signatureRequirementReport', () => {
  it('gives two attempts that differ only in the staging folder one fingerprint and one message', () => {
    const first = signatureRequirementReport(makeError({ message: signatureRequirementMessage('update.1VC5jWG') }));
    const second = signatureRequirementReport(makeError({ message: signatureRequirementMessage('update.Qz8pLr2') }));

    expect(first.fingerprint).toEqual(second.fingerprint);
    expect(first.error.message).toBe(second.error.message);
    expect(first.error.message).not.toContain('1VC5jWG');
    expect(first.error.message).toContain('com.kangentic.app.ShipIt/update.<staging>/Kangentic.app/');
    expect(first.error.message).toContain('code failed to satisfy specified code requirement(s)');
  });

  it('scrubs the staging folder from the stack too', () => {
    const error = makeError({ message: DESKTOP_2R_MESSAGE });
    error.stack = `Error: ${DESKTOP_2R_MESSAGE}`;
    const report = signatureRequirementReport(error);
    expect(report.error.stack).not.toContain('1VC5jWG');
  });

  // Squirrel's code -1 and the error name group the Sentry issue; losing them splits or mislabels it.
  it('keeps the error name and a numeric code on the scrubbed copy', () => {
    const error = new Error(DESKTOP_2R_MESSAGE) as Error & { code?: number };
    error.name = 'SquirrelError';
    error.code = -1;
    const report = signatureRequirementReport(error);
    expect(report.error.name).toBe('SquirrelError');
    expect((report.error as { code?: number }).code).toBe(-1);
  });

  // A signed download URL token in the report would leak a credential to Sentry.
  it('strips a URL query from the message', () => {
    const error = makeError({
      message: `${DESKTOP_2R_MESSAGE} (from https://example.com/Kangentic.zip?token=SECRET123)`,
    });
    const report = signatureRequirementReport(error);
    expect(report.error.message).not.toContain('SECRET123');
    expect(report.error.message).toContain('https://example.com/Kangentic.zip');
  });

  it('leaves the error upstream emitted as it was', () => {
    const error = makeError({ message: DESKTOP_2R_MESSAGE });
    signatureRequirementReport(error);
    expect(error.message).toBe(DESKTOP_2R_MESSAGE);
  });
});

describe('isPrereleaseWithNoMatchingRelease', () => {
  it('matches the production DESKTOP-17 error, by code', () => {
    expect(isPrereleaseWithNoMatchingRelease(
      makeError({ code: 'ERR_UPDATER_NO_PUBLISHED_VERSIONS', message: DESKTOP_17_MESSAGE }),
      PRERELEASE_VERSION,
    )).toBe(true);
  });

  it('matches by phrase when the code is lost between the throw and the emit', () => {
    // The disjunction exists so the predicate cannot go blind in production
    // while every test that sets `code` by hand keeps passing.
    expect(isPrereleaseWithNoMatchingRelease(
      makeError({ message: DESKTOP_17_MESSAGE }),
      PRERELEASE_VERSION,
    )).toBe(true);
  });

  it.each([
    '0.41.0-dev.1',
    '0.42.0-alpha.3',
    '1.0.0-beta',
    '0.41.0-0',
  ])('treats %s as a prerelease build', (version) => {
    expect(isPrereleaseWithNoMatchingRelease(
      makeError({ code: 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' }),
      version,
    )).toBe(true);
  });

  /**
   * The conjunct's whole reason for existing. GitHubProvider throws this same
   * sentence from two places: the tag-is-null throw, which carries the code and
   * needs allowPrerelease, and the feed's own entry lookup, which throws it
   * codeless when the Atom feed has no entries at all. On a stable build the
   * second means our releases feed is empty, which is a real failure. Drop the
   * version check and that failure disappears from the issue stream with it.
   */
  describe('a STABLE build seeing the same error still reports', () => {
    it.each([
      ['0.42.0', 'a plain release'],
      ['1.0.0', 'a major'],
      ['0.42.0+build.7', 'build metadata, which is not a prerelease'],
    ])('%s (%s)', (version) => {
      expect(isPrereleaseWithNoMatchingRelease(
        makeError({ code: 'ERR_UPDATER_NO_PUBLISHED_VERSIONS', message: DESKTOP_17_MESSAGE }),
        version,
      )).toBe(false);
      expect(isPrereleaseWithNoMatchingRelease(
        makeError({ message: DESKTOP_17_MESSAGE }),
        version,
      )).toBe(false);
    });
  });

  it('does not claim an unrelated failure just because the build is prerelease', () => {
    expect(isPrereleaseWithNoMatchingRelease(
      makeError({ code: 'ERR_UPDATER_INVALID_RELEASE_FEED', message: DESKTOP_F_MESSAGE }),
      PRERELEASE_VERSION,
    )).toBe(false);
  });

  it('does not claim the other two new conditions', () => {
    expect(isPrereleaseWithNoMatchingRelease(
      makeError({ message: DESKTOP_1A_MESSAGE }), PRERELEASE_VERSION,
    )).toBe(false);
    expect(isPrereleaseWithNoMatchingRelease(
      makeError({ message: DESKTOP_1B_MESSAGE }), PRERELEASE_VERSION,
    )).toBe(false);
  });

  it('is not claimed by the classifiers that already ran', () => {
    const error = makeError({
      code: 'ERR_UPDATER_NO_PUBLISHED_VERSIONS',
      message: DESKTOP_17_MESSAGE,
    });
    expect(isTransientUpdaterError(error)).toBe(false);
    // Worth pinning rather than assuming: the message says "on GitHub", which
    // is a near miss for FEED_WRAPPER_PHRASES' "latest version on GitHub".
    expect(hasTransientNetworkCause(error)).toBe(false);
    expect(isElevationDeniedError(error)).toBe(false);
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

  it('still dispatches the one DebUpdater message the missing-package-manager gate matches', () => {
    // Runs the predicate over every message DebUpdater dispatches rather than
    // comparing a typed copy, so a reword upstream and a drifted pattern here
    // both fail, and so does a pattern that starts claiming a sibling message.
    const debUpdaterSource = fs.readFileSync(
      path.join(updaterOutDir, 'DebUpdater.js'),
      'utf-8',
    );
    const dispatchedMessages = [
      ...debUpdaterSource.matchAll(/this\.dispatchError\(new Error\((["'`])(.*?)\1\)\)/g),
    ].map((match) => match[2]);

    expect(dispatchedMessages.length).toBeGreaterThan(1);
    expect(dispatchedMessages.filter(
      (message) => isPackageManagerMissingError(makeError({ message })),
    )).toHaveLength(1);
  });

  it('still throws the no-published-versions error the DESKTOP-17 gate matches', () => {
    const gitHubProviderSource = fs.readFileSync(
      path.join(updaterOutDir, 'providers', 'GitHubProvider.js'),
      'utf-8',
    );
    // Both throw sites, because the predicate's prerelease conjunct exists
    // precisely to tell them apart. If either is reworded or the code is
    // renamed, the gate goes blind and this goes red instead.
    expect(gitHubProviderSource).toContain('No published versions on GitHub');
    expect(gitHubProviderSource).toContain('ERR_UPDATER_NO_PUBLISHED_VERSIONS');
  });

  /**
   * The DESKTOP-24 gate matches doDownload's message by hand because that throw
   * has no code. Upstream may fix that (electron-builder#10548) or reword it, and
   * either would leave the gate quietly blind, which is how this bug started: the
   * HTTP_ERROR_ branch looked covered and could never match a download. So this
   * renders the REAL template and runs the predicate on the result. Resolved from
   * electron-updater's own directory, because that is the copy it loads.
   */
  describe('doDownload, in the builder-util-runtime electron-updater loads', () => {
    const runtimeRequire = createRequire(requireFromTest.resolve('electron-updater'));
    const httpExecutorSource = fs.readFileSync(
      path.join(path.dirname(runtimeRequire.resolve('builder-util-runtime')), 'httpExecutor.js'),
      'utf-8',
    );
    const templateMatch = /options\.callback\(new Error\(`(Cannot download [^`]*)`\)\)/.exec(httpExecutorSource);

    const renderedMessage = (statusCode: number): string => (templateMatch as RegExpExecArray)[1]
      .replace('${requestOptions.protocol || "https:"}', 'https:')
      .replace('${requestOptions.hostname}', 'assets.example.test')
      .replace('${requestOptions.path}', '/app.zip?sig=fake&jwt=fake')
      .replace('${response.statusCode}', String(statusCode))
      .replace('${response.statusMessage}', 'Status text');

    it('still hands its callback a plain Error, so there is no code for the HTTP_ERROR_ branch to read', () => {
      expect(templateMatch).not.toBeNull();
    });

    it('renders with no placeholder left, so the fixture below is the real text', () => {
      expect(renderedMessage(618)).not.toContain('${');
    });

    it.each([618, 503])('is transient at status %s through the real template', (statusCode) => {
      expect(isTransientUpdaterError(makeError({ message: renderedMessage(statusCode) }))).toBe(true);
    });

    it.each([403, 404])('stays loud at status %s through the real template', (statusCode) => {
      expect(isTransientUpdaterError(makeError({ message: renderedMessage(statusCode) }))).toBe(false);
    });

    it('carries the query in the text that the updater reports, which is why stripUrlQueries exists', () => {
      const message = renderedMessage(403);
      expect(message).toContain('sig=fake');
      expect(stripUrlQueries(message)).not.toContain('sig=');
      expect(stripUrlQueries(message)).toContain('https://assets.example.test/app.zip"');
    });
  });

  it('still logs an emitted error through its own logger, which is the breadcrumb route', () => {
    // updaterLogger has to strip a URL query because of this listener: it runs
    // ahead of ours and writes the whole stack. If it goes, the strip in
    // tagUpdaterLine is only guarding the Cannot download differentially lines.
    const appUpdaterSource = fs.readFileSync(
      path.join(updaterOutDir, 'AppUpdater.js'),
      'utf-8',
    );
    expect(appUpdaterSource).toContain('this._logger.error(`Error: ${error.stack || error.message}`)');
  });

  it('still derives allowPrerelease from the running version', () => {
    // The predicate reads the app's own version as a proxy for the branch
    // GitHubProvider will take. That proxy holds only while AppUpdater keeps
    // setting allowPrerelease from the current version's prerelease
    // components; if upstream makes it an explicit option instead, a stable
    // build could reach the coded throw and the conjunct would wrongly
    // suppress it.
    const appUpdaterSource = fs.readFileSync(
      path.join(updaterOutDir, 'AppUpdater.js'),
      'utf-8',
    );
    expect(appUpdaterSource).toMatch(
      /this\.allowPrerelease = hasPrereleaseComponents\(currentVersion\)/,
    );
  });
});

/**
 * The three macOS predicates get no such guard, and this names that rather than
 * leaving it to read as an oversight.
 *
 * isReadOnlyVolumeError, isResourceUnavailableError and
 * isSignatureRequirementError all match strings that have no source in
 * node_modules to read. Squirrel.Mac is compiled into Electron's framework
 * binary, `Resource temporarily unavailable` is macOS's own strerror text
 * reached through NSError, and errSecCSReqFailed's text is the Security
 * framework's. There is nothing on disk for a drift test to assert against, so
 * an upstream reword would go unnoticed until the issue reappeared in Sentry.
 * Accepted: the errors arrive with no code, no cause and no stack, so a reword
 * costs a rediscovery rather than a regression. For the first two the failure
 * mode is an issue coming back. For the signature one it is the scattered,
 * per-attempt issues coming back, still reported.
 */
describe('the macOS predicates have no upstream source to pin', () => {
  const macUpdaterSource = fs.readFileSync(
    path.join(path.dirname(requireFromTest.resolve('electron-updater')), 'MacUpdater.js'),
    'utf-8',
  );

  it('confirms electron-updater only forwards them, so nothing here throws them', () => {
    // The forward itself IS assertable, and it is what makes these errors
    // reach our handler at all. If MacUpdater stops re-emitting the native
    // updater's errors, all three gates become dead code.
    expect(macUpdaterSource).toMatch(/nativeUpdater\.on\(["']error["']/);
    expect(macUpdaterSource).not.toContain('read-only volume');
    expect(macUpdaterSource).not.toContain('Resource temporarily unavailable');
    expect(macUpdaterSource).not.toContain('code failed to satisfy specified code requirement');
  });

  /**
   * The read-only error arrives on the DOWNLOAD path, and gate 1 of our error
   * handler swallows anything that lands while a retry is in flight. It only
   * escapes because the forward is registered in MacUpdater's CONSTRUCTOR,
   * while the `once("error", reject)` that eventually sets our downloadRetrying
   * flag is registered later, inside doDownloadUpdate. Constructor-first means
   * our listener runs on the emit, before the rejection has propagated.
   *
   * The wiring test in updater-retry.test.ts hand-writes emit-then-reject, so
   * it proves our handler behaves correctly GIVEN that order. This is the half
   * that checks the order is upstream's and not our assumption about it.
   */
  it('registers its error forward in the constructor, before doDownloadUpdate reject', () => {
    const forwardIndex = macUpdaterSource.search(/nativeUpdater\.on\(["']error["']/);
    const downloadIndex = macUpdaterSource.indexOf('async doDownloadUpdate');
    const rejectIndex = macUpdaterSource.search(/nativeUpdater\.once\(["']error["']/);

    expect(forwardIndex).toBeGreaterThan(-1);
    expect(downloadIndex).toBeGreaterThan(-1);
    expect(rejectIndex).toBeGreaterThan(-1);
    // Constructor body precedes the method, and the method precedes its own
    // once(). Both orderings are what make the forward win the first emit.
    expect(forwardIndex).toBeLessThan(downloadIndex);
    expect(downloadIndex).toBeLessThan(rejectIndex);
  });
});
