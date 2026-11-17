/**
 * Opening an imported item's source: a web link goes to the external opener,
 * a note imported from a vault (a local `.md` file) opens through openPath,
 * since the external opener refuses `file:` by design, and any other local
 * file opens nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isLocalNoteLink, localFilePathOf, openExternalIssueLink } from '../../src/renderer/utils/external-issue-link';

const openPath = vi.fn();
const openExternal = vi.fn();

beforeEach(() => {
  vi.stubGlobal('window', { electronAPI: { shell: { openPath, openExternal } } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  openPath.mockReset();
  openExternal.mockReset();
});

describe('localFilePathOf', () => {
  it('reads a Windows drive path, a POSIX path and a network share', () => {
    expect(localFilePathOf('file:///D:/Notes/Work/Website%20relaunch.md')).toBe('D:/Notes/Work/Website relaunch.md');
    expect(localFilePathOf('file:///home/dev/Notes/a.md')).toBe('/home/dev/Notes/a.md');
    expect(localFilePathOf('file://server/share/a.md')).toBe('//server/share/a.md');
  });

  it('is null for a malformed escape, and that is not a note link either', () => {
    expect(localFilePathOf('file:///x/%zz.md')).toBeNull();
    expect(isLocalNoteLink('file:///x/%zz.md')).toBe(false);
  });

  it('reads the .md extension without regard to case', () => {
    expect(isLocalNoteLink('file:///D:/Notes/A.MD')).toBe(true);
  });

  it('is null for a web link or text', () => {
    expect(localFilePathOf('https://example.com/a.md')).toBeNull();
    expect(localFilePathOf('https://github.com/owner/repo/issues/1')).toBeNull();
    expect(localFilePathOf('not a link')).toBeNull();
  });
});

describe('openExternalIssueLink', () => {
  it('opens a local note with the system app', () => {
    expect(isLocalNoteLink('file:///D:/Notes/a.md')).toBe(true);
    openExternalIssueLink('file:///D:/Notes/a.md');
    expect(openPath).toHaveBeenCalledWith('D:/Notes/a.md');
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('opens nothing for a local file that is not a note', () => {
    expect(isLocalNoteLink('file:///D:/tools/run.exe')).toBe(false);
    openExternalIssueLink('file:///D:/tools/run.exe');
    expect(openPath).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('hands a web link to the external opener', () => {
    openExternalIssueLink('https://linear.app/acme/issue/ENG-1');
    expect(openExternal).toHaveBeenCalledWith('https://linear.app/acme/issue/ENG-1');
    expect(openPath).not.toHaveBeenCalled();
  });
});
