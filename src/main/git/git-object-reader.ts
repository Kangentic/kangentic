import { spawn } from 'node:child_process';

/**
 * One file's bytes from a repository's object database, read through a single
 * `git cat-file --batch` process. Git writes a header with the object id and
 * size before the content, so a read whose id the caller already holds, or
 * whose size is over the caller's cap, stops at the header and never reads
 * the content.
 *
 * `readBlobs` in src/main/retrieval/branch-git.ts also drives
 * `cat-file --batch`, for many ids at once with the whole output buffered and
 * a malformed header skipped. This reader takes one name, stops early, and
 * treats a header it cannot parse as a failure, so the two do not share a parser.
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

/** How much of git's error output a failure carries into its message. */
const STDERR_KEPT_BYTES = 2048;

/**
 * One `git cat-file --batch` header line: `<id> <type> <size>`, or
 * `<name> missing` / `<name> ambiguous` for a name git cannot resolve. The
 * name is the whole input line, so it may hold spaces; only the id never
 * does, and an id is exactly 40 (SHA-1) or 64 (SHA-256) hex characters. Null
 * for anything else, which means git and this parser disagree.
 */
export function parseObjectHeader(line: string): GitObjectHeader | null {
  if (line.endsWith(' missing') || line.endsWith(' ambiguous')) return { kind: 'missing' };
  const match = /^([0-9a-f]{40}|[0-9a-f]{64}) ([a-z]+) (\d+)$/.exec(line);
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
 * Rejects only when git itself fails: it cannot start, it exits before
 * answering (not a repository), or it writes a header the parser does not
 * recognise. A rejection never carries a Node error `code`, so a caller cannot
 * mistake git failing to start for a file that is not there.
 */
export function readGitObject(gitDirectory: string, objectName: string, options: GitObjectReadOptions): Promise<GitObjectRead> {
  // --batch reads one name per line, so a name holding a line break cannot be asked for.
  if (/[\r\n]/.test(objectName)) return Promise.resolve({ kind: 'missing' });
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['cat-file', '--batch'], { cwd: gitDirectory, windowsHide: true });
    let settled = false;
    let headerChunks: Buffer[] = [];
    let content: { objectId: string; bytes: Buffer; filled: number } | null = null;
    let stderrText = '';

    const finish = (result: GitObjectRead, stopGit: boolean) => {
      if (settled) return;
      settled = true;
      if (stopGit) child.kill();
      resolve(result);
    };
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(message));
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
      // The header nearly always arrives whole in the first chunk, which needs no copy.
      const received = headerChunks.length === 1 ? data : Buffer.concat(headerChunks);
      const newline = received.indexOf(0x0a);
      if (newline === -1) return;
      headerChunks = [];
      const header = parseObjectHeader(received.subarray(0, newline).toString('utf8'));
      if (header === null) {
        fail('git cat-file wrote a header this reader does not recognise');
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
      // Never a pooled slice: Electron's IPC clones the whole buffer behind a
      // view, so a pooled one would carry unrelated bytes. Not zero-filled
      // either, since it is handed back only once every byte has been written.
      content = { objectId: header.objectId, bytes: Buffer.allocUnsafeSlow(header.size), filled: 0 };
      if (header.size === 0 || fillContent(received.subarray(newline + 1))) {
        finish({ kind: 'blob', objectId: content.objectId, bytes: content.bytes }, false);
      }
    });
    // Read, not ignored, so the pipe never fills; the start of it explains a failure.
    child.stderr.on('data', (data: Buffer) => {
      if (stderrText.length < STDERR_KEPT_BYTES) stderrText += data.toString('utf8').slice(0, STDERR_KEPT_BYTES - stderrText.length);
    });
    child.on('error', (error) => fail(`git cat-file could not start: ${error.message}`));
    child.on('close', (code) => {
      const detail = stderrText.trim();
      fail(`git cat-file exited with ${code} before it answered${detail === '' ? '' : `: ${detail}`}`);
    });
    // A git that exits before reading (not a repository) raises EPIPE on
    // stdin. Unheard, that is an uncaught exception in main; `close` above
    // already reports the failure.
    child.stdin.on('error', () => undefined);
    child.stdin.end(`${objectName}\n`);
  });
}
