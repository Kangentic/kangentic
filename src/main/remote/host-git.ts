/**
 * Git on an SSH host, for the Changes panel, the branch summary, blame, history and the commit graph (#913).
 * A remote project's repository is on the host and this computer holds an empty stand-in folder for it, so
 * every read of its git, and of its working tree, runs there, through the helper's `runCommand`, and comes
 * back here as bytes.
 *
 * One read is one `sh` script. It runs `git` (or reads a file) with the arguments it was handed, each an
 * argument and never shell text, writes the result to a file under the host's home, and prints a few `KG:`
 * lines: the size, the file's id and the first chunk as base64. A reply is one frame and a frame's JSON body is
 * 256 KiB, so what is past one chunk is pulled in pieces by a second script, which removes the file with the
 * last piece. That keeps an answer binary-safe (a file's content, an image) and never cut short: a pull that
 * comes back short, or an id that is gone, is an error. Nothing reads a partial answer as the whole one.
 *
 * The directory a read starts in is the host path of the folder asked about, mapped from the project's shell
 * folder, so a worktree stand-in becomes its worktree on the host and nothing outside the project is reached.
 *
 * Imports nothing of electron.
 */

import { isUnderLocalRoot, localPathToHost, type SshCliPlace } from '../agent/shared/cli-target';
import {
  RemoteGitUnavailableError,
  type RemoteGitResolver,
  type RemoteGitResult,
  type RemoteGitRunner,
  type RemoteLineCount,
  type RemoteWorkingFile,
} from '../git/remote-git';
import type { HostCommandRequest, HostCommandResult } from './protocol/messages';

/** What the first reply carries of the output. With the envelope it stays under a frame's 256 KiB. */
const FIRST_CHUNK_BYTES = 96 * 1024;
/** What a pull carries, a reply with nothing else in it. */
const PULL_CHUNK_BYTES = 144 * 1024;
/** Of a failed run's stderr. A message, not a log. */
const STDERR_BYTES = 32 * 1024;
/** More than this is not an answer a panel can use, and is refused rather than pulled. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const RUN_TIMEOUT_MS = 60_000;
const PULL_TIMEOUT_MS = 30_000;
const FINGERPRINT_TIMEOUT_MS = 30_000;
/** How many untracked files one count asks about, so the arguments stay well under the shell's limit. */
const COUNT_BATCH = 100;
/** The same checks `countFileLines` makes: a null byte in the first 8 KiB is binary, and 20 MiB is read at most. */
const COUNT_BINARY_BYTES = 8192;
const COUNT_CAP_BYTES = 20 * 1024 * 1024;
const LINE_PREFIX = 'KG:';

/** A run's id: digits only after the prefix, so it can never name another file. */
const RUN_ID = /^git-\d+-\d+$/;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Sets up a run's files and `emit`, which prints the size, the id and the first chunk of `$out`. A run's files
 * are swept when two hours old, for a pull that never finished (a link that dropped for good). `$first` is the
 * first argument of every script.
 */
const PRELUDE = `
first=$1; shift
spool="\${HOME:-/tmp}/.kangentic/tmp"
mkdir -p "$spool" 2>/dev/null || spool=/tmp
find "$spool" -maxdepth 1 -type f \\( -name 'git-[0-9]*.out' -o -name 'git-[0-9]*.err' \\) -mmin +120 -exec rm -f {} \\; 2>/dev/null
id="git-$$-$(date +%s)"
out="$spool/$id.out"; err="$spool/$id.err"
emit() {
  size=$(wc -c <"$out" | tr -d ' ')
  echo "KG:size:$size"
  echo "KG:id:$id"
  echo "KG:out:$(head -c "$first" "$out" | base64 | tr -d '\\n')"
  if [ "$size" -le "$first" ]; then rm -f "$out"; fi
}`.trim();

/** Arguments are `first`, then git's own arguments. */
const RUN_SCRIPT = `
${PRELUDE}
GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 git "$@" >"$out" 2>"$err"
code=$?
echo "KG:code:$code"
echo "KG:err:$(head -c ${STDERR_BYTES} "$err" | base64 | tr -d '\\n')"
rm -f "$err"
emit
`.trim();

/**
 * Arguments are `first`, `name`, `max`, `known`. The name goes to git on stdin, as the local reader sends it,
 * so no name is read as an option. A name that is not a blob (a directory, a submodule) is missing.
 */
const OBJECT_SCRIPT = `
${PRELUDE}
name=$1; max=$2; known=$3
header=$(printf '%s\\n' "$name" | GIT_OPTIONAL_LOCKS=0 git cat-file --batch-check 2>/dev/null)
case "$header" in ''|*' missing'|*' ambiguous') echo KG:missing; exit 0 ;; esac
oid=$(printf '%s' "$header" | awk '{print $(NF-2)}')
type=$(printf '%s' "$header" | awk '{print $(NF-1)}')
objsize=$(printf '%s' "$header" | awk '{print $NF}')
[ "$type" = blob ] || { echo KG:missing; exit 0; }
echo "KG:oid:$oid"
if [ "$oid" = "$known" ]; then echo KG:unchanged; exit 0; fi
if [ "$objsize" -gt "$max" ]; then echo "KG:toobig:$objsize"; exit 0; fi
GIT_OPTIONAL_LOCKS=0 git cat-file blob "$oid" >"$out" 2>/dev/null || { rm -f "$out"; echo KG:missing; exit 0; }
emit
`.trim();

/**
 * Arguments are `first`, `path`, `max`. Only a plain file inside the folder is read: no absolute path, no `..`,
 * no symlink, and no folder on the way that a symlink takes elsewhere. The `./` keeps a name that starts with
 * a dash from reading as an option. The file is copied first, so the pull reads one consistent file.
 */
const FILE_SCRIPT = `
${PRELUDE}
file=$1; max=$2
case "$file" in ''|/*|..|../*|*/..|*/../*) echo KG:missing; exit 0 ;; esac
file="./$file"
root=$(pwd -P)
parent=$(cd "\${file%/*}" 2>/dev/null && pwd -P) || { echo KG:missing; exit 0; }
case "$parent/" in "$root"/*) ;; *) echo KG:missing; exit 0 ;; esac
{ [ -f "$file" ] && [ ! -L "$file" ]; } || { echo KG:missing; exit 0; }
filesize=$(wc -c <"$file" | tr -d ' ')
echo "KG:mtime:$(stat -c %Y "$file" 2>/dev/null || echo 0)"
if [ "$filesize" -gt "$max" ]; then echo "KG:toobig:$filesize"; exit 0; fi
cp "$file" "$out" 2>/dev/null || { rm -f "$out"; echo KG:missing; exit 0; }
emit
`.trim();

/**
 * Arguments are the paths. One `KG:count:<position>:<lines>:<binary>` line each, in order, the first at 1. A
 * batch is a shell loop, so a file costs as few processes as it can: the head of a file is read once.
 */
const COUNT_SCRIPT = `
position=0
for file; do
  position=$((position + 1))
  case "$file" in ''|/*|..|../*|*/..|*/../*) echo "KG:count:$position:0:0"; continue ;; esac
  file="./$file"
  if [ ! -f "$file" ] || [ -L "$file" ]; then echo "KG:count:$position:0:0"; continue; fi
  size=$(wc -c <"$file")
  nonnull=$(head -c ${COUNT_BINARY_BYTES} "$file" | tr -d '\\000' | wc -c)
  if [ "$nonnull" -lt "$size" ] && [ "$nonnull" -lt ${COUNT_BINARY_BYTES} ]; then echo "KG:count:$position:0:1"; continue; fi
  lines=$(head -c ${COUNT_CAP_BYTES} "$file" | grep -c '')
  echo "KG:count:$position:$lines:0"
done
`.trim();

/**
 * No arguments. Prints one `KG:fp:` line: a checksum of HEAD, the status, and each changed or untracked file's
 * name, modified time (to the nanosecond, so two edits in one second differ) and size, plus the index's. It takes
 * no optional lock, so it never blocks the agent's own git. A folder that is no repository prints a constant.
 */
const FINGERPRINT_SCRIPT = `
export GIT_OPTIONAL_LOCKS=0
fp=$( {
  git rev-parse HEAD
  git status --porcelain=v1 -b -z | tr '\\000' '\\n'
  git ls-files -m -o --exclude-standard -z | xargs -0 -r stat -c '%n %y %s' --
  stat -c '%y %s' "$(git rev-parse --git-path index)"
} 2>/dev/null | cksum )
echo "KG:fp:$fp"
`.trim();

/** Arguments are `id offset length total`. Removes the file once the last byte is read. */
const PULL_SCRIPT = `
case "$1" in git-*) ;; *) echo KG:error:bad-id; exit 3 ;; esac
case "$1" in *[!0-9a-z-]*) echo KG:error:bad-id; exit 3 ;; esac
case "$2$3$4" in ''|*[!0-9]*) echo KG:error:bad-number; exit 3 ;; esac
spool="\${HOME:-/tmp}/.kangentic/tmp"
[ -f "$spool/$1.out" ] || spool=/tmp
out="$spool/$1.out"
[ -f "$out" ] || { echo KG:error:gone; exit 3; }
echo "KG:out:$(tail -c +$(($2 + 1)) "$out" | head -c "$3" | base64 | tr -d '\\n')"
if [ $(($2 + $3)) -ge "$4" ]; then rm -f "$out"; fi
`.trim();

export interface HostGitDeps {
  /** The folder on the host the git runs in. */
  hostDirectory: string;
  runCommand(request: HostCommandRequest): Promise<HostCommandResult>;
}

function scriptRequest(script: string, args: readonly string[], cwd: string, timeoutMs: number): HostCommandRequest {
  return { file: 'sh', args: ['-c', script, 'kangentic-git', ...args], cwd, timeoutMs };
}

/** The `KG:` lines of a script's output, or why it did not run. A failed or unanswered run throws. */
function readLines(result: HostCommandResult, what: string): string[] {
  if (result.error) throw new RemoteGitUnavailableError(result.error);
  if (result.timedOut) throw new RemoteGitUnavailableError(`Git on the host took too long to ${what}.`);
  const lines = result.stdout.split('\n').map((line) => line.trim()).filter((line) => line.startsWith(LINE_PREFIX)).map((line) => line.slice(LINE_PREFIX.length));
  const failure = lines.find((line) => line.startsWith('error:'));
  if (failure) throw new RemoteGitUnavailableError(`The host could not ${what}: ${failure.slice('error:'.length)}`);
  if (result.code !== 0) {
    throw new RemoteGitUnavailableError(result.stderr.trim() || `The host's shell exited with ${String(result.code)} while it tried to ${what}.`);
  }
  return lines;
}

function lineValue(lines: string[], key: string): string | null {
  const found = lines.find((line) => line.startsWith(`${key}:`));
  return found === undefined ? null : found.slice(key.length + 1);
}

function wholeNumber(text: string | null, what: string): number {
  if (text === null || !/^\d+$/.test(text)) throw new RemoteGitUnavailableError(`The host did not say ${what}.`);
  return Number(text);
}

export class HostGit implements RemoteGitRunner {
  constructor(private readonly deps: HostGitDeps) {}

  /** One request to the host. A link that is down, or a host that refuses, is `RemoteGitUnavailableError`, whatever it threw. */
  private async ask(request: HostCommandRequest): Promise<HostCommandResult> {
    try {
      return await this.deps.runCommand(request);
    } catch (error) {
      if (error instanceof RemoteGitUnavailableError) throw error;
      throw new RemoteGitUnavailableError(error instanceof Error ? error.message : String(error), { cause: error });
    }
  }

  async run(args: readonly string[], options?: { timeoutMs?: number }): Promise<RemoteGitResult> {
    const lines = readLines(
      await this.ask(scriptRequest(RUN_SCRIPT, [String(FIRST_CHUNK_BYTES), ...args], this.deps.hostDirectory, options?.timeoutMs ?? RUN_TIMEOUT_MS)),
      'run git',
    );
    const code = wholeNumber(lineValue(lines, 'code'), 'how git ended');
    const stderr = Buffer.from(lineValue(lines, 'err') ?? '', 'base64').toString('utf8');
    return { code, stdout: await this.collect(lines), stderr };
  }

  async readObject(objectName: string, options: { knownObjectId?: string; maxBytes: number }): Promise<
    | { kind: 'blob'; objectId: string; bytes: Buffer }
    | { kind: 'unchanged'; objectId: string }
    | { kind: 'too-large'; objectId: string; size: number }
    | { kind: 'missing' }
  > {
    // --batch-check reads one name per line, so a name holding a line break cannot be asked for.
    if (/[\r\n]/.test(objectName)) return { kind: 'missing' };
    const lines = readLines(
      await this.ask(scriptRequest(OBJECT_SCRIPT, [String(FIRST_CHUNK_BYTES), objectName, String(options.maxBytes), options.knownObjectId ?? ''], this.deps.hostDirectory, RUN_TIMEOUT_MS)),
      'read a file from git',
    );
    if (lines.includes('missing')) return { kind: 'missing' };
    const objectId = lineValue(lines, 'oid') ?? '';
    if (!OBJECT_ID.test(objectId)) throw new RemoteGitUnavailableError('The host did not name the object it read.');
    if (lines.includes('unchanged')) return { kind: 'unchanged', objectId };
    const tooBig = lineValue(lines, 'toobig');
    if (tooBig !== null) return { kind: 'too-large', objectId, size: wholeNumber(tooBig, 'how large the file is') };
    return { kind: 'blob', objectId, bytes: await this.collect(lines) };
  }

  async readWorkingFile(relativePath: string, maxBytes: number): Promise<RemoteWorkingFile> {
    const lines = readLines(
      await this.ask(scriptRequest(FILE_SCRIPT, [String(FIRST_CHUNK_BYTES), relativePath, String(maxBytes)], this.deps.hostDirectory, RUN_TIMEOUT_MS)),
      'read a file',
    );
    if (lines.includes('missing')) return { kind: 'missing' };
    const mtimeMs = wholeNumber(lineValue(lines, 'mtime'), 'when the file changed') * 1000;
    const tooBig = lineValue(lines, 'toobig');
    if (tooBig !== null) return { kind: 'too-large', size: wholeNumber(tooBig, 'how large the file is'), mtimeMs };
    return { kind: 'bytes', bytes: await this.collect(lines), mtimeMs };
  }

  async fingerprint(): Promise<string> {
    const lines = readLines(await this.ask(scriptRequest(FINGERPRINT_SCRIPT, [], this.deps.hostDirectory, FINGERPRINT_TIMEOUT_MS)), 'check for changes');
    const fingerprint = lineValue(lines, 'fp');
    if (fingerprint === null || fingerprint === '') throw new RemoteGitUnavailableError('The host did not say whether the checkout changed.');
    return fingerprint;
  }

  async countUntracked(relativePaths: readonly string[]): Promise<RemoteLineCount[]> {
    const counts: RemoteLineCount[] = [];
    for (let start = 0; start < relativePaths.length; start += COUNT_BATCH) {
      const batch = relativePaths.slice(start, start + COUNT_BATCH);
      const lines = readLines(
        await this.ask(scriptRequest(COUNT_SCRIPT, batch, this.deps.hostDirectory, RUN_TIMEOUT_MS)),
        'count lines',
      );
      const answers = lines.filter((line) => line.startsWith('count:')).map((line) => line.slice('count:'.length).split(':'));
      if (answers.length !== batch.length) throw new RemoteGitUnavailableError('The host counted a different number of files than it was asked about.');
      answers.forEach(([position, lineCount, binary], index) => {
        if (position !== String(index + 1)) throw new RemoteGitUnavailableError('The host answered about a different file than it was asked about.');
        counts.push({ insertions: wholeNumber(lineCount ?? null, 'how many lines a file has'), binary: binary === '1' });
      });
    }
    return counts;
  }

  /** The whole output a script's reply names: its first chunk, then the pieces the host kept for it. */
  private async collect(lines: string[]): Promise<Buffer> {
    const size = wholeNumber(lineValue(lines, 'size'), 'how much it printed');
    const head = Buffer.from(lineValue(lines, 'out') ?? '', 'base64');
    if (size <= FIRST_CHUNK_BYTES) {
      // Everything came in the first reply; the script removed its file.
      if (head.length !== size) throw new RemoteGitUnavailableError('The host sent less than it said it printed.');
      return head;
    }
    const id = lineValue(lines, 'id') ?? '';
    if (!RUN_ID.test(id)) throw new RemoteGitUnavailableError('The host did not name where it kept the output.');
    if (size > MAX_OUTPUT_BYTES) {
      await this.drop(id, size);
      throw new RemoteGitUnavailableError(`The host's output was ${size} bytes, more than Kangentic reads.`);
    }
    return this.pullRest(id, size, head);
  }

  /** The output past the first chunk, a piece at a time. Throws, and returns nothing, on a short or missing piece. */
  private async pullRest(id: string, size: number, head: Buffer): Promise<Buffer> {
    const pieces: Buffer[] = [head];
    let offset = head.length;
    if (offset !== FIRST_CHUNK_BYTES) throw new RemoteGitUnavailableError('The host sent a short first piece of its output.');
    while (offset < size) {
      const length = Math.min(PULL_CHUNK_BYTES, size - offset);
      const lines = readLines(
        await this.ask(scriptRequest(PULL_SCRIPT, [id, String(offset), String(length), String(size)], this.deps.hostDirectory, PULL_TIMEOUT_MS)),
        'read the output',
      );
      const piece = Buffer.from(lineValue(lines, 'out') ?? '', 'base64');
      if (piece.length !== length) throw new RemoteGitUnavailableError('The host sent a short piece of its output.');
      pieces.push(piece);
      offset += length;
    }
    return Buffer.concat(pieces, size);
  }

  /** Removes a run's output without reading it. Best effort: the host sweeps what is left. */
  private async drop(id: string, size: number): Promise<void> {
    try {
      await this.ask(scriptRequest(PULL_SCRIPT, [id, String(size), '0', String(size)], this.deps.hostDirectory, PULL_TIMEOUT_MS));
    } catch {
      // The sweep removes it.
    }
  }
}

export interface RemoteGitResolverDeps {
  /** The projects that live on a host: the shell folder here, and the host and folder it stands for. */
  remoteProjects(): Array<{ path: string; remote: { hostId: string; path: string } }>;
  runCommand(hostId: string, request: HostCommandRequest): Promise<HostCommandResult>;
}

/**
 * The runner for a directory under a remote project's shell folder (the folder itself, a worktree stand-in
 * below it, or any folder under either), found by the longest shell folder that holds it. A directory that is
 * under no remote project is null and goes on to this computer's git.
 */
export function createRemoteGitResolver(deps: RemoteGitResolverDeps): RemoteGitResolver {
  return (directory) => {
    let owner: { path: string; remote: { hostId: string; path: string } } | null = null;
    for (const project of deps.remoteProjects()) {
      const roots: SshCliPlace['roots'] = [{ local: project.path, host: project.remote.path }];
      if (!isUnderLocalRoot(directory, roots)) continue;
      if (owner === null || project.path.length > owner.path.length) owner = project;
    }
    if (owner === null) return null;
    const hostDirectory = localPathToHost(directory, [{ local: owner.path, host: owner.remote.path }]);
    const hostId = owner.remote.hostId;
    return new HostGit({ hostDirectory, runCommand: (request) => deps.runCommand(hostId, request) });
  };
}
