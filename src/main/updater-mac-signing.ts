import * as path from 'path';
import { execFileAsync, type ExecOutput, type OffMainExecOptions } from './utility-process/off-main-exec';

/**
 * How the running app bundle is signed, as the DESKTOP-2R report tags it.
 *
 * Squirrel.Mac checks a downloaded update against the RUNNING copy's designated
 * requirement, so this is what separates the two causes of "code failed to
 * satisfy specified code requirement":
 * - `adhoc`, `unsigned`, `other-team`: this copy was re-signed or modified after
 *   it left us. An ad-hoc copy's requirement is its own cdhash, which no release
 *   can satisfy, so it can never update.
 * - `our-team`: the copy is ours, so suspect the release's signing identity.
 * - `unreadable`: codesign failed or said nothing this recognizes.
 *
 * A fixed set on purpose: a raw TeamIdentifier from someone else's re-sign may
 * be one person's individual team.
 */
export type RunningAppSigning = 'adhoc' | 'our-team' | 'other-team' | 'unsigned' | 'unreadable';

export type CodesignExec = (
  file: string,
  args: readonly string[],
  options: OffMainExecOptions,
) => Promise<ExecOutput>;

const CODESIGN_PATH = '/usr/bin/codesign';
const CODESIGN_TIMEOUT_MS = 5_000;
const TEAM_IDENTIFIER_PATTERN = /^TeamIdentifier=(.+)$/m;
const NOT_SIGNED_PATTERN = /code object is not signed at all/;

/**
 * Classify `codesign -dv` output. Ad-hoc is checked first because an ad-hoc
 * signature also prints `TeamIdentifier=not set`.
 */
export function classifyCodesignDisplay(display: string, ourTeamId: string): RunningAppSigning {
  if (/^Signature=adhoc$/m.test(display)) return 'adhoc';
  const teamMatch = TEAM_IDENTIFIER_PATTERN.exec(display);
  if (!teamMatch) return 'unreadable';
  const teamIdentifier = teamMatch[1].trim();
  if (teamIdentifier === 'not set') return 'unreadable';
  return teamIdentifier === ourTeamId ? 'our-team' : 'other-team';
}

/**
 * The `.app` bundle that holds the running executable, which sits at
 * `<bundle>/Contents/MacOS/<name>`. POSIX path rules, because this only ever
 * describes a macOS path, and the unit tests run on Windows too.
 */
export function bundlePathFromExecutable(executablePath: string): string {
  return path.posix.dirname(path.posix.dirname(path.posix.dirname(executablePath)));
}

/**
 * Read how the bundle at `bundlePath` is signed. Never rejects. `codesign -dv`
 * writes its display to stderr and exits non-zero on an unsigned bundle, so a
 * rejection is classified from the stderr the error carries.
 */
export async function readRunningAppSigning(
  bundlePath: string,
  ourTeamId: string,
  exec: CodesignExec = execFileAsync,
  platform: NodeJS.Platform = process.platform,
): Promise<RunningAppSigning> {
  if (platform !== 'darwin') return 'unreadable';
  try {
    const { stderr } = await exec(CODESIGN_PATH, ['-dv', bundlePath], { timeout: CODESIGN_TIMEOUT_MS });
    return classifyCodesignDisplay(stderr, ourTeamId);
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === 'string' && NOT_SIGNED_PATTERN.test(stderr)) return 'unsigned';
    return 'unreadable';
  }
}
