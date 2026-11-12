const { spawnSync } = require('child_process');

/**
 * The release check behind src/shared/apple-team-id.json.
 *
 * The app compares its own signature against that committed Team ID to tag a
 * Squirrel.Mac signature refusal (DESKTOP-2R): `our-team` points at the
 * release's signing, anything else at a modified copy. A stale value would
 * quietly label every copy as another team's, so a macOS leg that holds the
 * APPLE_TEAM_ID secret fails here instead, before notarization and upload.
 *
 * A build without the secret (a contributor signing with their own identity)
 * says it skipped and why. It runs from build/afterSign.js, which
 * electron-builder calls only when it signed.
 */

/** The same line src/main/updater-mac-signing.ts reads at runtime; change both together. */
const TEAM_IDENTIFIER_PATTERN = /^TeamIdentifier=(.+)$/m;
/** A hung codesign fails the leg instead of holding it to the job limit. */
const CODESIGN_TIMEOUT_MS = 60_000;

/** The TeamIdentifier `codesign -dv` printed, or null when there is none. */
function signedTeamIdentifier(display) {
  const match = TEAM_IDENTIFIER_PATTERN.exec(display);
  if (!match) return null;
  const teamIdentifier = match[1].trim();
  return teamIdentifier === 'not set' ? null : teamIdentifier;
}

/** `codesign -dv` writes its display to stderr. */
function readCodesignDisplayFromDisk(appPath) {
  const result = spawnSync('/usr/bin/codesign', ['-dv', appPath], { encoding: 'utf8', timeout: CODESIGN_TIMEOUT_MS });
  if (result.error) throw result.error;
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function verifySignedTeamId({
  appPath,
  expectedTeamId,
  env = process.env,
  readCodesignDisplay = readCodesignDisplayFromDisk,
  log = console.log,
}) {
  const secretTeamId = env.APPLE_TEAM_ID;
  if (!secretTeamId) {
    log('[afterSign] Team ID check skipped: APPLE_TEAM_ID not set (not a release build).');
    return;
  }
  if (secretTeamId !== expectedTeamId) {
    throw new Error(
      `[afterSign] APPLE_TEAM_ID (${secretTeamId}) does not match src/shared/apple-team-id.json (${expectedTeamId}). `
      + 'Update the file to the team that signs releases, or the app will tag its own signature as another team.',
    );
  }
  const signedTeamId = signedTeamIdentifier(readCodesignDisplay(appPath));
  if (signedTeamId !== expectedTeamId) {
    throw new Error(
      `[afterSign] ${appPath} is signed by team ${signedTeamId ?? '(none)'}, expected ${expectedTeamId} `
      + 'from src/shared/apple-team-id.json.',
    );
  }
  log(`[afterSign] Team ID check passed: signed by ${signedTeamId}, matching src/shared/apple-team-id.json.`);
}

module.exports = { verifySignedTeamId, signedTeamIdentifier };
