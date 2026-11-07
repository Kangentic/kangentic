import type { SshDirectoryEntry } from '../../../shared/types';

/**
 * How the Directory field reads what the user has typed (#913): the directory whose folders are suggested, and
 * the part of a name still being typed. Pure, so the typing rules are tested without a browser.
 */

/** The home folder as the host's listing takes it. */
export const HOME_DIRECTORY = '~/';

/** The most suggestions shown at once. The Browse list shows them all. */
export const MAX_SUGGESTIONS = 8;

export interface TypedDirectory {
  /** The directory to list, as typed up to and including its last slash. */
  parent: string;
  /** What follows that slash: the start of a folder's name. */
  tail: string;
}

/**
 * Split typed text at its last slash. Empty text and `~` list the home folder. Text with no slash is a name
 * typed relative to home, which the host reads as a folder in it.
 */
export function splitTypedDirectory(text: string): TypedDirectory {
  const typed = text.trim();
  if (typed === '' || typed === '~') return { parent: HOME_DIRECTORY, tail: '' };
  const lastSlash = typed.lastIndexOf('/');
  if (lastSlash < 0) return { parent: HOME_DIRECTORY, tail: typed };
  return { parent: typed.slice(0, lastSlash + 1), tail: typed.slice(lastSlash + 1) };
}

/** The folders whose names start with what is typed, ignoring case, in the host's order. */
export function matchingFolders(entries: SshDirectoryEntry[], tail: string): SshDirectoryEntry[] {
  const wanted = tail.toLowerCase();
  return entries.filter((entry) => entry.name.toLowerCase().startsWith(wanted));
}

/** The text the field holds after a suggestion is chosen: the folder, ready for the next level to be typed. */
export function chooseFolder(parent: string, entry: SshDirectoryEntry): string {
  return `${parent}${entry.name}/`;
}

/** An absolute directory as the home-relative parts a breadcrumb shows, each with the path it leads to. */
export function breadcrumbOf(directory: string, home: string): Array<{ label: string; path: string }> {
  const root = home.replace(/\/+$/, '');
  const crumbs = [{ label: '~', path: root }];
  if (directory === root || !directory.startsWith(`${root}/`)) return crumbs;
  let walked = root;
  for (const segment of directory.slice(root.length + 1).split('/').filter((part) => part.length > 0)) {
    walked = `${walked}/${segment}`;
    crumbs.push({ label: segment, path: walked });
  }
  return crumbs;
}
