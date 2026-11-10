import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safeWriteJson } from '../safe-write';
import type { SharedEntry } from './account-support';

/**
 * An account folder holds one account's login and nothing else of its own. Every shared entry is a
 * link or a copy back to the agent's default home, so every conversation stays in one folder that
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
 * - Nothing here deletes a folder's contents.
 */

export type AccountFolderProblemCode = 'link-failed' | 'user-owned' | 'kept-aside' | 'history-private';

export interface AccountFolderProblem {
  entry: string;
  code: AccountFolderProblemCode;
  detail: string;
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
  platform?: NodeJS.Platform;
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

/** True when `child` is `parent` or inside it, by real path, case-insensitive on Windows. */
export function isInsideOrSame(child: string, parent: string, platform: NodeJS.Platform = process.platform): boolean {
  const childPath = comparable(realOrResolved(child), platform);
  const parentPath = comparable(realOrResolved(parent), platform);
  if (childPath === parentPath) return true;
  const relative = path.relative(parentPath, childPath);
  // `..` alone or as the first part leads out; a name that only starts with two dots is inside.
  const leadsOut = relative === '..' || relative.startsWith(`..${path.sep}`);
  return relative !== '' && !leadsOut && !path.isAbsolute(relative);
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
): void {
  if (entry.onlyOn && !entry.onlyOn.includes(platform)) return;
  const source = entryPath(homeRoot, entry.name);
  const target = entryPath(accountRoot, entry.name);
  const fail = (code: AccountFolderProblemCode, detail: string): void => {
    report.problems.push({ entry: entry.name, code, detail });
    if (entry.conversationBearing && (code === 'link-failed' || code === 'user-owned')) {
      report.conversationLinkFailed = true;
    }
  };
  if (!lstatIfPresent(source)) {
    if (!entry.conversationBearing) return;
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
      fail('user-owned', `${target} links somewhere else`);
      return;
    }
    // A dangling link: remove only the link itself.
    try {
      fs.unlinkSync(target);
    } catch {
      fs.rmdirSync(target);
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
    fail('user-owned', `${target} is a file, not a folder`);
    return;
  }
  try {
    ensureParent(target);
    fs.symlinkSync(source, target, platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    fail('link-failed', `Could not link ${target}: ${String(error)}`);
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

function copyFile(
  entry: Extract<SharedEntry, { how: 'copy-file' }>,
  homeRoot: string,
  accountRoot: string,
  report: AccountFolderReport,
): void {
  const source = entryPath(homeRoot, entry.name);
  const target = entryPath(accountRoot, entry.name);
  if (!fs.existsSync(source)) return;
  const fail = (code: AccountFolderProblemCode, detail: string): void => {
    report.problems.push({ entry: entry.name, code, detail });
    if (entry.required) report.conversationLinkFailed = true;
  };
  if (lstatIfPresent(target)?.isSymbolicLink()) {
    fail('user-owned', `${target} is a link`);
    return;
  }
  let content: string;
  try {
    content = fs.readFileSync(source, 'utf8');
  } catch (error) {
    if (entry.required) fail('link-failed', `Could not read ${source}: ${String(error)}`);
    return;
  }
  if (!writeIfChanged(target, entry.transform ? entry.transform(content) : content) && entry.required) fail('link-failed', `Could not copy ${source}`);
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
 * the reader understands; a missing or empty file is an empty object.
 */
function readJsonObject(
  filePath: string,
  parse: (text: string) => Record<string, unknown> | null = parseStrictJsonObject,
): { value: Record<string, unknown>; unreadable: boolean } {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    return { value: {}, unreadable: (error as NodeJS.ErrnoException).code !== 'ENOENT' };
  }
  if (text.trim() === '') return { value: {}, unreadable: false };
  const parsed = parse(text);
  return parsed ? { value: parsed, unreadable: false } : { value: {}, unreadable: true };
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
  for (const entry of input.entries) {
    switch (entry.how) {
      case 'link-dir':
        linkDirectory(entry, homeRoot, accountRoot, platform, report);
        break;
      case 'hardlink-file':
        linkFile(entry, homeRoot, accountRoot, report);
        break;
      case 'copy-file':
        copyFile(entry, homeRoot, accountRoot, report);
        break;
      case 'text': {
        const content = entry.text(input.defaultHome);
        if (content !== null && fs.existsSync(entryPath(homeRoot, entry.name))) {
          writeIfChanged(entryPath(accountRoot, entry.name), content);
        }
        break;
      }
      case 'derive-json': {
        const source = entry.sourcePath ? entry.sourcePath(input.defaultHome) : entryPath(homeRoot, entry.name);
        const target = entry.targetPath ? entry.targetPath(input.accountFolder) : entryPath(accountRoot, entry.name);
        // Read and write inside the CLI's own lock on that file when it has one, so a refresh
        // never straddles the CLI's own read-modify-write.
        const write = (): void => {
          const sourceState = readJsonObject(source, entry.parse);
          if (sourceState.unreadable && entry.required) {
            // Running on defaults in place of the user's own settings is the one thing a
            // required file forbids, so the account waits until the file reads again.
            report.conversationLinkFailed = true;
            report.problems.push({ entry: entry.name, code: 'link-failed', detail: `Could not read ${source}` });
            return;
          }
          const current = readJsonObject(target, entry.parse).value;
          const next = entry.derive(sourceState.value, current);
          if (JSON.stringify(next) !== JSON.stringify(current)) {
            ensureParent(target);
            safeWriteJson(target, next, 'agent_account_state', { mode: 0o600 });
          }
        };
        if (entry.lock) {
          await entry.lock(target, write);
        } else {
          write();
        }
        break;
      }
    }
  }
  return report;
}
