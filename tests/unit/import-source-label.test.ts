import { describe, expect, it } from 'vitest';
import { labelFromSourceText } from '../../src/renderer/components/backlog/import-source-label';

/**
 * A new source's Label starts as the part of its link or folder that names it
 * (#872). A tracker's link carries generic parts and ids after the project's
 * name; the prefill passes over them, or every GitLab source would be labelled
 * "issues" and every Jira board "12".
 */
describe('labelFromSourceText', () => {
  it.each([
    ['https://github.com/acme/web.git', 'web'],
    ['acme/web', 'web'],
    ['https://gitlab.com/acme/web/-/issues', 'web'],
    ['https://acme.atlassian.net/jira/software/projects/WEB/boards/12', 'WEB'],
    ['https://dev.azure.com/acme/web/_workitems', 'web'],
    ['openspec/changes/', 'changes'],
    ['C:\\Users\\dev\\vault\\Notes', 'Notes'],
    // A drive letter is no URL scheme: a folder right under it still names the source.
    ['C:\\Notes', 'Notes'],
    ['D:\\vault\\issues', 'vault'],
    ['https://github.com/acme/web?tab=issues#top', 'web'],
  ])('%s gives %s', (text, label) => {
    expect(labelFromSourceText(text)).toBe(label);
  });

  it('gives nothing for a bare host or an empty field', () => {
    expect(labelFromSourceText('https://github.com')).toBe('');
    expect(labelFromSourceText('   ')).toBe('');
    expect(labelFromSourceText('C:\\')).toBe('');
  });
});
