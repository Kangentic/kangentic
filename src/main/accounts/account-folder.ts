import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safeWriteJson } from '../safe-write';
import type { DeriveContext, SharedEntry } from './account-support';
import { countReplaced, fileParts, hashParts, loadHomeRecord, type HomeRecord } from './home-record';

/**
 * An account folder holds one account's login and, for an `own-dir` entry, a folder the CLI will
 * not write through a link (Claude's `plans`). Every other entry is a link or a copy back to the
 * agent's default home, so every conversation stays in one folder that
 * every account reads and writes (measured with three real Claude accounts: transcripts through a
 * junction, cross-account resume with signed thinking blocks, concurrent writes, and a deleted
 * account folder that never reached a transcript).
 *
 * Rules this file holds:
 * - The default home is always a parameter. Under a test run it must not be the real user home.
 * - The default home's existing files are never moved, renamed or rewritten. The only writes into
 *   it are an empty folder or file a link needs, and entries drained from the account folder
 *   itself, which are merged and never replace anything there (a name clash keeps both).
 * - A conversation-bearing link that cannot be made is reported, and the caller blocks the account.
 * - Nothing here deletes a folder's contents. What it removes is an empty folder a link replaces,
 *   an old link into the default home where an `own-dir` entry goes, and a link Kangentic made
 *   under another default home (`KnownHomes`, the recorded home), which is made again to this one.
 * - Nothing made from an account session is copied back into the default home. A copy or a
 *   derived file still replaces a change made on the account, and says so (`change-replaced`).
 *   Text a person wrote in the account's own file is moved aside first, never written over.
 */

export type AccountFolderProblemCode = 'link-failed' | 'user-owned' | 'kept-aside' | 'history-private' | 'change-replaced';

/**
 * What stood at a `user-owned` entry, in one fixed word: a link to somewhere other than the
 * default home's entry, a file where a folder goes, a link where a file goes, or a link or folder
 * where a file goes.
 */
export type UserOwnedShape = 'link-elsewhere' | 'file' | 'link' | 'not-a-file';

/**
 * Where a link that stood in the way points, by the path it names (never its real path, which
 * collapses a link to an account folder's own link into the home that one points at): inside the
 * CLI's built-in home, inside Kangentic's accounts folder, at the entry in the home this folder's
 * links were last made to, or anywhere else.
 */
export type LinkTargetClass = 'builtin-home' | 'kangentic-account' | 'recorded-home' | 'other';

export interface AccountFolderProblem {
  entry: string;
  code: AccountFolderProblemCode;
  detail: string;
  /** Set on a `user-owned` problem. */
  shape?: UserOwnedShape;
  /** Set on a `user-owned` problem whose entry is a link. */
  linkTarget?: LinkTargetClass;
}

/**
 * Homes a link in an account folder may point into because Kangentic made it under another
 * default home: a launch with an inherited home variable and one without see two default homes,
 * and each run's links point at its own. Parameters, so tests pass temp folders.
 */
export interface KnownHomes {
  /** The CLI's home when no home variable is set (`~/.claude`). */
  builtinHome?: string;
  /** Kangentic's own accounts folder, `<configDir>/accounts`. */
  accountsRoot?: string;
}

export interface AccountFolderReport {
  problems: AccountFolderProblem[];
  /** A conversation-bearing link is missing: the account must not run until it is made. */
  conversationLinkFailed: boolean;
  /** Prompt history could not be shared (another drive), so this account keeps its own. */
  historyPrivate: boolean;
}

export interface ProvisionAccountFolderInput {
  accountFolder: string;
  defaultHome: string;
  /** Each entry's `name` is its path inside a home's data folder (`projects`, `../.agents`). */
  entries: readonly SharedEntry[];
  /** The data folder inside the account folder, when not the folder itself (`.gemini`). */
  accountDataSubfolder?: string;
  /** Homes a link Kangentic made may point into; see `KnownHomes`. Absent: only the recorded home. */
  knownHomes?: KnownHomes;
  platform?: NodeJS.Platform;
}

/** The homes `linkDirectory` and `ownDirectory` judge a link against. */
interface LinkHomes extends KnownHomes {
  /** The default home this folder's links were last made to (`HomeRecord.linkedHome`). */
  recordedHome: string | null;
  /** The account folder being provisioned, so a link's place inside it can be compared. */
  accountFolder: string;
}

/** Kangentic's own accounts folder, `<configDir>/accounts`, which holds `<agent>/<id>` folders. */
export function accountsRootOf(configDir: string): string {
  return path.join(configDir, 'accounts');
}

const KEPT_SUFFIX = '.kangentic-kept';

function lstatIfPresent(filePath: string): fs.Stats | null {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function comparable(filePath: string, platform: NodeJS.Platform): string {
  const resolved = path.resolve(filePath);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function realOrResolved(filePath: string): string {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

/**
 * True when a `path.relative` result stays inside its base. `..` alone or as the first part leads
 * out; a name that only starts with two dots is inside. Another drive or root reads as absolute.
 */
function relativeStaysInside(relative: string): boolean {
  const leadsOut = relative === '..' || relative.startsWith(`..${path.sep}`);
  return !leadsOut && !path.isAbsolute(relative);
}

/** True when `child` is `parent` or inside it, by real path, case-insensitive on Windows. */
export function isInsideOrSame(child: string, parent: string, platform: NodeJS.Platform = process.platform): boolean {
  const childPath = comparable(realOrResolved(child), platform);
  const parentPath = comparable(realOrResolved(parent), platform);
  if (childPath === parentPath) return true;
  const relative = path.relative(parentPath, childPath);
  return relative !== '' && relativeStaysInside(relative);
}

/**
 * True when `child` is `parent` or inside it, by the paths as written, case-insensitive on
 * Windows. Links are not followed: a link's own path says where Kangentic made it point.
 */
export function isLexicallyInside(child: string, parent: string, platform: NodeJS.Platform = process.platform): boolean {
  const relative = path.relative(comparable(parent, platform), comparable(child, platform));
  return relative === '' || relativeStaysInside(relative);
}

function lexicallySame(first: string, second: string, platform: NodeJS.Platform): boolean {
  return comparable(first, platform) === comparable(second, platform);
}

/**
 * A link's target as `readlink` gives it, without Windows' long-path prefix: a junction can read
 * back as `\\?\C:\...`, and one on a share as `\\?\UNC\server\share\...`, which is `\\server\share\...`.
 */
export function withoutLongPathPrefix(target: string): string {
  if (/^\\\\\?\\UNC\\/i.test(target)) return `\\\\${target.slice('\\\\?\\UNC\\'.length)}`;
  return target.replace(/^\\\\\?\\/, '');
}

/** The path a link names, resolved against its folder. Null when it is not a link or cannot be read. */
function namedLinkTarget(link: string): string | null {
  try {
    return path.resolve(path.dirname(link), withoutLongPathPrefix(fs.readlinkSync(link)));
  } catch {
    // report-ok: a link that cannot be read is classed `other`, which keeps the account's link as
    // it was and reports it.
    return null;
  }
}

/**
 * True when `named` is this link's own entry in another account folder: the same path below
 * `<accountsRoot>/<agent>/<id>` that the link has below the account folder being provisioned.
 * A folder further down another account, or another entry there, is not one Kangentic made.
 */
function namesSameEntryInAnotherAccount(named: string, link: string, homes: LinkHomes, platform: NodeJS.Platform): boolean {
  if (!homes.accountsRoot) return false;
  const inFolder = path.relative(comparable(homes.accountFolder, platform), comparable(link, platform)).split(path.sep);
  const underRoot = path.relative(comparable(homes.accountsRoot, platform), comparable(named, platform)).split(path.sep);
  return underRoot.length === inFolder.length + 2 && inFolder.every((part, index) => part === underRoot[index + 2]);
}

/** Where a link points, as a fixed class (`LinkTargetClass`). */
function classifyLinkTarget(named: string | null, entryName: string, homes: LinkHomes, platform: NodeJS.Platform): LinkTargetClass {
  if (!named) return 'other';
  if (homes.builtinHome && isLexicallyInside(named, homes.builtinHome, platform)) return 'builtin-home';
  if (homes.accountsRoot && isLexicallyInside(named, homes.accountsRoot, platform)) return 'kangentic-account';
  if (homes.recordedHome && lexicallySame(named, entryPath(homes.recordedHome, entryName), platform)) return 'recorded-home';
  return 'other';
}

/**
 * How a link that does not point at the current home's entry is judged: where it points, as a
 * class, and whether Kangentic made it under another default home, so it is pointed at the current
 * home's entry instead of blocking the account. Kangentic's are the same entry in the built-in
 * home or in the recorded home, and the same entry of another Kangentic account folder.
 */
function judgeForeignLink(
  link: string,
  entryName: string,
  homes: LinkHomes,
  platform: NodeJS.Platform,
): { linkTarget: LinkTargetClass; kangentic: boolean } {
  const named = namedLinkTarget(link);
  const linkTarget = classifyLinkTarget(named, entryName, homes, platform);
  if (!named) return { linkTarget, kangentic: false };
  switch (linkTarget) {
    case 'builtin-home':
      return { linkTarget, kangentic: homes.builtinHome !== undefined && lexicallySame(named, entryPath(homes.builtinHome, entryName), platform) };
    case 'kangentic-account':
      return { linkTarget, kangentic: namesSameEntryInAnotherAccount(named, link, homes, platform) };
    case 'recorded-home':
      return { linkTarget, kangentic: true };
    case 'other':
      return { linkTarget, kangentic: false };
  }
}

/**
 * Refuses the real user home while tests run. Every test, UI spec and E2E run passes a temp home;
 * a rig that reached the real one once deleted real data, so this is a hard stop, not a warning.
 */
export function refuseRealHomeUnderTest(defaultHome: string): void {
  // E2E runs set NODE_ENV=test; vitest marks its workers with VITEST.
  if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) return;
  const insideTemp = isInsideOrSame(defaultHome, os.tmpdir());
  if (!insideTemp && isInsideOrSame(defaultHome, os.homedir())) {
    throw new Error(`Refusing to provision against a real home folder under test: ${defaultHome}`);
  }
}

/** Why an existing folder cannot become an account, or null when it can. */
export type ExistingFolderRefusal =
  | 'missing'
  | 'is-default-home'
  | 'inside-default-home'
  | 'contains-default-home'
  | 'links-into-default-home';

/**
 * The gate in front of "Use an existing folder", the one path whose entries merge into the
 * default home. Pointing it at the default home, or anything that overlaps or already links into
 * it, would merge the home into itself.
 */
export function checkExistingFolder(
  folder: string,
  defaultHome: string,
  platform: NodeJS.Platform = process.platform,
): ExistingFolderRefusal | null {
  const stat = lstatIfPresent(folder);
  if (!stat || !stat.isDirectory()) return 'missing';
  const folderPath = comparable(realOrResolved(folder), platform);
  const homePath = comparable(realOrResolved(defaultHome), platform);
  if (folderPath === homePath) return 'is-default-home';
  if (isInsideOrSame(folder, defaultHome, platform)) return 'inside-default-home';
  if (isInsideOrSame(defaultHome, folder, platform)) return 'contains-default-home';
  for (const name of fs.readdirSync(folder)) {
    const entryPath = path.join(folder, name);
    const entryStat = lstatIfPresent(entryPath);
    if (entryStat?.isSymbolicLink() && isInsideOrSame(entryPath, defaultHome, platform)) {
      return 'links-into-default-home';
    }
  }
  return null;
}

/** Moves `from`'s entries into `to`, never replacing one. Returns how many it had to keep. */
function mergeTree(from: string, to: string): number {
  let kept = 0;
  for (const name of fs.readdirSync(from)) {
    const source = path.join(from, name);
    const destination = path.join(to, name);
    const destinationStat = lstatIfPresent(destination);
    const sourceStat = lstatIfPresent(source);
    if (!sourceStat) continue;
    try {
      if (!destinationStat) {
        fs.renameSync(source, destination);
      } else if (sourceStat.isDirectory() && destinationStat.isDirectory() && !destinationStat.isSymbolicLink()) {
        kept += mergeTree(source, destination);
      } else {
        kept += 1;
      }
    } catch {
      // A locked entry or another drive: it stays where it is, reported as kept.
      kept += 1;
    }
  }
  return kept;
}

function setAside(target: string): string {
  const aside = `${target}${KEPT_SUFFIX}-${Date.now()}`;
  fs.renameSync(target, aside);
  return aside;
}

/** An entry's path inside a home. Names use `/` between parts on every platform. */
function entryPath(root: string, name: string): string {
  return path.join(root, ...name.split('/'));
}

/** Makes the folder an entry sits in, for an entry below the home's root. */
function ensureParent(target: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
}

function linkDirectory(
  entry: Extract<SharedEntry, { how: 'link-dir' }>,
  homeRoot: string,
  accountRoot: string,
  platform: NodeJS.Platform,
  report: AccountFolderReport,
  homes: LinkHomes,
): void {
  if (entry.onlyOn && !entry.onlyOn.includes(platform)) return;
  const source = entryPath(homeRoot, entry.name);
  const target = entryPath(accountRoot, entry.name);
  const fail = (code: AccountFolderProblemCode, detail: string, facts: Pick<AccountFolderProblem, 'shape' | 'linkTarget'> = {}): void => {
    report.problems.push({ entry: entry.name, code, detail, ...facts });
    if (entry.conversationBearing && (code === 'link-failed' || code === 'user-owned')) {
      report.conversationLinkFailed = true;
    }
  };
  if (!lstatIfPresent(source)) {
    // Made empty in the default home whatever the folder holds. Skipping a setup folder the home
    // lacked left the account a real one, and an agent or command made there reached nobody else.
    // A `../` name is made the same way, beside the home, for the same reason.
    try {
      fs.mkdirSync(source, { recursive: true });
    } catch (error) {
      fail('link-failed', `Could not create ${source}: ${String(error)}`);
      return;
    }
  }
  const current = lstatIfPresent(target);
  if (current?.isSymbolicLink()) {
    let resolved: string | null;
    try {
      resolved = fs.realpathSync.native(target);
    } catch {
      resolved = null;
    }
    if (resolved && comparable(resolved, platform) === comparable(realOrResolved(source), platform)) return;
    if (resolved) {
      const { linkTarget, kangentic } = judgeForeignLink(target, entry.name, homes, platform);
      if (!kangentic) {
        fail('user-owned', `${target} links somewhere else`, { shape: 'link-elsewhere', linkTarget });
        return;
      }
      // A link Kangentic made under another default home (Sentry DESKTOP-4S): pointed at this
      // home's entry. Only the link goes; what it pointed at stays where it is.
      try {
        // Checked again just before: only ever a link, never a folder with files in it.
        if (!lstatIfPresent(target)?.isSymbolicLink()) return;
        removeLinkOnly(target);
      } catch (error) {
        // report-ok: pushed onto the folder report as `link-failed`, which the account service
        // reports, and the account is blocked until a later spawn can replace the link.
        fail('link-failed', `Could not remove the link ${target}: ${String(error)}`);
        return;
      }
    } else {
      // A dangling link: remove only the link itself.
      try {
        fs.unlinkSync(target);
      } catch {
        fs.rmdirSync(target);
      }
    }
  } else if (current?.isDirectory()) {
    // The account's own entries go into the default home, never replacing anything there.
    try {
      const kept = mergeTree(target, source);
      if (kept > 0 || fs.readdirSync(target).length > 0) {
        const aside = setAside(target);
        fail('kept-aside', `${kept} entries already in ${source} were kept at ${aside}`);
      } else {
        fs.rmdirSync(target);
      }
    } catch (error) {
      fail('link-failed', `Could not clear ${target} for its link: ${String(error)}`);
      return;
    }
  } else if (current) {
    fail('user-owned', `${target} is a file, not a folder`, { shape: 'file' });
    return;
  }
  try {
    ensureParent(target);
    fs.symlinkSync(source, target, platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    fail('link-failed', `Could not link ${target}: ${String(error)}`);
  }
}

/** Removes a folder link itself. A junction on Windows may need `rmdir`; neither touches its target. */
function removeLinkOnly(link: string): void {
  try {
    fs.unlinkSync(link);
  } catch (unlinkError) {
    try {
      fs.rmdirSync(link);
    } catch {
      // The first error says why (a locked junction's EBUSY), not the fallback's ENOTDIR.
      throw unlinkError;
    }
  }
}

/**
 * True when the link at `link` points at `homeEntry`. A link whose target cannot be reached (gone,
 * or on a drive that is offline) is judged by the path it names, so only a link that names the
 * home's own entry counts.
 */
function linksTo(link: string, homeEntry: string, platform: NodeJS.Platform): boolean {
  try {
    return comparable(fs.realpathSync.native(link), platform) === comparable(realOrResolved(homeEntry), platform);
  } catch {
    const namedPath = namedLinkTarget(link);
    if (!namedPath) return false;
    const named = comparable(namedPath, platform);
    return named === comparable(homeEntry, platform) || named === comparable(realOrResolved(homeEntry), platform);
  }
}

/**
 * A real folder of the account's own (`own-dir`). Claude refuses to write its plan file through a
 * link: the write resolves outside the folder it is allowed to write in plan mode (task #1070).
 * A link to the default home's folder, as an earlier version made it, is removed as a link and a
 * folder made in its place, so the home's files stay where they are. A link elsewhere is the user's.
 */
function ownDirectory(
  entry: Extract<SharedEntry, { how: 'own-dir' }>,
  homeRoot: string,
  accountRoot: string,
  platform: NodeJS.Platform,
  report: AccountFolderReport,
  homes: LinkHomes,
): void {
  const homeEntry = entryPath(homeRoot, entry.name);
  const target = entryPath(accountRoot, entry.name);
  const current = lstatIfPresent(target);
  if (current?.isSymbolicLink()) {
    if (!linksTo(target, homeEntry, platform)) {
      // A link an earlier version made under another default home is Kangentic's too.
      const { linkTarget, kangentic } = judgeForeignLink(target, entry.name, homes, platform);
      if (!kangentic) {
        report.problems.push({ entry: entry.name, code: 'user-owned', detail: `${target} links somewhere else`, shape: 'link-elsewhere', linkTarget });
        return;
      }
    }
    try {
      // Checked again just before: only ever a link, never a folder with files in it.
      if (!lstatIfPresent(target)?.isSymbolicLink()) return;
      removeLinkOnly(target);
    } catch (error) {
      report.problems.push({ entry: entry.name, code: 'link-failed', detail: `Could not remove the link ${target}: ${String(error)}` });
      return;
    }
  } else if (current?.isDirectory()) {
    return;
  } else if (current) {
    report.problems.push({ entry: entry.name, code: 'user-owned', detail: `${target} is a file, not a folder`, shape: 'file' });
    return;
  }
  try {
    ensureParent(target);
    fs.mkdirSync(target, { mode: 0o700 });
  } catch (error) {
    report.problems.push({ entry: entry.name, code: 'link-failed', detail: `Could not create ${target}: ${String(error)}` });
  }
}

function appendMissingLines(from: string, into: string): void {
  const existing = new Set(fs.readFileSync(into, 'utf8').split('\n'));
  const lines = fs.readFileSync(from, 'utf8').split('\n').filter((line) => line !== '' && !existing.has(line));
  if (lines.length === 0) return;
  const current = fs.readFileSync(into, 'utf8');
  const separator = current.length > 0 && !current.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(into, `${separator}${lines.join('\n')}\n`);
}

function linkFile(
  entry: Extract<SharedEntry, { how: 'hardlink-file' }>,
  homeRoot: string,
  accountRoot: string,
  report: AccountFolderReport,
): void {
  const source = entryPath(homeRoot, entry.name);
  const target = entryPath(accountRoot, entry.name);
  try {
    ensureParent(target);
    if (!lstatIfPresent(source)) fs.writeFileSync(source, '', { flag: 'a', mode: 0o600 });
    const sourceStat = fs.statSync(source, { bigint: true });
    if (fs.statSync(path.dirname(target), { bigint: true }).dev !== sourceStat.dev) {
      if (entry.holds !== 'other') report.historyPrivate = true;
      report.problems.push({ entry: entry.name, code: 'history-private', detail: 'The account folder is on another drive' });
      return;
    }
    const current = lstatIfPresent(target);
    if (current) {
      const targetStat = fs.statSync(target, { bigint: true });
      if (targetStat.ino === sourceStat.ino && targetStat.dev === sourceStat.dev) return;
      appendMissingLines(target, source);
      fs.unlinkSync(target);
    }
    fs.linkSync(source, target);
  } catch (error) {
    if (entry.holds !== 'other') report.historyPrivate = true;
    report.problems.push({ entry: entry.name, code: 'history-private', detail: String(error) });
  }
}

/** True when `target` now holds `content`. */
function writeIfChanged(target: string, content: string): boolean {
  try {
    if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') === content) return true;
  } catch {
    // Unreadable: rewrite it below.
  }
  // A name of its own: two provisions of one account in this process must not share a temp file.
  const temporary = `${target}.tmp.${process.pid}.${randomUUID()}`;
  try {
    ensureParent(target);
    fs.writeFileSync(temporary, content, { mode: 0o600 });
    fs.renameSync(temporary, target);
    return true;
  } catch {
    // A copy that fails keeps the account's previous copy; the next spawn tries again.
    fs.rmSync(temporary, { force: true });
    return false;
  }
}

/** The text of a regular file, or null for anything else: missing, a folder, a link, unreadable. */
function readRegularFile(filePath: string): string | null {
  try {
    return fs.lstatSync(filePath).isFile() ? fs.readFileSync(filePath, 'utf8') : null;
  } catch {
    // report-ok: a file that is missing or cannot be read holds nothing this refresh can judge.
    return null;
  }
}

function copyFile(
  entry: Extract<SharedEntry, { how: 'copy-file' }>,
  homeRoot: string,
  accountRoot: string,
  report: AccountFolderReport,
  record: HomeRecord,
): void {
  const source = entryPath(homeRoot, entry.name);
  const target = entryPath(accountRoot, entry.name);
  if (!fs.existsSync(source)) {
    // Said once: the home holds no such file, so one the account makes is known as its own on
    // the day the home gains one. What the home once held is never forgotten here.
    if (entry.reportReplaced && record.get(entry.name) === undefined) record.set(entry.name, null);
    return;
  }
  const fail = (code: AccountFolderProblemCode, detail: string, facts: Pick<AccountFolderProblem, 'shape'> = {}): void => {
    report.problems.push({ entry: entry.name, code, detail, ...facts });
    if (entry.required) report.conversationLinkFailed = true;
  };
  if (lstatIfPresent(target)?.isSymbolicLink()) {
    fail('user-owned', `${target} is a link`, { shape: 'link' });
    return;
  }
  let content: string;
  try {
    content = fs.readFileSync(source, 'utf8');
  } catch (error) {
    if (entry.required) fail('link-failed', `Could not read ${source}: ${String(error)}`);
    return;
  }
  const next = entry.transform ? entry.transform(content) : content;
  // Parsed once: the same parts are judged against and then recorded.
  const nextParts = entry.reportReplaced ? fileParts(next) : null;
  const held = nextParts ? readRegularFile(target) : null;
  // A copy the account still holds as it was written replaces nothing, so it is not parsed.
  const replaced = nextParts && held !== null && held !== next ? countReplaced(record.get(entry.name), fileParts(held), nextParts) : 0;
  if (!writeIfChanged(target, next)) {
    if (entry.required) fail('link-failed', `Could not copy ${source}`);
    return;
  }
  if (!nextParts) return;
  // Said and recorded only now: a copy that did not land replaced nothing.
  if (replaced > 0) {
    report.problems.push({ entry: entry.name, code: 'change-replaced', detail: `A change made in ${target} was replaced by the default home's copy` });
  }
  record.set(entry.name, hashParts(nextParts));
}

/**
 * A file whose content is built from the default home (Claude's `CLAUDE.md` import line). While
 * the home has no such file, a user-memory edit from an account session makes one in the account
 * folder that only it reads. That text is a person's, so it is moved aside before the content is
 * written, never written over. With nothing recorded the home is taken to have held nothing, so
 * any text that is not the content is kept.
 */
function writeText(
  entry: Extract<SharedEntry, { how: 'text' }>,
  homeRoot: string,
  accountRoot: string,
  report: AccountFolderReport,
  record: HomeRecord,
): void {
  const content = entry.text(homeRoot);
  if (content === null || !fs.existsSync(entryPath(homeRoot, entry.name))) return;
  const target = entryPath(accountRoot, entry.name);
  const contentParts = fileParts(content);
  try {
    // Inside the try: a file that cannot be looked at is reported like one that cannot be moved,
    // and the entries after this one still run.
    const current = lstatIfPresent(target);
    if (current && !current.isFile()) {
      report.problems.push({ entry: entry.name, code: 'user-owned', detail: `${target} is a link or a folder`, shape: 'not-a-file' });
      return;
    }
    if (current) {
      const held = fs.readFileSync(target, 'utf8');
      if (held !== content && countReplaced(record.get(entry.name) ?? null, fileParts(held), contentParts) > 0) {
        const aside = setAside(target);
        report.problems.push({ entry: entry.name, code: 'kept-aside', detail: `The account's own ${entry.name} was kept at ${aside}` });
      }
    }
  } catch (error) {
    // report-ok: pushed onto the folder report, which the account service reports. The file
    // is left as it is, and the next spawn tries again.
    report.problems.push({ entry: entry.name, code: 'link-failed', detail: `Could not keep ${target} aside: ${String(error)}` });
    return;
  }
  if (writeIfChanged(target, content)) record.set(entry.name, hashParts(contentParts));
}

function parseStrictJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * A JSON file as an object. `unreadable` is a file that exists, holds text, and is not an object
 * the reader understands; a missing or empty file is an empty object. `answered` is a file that
 * was read and holds something. A missing file, an empty one and `{}` all come back as the same
 * empty object, and only an answer says what the file's home holds.
 */
function readJsonObject(
  filePath: string,
  parse: (text: string) => Record<string, unknown> | null = parseStrictJsonObject,
): { value: Record<string, unknown>; unreadable: boolean; answered: boolean } {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    return { value: {}, unreadable: (error as NodeJS.ErrnoException).code !== 'ENOENT', answered: false };
  }
  if (text.trim() === '') return { value: {}, unreadable: false, answered: false };
  const parsed = parse(text);
  return parsed
    ? { value: parsed, unreadable: false, answered: Object.keys(parsed).length > 0 }
    : { value: {}, unreadable: true, answered: false };
}

/**
 * Builds the account's copy of a JSON file from the default home's. The read and the write run
 * inside the CLI's own lock on that file when it has one, so a refresh never straddles the CLI's
 * own read-modify-write.
 */
async function deriveJson(
  entry: Extract<SharedEntry, { how: 'derive-json' }>,
  input: ProvisionAccountFolderInput,
  homeRoot: string,
  accountRoot: string,
  report: AccountFolderReport,
  record: HomeRecord,
): Promise<void> {
  const source = entry.sourcePath ? entry.sourcePath(input.defaultHome) : entryPath(homeRoot, entry.name);
  const target = entry.targetPath ? entry.targetPath(input.accountFolder) : entryPath(accountRoot, entry.name);
  const write = (): void => {
    const sourceState = readJsonObject(source, entry.parse);
    if (sourceState.unreadable && entry.required) {
      // Running on defaults in place of the user's own settings is the one thing a
      // required file forbids, so the account waits until the file reads again.
      report.conversationLinkFailed = true;
      report.problems.push({ entry: entry.name, code: 'link-failed', detail: `Could not read ${source}` });
      return;
    }
    const accountState = readJsonObject(target, entry.parse);
    const current = accountState.value;
    const userParts = entry.userParts;
    const recorded = userParts ? record.get(entry.name) : undefined;
    // A home file caught missing, empty or half written says nothing about what the home holds:
    // it removes nothing from the account, and the record stays as it was.
    const homeParts = userParts && sourceState.answered ? userParts(sourceState.value) : null;
    const removedFromHome = recorded && homeParts ? Object.keys(recorded).filter((part) => !Object.hasOwn(homeParts, part)) : [];
    const context: DeriveContext = { removedFromHome: new Set(removedFromHome) };
    const next = entry.derive(sourceState.value, current, context);
    let replaced = 0;
    if (JSON.stringify(next) !== JSON.stringify(current)) {
      // Judged only for a write, which is the only thing that replaces anything, and only against
      // an account file that held something. One that is missing, empty or unreadable holds no
      // change of the account's, and every part the home held would read as one it removed.
      if (userParts && accountState.answered) replaced = countReplaced(recorded, userParts(current), userParts(next));
      ensureParent(target);
      // A write that did not land replaced nothing, and the record must not say it did.
      if (!safeWriteJson(target, next, 'agent_account_state', { mode: 0o600 })) return;
    }
    if (replaced > 0) {
      report.problems.push({ entry: entry.name, code: 'change-replaced', detail: `${replaced} parts changed in ${target} were replaced by the default home's` });
    }
    if (homeParts) record.set(entry.name, hashParts(homeParts));
  };
  if (entry.lock) {
    await entry.lock(target, write);
  } else {
    write();
  }
}

/**
 * Makes (or re-makes) an account folder's links and copies. Safe to run before every spawn: a
 * link already in place is left alone, a copy is rewritten only when it changed.
 */
export async function provisionAccountFolder(input: ProvisionAccountFolderInput): Promise<AccountFolderReport> {
  const platform = input.platform ?? process.platform;
  refuseRealHomeUnderTest(input.defaultHome);
  if (isInsideOrSame(input.accountFolder, input.defaultHome, platform) || isInsideOrSame(input.defaultHome, input.accountFolder, platform)) {
    throw new Error(`An account folder cannot overlap the default home: ${input.accountFolder}`);
  }
  const homeRoot = input.defaultHome;
  const accountRoot = input.accountDataSubfolder ? path.join(input.accountFolder, input.accountDataSubfolder) : input.accountFolder;
  const report: AccountFolderReport = { problems: [], conversationLinkFailed: false, historyPrivate: false };
  try {
    fs.mkdirSync(homeRoot, { recursive: true });
    fs.mkdirSync(accountRoot, { recursive: true, mode: 0o700 });
  } catch (error) {
    report.conversationLinkFailed = true;
    report.problems.push({ entry: '.', code: 'link-failed', detail: String(error) });
    return report;
  }
  // Kept in the account folder itself, the one path checked above against the default home.
  const record = loadHomeRecord(input.accountFolder);
  const homes: LinkHomes = { ...input.knownHomes, recordedHome: record.linkedHome(), accountFolder: input.accountFolder };
  try {
    for (const entry of input.entries) {
      switch (entry.how) {
        case 'link-dir':
          linkDirectory(entry, homeRoot, accountRoot, platform, report, homes);
          break;
        case 'own-dir':
          ownDirectory(entry, homeRoot, accountRoot, platform, report, homes);
          break;
        case 'hardlink-file':
          linkFile(entry, homeRoot, accountRoot, report);
          break;
        case 'copy-file':
          copyFile(entry, homeRoot, accountRoot, report, record);
          break;
        case 'text':
          writeText(entry, homeRoot, accountRoot, report, record);
          break;
        case 'derive-json':
          await deriveJson(entry, input, homeRoot, accountRoot, report, record);
          break;
      }
    }
    // The home every link now points at, so a launch under another default home knows them as
    // Kangentic's. Only when every link is in place: a blocked folder still points elsewhere.
    if (!report.conversationLinkFailed && input.entries.some((entry) => entry.how === 'link-dir' || entry.how === 'own-dir')) {
      record.setLinkedHome(path.resolve(homeRoot));
    }
  } finally {
    // Also when a derive throws at its lock, so the entries written before it stay recorded.
    record.save();
  }
  return report;
}
