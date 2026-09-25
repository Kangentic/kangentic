/**
 * ensureSpawnHelperPermissions (src/main/pty/spawn/spawn-helper-permissions.ts):
 * on macOS, fixes node-pty's spawn-helper execute bit and warns on any other
 * stat/chmod failure.
 *
 * The warn line passes the caught error as its OWN console.warn argument
 * rather than interpolating it into the tagged template string. That is what
 * lets the Sentry breadcrumb policy (src/shared/sentry-breadcrumbs.ts) reduce
 * it to name and code instead of forwarding the error's free-text message,
 * which is not guaranteed to be path-shaped (redactPaths only catches text
 * that reads as a filesystem path). A prior version wrote `${error}` straight
 * into the template, which put the raw message inside the one piece of a kept
 * console crumb the policy never reduces (the tagged line itself). These
 * tests exercise the console.warn call this function makes and then feed
 * those exact arguments through the real filterBreadcrumb, the way Sentry's
 * console integration builds the crumb, to prove the sensitive text never
 * survives, and that it WOULD have survived under the old single-argument
 * shape (the regression guard at the bottom of this file).
 *
 * node-pty is a real dependency, so spawnHelperCandidatePaths() runs for
 * real here; only fs.statSync/fs.chmodSync are mocked.
 *
 * Tier: Unit.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const { statSyncMock, chmodSyncMock } = vi.hoisted(() => ({
  statSyncMock: vi.fn(),
  chmodSyncMock: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: { ...actual, statSync: statSyncMock, chmodSync: chmodSyncMock },
    statSync: statSyncMock,
    chmodSync: chmodSyncMock,
  };
});

import { ensureSpawnHelperPermissions } from '../../src/main/pty/spawn/spawn-helper-permissions';
import { filterBreadcrumb } from '../../src/shared/sentry-breadcrumbs';

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

// Deliberately NOT path-shaped, so redactPaths cannot mask it. This is what
// separates "the error rides as its own argument" from "redactPaths happens
// to catch it anyway": a real chmod/stat failure can carry free text that
// names a task or a project without ever looking like a path.
const SENSITIVE_TEXT = "fix the login redirect";

afterEach(() => {
  setPlatform(originalPlatform);
  statSyncMock.mockReset();
  chmodSyncMock.mockReset();
});

describe('ensureSpawnHelperPermissions', () => {
  it('never touches fs off macOS', () => {
    setPlatform('win32');

    ensureSpawnHelperPermissions();

    expect(statSyncMock).not.toHaveBeenCalled();
    expect(chmodSyncMock).not.toHaveBeenCalled();
  });

  it('chmods a candidate that lacks any execute bit', () => {
    setPlatform('darwin');
    statSyncMock.mockReturnValue({ mode: 0o644 });

    ensureSpawnHelperPermissions();

    expect(chmodSyncMock).toHaveBeenCalled();
    const [, mode] = chmodSyncMock.mock.calls[0] as [string, number];
    expect(mode & 0o111).not.toBe(0);
  });

  it('leaves an already-executable candidate alone', () => {
    setPlatform('darwin');
    statSyncMock.mockReturnValue({ mode: 0o755 });

    ensureSpawnHelperPermissions();

    expect(chmodSyncMock).not.toHaveBeenCalled();
  });

  it('quietly skips a missing candidate (ENOENT), warning about neither', () => {
    setPlatform('darwin');
    const missing = Object.assign(new Error('no such file'), { code: 'ENOENT' });
    statSyncMock.mockImplementation(() => {
      throw missing;
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      ensureSpawnHelperPermissions();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("passes a non-ENOENT stat failure as the error's own console.warn argument, and the breadcrumb policy reduces it without the free text", () => {
    setPlatform('darwin');
    const statError = Object.assign(
      new Error(`EACCES: permission denied while checking the helper for task '${SENSITIVE_TEXT}'`),
      { code: 'EACCES' },
    );
    statSyncMock.mockImplementation(() => {
      throw statError;
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      ensureSpawnHelperPermissions();

      expect(warnSpy).toHaveBeenCalled();
      const call = warnSpy.mock.calls[0];
      // The behavior under test: the error rides as its own argument rather
      // than being baked into the template string. A regression back to
      // `${error}` would fold the sensitive message into call[0] and leave
      // only one argument (see the regression guard below).
      expect(call).toHaveLength(2);
      expect(typeof call[0]).toBe('string');
      expect(call[0] as string).toMatch(/^\[APP\] spawn-helper permission fix failed for /);
      expect(call[0] as string).not.toContain(SENSITIVE_TEXT);
      expect(call[1]).toBe(statError);

      // Rebuild the crumb Sentry's console integration would record from
      // these exact arguments, and run it through the real policy.
      const kept = filterBreadcrumb({
        category: 'console',
        level: 'warn',
        message: call.map(String).join(' '),
        data: { arguments: call, logger: 'console' },
      });

      expect(kept).not.toBeNull();
      expect(kept?.message).toMatch(/Error\(EACCES\)$/);
      expect(kept?.message).not.toContain(SENSITIVE_TEXT);
      expect(JSON.stringify(kept)).not.toContain(SENSITIVE_TEXT);
    } finally {
      warnSpy.mockRestore();
    }
  });

  /**
   * A prior version of ensureSpawnHelperPermissions wrote
   * `console.warn(\`[APP] spawn-helper permission fix failed for ${filePath}: ${error}\`)`,
   * a single interpolated string rather than the error as its own argument.
   * This does not run that old code (the fix already landed); it instead
   * constructs the exact call shape the old code produced and proves that
   * filterBreadcrumb, unchanged, would have let the free text through. That
   * is what makes the assertions above a real regression guard rather than a
   * tautology: they fail against this shape and pass against the current one.
   */
  it('regression guard: the OLD single-argument call shape would have leaked the free text', () => {
    const oldStyleCall = [
      `[APP] spawn-helper permission fix failed for /Applications/Kangentic.app/spawn-helper: `
        + `Error: EACCES: permission denied while checking the helper for task '${SENSITIVE_TEXT}'`,
    ];

    expect(oldStyleCall).toHaveLength(1);

    const kept = filterBreadcrumb({
      category: 'console',
      level: 'warn',
      message: oldStyleCall.join(' '),
      data: { arguments: oldStyleCall, logger: 'console' },
    });

    expect(kept).not.toBeNull();
    // redactPaths runs on the tagged line either way, but it only rewrites
    // text shaped like a filesystem path. Free text embedded via template
    // interpolation survives it, which is the leak the fix closes.
    expect(kept?.message).toContain(SENSITIVE_TEXT);
  });
});
