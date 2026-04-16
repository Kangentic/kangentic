/**
 * Unit tests for the board adapter registry.
 *
 * Enforces that every supported ExternalSource has a registered adapter and
 * that adapter contracts are met (id, displayName, icon, status). Mirrors
 * the hmr-resync.test.ts guard pattern: this test fails if a new provider
 * is added to the ExternalSource union but not registered, or if a stub's
 * status field is incorrect.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isReady: () => true, whenReady: () => Promise.resolve() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8'),
    getSelectedStorageBackend: () => 'basic_text',
  },
}));

vi.mock('which', () => ({
  default: async () => {
    throw new Error('not found in test');
  },
}));

import { boardRegistry } from '../../src/main/boards';
import type { ExternalSource } from '../../src/shared/types';

const EXPECTED_PROVIDERS: ExternalSource[] = [
  'github_issues',
  'github_projects',
  'azure_devops',
  'asana',
  'jira',
  'linear',
  'trello',
];

describe('boardRegistry', () => {
  it('registers all 7 supported providers', () => {
    expect(boardRegistry.list().length).toBe(EXPECTED_PROVIDERS.length);
    for (const id of EXPECTED_PROVIDERS) {
      expect(boardRegistry.has(id)).toBe(true);
    }
  });

  it('every adapter declares required metadata fields', () => {
    for (const adapter of boardRegistry.list()) {
      expect(typeof adapter.id).toBe('string');
      expect(adapter.displayName.length).toBeGreaterThan(0);
      expect(adapter.icon.length).toBeGreaterThan(0);
      expect(['stable', 'stub']).toContain(adapter.status);
    }
  });

  it('stable providers report status: stable (Asana is stable - its config is runtime, not build-time)', () => {
    expect(boardRegistry.getOrThrow('github_issues').status).toBe('stable');
    expect(boardRegistry.getOrThrow('github_projects').status).toBe('stable');
    expect(boardRegistry.getOrThrow('azure_devops').status).toBe('stable');
    expect(boardRegistry.getOrThrow('asana').status).toBe('stable');
  });

  it('the 3 remaining placeholder providers are status: stub', () => {
    expect(boardRegistry.getOrThrow('jira').status).toBe('stub');
    expect(boardRegistry.getOrThrow('linear').status).toBe('stub');
    expect(boardRegistry.getOrThrow('trello').status).toBe('stub');
  });

  it('getOrThrow throws for unknown provider id', () => {
    expect(() => boardRegistry.getOrThrow('unknown' as ExternalSource)).toThrow();
  });

  it('stub adapters return an unauthenticated checkCli result instead of throwing', async () => {
    for (const id of ['jira', 'linear', 'trello'] as const) {
      const adapter = boardRegistry.getOrThrow(id);
      const result = await adapter.checkCli();
      expect(result.available).toBe(false);
      expect(result.authenticated).toBe(false);
      expect(result.error).toContain('not yet implemented');
    }
  });

  it('asana reports not-connected via checkCli when no PAT is stored (not a stub)', async () => {
    const adapter = boardRegistry.getOrThrow('asana');
    const result = await adapter.checkCli();
    // PAT auth needs no CLI install, so `available` stays true even when
    // not connected. The user just needs to paste a token.
    expect(result.available).toBe(true);
    expect(result.authenticated).toBe(false);
    expect(result.error).toMatch(/connect|personal access token/i);
  });

  it('stub adapter fetch() throws not-implemented', async () => {
    const adapter = boardRegistry.getOrThrow('linear');
    await expect(
      adapter.fetch(
        { source: 'linear', repository: 'team', page: 1, perPage: 10 },
        () => new Set<string>(),
      ),
    ).rejects.toThrow(/not yet implemented/);
  });
});

describe('boardRegistry.requireStable()', () => {
  it('returns the adapter for github_issues', () => {
    const adapter = boardRegistry.requireStable('github_issues');
    expect(adapter.id).toBe('github_issues');
    expect(adapter.status).toBe('stable');
  });

  it('returns the adapter for github_projects', () => {
    const adapter = boardRegistry.requireStable('github_projects');
    expect(adapter.id).toBe('github_projects');
    expect(adapter.status).toBe('stable');
  });

  it('returns the adapter for azure_devops', () => {
    const adapter = boardRegistry.requireStable('azure_devops');
    expect(adapter.id).toBe('azure_devops');
    expect(adapter.status).toBe('stable');
  });

  it('returns the adapter for asana (runtime-configured, not a stub)', () => {
    const adapter = boardRegistry.requireStable('asana');
    expect(adapter.id).toBe('asana');
    expect(adapter.status).toBe('stable');
  });

  it('throws for jira (stub) with displayName in the message', () => {
    const jiraAdapter = boardRegistry.getOrThrow('jira');
    expect(() => boardRegistry.requireStable('jira')).toThrow(jiraAdapter.displayName);
  });

  it('throws for linear (stub) with displayName in the message', () => {
    const linearAdapter = boardRegistry.getOrThrow('linear');
    expect(() => boardRegistry.requireStable('linear')).toThrow(linearAdapter.displayName);
  });

  it('throws for trello (stub) with displayName in the message', () => {
    const trelloAdapter = boardRegistry.getOrThrow('trello');
    expect(() => boardRegistry.requireStable('trello')).toThrow(trelloAdapter.displayName);
  });

  it('throws for an unknown source id (falls through to getOrThrow)', () => {
    expect(() => boardRegistry.requireStable('unknown' as ExternalSource)).toThrow();
  });

  it('error message for stub adapters mentions not yet implemented', () => {
    expect(() => boardRegistry.requireStable('linear')).toThrow(/not yet implemented/);
  });
});
