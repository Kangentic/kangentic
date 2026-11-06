/**
 * Bytes to and from a host, for what crosses between the two computers whole: a file an agent attaches, a
 * screenshot it asked for, a task's attachments before its agent starts (#913).
 *
 * The helper has no binary file job. `readFile` decodes text and answers in one frame, and `writeFileRaw` decodes
 * too. So this runs `sh` scripts through `runCommand`, as `HostGit` does, rather than adding a helper method: a new
 * link rejoins whatever program is already running on the host with no version check, and `runCommand` is there on
 * every one of them. One script reads or writes one chunk as base64, small enough that a request or a reply stays
 * inside a frame's 256 KiB, and every value is an argument, never shell text.
 *
 * `runCommand` does not hold its arguments beneath the user's home the way the helper's file jobs do, so the
 * scripts do. A path outside the home, and a symlink, are refused before anything is read or made.
 *
 * A write lands beside the target and is renamed in once whole, so a reader never sees half a file. A failed ask is
 * an error, never "absent".
 *
 * Imports nothing of electron.
 */

import type { HostCommandRequest, HostCommandResult } from './protocol/messages';
import type { RemoteHostService } from './remote-host-service';

/** What one reply or request carries. As base64 this leaves room in a frame's 256 KiB for its envelope. */
const CHUNK_BYTES = 144 * 1024;
const CHUNK_TIMEOUT_MS = 30_000;
const LINE_PREFIX = 'KG:';

export interface HostCommandAccess {
  runCommand(request: HostCommandRequest): Promise<HostCommandResult>;
}

/** What a tool may ask of a project's host. Every call is one ask, and a failed ask rejects. */
export interface HostAccess extends HostCommandAccess {
  hostId: string;
  pathPresence(paths: string[]): Promise<Array<'present' | 'absent'>>;
  removeFiles(paths: string[]): Promise<{ removed: number; conflicts?: string[] }>;
  listeningPorts(): Promise<number[]>;
}

let hostAccessLookup: ((hostId: string) => HostAccess | null) | null = null;

/** Set once at startup, as the other remote resolvers are, so a caller holding only a host id needs no new dependency. */
export function setHostAccessLookup(lookup: ((hostId: string) => HostAccess | null) | null): void {
  hostAccessLookup = lookup;
}

/** What may be asked of a host, or null before the SSH feature has started. */
export function hostAccessFor(hostId: string): HostAccess | null {
  return hostAccessLookup?.(hostId) ?? null;
}

/** The asks above bound to one host. */
export function hostAccessOf(
  service: Pick<RemoteHostService, 'runCommand' | 'pathPresence' | 'removeFiles' | 'listeningPorts'>,
  hostId: string,
): HostAccess {
  return {
    hostId,
    runCommand: (request) => service.runCommand(hostId, request),
    pathPresence: (paths) => service.pathPresence(hostId, paths),
    removeFiles: (paths) => service.removeFiles(hostId, paths),
    listeningPorts: () => service.listeningPorts(hostId),
  };
}

/** A transfer the host refused or could not finish. Its message is written for the agent or the run log to read. */
export class HostTransferError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'HostTransferError';
  }
}

export type HostFileRead =
  | { kind: 'bytes'; bytes: Buffer }
  | { kind: 'too-large'; size: number }
  | { kind: 'missing' };

/**
 * Sets `$home` to the real path of the user's home and refuses `$1` unless it is absolute. `inside_home <folder>`
 * passes only when the real path of the folder lies beneath it. The real paths, so a host whose `/home` is itself a
 * link still passes, and a symlinked folder that leads out of the home does not.
 */
const GUARD = `
case "$1" in /*) ;; *) echo KG:refused; exit 0 ;; esac
home=$(cd "$HOME" 2>/dev/null && pwd -P) || { echo KG:error:no-home; exit 3; }
inside_home() {
  real=$(cd "$1/" 2>/dev/null && pwd -P) || return 1
  case "$real/" in "$home"/*) return 0 ;; *) return 1 ;; esac
}`.trim();

/** Arguments are `path offset length max`. A file past `max` is reported, never read. */
const READ_SCRIPT = `
${GUARD}
file=$1; offset=$2; length=$3; max=$4
case "$offset$length$max" in ''|*[!0-9]*) echo KG:error:bad-number; exit 3 ;; esac
parent=\${file%/*}
[ -d "$parent/" ] || { echo KG:missing; exit 0; }
inside_home "$parent" || { echo KG:refused; exit 0; }
[ -L "$file" ] && { echo KG:refused; exit 0; }
[ -f "$file" ] || { echo KG:missing; exit 0; }
size=$(wc -c <"$file" | tr -d ' ')
echo "KG:size:$size"
if [ "$size" -gt "$max" ]; then echo KG:toobig; exit 0; fi
echo "KG:out:$(tail -c +$((offset + 1)) "$file" | head -c "$length" | base64 | tr -d '\\n')"
`.trim();

/**
 * Arguments are `path id step size`, and a `write` step's chunk is on stdin as base64. The first chunk starts the
 * staging file, each later one adds to it, and `finish` renames it in only when it holds exactly `size` bytes.
 * The deepest folder that exists is checked before any is made, so `mkdir` cannot be led outside the home.
 */
const WRITE_SCRIPT = `
${GUARD}
target=$1; id=$2; step=$3; size=$4
case "$id" in ''|*[!0-9a-z]*) echo KG:error:bad-id; exit 3 ;; esac
case "$size" in ''|*[!0-9]*) echo KG:error:bad-number; exit 3 ;; esac
parent=\${target%/*}
probe=$parent
while [ -n "$probe" ] && [ ! -d "$probe/" ]; do probe=\${probe%/*}; done
inside_home "$probe" || { echo KG:refused; exit 0; }
{ [ -L "$target" ] || [ -d "$target" ]; } && { echo KG:refused; exit 0; }
mkdir -p "$parent" || { echo KG:error:no-folder; exit 3; }
inside_home "$parent" || { echo KG:refused; exit 0; }
staging="$target.$id.tmp"
case "$step" in
  first) rm -f "$staging"; base64 -d >"$staging" || { rm -f "$staging"; echo KG:error:write; exit 3; } ;;
  more) base64 -d >>"$staging" || { rm -f "$staging"; echo KG:error:write; exit 3; } ;;
  finish)
    written=$(wc -c <"$staging" | tr -d ' ')
    if [ "$written" != "$size" ]; then rm -f "$staging"; echo KG:error:short; exit 3; fi
    mv -f "$staging" "$target" || { rm -f "$staging"; echo KG:error:rename; exit 3; }
    ;;
  abort) rm -f "$staging" ;;
  *) echo KG:error:bad-step; exit 3 ;;
esac
echo KG:ok
`.trim();

/** Arguments are the paths. One `KG:size:<position>:<bytes>` line each, in order, with `-` for what is no plain file. */
const SIZES_SCRIPT = `
position=0
for file; do
  position=$((position + 1))
  if [ -f "$file" ] && [ ! -L "$file" ]; then echo "KG:size:$position:$(wc -c <"$file" | tr -d ' ')"; else echo "KG:size:$position:-"; fi
done
`.trim();

function scriptRequest(script: string, args: readonly string[], stdin?: string): HostCommandRequest {
  return { file: 'sh', args: ['-c', script, 'kangentic-transfer', ...args], timeoutMs: CHUNK_TIMEOUT_MS, ...(stdin === undefined ? {} : { stdin }) };
}

/** One script's `KG:` lines. A host that could not be asked, or a script that failed, throws. */
async function ask(access: HostCommandAccess, request: HostCommandRequest, what: string): Promise<string[]> {
  let result: HostCommandResult;
  try {
    result = await access.runCommand(request);
  } catch (error) {
    throw new HostTransferError(`The host could not be reached to ${what}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (result.error) throw new HostTransferError(`The host could not ${what}: ${result.error}`);
  if (result.timedOut) throw new HostTransferError(`The host took too long to ${what}.`);
  const lines = result.stdout.split('\n').map((line) => line.trim()).filter((line) => line.startsWith(LINE_PREFIX)).map((line) => line.slice(LINE_PREFIX.length));
  const failure = lines.find((line) => line.startsWith('error:'));
  if (failure) throw new HostTransferError(`The host could not ${what}: ${failure.slice('error:'.length)}.`);
  if (result.code !== 0) throw new HostTransferError(result.stderr.trim() || `The host could not ${what}: its shell exited with ${String(result.code)}.`);
  return lines;
}

function refusal(hostPath: string): HostTransferError {
  return new HostTransferError(`${hostPath} is not a plain file beneath this host's home folder, so Kangentic did not touch it. Copy it into your working folder and use that path.`);
}

function lineValue(lines: readonly string[], key: string): string | null {
  const found = lines.find((line) => line.startsWith(`${key}:`));
  return found === undefined ? null : found.slice(key.length + 1);
}

/**
 * A file on the host, whole. Past `maxBytes` it is reported and not read. A file that changes size while it is
 * read fails: a transfer is never part of one version and part of another.
 */
export async function readHostBytes(access: HostCommandAccess, hostPath: string, maxBytes: number): Promise<HostFileRead> {
  const what = `read ${hostPath}`;
  const chunks: Buffer[] = [];
  let received = 0;
  let expected: number | null = null;
  for (;;) {
    const lines = await ask(access, scriptRequest(READ_SCRIPT, [hostPath, String(received), String(CHUNK_BYTES), String(maxBytes)]), what);
    if (lines.includes('refused')) throw refusal(hostPath);
    if (lines.includes('missing')) return { kind: 'missing' };
    const sizeText = lineValue(lines, 'size');
    if (sizeText === null || !/^\d+$/.test(sizeText)) throw new HostTransferError(`The host did not say how large ${hostPath} is.`);
    const size = Number(sizeText);
    if (lines.includes('toobig')) return { kind: 'too-large', size };
    if (expected !== null && size !== expected) throw new HostTransferError(`${hostPath} changed while it was being read.`);
    expected = size;
    const chunk = Buffer.from(lineValue(lines, 'out') ?? '', 'base64');
    chunks.push(chunk);
    received += chunk.length;
    if (received >= size) break;
    if (chunk.length === 0) throw new HostTransferError(`The host sent less of ${hostPath} than it said it held.`);
  }
  if (received !== expected) throw new HostTransferError(`The host sent less of ${hostPath} than it said it held.`);
  return { kind: 'bytes', bytes: Buffer.concat(chunks, received) };
}

/** Each file's size on the host, in the order asked, or null for what is not there. One ask for all of them. */
export async function hostFileSizes(access: HostCommandAccess, hostPaths: readonly string[]): Promise<Array<number | null>> {
  if (hostPaths.length === 0) return [];
  const lines = await ask(access, scriptRequest(SIZES_SCRIPT, hostPaths), 'check which files it holds');
  const answers = lines.filter((line) => line.startsWith('size:')).map((line) => line.slice('size:'.length).split(':'));
  if (answers.length !== hostPaths.length) throw new HostTransferError('The host answered about a different number of files than it was asked about.');
  return answers.map(([, size]) => (size !== undefined && /^\d+$/.test(size) ? Number(size) : null));
}

/** Write a file on the host, making its folders. Replaces a file already there, and leaves nothing behind on a failure. */
export async function writeHostBytes(access: HostCommandAccess, hostPath: string, bytes: Buffer): Promise<void> {
  const what = `write ${hostPath}`;
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const size = String(bytes.length);
  try {
    let sent = 0;
    do {
      const chunk = bytes.subarray(sent, sent + CHUNK_BYTES);
      const step = sent === 0 ? 'first' : 'more';
      const lines = await ask(access, scriptRequest(WRITE_SCRIPT, [hostPath, id, step, size], chunk.toString('base64')), what);
      if (lines.includes('refused')) throw refusal(hostPath);
      sent += chunk.length;
    } while (sent < bytes.length);
    const lines = await ask(access, scriptRequest(WRITE_SCRIPT, [hostPath, id, 'finish', size]), what);
    if (lines.includes('refused')) throw refusal(hostPath);
  } catch (error) {
    // The script removes its staging file when it fails. This covers a chunk that never reached it.
    await access.runCommand(scriptRequest(WRITE_SCRIPT, [hostPath, id, 'abort', size])).catch(() => undefined);
    throw error;
  }
}
