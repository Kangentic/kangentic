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

vi.mock('electron', async () => {
  const { createFakeSafeStorage } = await import('./helpers/fake-safe-storage');
  return {
    app: { isReady: () => true, whenReady: () => Promise.resolve() },
    safeStorage: createFakeSafeStorage({ isAsyncEncryptionAvailable: () => false }),
  };
});

vi.mock('which', () => ({
  default: async () => {
    throw new Error('not found in test');
  },
}));

// The board_integration adoption signal fires from requireStable, the one
// funnel every import fetch and execute goes through.
const mockTrackFeatureUsed = vi.hoisted(() => vi.fn());
vi.mock('../../src/main/analytics/usage', () => ({
  trackFeatureUsed: mockTrackFeatureUsed,
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
  'obsidian_notes',
  'obsidian_checklist',
  'gitlab',
  'repo_folder',
  'script',
];

describe('boardRegistry', () => {
  it('requireStable reports board_integration for a stable adapter and nothing for a stub', () => {
    mockTrackFeatureUsed.mockClear();
    const stable = boardRegistry.list().find((adapter) => adapter.status !== 'stub');
    expect(stable).toBeDefined();

    expect(boardRegistry.requireStable(stable!.id)).toBe(stable);
    expect(mockTrackFeatureUsed).toHaveBeenCalledTimes(1);
    expect(mockTrackFeatureUsed).toHaveBeenCalledWith('board_integration');

    const stub = boardRegistry.list().find((adapter) => adapter.status === 'stub');
    if (stub) {
      expect(() => boardRegistry.requireStable(stub.id)).toThrow();
      expect(mockTrackFeatureUsed).toHaveBeenCalledTimes(1);
    }
  });

  it('registers every supported provider', () => {
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

  it('stable providers report status: stable (Asana, Jira, Linear and Trello are stable - their config is runtime, not build-time)', () => {
    expect(boardRegistry.getOrThrow('github_issues').status).toBe('stable');
    expect(boardRegistry.getOrThrow('github_projects').status).toBe('stable');
    expect(boardRegistry.getOrThrow('azure_devops').status).toBe('stable');
    expect(boardRegistry.getOrThrow('asana').status).toBe('stable');
    expect(boardRegistry.getOrThrow('jira').status).toBe('stable');
    expect(boardRegistry.getOrThrow('linear').status).toBe('stable');
    expect(boardRegistry.getOrThrow('obsidian_notes').status).toBe('stable');
    expect(boardRegistry.getOrThrow('obsidian_checklist').status).toBe('stable');
    expect(boardRegistry.getOrThrow('trello').status).toBe('stable');
    expect(boardRegistry.getOrThrow('gitlab').status).toBe('stable');
    expect(boardRegistry.getOrThrow('repo_folder').status).toBe('stable');
    expect(boardRegistry.getOrThrow('script').status).toBe('stable');
  });

  it('getOrThrow throws for unknown provider id', () => {
    expect(() => boardRegistry.getOrThrow('unknown' as ExternalSource)).toThrow();
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

  it('linear reports not-connected via checkCli when no credential is stored (not a stub)', async () => {
    const adapter = boardRegistry.getOrThrow('linear');
    const result = await adapter.checkCli();
    // Linear signs in through Kangentic, so `available` stays true; Connect Linear is the fix.
    expect(result.available).toBe(true);
    expect(result.authenticated).toBe(false);
    expect(result.error).toMatch(/not connected to linear/i);
  });

  it('gitlab reports not-connected via checkCli when no credential is stored (not a stub)', async () => {
    const adapter = boardRegistry.getOrThrow('gitlab');
    const result = await adapter.checkCli();
    // GitLab signs in through Kangentic, so `available` stays true; Connect GitLab is the fix.
    expect(result.available).toBe(true);
    expect(result.authenticated).toBe(false);
    expect(result.error).toMatch(/not connected to gitlab/i);
  });

  it('trello reports not-connected via checkCli when no token is stored (not a stub)', async () => {
    const adapter = boardRegistry.getOrThrow('trello');
    const result = await adapter.checkCli();
    expect(result.available).toBe(true);
    expect(result.authenticated).toBe(false);
    expect(result.error).toContain('Connect Trello');
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

  it('returns the adapter for jira (runtime-configured, not a stub)', () => {
    const adapter = boardRegistry.requireStable('jira');
    expect(adapter.id).toBe('jira');
    expect(adapter.status).toBe('stable');
  });

  it('returns the adapter for linear (runtime-configured, not a stub)', () => {
    const adapter = boardRegistry.requireStable('linear');
    expect(adapter.id).toBe('linear');
    expect(adapter.status).toBe('stable');
  });

  it('returns the adapter for trello (runtime-configured, not a stub)', () => {
    const adapter = boardRegistry.requireStable('trello');
    expect(adapter.id).toBe('trello');
    expect(adapter.status).toBe('stable');
  });

  it('throws for an unknown source id (falls through to getOrThrow)', () => {
    expect(() => boardRegistry.requireStable('unknown' as ExternalSource)).toThrow();
  });
});
