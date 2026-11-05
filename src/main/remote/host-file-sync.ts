/**
 * Keeps the files an agent CLI edits on a remote host in step with the unchanged adapter code that
 * edits them on this computer (#913). See `agent/shared/remote-files.ts` for why.
 *
 * One spawn is three steps, each a method:
 *
 * - `pull`: before the adapter's trust and command builder run, every file it declared is read from the
 *   host and written to the folder the adapter edits (the CLI's home mirror, or the project's shell
 *   folder). A file the host does not have removes the local copy, so a stale one cannot be re-pushed.
 * - the adapter runs, merging its entries into those copies as it always did.
 * - `push`: every declared file that differs from what the host had is written there, or removed there
 *   if the adapter removed it. Nothing is written over a file that changed on the host meanwhile.
 *
 * `settle` is the same push, run when the session's hold is released (the adapter has stripped its
 * entries from the local copy), so the host's file goes back to what the user had.
 *
 * A project file Kangentic CREATED on the host (nothing was there at the pull) is added to the host's
 * `.git/info/exclude`, as the adapters do for a local checkout (`ensureLocalGitExcludes`), so it does
 * not show in `git status` or ride along with an agent's `git add -A`.
 *
 * What it never does: edit a file it did not pull, write outside the declared list, or send a file the
 * host did not ask for. Paths are held relative and joined here, so a declaration cannot name a parent.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { isUnderLocalRoot, localPathToHost, type SshCliPlace } from '../agent/shared/cli-target';
import { isPlainRelativePath, type RemoteFileDeclaration } from '../agent/shared/remote-files';
import type { HostFileWrite } from './protocol/messages';

const LOG_TAG = '[HOST_FILES]';
/** The helper's read cap. A file this size may have been cut short, so it is never edited or pushed back. */
const HELPER_READ_LIMIT = 1_000_000;

/** A declared file whose host copy changed between the pull and the push. */
export class HostFileChangedError extends Error {
  constructor(readonly hostPath: string) {
    super(`${hostPath} changed on the host while Kangentic was preparing the session, so it was not overwritten. Start the session again.`);
    this.name = 'HostFileChangedError';
  }
}

/** A declared file too large for the helper to read whole, which would be pushed back cut short. */
export class HostFileTooLargeError extends Error {
  constructor(readonly hostPath: string) {
    super(`${hostPath} is larger than Kangentic edits on a host (1 MB), so the agent cannot be set up for it.`);
    this.name = 'HostFileTooLargeError';
  }
}

/** A declared JSON file the host holds that is not plain JSON, which an adapter would replace rather than merge into. */
export class HostFileUnreadableError extends Error {
  constructor(readonly hostPath: string) {
    super(`${hostPath} is not plain JSON (it may hold comments), so Kangentic did not rewrite it. Remove the comments, or move the file aside, and start the session again.`);
    this.name = 'HostFileUnreadableError';
  }
}

/** Whether a `.json` file has text in it that JSON.parse rejects. A byte order mark is not held against it. */
function isUnreadableJson(relative: string, content: string): boolean {
  if (!relative.endsWith('.json')) return false;
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  if (text.trim().length === 0) return false;
  try {
    JSON.parse(text);
    return false;
  } catch {
    return true;
  }
}

interface TrackedFile {
  kind: 'home' | 'project';
  relative: string;
  /** The adapter marked it as holding a secret: written owner-only. */
  secret: boolean;
  localPath: string;
  hostPath: string;
  /** What the host holds now, as far as this object knows: null when it has no such file. */
  hostContent: string | null;
}

export interface PushOptions {
  /** `skip` leaves a changed file alone and logs it, for a release that runs with nobody to tell. */
  onConflict: 'throw' | 'skip';
}

export class HostFileSync {
  private constructor(
    private readonly place: SshCliPlace,
    private readonly workingDirectory: string,
    private readonly tracked: TrackedFile[],
  ) {}

  /** Read the declared files from the host into the folders the adapter edits. */
  static async pull(declaration: RemoteFileDeclaration, workingDirectory: string, place: SshCliPlace): Promise<HostFileSync> {
    const files = place.files;
    if (!files) throw new Error('This host has no connection to edit its files through.');
    const resolvedDirectory = path.resolve(workingDirectory);
    const secrets = new Set(declaration.private ?? []);
    for (const relative of secrets) {
      if (!declaration.home.includes(relative) && !declaration.project.includes(relative)) {
        throw new Error(`${relative} is marked private but is not a declared host file.`);
      }
    }
    const tracked: TrackedFile[] = [
      ...declaration.home.map((relative): TrackedFile => {
        assertRelative(relative);
        return { kind: 'home', relative, secret: secrets.has(relative), localPath: path.join(place.localHome, ...relative.split('/')), hostPath: `${place.home}/${relative}`, hostContent: null };
      }),
      ...declaration.project.map((relative): TrackedFile => {
        assertRelative(relative);
        const localPath = path.join(resolvedDirectory, ...relative.split('/'));
        return { kind: 'project', relative, secret: secrets.has(relative), localPath, hostPath: localPathToHost(localPath, place.roots), hostContent: null };
      }),
    ];
    // Each read is its own round trip and none depends on another, so they run together. All of them
    // finish before a failure is handled: one still running would mark its file after the clear below.
    const reads = await Promise.allSettled(tracked.map(async (file) => {
      const key = hostFileKey(place.hostId, file.hostPath);
      const answer = await files.readFile(file.hostPath);
      if (answer.exists && answer.content !== null && Buffer.byteLength(answer.content, 'utf8') >= HELPER_READ_LIMIT) {
        throw new HostFileTooLargeError(file.hostPath);
      }
      const onHost = answer.exists ? answer.content : null;
      knownHostContent.set(key, onHost);
      if (isBeingEdited(key)) {
        // Another spawn on this host pulled this file and has not pushed it yet. The folder holds its
        // edits, and writing the host's copy over them would lose them. This spawn edits on top of what
        // is there, and its push checks the host against what Kangentic last knew it to hold.
        file.hostContent = await readLocal(file.localPath);
      } else {
        file.hostContent = onHost;
        await writeLocal(file.localPath, onHost, file.kind === 'home' || file.secret);
      }
      markBeingEdited(key, file);
    }));
    const sync = new HostFileSync(place, resolvedDirectory, tracked);
    const failed = reads.find((read) => read.status === 'rejected');
    if (failed) {
      sync.abandon();
      throw failed.reason;
    }
    return sync;
  }

  /**
   * The spawn ended before its push. A later pull may refresh the folder from the host again: left marked,
   * it would take the adapter's edits here as the host's content for the rest of the edit window, and a
   * retry's own edits would then compare equal and never reach the host.
   */
  abandon(): void {
    for (const file of this.tracked) clearBeingEdited(hostFileKey(this.place.hostId, file.hostPath), file);
  }

  /** Write what the adapter changed to the host, and keep new project files out of the host's git status. */
  async push(options: PushOptions = { onConflict: 'throw' }): Promise<void> {
    const files = this.place.files;
    if (!files) return;
    try {
      await this.pushFiles(files, options);
    } finally {
      // The adapter's edits are on the host (or the push failed and the spawn ends), so a later pull
      // may refresh the folder from the host again.
      this.abandon();
    }
  }

  private async pushFiles(files: NonNullable<SshCliPlace['files']>, options: PushOptions): Promise<void> {
    const writes: HostFileWrite[] = [];
    const removals: Array<{ file: TrackedFile; expected: string | null }> = [];
    const created: TrackedFile[] = [];
    const written: Array<{ file: TrackedFile; content: string }> = [];
    // Each host read is a round trip on a path a spawn waits for, and none depends on another.
    const changed = await Promise.all(this.tracked.map(async (file) => {
      const local = await readLocal(file.localPath);
      if (local === file.hostContent) return null;
      const current = await files.readFile(file.hostPath);
      return { file, local, hostNow: current.exists ? current.content : null };
    }));
    for (const change of changed) {
      if (!change) continue;
      const { file, local, hostNow } = change;
      const key = hostFileKey(this.place.hostId, file.hostPath);
      if (hostNow === local) {
        // The host already holds what we would write (another session got there first).
        file.hostContent = local;
        knownHostContent.set(key, local);
        continue;
      }
      // What Kangentic last knew the host to hold, which other sessions on the host move too. Comparing
      // with this session's own pull would call every other session's change a conflict.
      const expected = knownHostContent.has(key) ? (knownHostContent.get(key) ?? null) : file.hostContent;
      if (file.hostContent !== null && isUnreadableJson(file.relative, file.hostContent)) {
        // An adapter that could not parse the user's file started from an empty one, so pushing its result
        // would replace everything the user had in it (comments make a settings file unparseable).
        if (options.onConflict === 'throw') throw new HostFileUnreadableError(file.hostPath);
        console.warn(`${LOG_TAG} ${file.hostPath} is not plain JSON, so it was left as it is.`);
        continue;
      }
      if (hostNow !== expected) {
        if (options.onConflict === 'throw') throw new HostFileChangedError(file.hostPath);
        console.warn(`${LOG_TAG} ${file.hostPath} changed on the host since it was read, so it was left as it is.`);
        continue;
      }
      if (local === null) {
        removals.push({ file, expected: hostNow });
      } else {
        writes.push({
          path: file.hostPath,
          content: local,
          mode: modeFor(file),
          expect: hostNow,
          // A file the user had keeps the permissions they gave it, unless it holds a secret.
          ...(hostNow !== null && !file.secret ? { keepExistingMode: true } : {}),
        });
        written.push({ file, content: local });
        if (file.kind === 'project' && file.hostContent === null) created.push(file);
      }
    }
    if (writes.length > 0) {
      const answer = await files.writeFiles(writes);
      const refused = new Set(answer.conflicts ?? []);
      if (refused.size > 0) {
        // Changed in the instant after the check. Nothing of it was overwritten.
        if (options.onConflict === 'throw') throw new HostFileChangedError([...refused][0]);
        console.warn(`${LOG_TAG} ${[...refused].join(', ')} changed on the host as it was written, so it was left as it is.`);
      }
      for (const { file, content } of written) {
        if (refused.has(file.hostPath)) continue;
        file.hostContent = content;
        knownHostContent.set(hostFileKey(this.place.hostId, file.hostPath), content);
      }
    }
    if (removals.length > 0) {
      await files.removeFiles(removals.map((removal) => removal.file.hostPath));
      for (const { file } of removals) {
        file.hostContent = null;
        knownHostContent.set(hostFileKey(this.place.hostId, file.hostPath), null);
      }
    }
    if (created.length > 0) await this.excludeFromGit(created.filter((file) => file.hostContent !== null));
  }

  /** The release of a session: the adapter has stripped its entries locally, so the host gets the same. */
  async settle(): Promise<void> {
    await this.push({ onConflict: 'skip' });
  }

  private async excludeFromGit(created: TrackedFile[]): Promise<void> {
    const files = this.place.files;
    if (!files) return;
    const root = this.rootOfWorkingDirectory();
    if (!root) return;
    const rootHost = root.host.replace(/\/+$/, '');
    const excludeFile = `${rootHost}/.git/info/exclude`;
    try {
      // Only where the folder is a git checkout; creating `.git` in a plain folder would make it look like one.
      const [infoFolder] = await files.pathPresence([`${rootHost}/.git/info`]);
      if (infoFolder !== 'present') return;
      const existing = await files.readFile(excludeFile);
      const current = existing.exists && existing.content !== null ? existing.content : '';
      const have = new Set(current.split('\n').map((line) => line.trim()));
      // Named from the working directory, not the root. Every worktree reads this file, and git anchors a
      // leading slash to the top of the checkout it is looking at, which for a task's worktree is not the root.
      const wanted = created.map((file) => `/${file.relative}`).filter((line) => !have.has(line));
      if (wanted.length === 0) return;
      const separator = current.length === 0 || current.endsWith('\n') ? '' : '\n';
      const marker = Array.from(have).some((line) => line.startsWith('# kangentic:')) ? '' : '# kangentic: agent runtime files (local ignore, safe to remove)\n';
      await files.writeFiles([{ path: excludeFile, content: `${current}${separator}${marker}${wanted.join('\n')}\n`, mode: 0o644 }]);
    } catch (error) {
      // Best-effort, as locally: the file only stays visible in git status.
      console.warn(`${LOG_TAG} could not add the new files to the host's git exclude: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The path-map root the working directory lies in: the project's folder here and on the host. */
  private rootOfWorkingDirectory(): SshCliPlace['roots'][number] | undefined {
    return this.place.roots.find((candidate) => isUnderLocalRoot(this.workingDirectory, [candidate]));
  }
}

/**
 * What Kangentic last knew each host file to hold, by host and path, shared by every session on the host.
 * A session's own pull goes stale the moment another session pushes the same file (Gemini's settings,
 * Codex's config, a trusted-folders list all are shared), so a release that compared the host with its
 * own pull would call another session's entries "a change by someone else" and leave its own on the host.
 */
const knownHostContent = new Map<string, string | null>();

/** How long a pull may go unpushed before it stops protecting the folder, for a spawn that never ended (`abandon` covers one that threw). */
const EDIT_WINDOW_MS = 60_000;
/** The files a spawn has pulled and not yet pushed, with when the pull happened. */
const filesBeingEdited = new Map<string, Map<TrackedFile, number>>();

/** Forget what is known and what is being edited. For tests, which share this module's state. */
export function resetHostFileSyncState(): void {
  knownHostContent.clear();
  filesBeingEdited.clear();
  syncsBySession.clear();
}

function hostFileKey(hostId: string, hostPath: string): string {
  return `${hostId}\u0000${hostPath}`;
}

function isBeingEdited(key: string): boolean {
  const holders = filesBeingEdited.get(key);
  if (!holders) return false;
  const now = Date.now();
  for (const [file, since] of holders) {
    if (now - since > EDIT_WINDOW_MS) holders.delete(file);
  }
  if (holders.size === 0) {
    filesBeingEdited.delete(key);
    return false;
  }
  return true;
}

function markBeingEdited(key: string, file: TrackedFile): void {
  const holders = filesBeingEdited.get(key) ?? new Map<TrackedFile, number>();
  holders.set(file, Date.now());
  filesBeingEdited.set(key, holders);
}

function clearBeingEdited(key: string, file: TrackedFile): void {
  const holders = filesBeingEdited.get(key);
  if (!holders) return;
  holders.delete(file);
  if (holders.size === 0) filesBeingEdited.delete(key);
}

function assertRelative(relative: string): void {
  if (!isPlainRelativePath(relative)) {
    throw new Error(`${relative} is not a plain relative path, so it cannot be declared as a host file.`);
  }
}

/** Scripts must run; a secret or a file under the home is owner-only; a project file keeps the mode a checkout gives. */
function modeFor(file: TrackedFile): number {
  if (file.relative.endsWith('.sh')) return 0o755;
  return file.secret || file.kind === 'home' ? 0o600 : 0o644;
}

async function readLocal(localPath: string): Promise<string | null> {
  try {
    return await fs.readFile(localPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Make the local copy equal the host's: write it, or remove it when the host has none. Unchanged is not rewritten. */
async function writeLocal(localPath: string, content: string | null, ownerOnly: boolean): Promise<void> {
  if (content === null) {
    await fs.rm(localPath, { force: true });
    return;
  }
  if ((await readLocal(localPath)) === content) return;
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  // The mirror of a CLI's home can hold its credentials, so on this computer only its owner reads the copy.
  await fs.writeFile(localPath, content, ownerOnly ? { encoding: 'utf8', mode: 0o600 } : 'utf8');
}

/**
 * Pull the files an adapter declares, for a spawn whose CLI is on a host. Null for a spawn on this
 * computer or in a WSL distro, and for an adapter that declares nothing, so a caller can pass any
 * spawn through it and `push` only what it got.
 */
export async function pullHostFilesFor(
  adapter: { remoteFiles?(): RemoteFileDeclaration },
  workingDirectory: string,
  place: { kind: string } | null,
): Promise<HostFileSync | null> {
  if (!place || place.kind !== 'ssh' || !adapter.remoteFiles) return null;
  const declaration = adapter.remoteFiles();
  if (declaration.home.length === 0 && declaration.project.length === 0) return null;
  return HostFileSync.pull(declaration, workingDirectory, place as SshCliPlace);
}

/** A spawn's pull, held where the spawn's failure path can reach it. */
export interface HostFilePull {
  sync: HostFileSync | null;
}

/**
 * Run a spawn that pulls host files. A spawn that throws before its push abandons the pull, whichever
 * step threw. Both chokepoints go through here, so one cannot keep a failure the other handles.
 */
export async function withHostFilePull<Result>(run: (pull: HostFilePull) => Promise<Result>): Promise<Result> {
  const pull: HostFilePull = { sync: null };
  try {
    return await run(pull);
  } catch (error) {
    pull.sync?.abandon();
    throw error;
  }
}

/** The last step of a spawn's sync. `onFailure` runs when the push fails, before the error goes on. */
export async function pushHostFilesForSpawn(hostFiles: HostFileSync | null, sessionId: string, onFailure: () => void): Promise<void> {
  if (!hostFiles) return;
  // Remembered before the push: a push that fails partway has already written some files, and the
  // release strips them on the host along with the local copies.
  rememberHostFileSync(sessionId, hostFiles);
  try {
    await hostFiles.push();
  } catch (error) {
    onFailure();
    throw error;
  }
}

/**
 * The syncs of running sessions, by the session's own id, so the release that strips the adapter's
 * entries locally can strip them on the host too (`releaseCommandHold`). One entry per session.
 */
const syncsBySession = new Map<string, HostFileSync>();

export function rememberHostFileSync(sessionId: string, sync: HostFileSync): void {
  syncsBySession.set(sessionId, sync);
}

/** Push the session's strip to the host and forget it. Never throws: a release has nobody to tell. */
export async function settleHostFiles(sessionId: string): Promise<void> {
  const sync = syncsBySession.get(sessionId);
  if (!sync) return;
  syncsBySession.delete(sessionId);
  try {
    await sync.settle();
  } catch (error) {
    console.warn(`${LOG_TAG} could not restore the host's files for session ${sessionId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
