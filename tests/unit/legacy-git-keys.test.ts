import { describe, expect, it } from 'vitest';
import { legacyIntervalIsOn, migrateLegacyGitKeys } from '../../src/main/config/legacy-git-keys';

describe('legacyIntervalIsOn', () => {
  // The interval pickers wrote null for Off, and JSON keeps null apart from an
  // absent key, so null must not collapse into "unset, use the default".
  it('reads null as off', () => {
    expect(legacyIntervalIsOn(null)).toBe(false);
  });

  it('reads zero and negative intervals as off, as the schedulers did', () => {
    expect(legacyIntervalIsOn(0)).toBe(false);
    expect(legacyIntervalIsOn(-1)).toBe(false);
  });

  it('reads any live interval as on', () => {
    expect(legacyIntervalIsOn(2)).toBe(true);
    expect(legacyIntervalIsOn(15)).toBe(true);
  });
});

describe('migrateLegacyGitKeys', () => {
  it('leaves a config with no retired keys alone', () => {
    const git: Record<string, unknown> = { prAutoRefresh: false, autoFetch: true };
    expect(migrateLegacyGitKeys(git)).toBe(false);
    expect(git).toEqual({ prAutoRefresh: false, autoFetch: true });
  });

  it('turns an off interval into an off switch and drops the retired key', () => {
    const git: Record<string, unknown> = { prRefreshIntervalMinutes: null, autoFetchIntervalMinutes: 0 };
    expect(migrateLegacyGitKeys(git)).toBe(true);
    expect(git).toEqual({ prAutoRefresh: false, autoFetch: false });
  });

  it('turns a live interval into an on switch', () => {
    const git: Record<string, unknown> = { prRefreshIntervalMinutes: 10, autoFetchIntervalMinutes: 2 };
    migrateLegacyGitKeys(git);
    expect(git).toEqual({ prAutoRefresh: true, autoFetch: true });
  });

  it('keeps a switch the file already set over the retired interval beside it', () => {
    const git: Record<string, unknown> = { prRefreshIntervalMinutes: 5, prAutoRefresh: false };
    migrateLegacyGitKeys(git);
    expect(git).toEqual({ prAutoRefresh: false });
  });

  // The global config is merged with defaults before this runs, so the merged
  // object always carries prAutoRefresh. Explicitness has to come from the file.
  it('decides explicitness from the parsed file, not the merged copy', () => {
    const merged: Record<string, unknown> = { prAutoRefresh: true, autoFetch: true, prRefreshIntervalMinutes: null };
    const parsed: Record<string, unknown> = { prRefreshIntervalMinutes: null };
    migrateLegacyGitKeys(merged, parsed);
    expect(merged).toEqual({ prAutoRefresh: false, autoFetch: true });
  });

  it('drops prEvaluateBranchPolicies, since Azure DevOps policies are always checked now', () => {
    const git: Record<string, unknown> = { prEvaluateBranchPolicies: true, prBypassCountsAsReady: false };
    expect(migrateLegacyGitKeys(git)).toBe(true);
    expect(git).toEqual({ prBypassCountsAsReady: false });
  });
});
