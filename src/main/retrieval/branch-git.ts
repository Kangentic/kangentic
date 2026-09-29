import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * Reading a project's default branch for the memory index: its head, its tree
 * and its file contents, as committed (never the working copy, which may hold
 * another branch or unfinished work). Every call is a child process, so git's
 * work never runs on main's thread.
 */

const execFileAsync = promisify(execFile);

export interface BranchHead {
  /** The ref read, short: `origin/main`, `main`, `origin/master` (the remote's
   *  own default), or the checked-out branch's name. */
  ref: string;
  sha: string;
}

export interface TreeEntry {
  path: string;
  /** The blob's object id: a hash of the file's content. */
  blob: string;
  size: number;
}

export async function runGit(projectPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: projectPath,
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
  });
  return stdout;
}

/**
 * The branch the index reads, so any repository with a commit has one: the
 * project's base on origin, then locally, then the remote's own default
 * (`origin/HEAD`, set by every clone), then whatever is checked out. Null only
 * for a folder with nothing committed, or no repository at all.
 *
 * The usual case costs one `git for-each-ref`, the same one process a sweep
 * always paid; only a repository with none of the three pays the two reads of
 * the checked-out branch.
 */
export async function readBranchHead(projectPath: string, baseBranch: string): Promise<BranchHead | null> {
  const wanted = [`refs/remotes/origin/${baseBranch}`, `refs/heads/${baseBranch}`, 'refs/remotes/origin/HEAD'];
  try {
    const listed = parseRefList(await runGit(projectPath, ['for-each-ref', '--format=%(refname)%09%(objectname)%09%(symref)', ...wanted]));
    for (const refname of wanted) {
      const found = listed.get(refname);
      if (!found) continue;
      // origin/HEAD is named by the branch it points to, like origin/master.
      return { ref: shortRefName(found.symref || refname), sha: found.sha };
    }
  } catch {
    return null;
  }
  try {
    const sha = (await runGit(projectPath, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])).trim();
    if (!sha) return null;
    const branch = (await runGit(projectPath, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')).trim();
    return { ref: branch || 'HEAD', sha };
  } catch {
    // Nothing committed yet.
    return null;
  }
}

/** `git for-each-ref` output in the format above, keyed by exact ref name (a
 *  pattern also matches refs below it, such as `refs/heads/main/wip`). */
export function parseRefList(stdout: string): Map<string, { sha: string; symref: string }> {
  const refs = new Map<string, { sha: string; symref: string }>();
  for (const line of stdout.split('\n')) {
    const [refname, sha, symref = ''] = line.trim().split('\t');
    if (refname && sha) refs.set(refname, { sha, symref });
  }
  return refs;
}

function shortRefName(refname: string): string {
  return refname.replace(/^refs\/remotes\//, '').replace(/^refs\/heads\//, '');
}

/** Every file in a commit's tree, with its blob id and size. */
export async function listTree(projectPath: string, commit: string): Promise<TreeEntry[]> {
  const stdout = await runGit(projectPath, ['ls-tree', '-r', '-l', '--full-tree', '-z', commit]);
  return parseTree(stdout);
}

/** `git ls-tree -r -l -z` output: `<mode> <type> <object> <size>\t<path>\0`. */
export function parseTree(stdout: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const record of stdout.split('\0')) {
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    const [, type, blob, size] = record.slice(0, tab).trim().split(/\s+/);
    if (type !== 'blob' || !blob) continue;
    const bytes = Number(size);
    entries.push({ path: record.slice(tab + 1), blob, size: Number.isFinite(bytes) ? bytes : 0 });
  }
  return entries;
}

/**
 * Blob contents by object id, read through ONE `git cat-file --batch` process
 * however many there are. A blob git cannot find is left out.
 */
export function readBlobs(projectPath: string, blobs: ReadonlyArray<string>): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    if (blobs.length === 0) {
      resolve(new Map());
      return;
    }
    const child = spawn('git', ['cat-file', '--batch'], { cwd: projectPath, windowsHide: true });
    const parts: Buffer[] = [];
    child.stdout.on('data', (data: Buffer) => parts.push(data));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`git cat-file exited with ${code}`));
        return;
      }
      resolve(parseBatch(Buffer.concat(parts)));
    });
    child.stdin.end(`${blobs.join('\n')}\n`);
  });
}

/** `git cat-file --batch` output: `<object> <type> <size>\n<content>\n` per
 *  object, or `<object> missing\n`. */
export function parseBatch(output: Buffer): Map<string, Buffer> {
  const contents = new Map<string, Buffer>();
  let offset = 0;
  while (offset < output.length) {
    const newline = output.indexOf(0x0a, offset);
    if (newline === -1) break;
    const header = output.subarray(offset, newline).toString('utf8').split(' ');
    offset = newline + 1;
    if (header[1] === 'missing' || header.length < 3) continue;
    const size = Number(header[2]);
    if (!Number.isFinite(size)) break;
    contents.set(header[0], output.subarray(offset, offset + size));
    // The content, then the newline git puts after every object.
    offset += size + 1;
  }
  return contents;
}
