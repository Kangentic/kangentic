import { describe, it, expect, beforeAll } from 'vitest';
import { buildWiqlQuery, escapeWiqlString } from '../../src/main/boards/adapters/azure-devops/wiql';

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
      expect(query).toContain('ORDER BY [System.ChangedDate] DESC');
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
