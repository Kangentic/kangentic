/**
 * build/verify-signed-team-id.js - the release check that keeps the committed
 * Team ID (src/shared/apple-team-id.json) true. The app compares its own
 * signature against that file to tag DESKTOP-2R, so a stale value would quietly
 * mislabel every event as another team's. A release leg that holds the
 * APPLE_TEAM_ID secret fails instead.
 *
 * Tier: Unit.
 */
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { verifySignedTeamId, signedTeamIdentifier } = require('../../build/verify-signed-team-id.js') as {
  verifySignedTeamId: (options: {
    appPath: string;
    expectedTeamId: string;
    env: Record<string, string | undefined>;
    readCodesignDisplay: (appPath: string) => string;
    log?: (line: string) => void;
  }) => void;
  signedTeamIdentifier: (display: string) => string | null;
};
const committed = require('../../src/shared/apple-team-id.json') as { teamId: string };

const APP_PATH = '/tmp/mac-out/Kangentic.app';

function codesignShowing(teamId: string): (appPath: string) => string {
  return () => `Executable=${APP_PATH}/Contents/MacOS/Kangentic\nTeamIdentifier=${teamId}\nSealed Resources version=2`;
}

describe('verifySignedTeamId', () => {
  it('passes when the secret, the committed id and the signed app agree, and says so', () => {
    const log = vi.fn();
    verifySignedTeamId({
      appPath: APP_PATH,
      expectedTeamId: 'AF8KY83RAF',
      env: { APPLE_TEAM_ID: 'AF8KY83RAF' },
      readCodesignDisplay: codesignShowing('AF8KY83RAF'),
      log,
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('AF8KY83RAF'));
  });

  it('fails when the secret no longer matches the committed id', () => {
    expect(() => verifySignedTeamId({
      appPath: APP_PATH,
      expectedTeamId: 'AF8KY83RAF',
      env: { APPLE_TEAM_ID: 'ZZZZZZZZZZ' },
      readCodesignDisplay: codesignShowing('ZZZZZZZZZZ'),
      log: () => undefined,
    })).toThrow(/apple-team-id\.json/);
  });

  it('fails when the signed app carries another team', () => {
    expect(() => verifySignedTeamId({
      appPath: APP_PATH,
      expectedTeamId: 'AF8KY83RAF',
      env: { APPLE_TEAM_ID: 'AF8KY83RAF' },
      readCodesignDisplay: codesignShowing('ZZZZZZZZZZ'),
      log: () => undefined,
    })).toThrow(/ZZZZZZZZZZ/);
  });

  it('fails when the signed app shows no team at all', () => {
    expect(() => verifySignedTeamId({
      appPath: APP_PATH,
      expectedTeamId: 'AF8KY83RAF',
      env: { APPLE_TEAM_ID: 'AF8KY83RAF' },
      readCodesignDisplay: () => 'Signature=adhoc\nTeamIdentifier=not set',
      log: () => undefined,
    })).toThrow();
  });

  it('skips a build with no secret, and says why, without running codesign', () => {
    const readCodesignDisplay = vi.fn(codesignShowing('ZZZZZZZZZZ'));
    const log = vi.fn();
    verifySignedTeamId({
      appPath: APP_PATH,
      expectedTeamId: 'AF8KY83RAF',
      env: { APPLE_TEAM_ID: '' },
      readCodesignDisplay,
      log,
    });
    expect(readCodesignDisplay).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('APPLE_TEAM_ID not set'));
  });
});

describe('signedTeamIdentifier', () => {
  it('reads the TeamIdentifier line and treats "not set" as none', () => {
    expect(signedTeamIdentifier('a=b\nTeamIdentifier=AF8KY83RAF\nc=d')).toBe('AF8KY83RAF');
    expect(signedTeamIdentifier('TeamIdentifier=not set')).toBeNull();
    expect(signedTeamIdentifier('')).toBeNull();
  });
});

describe('the committed Team ID', () => {
  it('is a 10-character Apple Team ID', () => {
    expect(committed.teamId).toMatch(/^[A-Z0-9]{10}$/);
  });
});
