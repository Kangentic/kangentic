import { spawn } from 'node:child_process';

/**
 * One file's bytes from a repository's object database, read through a single
 * `git cat-file --batch` process. Git writes a header with the object id and
 * size before the content, so a read whose id the caller already holds, or
 * whose size is over the caller's cap, stops at the header and never reads
 * the content.
 *
 * The Changes panel's image reader used `rev-parse`, `cat-file -s` and `show`
 * for this: three processes in a row, measured at 156 ms for an image side on
 * Windows against 49 ms for a file's whole text diff, so selecting an SVG
 * waited on its image read for 180 ms instead of 49.
 */

export type GitObjectRead =
  | { kind: 'blob'; objectId: string; bytes: Buffer }
  | { kind: 'unchanged'; objectId: string }
  | { kind: 'too-large'; objectId: string; size: number }
  | { kind: 'missing' };

export interface GitObjectReadOptions {
  /** An object id the caller already holds the content of. A match answers `unchanged`. */
  knownObjectId?: string;
  /** Content over this many bytes answers `too-large` with its size. */
  maxBytes: number;
}

export type GitObjectHeader =
  | { kind: 'object'; objectId: string; type: string; size: number }
  | { kind: 'missing' };

/**
 * One `git cat-file --batch` header line: `<id> <type> <size>`, or
 * `<name> missing` / `<name> ambiguous` for a name git cannot resolve. The
 * name is the whole input line, so it may hold spaces; only the id never
 * does. Null for anything else, which means git and this parser disagree.
 */
export function parseObjectHeader(line: string): GitObjectHeader | null {
  if (line.endsWith(' missing') || line.endsWith(' ambiguous')) return { kind: 'missing' };
  const match = /^([0-9a-f]{40,64}) ([a-z]+) (\d+)$/.exec(line);
  if (match === null) return null;
  const size = Number(match[3]);
  if (!Number.isSafeInteger(size)) return null;
  return { kind: 'object', objectId: match[1], type: match[2], size };
}

/**
 * `objectName` is anything `git rev-parse` accepts: `<rev>:<path>`, or
 * `:<path>` for the index. It goes to git on stdin, never as an argument, so
 * no name can be read as an option. A name git cannot resolve, or one that
 * names a directory or a submodule rather than a file, reads `missing`.
 * Rejects only when git itself fails: no git binary, not a repository, or a
 * header the parser does not recognise.
 */
export function readGitObject(gitDirectory: string, objectName: string, options: GitObjectReadOptions): Promise<GitObjectRead> {
  // --batch reads one name per line, so a name holding a line break cannot be asked for.
  if (/[\r\n]/.test(objectName)) return Promise.resolve({ kind: 'missing' });
  return new Promise((resolve, reject) => {
    // stderr is ignored rather than piped: nothing reads it, and an unread pipe can fill.
    const child = spawn('git', ['cat-file', '--batch'], { cwd: gitDirectory, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let settled = false;
    let headerChunks: Buffer[] = [];
    let content: { objectId: string; bytes: Buffer; filled: number } | null = null;

    const finish = (result: GitObjectRead, stopGit: boolean) => {
      if (settled) return;
      settled = true;
      if (stopGit) child.kill();
      resolve(result);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(error);
    };

    /** Copy what arrived into the content buffer; true once it is full. */
    const fillContent = (data: Buffer): boolean => {
      if (content === null) return false;
      const take = Math.min(data.length, content.bytes.length - content.filled);
      data.copy(content.bytes, content.filled, 0, take);
      content.filled += take;
      return content.filled === content.bytes.length;
    };

    child.stdout.on('data', (data: Buffer) => {
      if (settled) return;
      if (content !== null) {
        if (fillContent(data)) finish({ kind: 'blob', objectId: content.objectId, bytes: content.bytes }, false);
        return;
      }
      headerChunks.push(data);
      const received = Buffer.concat(headerChunks);
      const newline = received.indexOf(0x0a);
      if (newline === -1) return;
      headerChunks = [];
      const header = parseObjectHeader(received.subarray(0, newline).toString('utf8'));
      if (header === null) {
        fail(new Error('git cat-file wrote a header this reader does not recognise'));
        return;
      }
      if (header.kind === 'missing' || header.type !== 'blob') {
        finish({ kind: 'missing' }, true);
        return;
      }
      if (header.objectId === options.knownObjectId) {
        finish({ kind: 'unchanged', objectId: header.objectId }, true);
        return;
      }
      if (header.size > options.maxBytes) {
        finish({ kind: 'too-large', objectId: header.objectId, size: header.size }, true);
        return;
      }
      // Its own allocation, never a pooled slice: Electron's IPC clones the
      // whole buffer behind a view, so a pooled one would carry unrelated bytes.
      content = { objectId: header.objectId, bytes: Buffer.alloc(header.size), filled: 0 };
      if (header.size === 0 || fillContent(received.subarray(newline + 1))) {
        finish({ kind: 'blob', objectId: content.objectId, bytes: content.bytes }, false);
      }
    });
    child.on('error', fail);
    child.on('close', (code) => fail(new Error(`git cat-file exited with ${code} before it answered`)));
    // A git that exits before reading (not a repository) raises EPIPE on
    // stdin. Unheard, that is an uncaught exception in main; `close` above
    // already reports the failure.
    child.stdin.on('error', () => undefined);
    child.stdin.end(`${objectName}\n`);
  });
}
