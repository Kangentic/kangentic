/**
 * Unit tests for src/main/boards/adapters/jira/credential-store.ts.
 *
 * Runs against a real temp config directory (PATHS.configDir is mocked to it) and a
 * fake safeStorage, so the read-modify-write cycle and the on-disk file are real and
 * no keychain is touched.
 *
 * - Two overlapping saves for different sites both land. Each save reads the whole
 *   file, changes one site and writes it back, so without the save chain the second
 *   write drops the first site.
 * - One malformed site entry is dropped without signing the valid ones out.
 * - The file on disk holds no plaintext secret.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const pathsState = vi.hoisted(() => ({ configDir: '' }));

vi.mock('electron', async () => {
  const { createFakeSafeStorage } = await import('./helpers/fake-safe-storage');
  return {
    app: {
      isReady: () => true,
      whenReady: () => Promise.resolve(),
    },
    safeStorage: createFakeSafeStorage(),
  };
});

vi.mock('../../src/main/config/paths', () => ({
  PATHS: {
    get configDir() {
      return pathsState.configDir;
    },
  },
}));

import {
  loadJiraCredentials,
  saveJiraCredential,
  type JiraSiteCredential,
} from '../../src/main/boards/adapters/jira/credential-store';
import { encryptSecret } from '../../src/main/boards/shared/auth';

function credentialFor(site: string, secret: string): JiraSiteCredential {
  return {
    site,
    deployment: 'cloud',
    method: 'api-token',
    email: 'dev@example.com',
    secret,
    account: 'dev@example.com',
    savedAt: '2026-01-01T00:00:00.000Z',
  };
}

function storeFilePath(): string {
  return path.join(pathsState.configDir, 'jira-credentials.json');
}

beforeEach(() => {
  pathsState.configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-credential-store-'));
});

afterEach(() => {
  fs.rmSync(pathsState.configDir, { recursive: true, force: true });
});

describe('saveJiraCredential', () => {
  it('keeps both sites when two saves for different sites overlap', async () => {
    const first = credentialFor('https://one.example.net', 'secret-one');
    const second = credentialFor('https://two.example.net', 'secret-two');

    // Neither is awaited before the other starts.
    await Promise.all([saveJiraCredential(first), saveJiraCredential(second)]);

    const loaded = await loadJiraCredentials();
    expect(Object.keys(loaded).sort()).toEqual(['https://one.example.net', 'https://two.example.net']);
    expect(loaded['https://one.example.net'].secret).toBe('secret-one');
    expect(loaded['https://two.example.net'].secret).toBe('secret-two');
  });

  it('replaces the saved sign-in when the same site is saved again', async () => {
    await saveJiraCredential(credentialFor('https://one.example.net', 'old-secret'));
    await saveJiraCredential(credentialFor('https://one.example.net', 'new-secret'));

    const loaded = await loadJiraCredentials();
    expect(Object.keys(loaded)).toEqual(['https://one.example.net']);
    expect(loaded['https://one.example.net'].secret).toBe('new-secret');
  });

  it('never writes the plaintext secret to disk', async () => {
    await saveJiraCredential(credentialFor('https://one.example.net', 'plaintext-marker-secret'));

    const onDisk = fs.readFileSync(storeFilePath(), 'utf8');
    expect(onDisk).not.toContain('plaintext-marker-secret');
    expect(onDisk).not.toContain('one.example.net');
    expect(JSON.parse(onDisk)).toHaveProperty('encrypted');
  });
});

describe('saveJiraCredential over an unreadable file', () => {
  function unreadableCopies(): string[] {
    return fs.readdirSync(pathsState.configDir).filter((name) => name.startsWith('jira-credentials.json.unreadable-'));
  }

  it.each([
    ['text that is not the encrypted shape', 'this is not json at all'],
    ['an encrypted value that fails to decrypt', JSON.stringify({ encrypted: 'not-a-real-ciphertext' })],
  ])('copies %s aside with its original bytes, then writes the new site', async (_label, original) => {
    fs.writeFileSync(storeFilePath(), original);

    await saveJiraCredential(credentialFor('https://one.example.net', 'new-secret'));

    const copies = unreadableCopies();
    expect(copies).toHaveLength(1);
    expect(fs.readFileSync(path.join(pathsState.configDir, copies[0]), 'utf8')).toBe(original);
    const loaded = await loadJiraCredentials();
    expect(Object.keys(loaded)).toEqual(['https://one.example.net']);
    expect(loaded['https://one.example.net'].secret).toBe('new-secret');
  });

  it('makes no copy when the file is readable or absent', async () => {
    await saveJiraCredential(credentialFor('https://one.example.net', 'first'));
    await saveJiraCredential(credentialFor('https://two.example.net', 'second'));
    expect(unreadableCopies()).toEqual([]);
  });
});

describe('loadJiraCredentials', () => {
  it('is empty when nothing is saved', async () => {
    expect(await loadJiraCredentials()).toEqual({});
  });

  it('drops a malformed site entry without dropping the valid one', async () => {
    const valid = credentialFor('https://good.example.net', 'good-secret');
    const stored = {
      sites: {
        'https://good.example.net': valid,
        'https://no-secret.example.net': { ...credentialFor('https://no-secret.example.net', ''), secret: '' },
        'https://bad-deployment.example.net': {
          ...credentialFor('https://bad-deployment.example.net', 'x'),
          deployment: 'server',
        },
        'https://not-an-object.example.net': 'nope',
      },
    };
    fs.writeFileSync(
      storeFilePath(),
      JSON.stringify({ encrypted: await encryptSecret(JSON.stringify(stored)) }),
    );

    const loaded = await loadJiraCredentials();

    expect(Object.keys(loaded)).toEqual(['https://good.example.net']);
    expect(loaded['https://good.example.net']).toEqual(valid);
  });

  function oauthCredentialFor(site: string): JiraSiteCredential {
    return {
      ...credentialFor(site, 'access-token'),
      method: 'oauth',
      email: undefined,
      refreshToken: 'refresh-token',
      expiresAt: '2026-11-17T13:00:00.000Z',
      cloudId: 'cloud-123',
      viaGateway: true,
    };
  }

  it('saves a browser sign-in and loads it back with its refresh token and expiry', async () => {
    const oauth = oauthCredentialFor('https://one.example.net');
    await saveJiraCredential(oauth);

    const loaded = await loadJiraCredentials();
    expect(loaded['https://one.example.net']).toMatchObject({
      method: 'oauth',
      refreshToken: 'refresh-token',
      expiresAt: '2026-11-17T13:00:00.000Z',
      cloudId: 'cloud-123',
    });
  });

  it('drops a browser sign-in missing its refresh token, expiry or site id, keeping a valid sibling', async () => {
    const valid = oauthCredentialFor('https://good.example.net');
    const withoutRefreshToken: Partial<JiraSiteCredential> = oauthCredentialFor('https://no-refresh.example.net');
    delete withoutRefreshToken.refreshToken;
    const withoutExpiry: Partial<JiraSiteCredential> = oauthCredentialFor('https://no-expiry.example.net');
    delete withoutExpiry.expiresAt;
    const withoutCloudId: Partial<JiraSiteCredential> = oauthCredentialFor('https://no-cloud.example.net');
    delete withoutCloudId.cloudId;
    const stored = {
      sites: {
        'https://good.example.net': valid,
        'https://no-refresh.example.net': withoutRefreshToken,
        'https://no-expiry.example.net': withoutExpiry,
        'https://no-cloud.example.net': withoutCloudId,
        'https://empty-refresh.example.net': { ...oauthCredentialFor('https://empty-refresh.example.net'), refreshToken: '' },
        'https://empty-cloud.example.net': { ...oauthCredentialFor('https://empty-cloud.example.net'), cloudId: '' },
      },
    };
    fs.writeFileSync(
      storeFilePath(),
      JSON.stringify({ encrypted: await encryptSecret(JSON.stringify(stored)) }),
    );

    const loaded = await loadJiraCredentials();

    expect(Object.keys(loaded)).toEqual(['https://good.example.net']);
    expect(loaded['https://good.example.net']).toEqual(valid);
  });
});
