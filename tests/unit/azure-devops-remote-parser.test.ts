import { describe, it, expect } from 'vitest';
import {
  parseAzureRemote,
  firstAzureRemote,
  buildAzurePrWebUrl,
} from '../../src/main/pr/adapters/azure-devops/azure-remote';
import { azureDevOpsPRConnector } from '../../src/main/pr/adapters/azure-devops/azure-devops-connector';

const AKWISE = { org: 'SOA-DCCED', project: 'AOGCC AKWISE', repo: 'AKWISE' };

describe('parseAzureRemote', () => {
  // The literal remote of the AKWISE checkout this connector exists for.
  it('parses the scp-like SSH remote, decoding %20 in the project', () => {
    expect(parseAzureRemote('git@ssh.dev.azure.com:v3/SOA-DCCED/AOGCC%20AKWISE/AKWISE')).toEqual(AKWISE);
  });

  it('parses the ssh:// form with an explicit port', () => {
    expect(parseAzureRemote('ssh://git@ssh.dev.azure.com:22/v3/SOA-DCCED/AOGCC%20AKWISE/AKWISE')).toEqual(AKWISE);
  });

  it('parses the modern HTTPS form', () => {
    expect(parseAzureRemote('https://dev.azure.com/SOA-DCCED/AOGCC%20AKWISE/_git/AKWISE')).toEqual(AKWISE);
  });

  // The userinfo is a login hint; the org must come from the path.
  it('takes the org from the path, not the userinfo', () => {
    expect(
      parseAzureRemote('https://someoneelse@dev.azure.com/SOA-DCCED/AOGCC%20AKWISE/_git/AKWISE'),
    ).toEqual(AKWISE);
  });

  it('parses the legacy visualstudio.com form, org from the host label', () => {
    expect(parseAzureRemote('https://SOA-DCCED.visualstudio.com/AOGCC%20AKWISE/_git/AKWISE')).toEqual(AKWISE);
  });

  it('parses the legacy form with a DefaultCollection segment', () => {
    expect(
      parseAzureRemote('https://SOA-DCCED.visualstudio.com/DefaultCollection/AOGCC%20AKWISE/_git/AKWISE'),
    ).toEqual(AKWISE);
  });

  it('parses the legacy vs-ssh form', () => {
    expect(parseAzureRemote('git@vs-ssh.visualstudio.com:v3/SOA-DCCED/AOGCC%20AKWISE/AKWISE')).toEqual(AKWISE);
  });

  it('strips a trailing .git from the repo', () => {
    expect(parseAzureRemote('https://dev.azure.com/SOA-DCCED/AOGCC%20AKWISE/_git/AKWISE.git')).toEqual(AKWISE);
  });

  it('tolerates a trailing slash', () => {
    expect(parseAzureRemote('https://dev.azure.com/SOA-DCCED/AOGCC%20AKWISE/_git/AKWISE/')).toEqual(AKWISE);
  });

  /**
   * `decodeSegment`'s catch branch, previously untested: a malformed percent
   * escape (an invalid hex digit, or a `%` with fewer than two digits after
   * it) makes `decodeURIComponent` throw a URIError. The segment pattern only
   * excludes `/` and whitespace, so an ill-formed `%` sequence still matches
   * the regex and reaches `decodeSegment` - it is not rejected earlier.
   *
   * The consequence matters beyond this one function: `matchesRemote` calls
   * `parseAzureRemote` SYNCHRONOUSLY, and `dispatchResolve` runs
   * `matchesRemote` inside `Array.prototype.filter`. An uncaught throw here
   * would escape the ownership gate entirely rather than degrading one
   * resolve, so both the parse and the connector's gate are asserted.
   *
   * Red-green: remove the try/catch in `decodeSegment` (let
   * `decodeURIComponent` throw) - both assertions below go red, the second as
   * an uncaught URIError rather than a returned `false`.
   */
  it('keeps the raw segment on a malformed percent escape, rather than throwing', () => {
    const malformedUrl = 'https://dev.azure.com/SOA-DCCED/AOGCC%ZZ/_git/AKWISE';
    expect(parseAzureRemote(malformedUrl)).toEqual({ org: 'SOA-DCCED', project: 'AOGCC%ZZ', repo: 'AKWISE' });
    expect(() => azureDevOpsPRConnector.matchesRemote([malformedUrl])).not.toThrow();
    expect(azureDevOpsPRConnector.matchesRemote([malformedUrl])).toBe(true);
  });

  describe('returns null for non-Azure remotes (this null IS the connector gate)', () => {
    it.each([
      ['GitHub SSH', 'git@github.com:owner/repo.git'],
      ['GitHub HTTPS', 'https://github.com/owner/repo.git'],
      ['GitLab', 'https://gitlab.com/group/project.git'],
      ['a GitHub Enterprise host', 'https://github.mycorp.com/owner/repo.git'],
      ['a bare filesystem path', 'C:\\Users\\dev\\some\\repo'],
      ['an empty string', ''],
      ['whitespace', '   '],
      // No `_git` segment: this is a board URL, which the board adapter parses.
      ['an Azure board URL', 'https://dev.azure.com/SOA-DCCED/AOGCC%20AKWISE'],
    ])('%s', (_label, url) => {
      expect(parseAzureRemote(url)).toBeNull();
    });
  });
});

describe('firstAzureRemote', () => {
  it('finds the Azure remote among several', () => {
    expect(
      firstAzureRemote([
        'https://github.com/owner/repo.git',
        'git@ssh.dev.azure.com:v3/SOA-DCCED/AOGCC%20AKWISE/AKWISE',
      ]),
    ).toEqual(AKWISE);
  });

  it('returns null when none is an Azure remote', () => {
    expect(firstAzureRemote(['https://github.com/owner/repo.git'])).toBeNull();
  });

  it('returns null for no remotes at all', () => {
    expect(firstAzureRemote([])).toBeNull();
  });
});

describe('buildAzurePrWebUrl', () => {
  // Azure returns null for _links.web.href / remoteUrl / repository.webUrl on
  // every tier, so this construction is the only source of a browser URL.
  it('round-trips a spaced project back to %20 without double-encoding', () => {
    expect(buildAzurePrWebUrl(AKWISE, 1343)).toBe(
      'https://dev.azure.com/SOA-DCCED/AOGCC%20AKWISE/_git/AKWISE/pullrequest/1343',
    );
  });

  it('produces a URL the shared parser can read the number back out of', async () => {
    const { prNumberFromUrl } = await import('../../src/shared/pr-url');
    expect(prNumberFromUrl(buildAzurePrWebUrl(AKWISE, 1343))).toBe(1343);
  });

  it('parses back to the same remote triple', () => {
    const url = buildAzurePrWebUrl(AKWISE, 1343).replace('/pullrequest/1343', '');
    expect(parseAzureRemote(url)).toEqual(AKWISE);
  });
});
