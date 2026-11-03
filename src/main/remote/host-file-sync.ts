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
import type { RemoteFileDeclaration } from '../agent/shared/remote-files';
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

interface TrackedFile {
  kind: 'home' | 'project';
  relative: string;
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
    const tracked: TrackedFile[] = [
      ...declaration.home.map((relative): TrackedFile => {
        assertRelative(relative);
        return { kind: 'home', relative, localPath: path.join(place.localHome, ...relative.split('/')), hostPath: `${place.home}/${relative}`, hostContent: null };
      }),
      ...declaration.project.map((relative): TrackedFile => {
        assertRelative(relative);
        const localPath = path.join(resolvedDirectory, ...relative.split('/'));
        return { kind: 'project', relative, localPath, hostPath: localPathToHost(localPath, place.roots), hostContent: null };
      }),
    ];
    // Each read is its own round trip and none depends on another, so they run together.
    await Promise.all(tracked.map(async (file) => {
      const answer = await files.readFile(file.hostPath);
      if (answer.exists && answer.content !== null && Buffer.byteLength(answer.content, 'utf8') >= HELPER_READ_LIMIT) {
        throw new HostFileTooLargeError(file.hostPath);
      }
      file.hostContent = answer.exists ? answer.content : null;
      await writeLocal(file.localPath, file.hostContent);
    }));
    return new HostFileSync(place, resolvedDirectory, tracked);
  }

  /** Write what the adapter changed to the host, and keep new project files out of the host's git status. */
  async push(options: PushOptions = { onConflict: 'throw' }): Promise<void> {
    const files = this.place.files;
    if (!files) return;
    const writes: HostFileWrite[] = [];
    const removals: string[] = [];
    const created: TrackedFile[] = [];
    for (const file of this.tracked) {
      const local = await readLocal(file.localPath);
      if (local === file.hostContent) continue;
      const current = await files.readFile(file.hostPath);
      const hostNow = current.exists ? current.content : null;
      if (hostNow === local) {
        // The host already holds what we would write (another session got there first).
        file.hostContent = local;
        continue;
      }
      if (hostNow !== file.hostContent) {
        if (options.onConflict === 'throw') throw new HostFileChangedError(file.hostPath);
        console.warn(`${LOG_TAG} ${file.hostPath} changed on the host since it was read, so it was left as it is.`);
        continue;
      }
      if (local === null) {
        removals.push(file.hostPath);
      } else {
        writes.push({ path: file.hostPath, content: local, mode: modeFor(file) });
        if (file.kind === 'project' && file.hostContent === null) created.push(file);
      }
      file.hostContent = local;
    }
    if (writes.length > 0) await files.writeFiles(writes);
    if (removals.length > 0) await files.removeFiles(removals);
    if (created.length > 0) await this.excludeFromGit(created);
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
      const wanted = created.map((file) => `/${path.relative(root.local, file.localPath).split(path.sep).join('/')}`).filter((line) => !have.has(line));
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

/** A relative path that stays inside the folder it is joined to. */
function assertRelative(relative: string): void {
  if (relative.length === 0 || relative.startsWith('/') || relative.includes('\\') || relative.split('/').some((part) => part === '..' || part === '')) {
    throw new Error(`${relative} is not a plain relative path, so it cannot be declared as a host file.`);
  }
}

/** Scripts must run; a file under the home may hold a token; a project file keeps the mode a checkout gives. */
function modeFor(file: TrackedFile): number {
  if (file.relative.endsWith('.sh')) return 0o755;
  return file.kind === 'home' ? 0o600 : 0o644;
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
async function writeLocal(localPath: string, content: string | null): Promise<void> {
  if (content === null) {
    await fs.rm(localPath, { force: true });
    return;
  }
  if ((await readLocal(localPath)) === content) return;
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, content, 'utf8');
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

/** Forget a session's sync without pushing (the spawn failed before anything was written to the host). */
export function forgetHostFileSync(sessionId: string): void {
  syncsBySession.delete(sessionId);
}
