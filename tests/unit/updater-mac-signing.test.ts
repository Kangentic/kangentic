/**
 * The running bundle's signing, as the DESKTOP-2R report tags it. Squirrel.Mac
 * refuses an update whose signature does not satisfy the RUNNING copy's
 * designated requirement, so what the running copy is signed with is what tells
 * a damaged or re-signed install apart from a release signed by the wrong team.
 *
 * `codesign -dv` writes its display to STDERR, so every stub here resolves an
 * empty stdout and puts the text in stderr. A stub that used stdout would pass
 * against a reader that reads the wrong stream.
 *
 * Tier: Unit.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  bundlePathFromExecutable,
  classifyCodesignDisplay,
  readRunningAppSigning,
  type CodesignExec,
} from '../../src/main/updater-mac-signing';

const OUR_TEAM = 'AF8KY83RAF';
const BUNDLE = '/Applications/Kangentic.app';

/** The lines of `codesign -dv` the classifier reads, around the ones it does not. */
function display(signatureLines: string[]): string {
  return [
    `Executable=${BUNDLE}/Contents/MacOS/Kangentic`,
    'Identifier=com.kangentic.app',
    'Format=app bundle with Mach-O thin (arm64)',
    'CodeDirectory v=20500 size=1234 flags=0x10000(runtime) hashes=27+7 location=embedded',
    ...signatureLines,
    'Sealed Resources version=2 rules=13 files=200',
  ].join('\n');
}

function resolvingExec(stderr: string): CodesignExec {
  return vi.fn(async () => ({ stdout: '', stderr }));
}

function rejectingExec(stderr?: string): CodesignExec {
  return vi.fn(async () => {
    const failure = new Error('Command failed: /usr/bin/codesign -dv') as Error & { stderr?: string; code?: number };
    failure.code = 1;
    if (stderr !== undefined) failure.stderr = stderr;
    throw failure;
  });
}

describe('readRunningAppSigning', () => {
  it('reads an ad-hoc copy as adhoc, though it also prints TeamIdentifier=not set', async () => {
    const exec = resolvingExec(display(['Signature=adhoc', 'TeamIdentifier=not set']));
    expect(await readRunningAppSigning(BUNDLE, OUR_TEAM, exec, 'darwin')).toBe('adhoc');
  });

  it('reads our own Developer ID signature as our-team', async () => {
    const exec = resolvingExec(display([
      'Signature size=9000',
      'Authority=Developer ID Application: Example (AF8KY83RAF)',
      'Timestamp=Nov 10, 2026 at 09:00:00',
      `TeamIdentifier=${OUR_TEAM}`,
    ]));
    expect(await readRunningAppSigning(BUNDLE, OUR_TEAM, exec, 'darwin')).toBe('our-team');
  });

  it('reads any other team as other-team', async () => {
    const exec = resolvingExec(display(['Signature size=9000', 'TeamIdentifier=ZZZZZZZZZZ']));
    expect(await readRunningAppSigning(BUNDLE, OUR_TEAM, exec, 'darwin')).toBe('other-team');
  });

  it('reads an unsigned bundle as unsigned, from the rejection stderr', async () => {
    const exec = rejectingExec(`${BUNDLE}: code object is not signed at all`);
    expect(await readRunningAppSigning(BUNDLE, OUR_TEAM, exec, 'darwin')).toBe('unsigned');
  });

  it('reads any other failure as unreadable', async () => {
    expect(await readRunningAppSigning(BUNDLE, OUR_TEAM, rejectingExec(), 'darwin')).toBe('unreadable');
    expect(await readRunningAppSigning(BUNDLE, OUR_TEAM, rejectingExec('bundle format unrecognized'), 'darwin'))
      .toBe('unreadable');
  });

  it('reads a display it cannot place as unreadable', async () => {
    expect(await readRunningAppSigning(BUNDLE, OUR_TEAM, resolvingExec(''), 'darwin')).toBe('unreadable');
  });

  it('asks codesign about the bundle, by its absolute path, with a timeout', async () => {
    const exec = resolvingExec(display(['Signature=adhoc']));
    await readRunningAppSigning(BUNDLE, OUR_TEAM, exec, 'darwin');
    expect(exec).toHaveBeenCalledWith('/usr/bin/codesign', ['-dv', BUNDLE], expect.objectContaining({
      timeout: expect.any(Number),
    }));
  });

  it.each(['win32', 'linux'] as const)('runs nothing on %s', async (platform) => {
    const exec = resolvingExec(display(['Signature=adhoc']));
    expect(await readRunningAppSigning(BUNDLE, OUR_TEAM, exec, platform)).toBe('unreadable');
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('classifyCodesignDisplay', () => {
  it('needs the whole team id, not a prefix of it', () => {
    expect(classifyCodesignDisplay('TeamIdentifier=AF8KY83RAFX', OUR_TEAM)).toBe('other-team');
  });
});

describe('bundlePathFromExecutable', () => {
  it('climbs from Contents/MacOS/<exe> to the .app', () => {
    expect(bundlePathFromExecutable('/Applications/Kangentic.app/Contents/MacOS/Kangentic'))
      .toBe('/Applications/Kangentic.app');
    expect(bundlePathFromExecutable('/Users/dev/Applications/Kangentic.app/Contents/MacOS/Kangentic'))
      .toBe('/Users/dev/Applications/Kangentic.app');
  });
});
