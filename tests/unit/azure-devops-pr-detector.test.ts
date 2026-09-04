import { describe, it, expect } from 'vitest';
import { azureDevOpsPRConnector } from '../../src/main/pr/adapters/azure-devops/azure-devops-connector';
import { gitHubPRConnector } from '../../src/main/pr/adapters/github/github-connector';

const AZURE_PR_URL = 'https://dev.azure.com/SOA-DCCED/AOGCC%20AKWISE/_git/AKWISE/pullrequest/1343';
const GITHUB_PR_URL = 'https://github.com/owner/repo/pull/42';

describe('azureDevOpsPRConnector.extract', () => {
  it('finds a PR URL on the modern host', () => {
    expect(azureDevOpsPRConnector.extract(`Created PR ${AZURE_PR_URL}\n`)).toEqual({
      url: AZURE_PR_URL,
      number: 1343,
    });
  });

  it('finds a PR URL on the legacy visualstudio.com host', () => {
    const legacy = 'https://SOA-DCCED.visualstudio.com/AOGCC%20AKWISE/_git/AKWISE/pullrequest/1343';
    expect(azureDevOpsPRConnector.extract(legacy)?.number).toBe(1343);
  });

  it('returns the LAST match, which is the most recent', () => {
    const scrollback = `${AZURE_PR_URL}\nlater\nhttps://dev.azure.com/SOA-DCCED/AOGCC%20AKWISE/_git/AKWISE/pullrequest/1350`;
    expect(azureDevOpsPRConnector.extract(scrollback)?.number).toBe(1350);
  });

  it('sees through ANSI colour codes', () => {
    expect(azureDevOpsPRConnector.extract(`\x1b[32m${AZURE_PR_URL}\x1b[0m`)?.number).toBe(1343);
  });

  it('sees through an OSC-8 hyperlink (BEL terminated)', () => {
    const scrollback = `\x1b]8;;${AZURE_PR_URL}\x07${AZURE_PR_URL}\x1b]8;;\x07`;
    expect(azureDevOpsPRConnector.extract(scrollback)?.number).toBe(1343);
  });

  it('sees through an OSC-8 hyperlink (ST terminated)', () => {
    const scrollback = `\x1b]8;;${AZURE_PR_URL}\x1b\\${AZURE_PR_URL}\x1b]8;;\x1b\\`;
    expect(azureDevOpsPRConnector.extract(scrollback)?.number).toBe(1343);
  });

  it('ignores a URL older than the 4KB scan window', () => {
    expect(azureDevOpsPRConnector.extract(`${AZURE_PR_URL}${'x'.repeat(5000)}`)).toBeNull();
  });

  /**
   * RED-GREEN for the `AZURE_PR_URL_PATTERN.lastIndex = 0` reset. A module-level
   * /g regex retains lastIndex between calls, so without the reset the second
   * extract in a process starts mid-string and silently misses.
   */
  it('still matches on a second call with the same input', () => {
    expect(azureDevOpsPRConnector.extract(AZURE_PR_URL)?.number).toBe(1343);
    expect(azureDevOpsPRConnector.extract(AZURE_PR_URL)?.number).toBe(1343);
  });

  describe('does not match', () => {
    it.each([
      ['the compose page', 'https://dev.azure.com/O/P/_git/R/pullrequestcreate?sourceRef=x'],
      ['a bare repo URL', 'https://dev.azure.com/O/P/_git/R'],
      ['a work item URL', 'https://dev.azure.com/O/P/_workitems/edit/7927'],
      ['a board URL', 'https://dev.azure.com/O/P'],
      ['a GitHub PR URL', GITHUB_PR_URL],
      ['empty scrollback', ''],
      ['scrollback with no URL', 'building...\ndone\n'],
    ])('%s', (_label, scrollback) => {
      expect(azureDevOpsPRConnector.extract(scrollback)).toBeNull();
    });
  });
});

describe('azureDevOpsPRConnector.matchesCommand', () => {
  it.each([
    'az repos pr create --title x',
    'az repos pr show --id 1343',
    'az repos pr update --id 1343 --status completed',
  ])('matches %s', (command) => {
    expect(azureDevOpsPRConnector.matchesCommand(command)).toBe(true);
  });

  it.each([
    // A survey, not an act on one PR - same exclusion `gh pr list` has.
    'az repos pr list --status active',
    'az boards query --wiql "select ..."',
    'gh pr create --fill',
    'npm run build',
  ])('does not match %s', (command) => {
    expect(azureDevOpsPRConnector.matchesCommand(command)).toBe(false);
  });
});

/**
 * With two connectors registered, first-match ordering in `detectPR` only stays
 * safe while the URL patterns are disjoint.
 */
describe('connectors do not claim each other URLs', () => {
  it('GitHub does not claim an Azure PR URL', () => {
    expect(gitHubPRConnector.extract(AZURE_PR_URL)).toBeNull();
  });

  it('Azure does not claim a GitHub PR URL', () => {
    expect(azureDevOpsPRConnector.extract(GITHUB_PR_URL)).toBeNull();
  });

  it('GitHub does not claim an Azure remote, and vice versa', () => {
    expect(gitHubPRConnector.matchesRemote(['git@ssh.dev.azure.com:v3/O/P/R'])).toBe(false);
    expect(azureDevOpsPRConnector.matchesRemote(['https://github.com/owner/repo.git'])).toBe(false);
  });

  it('GitHub claims an Enterprise host that carries the name', () => {
    expect(gitHubPRConnector.matchesRemote(['https://github.mycorp.com/owner/repo.git'])).toBe(true);
    expect(gitHubPRConnector.matchesRemote(['git@github.com:owner/repo.git'])).toBe(true);
  });
});
