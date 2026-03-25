import { describe, it, expect } from 'vitest';
import { parseAzureDevOpsUrl, buildAzureDevOpsLabel } from '../../src/main/import/azure-devops/url-parser';

describe('parseAzureDevOpsUrl', () => {
  describe('modern format (dev.azure.com)', () => {
    it('parses a plain project URL', () => {
      const result = parseAzureDevOpsUrl('https://dev.azure.com/MyOrg/MyProject');
      expect(result.repository).toBe('MyOrg/MyProject');
    });

    it('parses a URL with trailing path segments', () => {
      const result = parseAzureDevOpsUrl('https://dev.azure.com/MyOrg/MyProject/_boards/board/t/MyTeam/Stories');
      expect(result.repository).toBe('MyOrg/MyProject');
    });

    it('parses a sprint taskboard URL with iteration path', () => {
      const result = parseAzureDevOpsUrl('https://dev.azure.com/OklahomaDev/OCC/_sprints/taskboard/OCC%20OKIES/OCC/OCC-OKIES/2026-06');
      expect(result.repository).toBe('OklahomaDev/OCC::OCC\\OCC-OKIES\\2026-06');
    });

    it('parses a sprint backlog URL with iteration path', () => {
      const result = parseAzureDevOpsUrl('https://dev.azure.com/MyOrg/MyProject/_sprints/backlog/MyTeam/MyProject/Sprint1');
      expect(result.repository).toBe('MyOrg/MyProject::MyProject\\Sprint1');
    });

    it('parses a sprint capacity URL with iteration path', () => {
      const result = parseAzureDevOpsUrl('https://dev.azure.com/MyOrg/MyProject/_sprints/capacity/MyTeam/MyProject/Sprint1');
      expect(result.repository).toBe('MyOrg/MyProject::MyProject\\Sprint1');
    });

    it('parses a sprint URL without specific iteration (team root)', () => {
      const result = parseAzureDevOpsUrl('https://dev.azure.com/OklahomaDev/OCC/_sprints/taskboard/OCC%20OKIES/OCC/OCC-OKIES');
      expect(result.repository).toBe('OklahomaDev/OCC::OCC\\OCC-OKIES');
    });

    it('decodes URL-encoded org and project names', () => {
      const result = parseAzureDevOpsUrl('https://dev.azure.com/My%20Org/My%20Project');
      expect(result.repository).toBe('My Org/My Project');
    });

    it('parses a work item edit URL (no iteration)', () => {
      const result = parseAzureDevOpsUrl('https://dev.azure.com/MyOrg/MyProject/_workitems/edit/12345');
      expect(result.repository).toBe('MyOrg/MyProject');
    });

    it('strips trailing slashes', () => {
      const result = parseAzureDevOpsUrl('https://dev.azure.com/MyOrg/MyProject/');
      expect(result.repository).toBe('MyOrg/MyProject');
    });
  });

  describe('legacy format (visualstudio.com)', () => {
    it('parses a plain project URL', () => {
      const result = parseAzureDevOpsUrl('https://myorg.visualstudio.com/MyProject');
      expect(result.repository).toBe('myorg/MyProject');
    });

    it('parses a URL with trailing path segments', () => {
      const result = parseAzureDevOpsUrl('https://myorg.visualstudio.com/MyProject/_boards');
      expect(result.repository).toBe('myorg/MyProject');
    });
  });

  describe('error cases', () => {
    it('throws for a non-Azure DevOps URL', () => {
      expect(() => parseAzureDevOpsUrl('https://github.com/owner/repo')).toThrow('Invalid Azure DevOps URL');
    });

    it('throws for a plain domain with no project', () => {
      expect(() => parseAzureDevOpsUrl('https://dev.azure.com/MyOrg')).toThrow('Invalid Azure DevOps URL');
    });
  });
});

describe('buildAzureDevOpsLabel', () => {
  it('returns repository as-is for project-scoped sources', () => {
    expect(buildAzureDevOpsLabel('MyOrg/MyProject')).toBe('MyOrg/MyProject');
  });

  it('builds a human-readable label for iteration-scoped sources', () => {
    expect(buildAzureDevOpsLabel('OklahomaDev/OCC::OCC\\OCC-OKIES\\2026-06')).toBe('OCC / OCC-OKIES/2026-06');
  });

  it('strips the project prefix from the iteration display', () => {
    expect(buildAzureDevOpsLabel('MyOrg/MyProject::MyProject\\Sprint1')).toBe('MyProject / Sprint1');
  });

  it('handles iteration path without project prefix', () => {
    expect(buildAzureDevOpsLabel('MyOrg/MyProject::CustomPath\\Sprint1')).toBe('MyProject / CustomPath/Sprint1');
  });
});
