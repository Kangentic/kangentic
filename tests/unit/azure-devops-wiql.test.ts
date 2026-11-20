import { describe, it, expect, beforeAll } from 'vitest';
import { buildWiqlQuery, buildWorkItemIdsWiql, escapeWiqlString } from '../../src/main/boards/adapters/azure-devops/wiql';

describe('WIQL query building', () => {
  describe('escapeWiqlString', () => {
    it('escapes single quotes by doubling them', () => {
      expect(escapeWiqlString("O'Brien")).toBe("O''Brien");
    });

    it('handles multiple single quotes', () => {
      expect(escapeWiqlString("it's a 'test'")).toBe("it''s a ''test''");
    });

    it('passes through strings without single quotes', () => {
      expect(escapeWiqlString('normal string')).toBe('normal string');
    });

    it('handles empty string', () => {
      expect(escapeWiqlString('')).toBe('');
    });
  });

  describe('buildWiqlQuery', () => {
    it('builds a base query with project filter only', () => {
      const query = buildWiqlQuery('MyProject');
      expect(query).toContain(`[System.TeamProject] = 'MyProject'`);
      expect(query).toContain('FROM WorkItems');
      // By id, so the client can page past az's 1000-item cap.
      expect(query).toContain('ORDER BY [System.Id]');
      expect(query).not.toContain('[System.Id] >');
    });

    it('adds the page condition for the ids past the last page', () => {
      const query = buildWiqlQuery('MyProject', 'all', undefined, undefined, undefined, 4821);
      expect(query).toContain(`[System.TeamProject] = 'MyProject' AND [System.Id] > 4821`);
      expect(query).toMatch(/ORDER BY \[System\.Id\]$/);
    });

    it('adds open-state filter', () => {
      const query = buildWiqlQuery('MyProject', 'open');
      expect(query).toContain(`[System.State] NOT IN ('Closed', 'Done', 'Removed', 'Resolved')`);
    });

    it('adds closed-state filter', () => {
      const query = buildWiqlQuery('MyProject', 'closed');
      expect(query).toContain(`[System.State] IN ('Closed', 'Done', 'Removed', 'Resolved')`);
    });

    it('adds title search filter and trims whitespace', () => {
      const query = buildWiqlQuery('MyProject', undefined, '  bug fix  ');
      expect(query).toContain(`[System.Title] CONTAINS 'bug fix'`);
    });

    it('adds iteration-path filter with UNDER operator', () => {
      const query = buildWiqlQuery('MyProject', undefined, undefined, 'MyProject\\Sprint 1');
      expect(query).toContain(`[System.IterationPath] UNDER 'MyProject\\Sprint 1'`);
    });

    it('escapes single quotes in project name', () => {
      const query = buildWiqlQuery("Cust'om");
      expect(query).toContain(`[System.TeamProject] = 'Cust''om'`);
    });

    it('ignores empty or whitespace-only search queries', () => {
      const query = buildWiqlQuery('MyProject', undefined, '   ');
      expect(query).not.toContain('[System.Title] CONTAINS');
    });

    // Sentry DESKTOP-47: `az boards query` runs WIQL at day precision, and the
    // server refuses a literal with a time ("You cannot supply a time with the
    // date when running a query using date precision"). The watermark goes out
    // date-only, one day early so any time zone the server reads it in is covered.
    it('writes the changed-since watermark as a date-only literal one day earlier', () => {
      const query = buildWiqlQuery('MyProject', 'all', undefined, undefined, '2026-01-02T03:04:05.000Z');
      expect(query).toContain(`[System.ChangedDate] >= '2026-01-01'`);
      expect(query).not.toMatch(/\[System\.ChangedDate\] >= '[^']*T/);
    });

    it('takes the day before from the UTC date, across a month boundary', () => {
      const query = buildWiqlQuery('MyProject', 'all', undefined, undefined, '2026-03-01T00:30:00.000Z');
      expect(query).toContain(`[System.ChangedDate] >= '2026-02-28'`);
    });

    it('drops the changed-since filter for a watermark that does not parse', () => {
      const query = buildWiqlQuery('MyProject', 'all', undefined, undefined, 'not-a-date');
      expect(query).not.toContain('[System.ChangedDate] >=');
    });

    it('omits the changed-since filter when not given', () => {
      const query = buildWiqlQuery('MyProject', 'open');
      // The SELECT/ORDER BY always mention ChangedDate; the FILTER (>=) must not appear.
      expect(query).not.toContain('[System.ChangedDate] >=');
    });

    it('ignores an empty changed-since watermark', () => {
      const query = buildWiqlQuery('MyProject', undefined, undefined, undefined, '   ');
      expect(query).not.toContain('[System.ChangedDate] >=');
    });
  });

  describe('an afterId that is not a safe integer', () => {
    it.each([Number.NaN, 1.5, Number.POSITIVE_INFINITY, 2 ** 60])('is ignored by both builders (%s)', (afterId) => {
      expect(buildWiqlQuery('MyProject', 'all', undefined, undefined, undefined, afterId)).not.toContain('[System.Id] >');
      expect(buildWorkItemIdsWiql('MyProject', undefined, afterId)).not.toContain('[System.Id] >');
    });
  });

  describe('buildWorkItemIdsWiql', () => {
    it('selects only the id, filtered by project', () => {
      const query = buildWorkItemIdsWiql('MyProject');
      expect(query).toContain('SELECT [System.Id]');
      expect(query).toContain(`[System.TeamProject] = 'MyProject'`);
      expect(query).not.toContain('[System.State]');
      expect(query).not.toContain('[System.Title]');
    });

    it('adds an iteration-path filter when given', () => {
      const query = buildWorkItemIdsWiql('MyProject', 'MyProject\\Sprint 1');
      expect(query).toContain(`[System.IterationPath] UNDER 'MyProject\\Sprint 1'`);
    });

    it('adds the page condition for the ids past the last page', () => {
      const query = buildWorkItemIdsWiql('MyProject', undefined, 1000);
      expect(query).toContain(`[System.TeamProject] = 'MyProject' AND [System.Id] > 1000`);
      expect(query).toMatch(/ORDER BY \[System\.Id\]$/);
    });
  });
});

describe('GitHub URL parsers', () => {
  // Test the GitHub URL parsers that were moved to their own file
  let parseGitHubIssuesUrl: (url: string) => { repository: string };
  let parseGitHubProjectsUrl: (url: string) => { repository: string };
  let buildGitHubLabel: (repository: string) => string;

  beforeAll(async () => {
    const issuesModule = await import('../../src/main/boards/adapters/github-issues/url-parser');
    const projectsModule = await import('../../src/main/boards/adapters/github-projects/url-parser');
    parseGitHubIssuesUrl = issuesModule.parseGitHubIssuesUrl;
    parseGitHubProjectsUrl = projectsModule.parseGitHubProjectsUrl;
    buildGitHubLabel = issuesModule.buildGitHubLabel;
  });

  describe('parseGitHubIssuesUrl', () => {
    it('parses a basic repo URL', () => {
      expect(parseGitHubIssuesUrl('https://github.com/owner/repo')).toEqual({ repository: 'owner/repo' });
    });

    it('parses a repo URL with /issues suffix', () => {
      expect(parseGitHubIssuesUrl('https://github.com/owner/repo/issues')).toEqual({ repository: 'owner/repo' });
    });

    it('parses a repo URL with /pulls suffix', () => {
      expect(parseGitHubIssuesUrl('https://github.com/owner/repo/pulls')).toEqual({ repository: 'owner/repo' });
    });

    it('throws for an org projects URL', () => {
      expect(() => parseGitHubIssuesUrl('https://github.com/orgs/myorg/projects/1')).toThrow('Invalid GitHub repository URL');
    });

    it('throws for a non-GitHub URL', () => {
      expect(() => parseGitHubIssuesUrl('https://gitlab.com/owner/repo')).toThrow('Invalid GitHub repository URL');
    });
  });

  describe('parseGitHubProjectsUrl', () => {
    it('parses an org projects URL', () => {
      expect(parseGitHubProjectsUrl('https://github.com/orgs/myorg/projects/42')).toEqual({ repository: 'myorg/42' });
    });

    it('parses a user projects URL', () => {
      expect(parseGitHubProjectsUrl('https://github.com/users/myuser/projects/5')).toEqual({ repository: 'myuser/5' });
    });

    it('throws for a repo URL', () => {
      expect(() => parseGitHubProjectsUrl('https://github.com/owner/repo')).toThrow('Invalid GitHub Projects URL');
    });
  });

  describe('buildGitHubLabel', () => {
    it('returns the repository identifier as-is', () => {
      expect(buildGitHubLabel('owner/repo')).toBe('owner/repo');
    });
  });
});
