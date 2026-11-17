/**
 * Opening the source of an imported item (`external_url`). Most providers link
 * to a web page, which `shell.openExternal` opens. A note imported from an
 * Obsidian vault links to its `.md` file on this computer, which the external
 * opener refuses by design (`EXTERNAL_OPEN_SCHEMES`), so a local markdown file
 * opens with the system's app for it through `shell.openPath` instead. Any other
 * `file:` link opens nothing: only notes are imported as files.
 */

/** The path a `file:` URL names, or null when the URL is not a local file. */
export function localFilePathOf(url: string): string | null {
  // Most links are web pages; skip the parse for them, since every backlog row asks.
  if (!url.startsWith('file:')) return null;
  let parsed: URL;
  let pathname: string;
  try {
    parsed = new URL(url);
    pathname = decodeURIComponent(parsed.pathname);
  } catch { // report-ok: text that is not a URL, or a path with a malformed escape, is not a local file link
    return null;
  }
  if (parsed.protocol !== 'file:') return null;
  // `file:///D:/Notes/a.md` carries the drive after a leading slash.
  const localPath = /^\/[A-Za-z]:/.test(pathname) ? pathname.slice(1) : pathname;
  return parsed.host ? `//${parsed.host}${localPath}` : localPath;
}

/** A link to a markdown file on this computer: an imported note. */
export function isLocalNoteLink(url: string): boolean {
  return localFilePathOf(url)?.toLowerCase().endsWith('.md') ?? false;
}

export function openExternalIssueLink(url: string): void {
  if (url.startsWith('file:')) {
    const notePath = isLocalNoteLink(url) ? localFilePathOf(url) : null;
    if (notePath) void window.electronAPI.shell.openPath(notePath);
    return;
  }
  void window.electronAPI.shell.openExternal(url);
}
