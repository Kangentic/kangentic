/**
 * Jira link and JQL parsing, site normalization, and the JQL the incremental
 * fetch sends. What a user loses if these break: a pasted Jira link saves the
 * wrong source (or none), a Data Center site behind a context path is called at
 * the wrong address, and an incremental refresh misses items or breaks a query
 * that ends in ORDER BY.
 */
import { describe, expect, it } from 'vitest';
import {
  buildJiraLabel,
  decodeJiraRepository,
  encodeJiraRepository,
  isJiraRepository,
  parseJiraInput,
} from '../../src/main/boards/adapters/jira/url-parser';
import { RefusalError } from '../../src/shared/refusal';
import { detectDeployment, normalizeSiteBase, siteBaseFromUrl } from '../../src/main/boards/adapters/jira/site';
import { formatJqlInstant, splitOrderBy, withUpdatedSince } from '../../src/main/boards/adapters/jira/jql';

function parsed(text: string) {
  return decodeJiraRepository(parseJiraInput(text).repository);
}

describe('parseJiraInput', () => {
  it('reads a team-managed and a company-managed board link', () => {
    expect(parsed('https://acme.atlassian.net/jira/software/projects/ENG/boards/12'))
      .toEqual({ site: 'https://acme.atlassian.net', kind: 'board', value: '12' });
    expect(parsed('https://acme.atlassian.net/jira/software/c/projects/ENG/boards/7/backlog?selectedIssue=ENG-142'))
      .toEqual({ site: 'https://acme.atlassian.net', kind: 'board', value: '7' });
  });

  it('reads a Data Center RapidBoard link and keeps its context path', () => {
    expect(parsed('https://example.com/jira/secure/RapidBoard.jspa?rapidView=12'))
      .toEqual({ site: 'https://example.com/jira', kind: 'board', value: '12' });
  });

  it('reads a saved filter and a search link', () => {
    expect(parsed('https://acme.atlassian.net/issues/?filter=10021'))
      .toEqual({ site: 'https://acme.atlassian.net', kind: 'filter', value: '10021' });
    expect(parsed('https://acme.atlassian.net/issues/?jql=project%20%3D%20ENG%20ORDER%20BY%20created'))
      .toEqual({ site: 'https://acme.atlassian.net', kind: 'jql', value: 'project = ENG ORDER BY created' });
  });

  it('reads a project from a project link and from an issue link', () => {
    expect(parsed('https://acme.atlassian.net/browse/ENG')).toEqual({ site: 'https://acme.atlassian.net', kind: 'project', value: 'ENG' });
    expect(parsed('https://acme.atlassian.net/browse/ENG-142').value).toBe('ENG');
    expect(parsed('https://acme.atlassian.net/jira/software/projects/eng/list').value).toBe('ENG');
  });

  it('reads a link pasted without its scheme', () => {
    expect(parsed('acme.atlassian.net/browse/ENG')).toEqual({ site: 'https://acme.atlassian.net', kind: 'project', value: 'ENG' });
  });

  it('treats text that is not a link as typed JQL with no site yet', () => {
    expect(parsed('project = ENG AND sprint in openSprints()'))
      .toEqual({ site: '', kind: 'jql', value: 'project = ENG AND sprint in openSprints()' });
  });

  it('reads a scheme-less intranet host with a port as a link, not as JQL', () => {
    expect(parsed('jira:8080/browse/ENG-1')).toEqual({ site: 'https://jira:8080', kind: 'project', value: 'ENG' });
    expect(parsed('localhost:8080/secure/RapidBoard.jspa?rapidView=3'))
      .toEqual({ site: 'https://localhost:8080', kind: 'board', value: '3' });
  });

  it('still reads a JQL clause with a function call as JQL', () => {
    expect(parsed('assignee = currentUser()')).toEqual({ site: '', kind: 'jql', value: 'assignee = currentUser()' });
  });

  it('refuses a link that names no board, project, filter or search', () => {
    expect(() => parseJiraInput('https://acme.atlassian.net/jira/your-work')).toThrow(/doesn't name a Jira/);
  });

  it('round-trips a repository whose JQL itself contains the separator', () => {
    const ref = { site: 'https://acme.atlassian.net', kind: 'jql' as const, value: 'text ~ "a::b"' };
    expect(decodeJiraRepository(encodeJiraRepository(ref))).toEqual(ref);
  });

  it('labels a source before the remote names it', () => {
    expect(buildJiraLabel('https://acme.atlassian.net::board::12')).toBe('Board 12');
    expect(buildJiraLabel('https://acme.atlassian.net::jql::project = ENG')).toBe('project = ENG');
  });
});

describe('site normalization', () => {
  it('normalizes a typed host and a pasted link to the base URL', () => {
    expect(normalizeSiteBase('Acme.atlassian.net')).toBe('https://acme.atlassian.net');
    expect(normalizeSiteBase('https://jira.example.com:8443/jira/browse/ENG')).toBe('https://jira.example.com:8443/jira');
    expect(siteBaseFromUrl(new URL('https://acme.atlassian.net/jira/software/projects/ENG/boards/1'))).toBe('https://acme.atlassian.net');
  });

  it('keeps an intranet Data Center site: a one-label host, http, a port, an address', () => {
    expect(normalizeSiteBase('http://jira:8080/browse/ENG-1')).toBe('http://jira:8080');
    expect(normalizeSiteBase('http://10.0.0.5:8080/jira/browse/ENG-1')).toBe('http://10.0.0.5:8080/jira');
    expect(normalizeSiteBase('jira:8080')).toBe('https://jira:8080');
    expect(parsed('http://jira:8080/secure/RapidBoard.jspa?rapidView=3'))
      .toEqual({ site: 'http://jira:8080', kind: 'board', value: '3' });
  });

  it('upgrades a typed http:// Cloud host to https, and keeps http for a Data Center host', () => {
    expect(normalizeSiteBase('http://acme.atlassian.net')).toBe('https://acme.atlassian.net');
    expect(normalizeSiteBase('http://jira.example.com:8080')).toBe('http://jira.example.com:8080');
  });

  it('refuses text that is not a site', () => {
    expect(() => normalizeSiteBase('')).toThrow();
    expect(() => normalizeSiteBase('not a site')).toThrow();
  });

  it('keeps the context path of a typed Data Center base and drops its trailing slash', () => {
    expect(normalizeSiteBase('example.com/jira')).toBe('https://example.com/jira');
    expect(normalizeSiteBase('https://example.com/jira/')).toBe('https://example.com/jira');
  });

  it('gives a typed base the same site a pasted link on that site saves, so the credential key matches', () => {
    const linkSite = parsed('https://example.com/jira/browse/ENG-1').site;
    expect(normalizeSiteBase('https://example.com/jira/')).toBe(linkSite);
    expect(normalizeSiteBase('example.com/jira')).toBe(linkSite);
  });

  it('reduces a Cloud host typed with a path to its bare origin', () => {
    expect(normalizeSiteBase('acme.atlassian.net/jira/software/projects/ENG/boards/12')).toBe('https://acme.atlassian.net');
  });
});

describe('IPv6 Data Center sites', () => {
  it('round-trips a source whose site has :: in its host', () => {
    const ref = { site: 'http://[::1]:8080', kind: 'board' as const, value: '12' };
    expect(decodeJiraRepository(encodeJiraRepository(ref))).toEqual(ref);
  });

  it('reads a pasted link on an IPv6 site', () => {
    expect(parsed('http://[::1]:8080/browse/ENG-1'))
      .toEqual({ site: 'http://[::1]:8080', kind: 'project', value: 'ENG' });
  });
});

describe('isJiraRepository', () => {
  it('is true for a saved source string, whatever its kind', () => {
    expect(isJiraRepository('https://acme.atlassian.net::board::12')).toBe(true);
    expect(isJiraRepository('::jql::project = ENG')).toBe(true);
  });

  it('is false for a pasted link, including one on an IPv6 site', () => {
    expect(isJiraRepository('https://acme.atlassian.net/browse/ENG-1')).toBe(false);
    expect(isJiraRepository('http://[::1]:8080/browse/ENG-1')).toBe(false);
  });
});

describe('decodeJiraRepository with separators in the value', () => {
  it('keeps a kind segment that sits inside the JQL', () => {
    const site = 'https://acme.atlassian.net';
    const value = 'summary ~ "a::board::b"';
    expect(decodeJiraRepository(`${site}::jql::${value}`)).toEqual({ site, kind: 'jql', value });
  });
});

describe('parseJiraInput with text shaped like a link that does not parse', () => {
  it.each(['http://', 'https://exa mple'])('refuses %s with the no-source refusal, not a TypeError', (text) => {
    let thrown: unknown;
    try {
      parseJiraInput(text);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RefusalError);
    expect((thrown as RefusalError).message).toBe("That link doesn't name a Jira board, project, filter or search.");
  });
});

describe('detectDeployment', () => {
  const answer = (body: unknown, ok = true) => (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;

  it('reads deploymentType from the anonymous serverInfo', async () => {
    expect(await detectDeployment('https://jira.example.com', answer({ deploymentType: 'Cloud' }))).toBe('cloud');
    expect(await detectDeployment('https://acme.atlassian.net', answer({ deploymentType: 'Server' }))).toBe('datacenter');
  });

  it('falls back to the host name when a private site will not say', async () => {
    const refused = answer({}, false);
    expect(await detectDeployment('https://acme.atlassian.net', refused)).toBe('cloud');
    expect(await detectDeployment('https://jira.example.com', refused)).toBe('datacenter');
    const unreachable = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    expect(await detectDeployment('https://jira.example.com', unreachable)).toBe('datacenter');
  });
});

describe('incremental JQL', () => {
  it('formats an instant in the signed-in user time zone, not this computer one', () => {
    const instant = new Date('2026-11-12T15:07:00.000Z');
    expect(formatJqlInstant(instant, 'UTC')).toBe('2026/11/12 15:07');
    expect(formatJqlInstant(instant, 'America/New_York')).toBe('2026/11/12 10:07');
  });

  it('formats in UTC when the zone name is unknown instead of throwing', () => {
    const instant = new Date('2026-11-12T15:07:00.000Z');
    expect(formatJqlInstant(instant, 'Not/AZone')).toBe('2026/11/12 15:07');
    expect(withUpdatedSince('project = ENG', '2026-11-12T15:07:00.000Z', 'Not/AZone'))
      .toBe('(project = ENG) AND updated >= "2026/11/12 15:02"');
  });

  it('adds the updated clause before ORDER BY, rewound five minutes', () => {
    expect(withUpdatedSince('project = ENG ORDER BY rank', '2026-11-12T15:07:00.000Z', 'UTC'))
      .toBe('(project = ENG) AND updated >= "2026/11/12 15:02" ORDER BY rank');
    expect(withUpdatedSince('', '2026-11-12T15:07:00.000Z', 'UTC')).toBe('updated >= "2026/11/12 15:02"');
    expect(withUpdatedSince('project = ENG', undefined, 'UTC')).toBe('project = ENG');
  });

  it('splits the ORDER BY clause and ignores the words inside quoted text', () => {
    expect(splitOrderBy('summary ~ "order by" ORDER BY created DESC'))
      .toEqual({ condition: 'summary ~ "order by"', orderBy: 'ORDER BY created DESC' });
    expect(splitOrderBy('ORDER BY created DESC')).toEqual({ condition: '', orderBy: 'ORDER BY created DESC' });
  });
});
