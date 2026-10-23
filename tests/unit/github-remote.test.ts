import { describe, it, expect } from 'vitest';
import { buildGitHubCommitWebUrl, firstGitHubRemote, parseGitHubRemote } from '../../src/main/pr/adapters/github/github-remote';
import { buildAzureCommitWebUrl, parseAzureRemote } from '../../src/main/pr/adapters/azure-devops/azure-remote';

const SHA = 'f4657fd6cf9f208ad2fe4e4bc9fae99f0edfca55';

describe('parseGitHubRemote', () => {
  it.each([
    ['https://github.com/owner/repo.git', { host: 'github.com', owner: 'owner', repo: 'repo' }],
    ['https://github.com/owner/repo', { host: 'github.com', owner: 'owner', repo: 'repo' }],
    ['https://github.com/owner/repo/', { host: 'github.com', owner: 'owner', repo: 'repo' }],
    ['https://user:token@github.com/owner/repo.git', { host: 'github.com', owner: 'owner', repo: 'repo' }],
    ['git@github.com:owner/repo.git', { host: 'github.com', owner: 'owner', repo: 'repo' }],
    ['ssh://git@github.com/owner/repo.git', { host: 'github.com', owner: 'owner', repo: 'repo' }],
    ['ssh://git@ssh.github.com:443/owner/repo.git', { host: 'github.com', owner: 'owner', repo: 'repo' }],
    ['https://github.mycorp.com/team/service.git', { host: 'github.mycorp.com', owner: 'team', repo: 'service' }],
    ['git@github.mycorp.com:team/service.git', { host: 'github.mycorp.com', owner: 'team', repo: 'service' }],
    // An https port serves the web pages, so it stays with the host.
    ['https://github.example.com:8443/org/repo.git', { host: 'github.example.com:8443', owner: 'org', repo: 'repo' }],
    ['https://user:token@github.example.com:8443/org/repo.git', { host: 'github.example.com:8443', owner: 'org', repo: 'repo' }],
    // An ssh port is the ssh daemon's, which serves no web pages, so it is dropped.
    ['ssh://git@github.example.com:2222/org/repo.git', { host: 'github.example.com', owner: 'org', repo: 'repo' }],
  ])('parses %s', (url, expected) => {
    expect(parseGitHubRemote(url)).toEqual(expected);
  });

  it.each([
    'https://gitlab.com/group/project.git',
    'git@bitbucket.org:owner/repo.git',
    'https://dev.azure.com/my-org/My%20Project/_git/my-repo',
    'C:\\Users\\dev\\some\\local\\repo',
    '/home/dev/some/local/repo',
    'https://github.com/owner',
    '',
  ])('returns null for %s', (url) => {
    expect(parseGitHubRemote(url)).toBeNull();
  });

  it('firstGitHubRemote skips the remotes that are not GitHub\'s', () => {
    expect(firstGitHubRemote(['https://gitlab.com/group/project.git', 'git@github.com:owner/repo.git'])).toEqual({ host: 'github.com', owner: 'owner', repo: 'repo' });
    expect(firstGitHubRemote([])).toBeNull();
  });
});

describe('commit web URLs', () => {
  it('GitHub', () => {
    expect(buildGitHubCommitWebUrl({ host: 'github.com', owner: 'Kangentic', repo: 'kangentic' }, SHA))
      .toBe(`https://github.com/Kangentic/kangentic/commit/${SHA}`);
  });

  it('GitHub, keeping the port of an https remote so the link reaches the same web server', () => {
    // Built from the parser's output rather than a hand-written remote, so the
    // port reaching the URL is proven end to end, not just interpolated.
    const remote = parseGitHubRemote('https://github.example.com:8443/org/repo.git');
    expect(remote).not.toBeNull();
    expect(buildGitHubCommitWebUrl(remote!, SHA)).toBe(`https://github.example.com:8443/org/repo/commit/${SHA}`);
  });

  it('GitHub, dropping the ssh port from the link, since the web pages are not served there', () => {
    const remote = parseGitHubRemote('ssh://git@github.example.com:2222/org/repo.git');
    expect(remote).not.toBeNull();
    expect(buildGitHubCommitWebUrl(remote!, SHA)).toBe(`https://github.example.com/org/repo/commit/${SHA}`);
  });

  it('Azure DevOps, re-encoding the segments parseAzureRemote decoded', () => {
    const remote = parseAzureRemote('git@ssh.dev.azure.com:v3/my-org/My%20Project/my-repo');
    expect(remote).not.toBeNull();
    expect(buildAzureCommitWebUrl(remote!, SHA)).toBe(`https://dev.azure.com/my-org/My%20Project/_git/my-repo/commit/${SHA}`);
  });
});
