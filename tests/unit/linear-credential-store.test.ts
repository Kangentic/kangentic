/**
 * The Linear credential file's shape check. A file that does not parse into a
 * whole credential must read as "not connected", or the first API call sends an
 * empty Authorization header and the user sees Linear's error instead of the
 * Connect dialog.
 */
import { describe, it, expect } from 'vitest';
import { parseLinearCredential } from '../../src/main/boards/adapters/linear/credential-store';

const BASE = { userName: 'dana', organizationUrlKey: 'acme', savedAt: '2026-11-17T00:00:00.000Z' };

describe('parseLinearCredential', () => {
  it('reads an API key and an OAuth pair', () => {
    expect(parseLinearCredential(JSON.stringify({ ...BASE, kind: 'api_key', apiKey: 'lin_api_x' })))
      .toEqual({ ...BASE, kind: 'api_key', apiKey: 'lin_api_x' });
    const oauth = { ...BASE, kind: 'oauth', accessToken: 'a', refreshToken: 'r', expiresAt: '2026-11-18T00:00:00.000Z' };
    expect(parseLinearCredential(JSON.stringify(oauth))).toEqual(oauth);
  });

  it('refuses a credential with a missing part', () => {
    expect(parseLinearCredential(JSON.stringify({ ...BASE, kind: 'api_key', apiKey: '' }))).toBeNull();
    expect(parseLinearCredential(JSON.stringify({ ...BASE, kind: 'oauth', accessToken: 'a', expiresAt: 'x' }))).toBeNull();
    expect(parseLinearCredential(JSON.stringify({ ...BASE, apiKey: 'lin_api_x' }))).toBeNull();
  });

  it('refuses a credential with no workspace URL key, since every team link is built from it', () => {
    const apiKey = { ...BASE, kind: 'api_key', apiKey: 'lin_api_x' };
    const oauth = { ...BASE, kind: 'oauth', accessToken: 'a', refreshToken: 'r', expiresAt: '2026-11-18T00:00:00.000Z' };
    for (const credential of [apiKey, oauth]) {
      expect(parseLinearCredential(JSON.stringify({ ...credential, organizationUrlKey: '' }))).toBeNull();
      const { organizationUrlKey: _omitted, ...withoutKey } = credential;
      expect(parseLinearCredential(JSON.stringify(withoutKey))).toBeNull();
    }
  });
});
