/**
 * How a git call reaches a repository on an SSH host (#913). A remote project's repository is on the host and
 * this computer holds an empty stand-in folder for it, so a git command run in that folder here would either
 * fail or, if the folder sits inside some other repository, answer about the wrong one. Everything that reads
 * a project's git (`gitAt`, `openSimpleGit`, `runGitWithTimeout`, `readGitObject`) and everything that reads or
 * watches its working tree (`DiffService`, `DiffWatcher`) asks the resolver below first: a directory that belongs
 * to a remote project is run on the host, and any other directory goes on to this computer as before.
 *
 * The resolver is registered at startup (`remote-hosting.ts`) rather than imported, so this git module keeps
 * its dependency direction: it does not reach into the SSH feature.
 *
 * Imports nothing of electron.
 */

export interface RemoteGitResult {
  /** The exit code. Never null: a run that timed out, could not start or was not answered rejects instead. */
  code: number;
  stdout: Buffer;
  stderr: string;
}

/** A file in a remote project's working tree, as the host holds it. */
export type RemoteWorkingFile =
  | { kind: 'bytes'; bytes: Buffer; mtimeMs: number }
  | { kind: 'too-large'; size: number; mtimeMs: number }
  | { kind: 'missing' };

/** What counting the new lines of an untracked file found, as `countFileLines` reports it. */
export interface RemoteLineCount {
  insertions: number;
  binary: boolean;
}

export interface RemoteGitRunner {
  /**
   * `git <args>` in the directory on the host. Rejects when the host cannot be asked, when the run timed out
   * or could not start, and when the output is more than is read: an answer that never came is never an empty
   * one, so a down link cannot read as "no changes" or "nothing ahead".
   */
  run(args: readonly string[], options?: { timeoutMs?: number }): Promise<RemoteGitResult>;
  /**
   * A git object by name (`<rev>:<path>`, or `:<path>` for the index), as `readGitObject` reads it here:
   * `unchanged` when its id is the one the caller holds, `too-large` past `maxBytes`, `missing` for a name git
   * cannot resolve to a file. The name is a script argument, never an option.
   */
  readObject(objectName: string, options: { knownObjectId?: string; maxBytes: number }): Promise<
    | { kind: 'blob'; objectId: string; bytes: Buffer }
    | { kind: 'unchanged'; objectId: string }
    | { kind: 'too-large'; objectId: string; size: number }
    | { kind: 'missing' }
  >;
  /**
   * A file in the working tree, by a path relative to the directory. A path that climbs out of it, a symlink, a
   * symlinked folder that leads out of it and a file that is not there all read `missing`, so no read leaves
   * the repository.
   */
  readWorkingFile(relativePath: string, maxBytes: number): Promise<RemoteWorkingFile>;
  /** The new lines of each untracked file, in the order asked. A file that is gone counts as empty, as it does here. */
  countUntracked(relativePaths: readonly string[]): Promise<RemoteLineCount[]>;
  /**
   * A short text that changes when the checkout's diff may have: HEAD, git's status, and the modified time and
   * size of every changed or untracked file, so a second edit to a file that was already modified counts. One
   * request, no git lock. The panel polls it, because nothing here can watch the host's disk.
   */
  fingerprint(): Promise<string>;
}

/** The git of a project on a host could not answer, or was asked for something it does not do there yet. */
export class RemoteGitUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RemoteGitUnavailableError';
  }
}

/** The runner for a directory on this computer, or null when the directory is not under a remote project's folder. */
export type RemoteGitResolver = (directory: string) => RemoteGitRunner | null;

let resolver: RemoteGitResolver | null = null;

export function setRemoteGitResolver(next: RemoteGitResolver | null): void {
  resolver = next;
}

export function remoteGitRunnerFor(directory: string): RemoteGitRunner | null {
  return resolver ? resolver(directory) : null;
}
