/**
 * Unit tests for src/main/boards/adapters/gitlab/credential-store.ts.
 *
 * Runs against a real temp config directory (PATHS.configDir is mocked to it) and a
 * fake safeStorage, so the read-modify-write cycle and the on-disk file are real and
 * no keychain is touched.
 *
 * - Two overlapping saves for different servers both land.
 * - One malformed entry is dropped without signing the valid ones out.
 * - A damaged file is copied aside before a save overwrites it.
 * - The file on disk holds no plaintext secret.
 * - credentialForUrl matches a link to its server by whole path segments, never by prefix text.
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
  credentialForUrl,
  loadGitLabCredentials,
  saveGitLabCredential,
  type GitLabCredential,
} from '../../src/main/boards/adapters/gitlab/credential-store';
import { encryptSecret } from '../../src/main/boards/shared/auth';

function credentialFor(site: string, secret: string): GitLabCredential {
  return {
    site,
    method: 'token',
    secret,
    account: 'dev',
    savedAt: '2026-01-01T00:00:00.000Z',
  };
}

function storeFilePath(): string {
  return path.join(pathsState.configDir, 'gitlab-credentials.json');
}

beforeEach(() => {
  pathsState.configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitlab-credential-store-'));
});

afterEach(() => {
  fs.rmSync(pathsState.configDir, { recursive: true, force: true });
});

describe('saveGitLabCredential', () => {
  it('keeps both servers when two saves for different servers overlap', async () => {
    const first = credentialFor('https://gitlab.com', 'secret-one');
    const second = credentialFor('https://git.example.com', 'secret-two');

    await Promise.all([saveGitLabCredential(first), saveGitLabCredential(second)]);

    const loaded = await loadGitLabCredentials();
    expect(Object.keys(loaded).sort()).toEqual(['https://git.example.com', 'https://gitlab.com']);
    expect(loaded['https://gitlab.com'].secret).toBe('secret-one');
    expect(loaded['https://git.example.com'].secret).toBe('secret-two');
  });

  it('replaces the saved sign-in when the same server is saved again', async () => {
    await saveGitLabCredential(credentialFor('https://gitlab.com', 'old-secret'));
    await saveGitLabCredential(credentialFor('https://gitlab.com', 'new-secret'));

    const loaded = await loadGitLabCredentials();
    expect(Object.keys(loaded)).toEqual(['https://gitlab.com']);
    expect(loaded['https://gitlab.com'].secret).toBe('new-secret');
  });

  it('never writes the plaintext secret to disk', async () => {
    await saveGitLabCredential(credentialFor('https://git.example.com', 'plaintext-marker-secret'));

    const onDisk = fs.readFileSync(storeFilePath(), 'utf8');
    expect(onDisk).not.toContain('plaintext-marker-secret');
    expect(onDisk).not.toContain('git.example.com');
    expect(JSON.parse(onDisk)).toHaveProperty('encrypted');
  });
});

describe('saveGitLabCredential over an unreadable file', () => {
  function unreadableCopies(): string[] {
    return fs.readdirSync(pathsState.configDir).filter((name) => name.startsWith('gitlab-credentials.json.unreadable-'));
  }

  it('copies a damaged file aside with its original bytes, then writes the new server', async () => {
    const original = 'this is not json at all';
    fs.writeFileSync(storeFilePath(), original);

    await saveGitLabCredential(credentialFor('https://gitlab.com', 'new-secret'));

    const copies = unreadableCopies();
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatch(/^gitlab-credentials\.json\.unreadable-\d+$/);
    expect(fs.readFileSync(path.join(pathsState.configDir, copies[0]), 'utf8')).toBe(original);
    const loaded = await loadGitLabCredentials();
    expect(Object.keys(loaded)).toEqual(['https://gitlab.com']);
  });

  it('makes no copy when the file is readable or absent', async () => {
    await saveGitLabCredential(credentialFor('https://gitlab.com', 'first'));
    await saveGitLabCredential(credentialFor('https://git.example.com', 'second'));
    expect(unreadableCopies()).toEqual([]);
  });
});

describe('loadGitLabCredentials', () => {
  it('is empty when nothing is saved', async () => {
    expect(await loadGitLabCredentials()).toEqual({});
  });

  it('loads only the good entry when one has an empty secret and one an unknown method', async () => {
    const valid = credentialFor('https://gitlab.com', 'good-secret');
    const stored = {
      sites: {
        'https://gitlab.com': valid,
        'https://no-secret.example.com': credentialFor('https://no-secret.example.com', ''),
        'https://bad-method.example.com': {
          ...credentialFor('https://bad-method.example.com', 'x'),
          method: 'password',
        },
      },
    };
    fs.writeFileSync(
      storeFilePath(),
      JSON.stringify({ encrypted: await encryptSecret(JSON.stringify(stored)) }),
    );

    const loaded = await loadGitLabCredentials();

    expect(Object.keys(loaded)).toEqual(['https://gitlab.com']);
    expect(loaded['https://gitlab.com']).toEqual(valid);
  });
});

describe('credentialForUrl', () => {
  const gitlabCom = credentialFor('https://gitlab.com', 'com-secret');

  it('does not match a look-alike host that merely starts with the base', () => {
    const credentials = { [gitlabCom.site]: gitlabCom };
    expect(credentialForUrl(credentials, 'https://gitlab.com.evil.example/acme/web')).toBeUndefined();
  });

  it('matches a link under the server', () => {
    const credentials = { [gitlabCom.site]: gitlabCom };
    expect(credentialForUrl(credentials, 'https://gitlab.com/acme/web')).toBe(gitlabCom);
  });

  it('matches the exact base', () => {
    const credentials = { [gitlabCom.site]: gitlabCom };
    expect(credentialForUrl(credentials, 'https://gitlab.com')).toBe(gitlabCom);
  });

  it('picks the longer base when one instance sits under a path prefix of another', () => {
    const bare = credentialFor('https://example.com', 'bare-secret');
    const prefixed = credentialFor('https://example.com/gitlab', 'prefixed-secret');
    const credentials = { [bare.site]: bare, [prefixed.site]: prefixed };

    expect(credentialForUrl(credentials, 'https://example.com/gitlab/acme/web')).toBe(prefixed);
    expect(credentialForUrl(credentials, 'https://example.com/other/acme/web')).toBe(bare);
  });

  it('matches case-insensitively on the host', () => {
    const credentials = { [gitlabCom.site]: gitlabCom };
    expect(credentialForUrl(credentials, 'https://GitLab.com/Acme/Web')).toBe(gitlabCom);
  });

  it('returns undefined with no credentials', () => {
    expect(credentialForUrl({}, 'https://gitlab.com/acme/web')).toBeUndefined();
  });
});
