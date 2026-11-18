/**
 * The GitLab link parser: every link shape the Add Source field takes, read
 * into the repository a source is saved under. A wrong parse saves a source
 * that never loads, or claims a link that names no GitLab source.
 */
import { describe, expect, it } from 'vitest';
import {
  buildGitLabLabel,
  decodeGitLabRepository,
  encodeGitLabRepository,
  isGitLabRepository,
  parseGitLabUrl,
} from '../../src/main/boards/adapters/gitlab/url-parser';

function parsed(input: string) {
  return decodeGitLabRepository(parseGitLabUrl(input).repository);
}

describe('parseGitLabUrl', () => {
  it.each([
    ['https://gitlab.com/acme/web', { base: 'https://gitlab.com', path: 'acme/web' }],
    ['https://gitlab.com/acme/web/-/issues?label_name=bug', { base: 'https://gitlab.com', path: 'acme/web' }],
    ['https://gitlab.com/acme/web/-/issues/214', { base: 'https://gitlab.com', path: 'acme/web' }],
    ['https://gitlab.com/acme/web/-/work_items/214', { base: 'https://gitlab.com', path: 'acme/web' }],
    ['https://gitlab.com/acme/platform/infra', { base: 'https://gitlab.com', path: 'acme/platform/infra' }],
    ['https://gitlab.com/groups/acme/-/issues', { base: 'https://gitlab.com', path: 'acme' }],
    ['https://gitlab.com/acme', { base: 'https://gitlab.com', path: 'acme' }],
    ['gitlab.com/acme/web', { base: 'https://gitlab.com', path: 'acme/web' }],
    ['http://gitlab.com/acme/web', { base: 'https://gitlab.com', path: 'acme/web' }],
    ['https://git.example.com/platform/api', { base: 'https://git.example.com', path: 'platform/api' }],
    ['http://git.example.com:8080/platform/api', { base: 'http://git.example.com:8080', path: 'platform/api' }],
    ['https://Git.Example.com/Platform/API', { base: 'https://git.example.com', path: 'Platform/API' }],
  ])('reads %s', (input, expected) => {
    expect(parsed(input)).toEqual(expected);
  });

  it('keeps the board a board link names', () => {
    expect(parsed('https://gitlab.com/acme/web/-/boards/12')).toEqual({ base: 'https://gitlab.com', path: 'acme/web', board: '12' });
    expect(parsed('https://gitlab.com/groups/acme/-/boards/7')).toEqual({ base: 'https://gitlab.com', path: 'acme', board: '7' });
  });

  it.each([
    '',
    'not a link',
    'ftp://gitlab.com/acme/web',
    'https://gitlab.com',
    'https://gitlab.com/',
    'https://gitlab.com/explore/projects',
    'https://gitlab.com/dashboard/issues',
    'https://gitlab.com/-/user_settings/personal_access_tokens',
  ])('refuses %j with the popover line', (input) => {
    expect(() => parseGitLabUrl(input)).toThrow('Paste a GitLab project, group or board link.');
  });

  it('refuses a path holding an encoded pipe, which would split the saved repository fields', () => {
    expect(() => parseGitLabUrl('https://gitlab.com/grp/pro%7Cj')).toThrow('Paste a GitLab project, group or board link.');
    expect(parsed('https://gitlab.com/grp/proj')).toEqual({ base: 'https://gitlab.com', path: 'grp/proj' });
  });
});

describe('the saved repository', () => {
  it('round-trips through encode and decode', () => {
    const ref = { base: 'https://example.com/gitlab', path: 'acme/web', board: '12' };
    expect(decodeGitLabRepository(encodeGitLabRepository(ref))).toEqual(ref);
  });

  it('tells a saved repository from a pasted link', () => {
    expect(isGitLabRepository('https://gitlab.com|acme/web')).toBe(true);
    expect(isGitLabRepository('https://gitlab.com/acme/web')).toBe(false);
  });

  it('labels a source by its path until GitLab names it', () => {
    expect(buildGitLabLabel('https://gitlab.com|acme/web|board=12')).toBe('acme/web');
  });
});
