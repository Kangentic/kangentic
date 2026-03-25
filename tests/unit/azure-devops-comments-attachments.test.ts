import { describe, it, expect } from 'vitest';
import { AzureDevOpsImporter, convertHtmlToMarkdown } from '../../src/main/import/azure-devops/azure-devops-importer';
import type { AzureDevOpsComment } from '../../src/main/import/azure-devops/azure-devops-importer';

describe('Azure DevOps comments and attachments', () => {
  const importer = new AzureDevOpsImporter();

  describe('extractFileAttachments', () => {
    it('returns empty array when relations is undefined', () => {
      const result = importer.extractFileAttachments(undefined);
      expect(result).toEqual([]);
    });

    it('returns empty array when no AttachedFile relations exist', () => {
      const relations = [
        { rel: 'System.LinkTypes.Hierarchy-Reverse', url: 'https://dev.azure.com/org/_apis/wit/workitems/1', attributes: {} },
        { rel: 'ArtifactLink', url: 'https://dev.azure.com/org/_apis/build/builds/42', attributes: {} },
      ];
      const result = importer.extractFileAttachments(relations);
      expect(result).toEqual([]);
    });

    it('extracts AttachedFile relations with name and size', () => {
      const relations = [
        {
          rel: 'AttachedFile',
          url: 'https://dev.azure.com/org/_apis/wit/attachments/abc-123',
          attributes: { name: 'report.xlsx', resourceSize: 54321 },
        },
      ];
      const result = importer.extractFileAttachments(relations);
      expect(result).toHaveLength(1);
      expect(result[0].filename).toBe('report.xlsx');
      expect(result[0].sizeBytes).toBe(54321);
    });

    it('appends api-version to attachment URL without query params', () => {
      const relations = [
        {
          rel: 'AttachedFile',
          url: 'https://dev.azure.com/org/_apis/wit/attachments/abc-123',
          attributes: { name: 'file.pdf' },
        },
      ];
      const result = importer.extractFileAttachments(relations);
      expect(result[0].url).toBe('https://dev.azure.com/org/_apis/wit/attachments/abc-123?api-version=7.0');
    });

    it('appends api-version with & when URL already has query params', () => {
      const relations = [
        {
          rel: 'AttachedFile',
          url: 'https://dev.azure.com/org/_apis/wit/attachments/abc-123?fileName=test.docx',
          attributes: { name: 'test.docx', resourceSize: 1000 },
        },
      ];
      const result = importer.extractFileAttachments(relations);
      expect(result[0].url).toBe('https://dev.azure.com/org/_apis/wit/attachments/abc-123?fileName=test.docx&api-version=7.0');
    });

    it('uses fallback filename when name attribute is missing', () => {
      const relations = [
        {
          rel: 'AttachedFile',
          url: 'https://dev.azure.com/org/_apis/wit/attachments/abc-123',
          attributes: {},
        },
      ];
      const result = importer.extractFileAttachments(relations);
      expect(result[0].filename).toMatch(/^attachment_\d+$/);
    });

    it('filters mixed relation types and extracts only AttachedFile', () => {
      const relations = [
        { rel: 'System.LinkTypes.Hierarchy-Reverse', url: 'https://dev.azure.com/org/_apis/wit/workitems/1', attributes: {} },
        { rel: 'AttachedFile', url: 'https://dev.azure.com/org/_apis/wit/attachments/a', attributes: { name: 'a.png', resourceSize: 100 } },
        { rel: 'Hyperlink', url: 'https://example.com', attributes: {} },
        { rel: 'AttachedFile', url: 'https://dev.azure.com/org/_apis/wit/attachments/b', attributes: { name: 'b.pdf', resourceSize: 200 } },
      ];
      const result = importer.extractFileAttachments(relations);
      expect(result).toHaveLength(2);
      expect(result[0].filename).toBe('a.png');
      expect(result[1].filename).toBe('b.pdf');
    });
  });

  describe('mapToExternalIssues with comments', () => {
    const baseItem = {
      id: 42,
      fields: {
        'System.Title': 'Test item',
        'System.Description': '<p>Description text</p>',
        'System.State': 'Active',
        'System.Tags': '',
        'System.CreatedDate': '2026-01-01T00:00:00Z',
        'System.ChangedDate': '2026-01-02T00:00:00Z',
      },
      url: 'https://dev.azure.com/org/_apis/wit/workitems/42',
    };

    it('appends comments section to body when comments exist', () => {
      const commentsMap = new Map<number, AzureDevOpsComment[]>();
      commentsMap.set(42, [
        {
          id: 1,
          text: '<p>This is a comment</p>',
          createdBy: { displayName: 'Alice' },
          createdDate: '2026-03-15T10:30:00Z',
        },
      ]);

      const result = importer.mapToExternalIssues([baseItem], 'org', 'project', new Set(), commentsMap);
      expect(result[0].body).toContain('## Comments');
      expect(result[0].body).toContain('### Alice');
      expect(result[0].body).toContain('This is a comment');
    });

    it('does not append comments section when no comments exist', () => {
      const commentsMap = new Map<number, AzureDevOpsComment[]>();
      const result = importer.mapToExternalIssues([baseItem], 'org', 'project', new Set(), commentsMap);
      expect(result[0].body).not.toContain('## Comments');
    });

    it('renders multiple comments in order', () => {
      const commentsMap = new Map<number, AzureDevOpsComment[]>();
      commentsMap.set(42, [
        { id: 1, text: 'First comment', createdBy: { displayName: 'Alice' }, createdDate: '2026-03-15T10:00:00Z' },
        { id: 2, text: 'Second comment', createdBy: { displayName: 'Bob' }, createdDate: '2026-03-15T11:00:00Z' },
      ]);

      const result = importer.mapToExternalIssues([baseItem], 'org', 'project', new Set(), commentsMap);
      const body = result[0].body;
      const aliceIndex = body.indexOf('### Alice');
      const bobIndex = body.indexOf('### Bob');
      expect(aliceIndex).toBeLessThan(bobIndex);
      expect(body).toContain('First comment');
      expect(body).toContain('Second comment');
    });

    it('converts HTML in comment text to markdown', () => {
      const commentsMap = new Map<number, AzureDevOpsComment[]>();
      commentsMap.set(42, [
        { id: 1, text: '<p>Check <strong>this</strong> out</p>', createdBy: { displayName: 'Alice' }, createdDate: '2026-03-15T10:00:00Z' },
      ]);

      const result = importer.mapToExternalIssues([baseItem], 'org', 'project', new Set(), commentsMap);
      expect(result[0].body).toContain('Check **this** out');
    });

    it('handles comment with missing createdBy gracefully', () => {
      const commentsMap = new Map<number, AzureDevOpsComment[]>();
      commentsMap.set(42, [
        { id: 1, text: 'orphan comment', createdBy: undefined as unknown as { displayName: string }, createdDate: '2026-03-15T10:00:00Z' },
      ]);

      const result = importer.mapToExternalIssues([baseItem], 'org', 'project', new Set(), commentsMap);
      expect(result[0].body).toContain('### Unknown');
    });
  });

  describe('mapToExternalIssues with file attachments', () => {
    const baseItem = {
      id: 42,
      fields: {
        'System.Title': 'Test item',
        'System.Description': '<p>Description</p>',
        'System.State': 'Active',
        'System.Tags': '',
        'System.CreatedDate': '2026-01-01T00:00:00Z',
        'System.ChangedDate': '2026-01-02T00:00:00Z',
      },
      url: 'https://dev.azure.com/org/_apis/wit/workitems/42',
    };

    it('includes file attachments from relations in the result', () => {
      const relationsMap = new Map();
      relationsMap.set(42, [
        { rel: 'AttachedFile', url: 'https://dev.azure.com/org/_apis/wit/attachments/abc', attributes: { name: 'doc.pdf', resourceSize: 5000 } },
      ]);

      const result = importer.mapToExternalIssues([baseItem], 'org', 'project', new Set(), undefined, relationsMap);
      expect(result[0].fileAttachments).toHaveLength(1);
      expect(result[0].fileAttachments![0].filename).toBe('doc.pdf');
    });

    it('sets fileAttachments to undefined when no AttachedFile relations exist', () => {
      const relationsMap = new Map();
      relationsMap.set(42, [
        { rel: 'Hyperlink', url: 'https://example.com', attributes: {} },
      ]);

      const result = importer.mapToExternalIssues([baseItem], 'org', 'project', new Set(), undefined, relationsMap);
      expect(result[0].fileAttachments).toBeUndefined();
    });

    it('counts both inline images and file attachments in attachmentCount', () => {
      const itemWithImage = {
        ...baseItem,
        fields: {
          ...baseItem.fields,
          'System.Description': '<p>See <img src="https://example.com/img.png" /></p>',
        },
      };
      const relationsMap = new Map();
      relationsMap.set(42, [
        { rel: 'AttachedFile', url: 'https://dev.azure.com/org/_apis/wit/attachments/abc', attributes: { name: 'doc.pdf', resourceSize: 5000 } },
      ]);

      const result = importer.mapToExternalIssues([itemWithImage], 'org', 'project', new Set(), undefined, relationsMap);
      // 1 inline image + 1 file attachment = 2
      expect(result[0].attachmentCount).toBe(2);
    });
  });

  describe('convertHtmlToMarkdown for comment content', () => {
    it('converts img tags with alt text to markdown images', () => {
      const html = '<img src="https://dev.azure.com/org/_apis/wit/attachments/abc" alt="screenshot" />';
      const result = convertHtmlToMarkdown(html);
      expect(result).toBe('![screenshot](https://dev.azure.com/org/_apis/wit/attachments/abc)');
    });

    it('converts img tags without alt text to markdown images', () => {
      const html = '<img src="https://example.com/photo.png" />';
      const result = convertHtmlToMarkdown(html);
      expect(result).toBe('![](https://example.com/photo.png)');
    });
  });
});
