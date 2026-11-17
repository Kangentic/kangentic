/**
 * How the Jira mapper turns rendered HTML into an imported body. What a user
 * loses if these break: a Data Center site behind a context path imports images
 * from a doubled path that 404s, a Cloud image is not made absolute, and an inline
 * thumbnail is also saved as a separate file attachment. Also the shared comments
 * section every provider folds in.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isReady: () => true }, safeStorage: {}, ipcMain: { handle: vi.fn() } }));

import { mapJiraIssues, type JiraIssueRaw } from '../../src/main/boards/adapters/jira/mapper';
import { formatCommentsSection } from '../../src/main/boards/shared/comments-section';

function mapOne(site: string, issue: JiraIssueRaw) {
  return mapJiraIssues([issue], { site, alreadyImported: new Set() })[0];
}

describe('mapJiraIssues relative URLs', () => {
  it('prefixes a Data Center root-relative URL with the origin, never doubling the context path', () => {
    const issue = mapOne('https://example.com/jira', {
      id: '1',
      key: 'ENG-1',
      renderedFields: { description: '<p><img src="/jira/secure/attachment/10001/a.png"></p>' },
    });
    expect(issue.body).toContain('https://example.com/jira/secure/attachment/10001/a.png');
    expect(issue.body).not.toContain('/jira/jira/');
  });

  it('prefixes a Cloud root-relative URL with the site', () => {
    const site = 'https://acme.atlassian.net';
    const issue = mapOne(site, {
      id: '2',
      key: 'ENG-2',
      renderedFields: { description: '<p><img src="/rest/api/3/attachment/content/20002"></p>' },
    });
    expect(issue.body).toContain(`${site}/rest/api/3/attachment/content/20002`);
  });
});

describe('mapJiraIssues inline attachments', () => {
  it('leaves a Data Center inline thumbnail out of the file attachments and keeps the others', () => {
    const issue = mapOne('https://example.com', {
      id: '3',
      key: 'ENG-3',
      renderedFields: { description: '<p><img src="/secure/thumbnail/10001/_thumb_10001.png"></p>' },
      fields: {
        attachment: [
          { id: '10001', filename: 'a.png', size: 5, content: 'https://example.com/secure/attachment/10001/a.png' },
          { id: '10002', filename: 'b.pdf', size: 7, content: 'https://example.com/secure/attachment/10002/b.pdf' },
        ],
      },
    });
    expect(issue.fileAttachments?.map((attachment) => attachment.externalRef)).toEqual(['10002']);
    expect(issue.attachmentCount).toBe(2);
  });
});

describe('formatCommentsSection', () => {
  it('names a null or blank author Unknown', () => {
    const section = formatCommentsSection([
      { author: null, createdAt: '2026-11-12T15:07:00.000Z', html: '<p>first</p>' },
      { author: '   ', createdAt: '2026-11-12T15:07:00.000Z', html: '<p>second</p>' },
    ]);
    expect(section.match(/^### Unknown - /gm)).toHaveLength(2);
  });

  it('renders a Comments heading, then each comment as an author heading over its Markdown body', () => {
    const section = formatCommentsSection([
      { author: ' Ada ', createdAt: '2026-11-12T15:07:00.000Z', html: '<p>hello <strong>there</strong></p>' },
    ]);
    const lines = section.split('\n');
    expect(lines[0]).toBe('## Comments');
    expect(lines[1]).toBe('');
    expect(lines[2]).toMatch(/^### Ada - .*2026/);
    expect(lines[3]).toBe('');
    expect(lines[4]).toBe('hello **there**');
  });
});
