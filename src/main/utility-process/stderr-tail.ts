import os from 'node:os';
import { StringDecoder } from 'node:string_decoder';

/**
 * Bounded tail of a utility process's stderr, kept so a worker that dies can
 * say why.
 *
 * `utilityProcess.fork` defaults `stdio` to `inherit`, which on a packaged GUI
 * build sends the worker's stderr nowhere: the uncaught-exception dump that
 * names a crash was thrown away on every occurrence, and the crash report
 * could only say "exited with code 1" (DESKTOP-H). Both workers now fork with
 * stderr piped (`UTILITY_PROCESS_STDIO`) and drain it into one of these per
 * child; the restart policy reads it when it logs a crash and when it reports
 * the latch.
 *
 * Byte-bounded, not line-bounded: native onnxruntime output arrives with no
 * line discipline, and a bound on bytes is what keeps the Sentry context and
 * the log line small whatever the shape of the text. Old bytes are dropped
 * from the front at a line boundary once the budget is exceeded, so the newest
 * lines (the crash) always survive.
 *
 * The snapshot redacts the home directory. Node's `Require stack:` lines print
 * absolute install paths under the user's profile, and the Sentry SDK's path
 * normalizer rewrites stack frames only, never free text, so this is the one
 * scrub that has to happen at the capture site.
 */

/** stdio for both Kangentic utility processes: stdin must be `ignore`
 *  (Electron supports nothing else there), stdout keeps the `inherit`
 *  default, stderr is piped so `captureWorkerStderr` can drain it. */
export const UTILITY_PROCESS_STDIO: Array<'pipe' | 'ignore' | 'inherit'> = ['ignore', 'inherit', 'pipe'];

export const DEFAULT_STDERR_TAIL_BYTES = 8 * 1024;

/** What the restart policy holds per crash. Read lazily, by reference: the
 *  pipe can still be draining when the `exit` event that records the crash
 *  fires, and the latch report comes two backoffs after the first crash. */
export interface StderrSource {
  snapshot(): string;
}

export class StderrTail implements StderrSource {
  private readonly decoder = new StringDecoder('utf8');
  private text = '';

  constructor(
    private readonly maxBytes: number = DEFAULT_STDERR_TAIL_BYTES,
    private readonly homeDirectory: string = os.homedir(),
    private readonly caseInsensitiveHome: boolean = process.platform === 'win32',
  ) {}

  append(chunk: Buffer | string): void {
    const decoded = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    if (decoded.length === 0) return;
    this.text += decoded;
    this.trimToBudget();
  }

  /** The retained text, home directory redacted, trailing whitespace dropped. */
  snapshot(): string {
    return redactHomeDirectory(this.text, this.homeDirectory, this.caseInsensitiveHome).trimEnd();
  }

  clear(): void {
    this.text = '';
  }

  private trimToBudget(): void {
    let bytes = Buffer.byteLength(this.text, 'utf8');
    while (bytes > this.maxBytes) {
      const newlineIndex = this.text.indexOf('\n');
      if (newlineIndex !== -1 && newlineIndex < this.text.length - 1) {
        // Drop the oldest whole line.
        bytes -= Buffer.byteLength(this.text.slice(0, newlineIndex + 1), 'utf8');
        this.text = this.text.slice(newlineIndex + 1);
        continue;
      }
      // A single line larger than the whole budget: keep its newest bytes.
      // The cut is made on the encoded bytes, not on the string. A byte count
      // is not a valid code-unit index once the text stops being ASCII, and
      // using it as one overshoots: a tail of 4-byte emoji cuts to empty,
      // losing the whole diagnostic. Advancing past continuation bytes puts
      // the cut on a character boundary, so nothing is split and nothing
      // decodes to U+FFFD.
      const encoded = Buffer.from(this.text, 'utf8');
      let start = encoded.length - this.maxBytes;
      while (start < encoded.length && (encoded[start] & 0xc0) === 0x80) start += 1;
      this.text = encoded.subarray(start).toString('utf8');
      bytes = Buffer.byteLength(this.text, 'utf8');
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replace every spelling of the home directory (either separator, and on
 *  Windows any letter case) with `~`. A longer name that merely starts with
 *  the home path (`/home/dev` inside `/home/developer`) is left alone. */
export function redactHomeDirectory(
  text: string,
  homeDirectory: string = os.homedir(),
  caseInsensitive: boolean = process.platform === 'win32',
): string {
  const trimmedHome = homeDirectory.replace(/[\\/]+$/, '');
  if (trimmedHome.length === 0 || text.length === 0) return text;
  // Escape each SEGMENT and rejoin with the separator class. Escaping the
  // whole path first and then pattern-matching the escaped separators works,
  // but it means reading `escapeRegExp`'s output as an intermediate form.
  const separatorAgnostic = trimmedHome.split(/[\\/]+/).map(escapeRegExp).join('[\\\\/]+');
  const pattern = new RegExp(`${separatorAgnostic}(?![\\w-])`, caseInsensitive ? 'gi' : 'g');
  return text.replace(pattern, '~');
}

/** The line that best explains a crash, for the in-app signal: the first line
 *  naming an error, else the first non-empty line, cut to `maxLength`. */
export function summarizeStderrTail(tail: string, maxLength = 160): string | null {
  const lines = tail
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return null;
  const chosen = lines.find((line) => /error/i.test(line)) ?? lines[0];
  // Math.max, because a negative second argument to slice counts from the end
  // and would return nearly the whole line for a caller asking for a tiny cap.
  return chosen.length > maxLength ? `${chosen.slice(0, Math.max(0, maxLength - 3))}...` : chosen;
}

/** Drain a forked worker's piped stderr into `tail`. Draining is mandatory:
 *  once the OS pipe buffer fills, an undrained pipe blocks the child on its
 *  next write. `passThrough` re-emits each chunk on this process's stderr so a
 *  dev terminal still shows the worker's output the way `inherit` did; it
 *  writes the raw stream rather than `console.error`, so the log mirror does
 *  not persist every worker line as an error entry. */
export function captureWorkerStderr(
  child: { stderr: NodeJS.ReadableStream | null },
  tail: StderrTail,
  passThrough: boolean,
): void {
  const stream = child.stderr;
  if (!stream) return;
  stream.on('data', (chunk: Buffer | string) => {
    tail.append(chunk);
    if (!passThrough) return;
    try {
      process.stderr.write(chunk);
    } catch {
      // A dev terminal that has gone away is not the worker's problem.
    }
  });
  stream.on('error', () => {
    // A broken pipe from a dying child is expected; the exit handler owns it.
  });
}
