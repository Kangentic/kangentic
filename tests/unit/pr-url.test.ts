import { describe, it, expect } from 'vitest';
import { prNumberFromUrl } from '../../src/shared/pr-url';

describe('prNumberFromUrl', () => {
  it('reads a GitHub /pull/<n> URL', () => {
    expect(prNumberFromUrl('https://github.com/owner/repo/pull/42')).toBe(42);
  });

  it('reads an Azure DevOps /pullrequest/<n> URL', () => {
    expect(
      prNumberFromUrl('https://dev.azure.com/SOA-DCCED/AOGCC%20AKWISE/_git/AKWISE/pullrequest/1343'),
    ).toBe(1343);
  });

  it('reads a legacy visualstudio.com Azure PR URL', () => {
    expect(
      prNumberFromUrl('https://SOA-DCCED.visualstudio.com/AOGCC%20AKWISE/_git/AKWISE/pullrequest/1343'),
    ).toBe(1343);
  });

  it('ignores a trailing path after the number', () => {
    expect(prNumberFromUrl('https://github.com/owner/repo/pull/42/files')).toBe(42);
  });

  // `git push` prints this; it names a branch to open a PR for, not a PR.
  it('returns null for the /pull/new/<branch> push hint', () => {
    expect(prNumberFromUrl('https://github.com/owner/repo/pull/new/feature-branch')).toBeNull();
  });

  it('returns null for a branch segment that merely starts with digits', () => {
    expect(prNumberFromUrl('https://github.com/owner/repo/pull/new/123-fix')).toBeNull();
  });

  it('returns null for the owner/repo#123 short form', () => {
    expect(prNumberFromUrl('owner/repo#123')).toBeNull();
  });

  it('returns null for a repo URL carrying no PR', () => {
    expect(prNumberFromUrl('https://dev.azure.com/SOA-DCCED/AOGCC%20AKWISE/_git/AKWISE')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(prNumberFromUrl('')).toBeNull();
  });
});
