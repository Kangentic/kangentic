import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import {
  StderrTail,
  DEFAULT_STDERR_TAIL_BYTES,
  UTILITY_PROCESS_STDIO,
  captureWorkerStderr,
  redactHomeDirectory,
  summarizeStderrTail,
} from '../../src/main/utility-process/stderr-tail';

/**
 * StderrTail - the bounded stderr capture behind the utility-process crash
 * report (DESKTOP-H). The Sentry event for a worker that died at module load
 * carried only "exit code 1" because the worker's stderr was inherited into a
 * GUI process with no console. These pin the three properties the capture
 * must have: it keeps the NEWEST bytes, it never leaks the home directory,
 * and it summarizes to the line that names the error.
 */

const POSIX_HOME = '/home/dev';

function makeTail(maxBytes = DEFAULT_STDERR_TAIL_BYTES): StderrTail {
  return new StderrTail(maxBytes, POSIX_HOME, false);
}

describe('StderrTail', () => {
  it('keeps everything under the byte budget verbatim, minus trailing whitespace', () => {
    const tail = makeTail();
    tail.append('first line\n');
    tail.append(Buffer.from('second line\n'));
    expect(tail.snapshot()).toBe('first line\nsecond line');
  });

  it('drops whole oldest lines once over budget, so the newest lines survive intact', () => {
    // Eight 8-byte lines fill a 64-byte budget exactly; every line after that
    // evicts the oldest one.
    const tail = makeTail(64);
    for (let index = 0; index < 20; index += 1) {
      tail.append(`line-${String(index).padStart(2, '0')}\n`);
    }
    const snapshot = tail.snapshot();
    expect(Buffer.byteLength(snapshot, 'utf8')).toBeLessThanOrEqual(64);
    expect(snapshot.startsWith('line-12\n')).toBe(true);
    expect(snapshot.endsWith('line-19')).toBe(true);
    expect(snapshot).not.toContain('line-11');
  });

  it('keeps the newest bytes of a single line larger than the whole budget', () => {
    const tail = makeTail(16);
    tail.append(`${'a'.repeat(40)}END`);
    expect(tail.snapshot()).toBe(`${'a'.repeat(13)}END`);
  });

  it('keeps the newest bytes of an oversized single line of multi-byte text', () => {
    // The over-budget cut point is a BYTE count. Using it as a string index
    // overshoots as soon as a character costs more than one UTF-16 unit, and
    // for an all-emoji line it cut past the end and left the tail empty - so
    // the crash report lost the whole diagnostic it exists to carry.
    const tail = makeTail(10);
    tail.append('\u{1F600}'.repeat(5)); // 5 emoji: 20 bytes, 10 UTF-16 units.
    const snapshot = tail.snapshot();
    expect(snapshot).toBe('\u{1F600}\u{1F600}');
    expect(Buffer.byteLength(snapshot, 'utf8')).toBeLessThanOrEqual(10);
    // The cut lands on a character boundary, so nothing decodes to U+FFFD.
    expect(snapshot).not.toContain('�');
  });

  it('reassembles a multi-byte character split across two chunks', () => {
    const bytes = Buffer.from('caf\u00e9 error\n', 'utf8');
    const tail = makeTail();
    // 'caf' plus the first byte of the two-byte e-acute.
    tail.append(bytes.subarray(0, 4));
    tail.append(bytes.subarray(4));
    expect(tail.snapshot()).toBe('caf\u00e9 error');
  });

  it('redacts the home directory in the snapshot', () => {
    const tail = makeTail();
    tail.append('Require stack:\n- /home/dev/app/resources/app.asar.unpacked/x.js\n');
    expect(tail.snapshot()).toBe('Require stack:\n- ~/app/resources/app.asar.unpacked/x.js');
  });

  it('clear() empties it', () => {
    const tail = makeTail();
    tail.append('boom\n');
    tail.clear();
    expect(tail.snapshot()).toBe('');
  });
});

describe('redactHomeDirectory', () => {
  it('replaces a Windows home path in either separator and any letter case with ~', () => {
    const text = 'Require stack:\n- C:\\Users\\dev\\AppData\\x.js\n- c:/users/DEV/app/y.js';
    expect(redactHomeDirectory(text, 'C:\\Users\\dev', true)).toBe(
      'Require stack:\n- ~\\AppData\\x.js\n- ~/app/y.js',
    );
  });

  it('replaces a POSIX home path and stays case-sensitive off Windows', () => {
    expect(redactHomeDirectory('at /home/dev/app/index.js', POSIX_HOME, false)).toBe('at ~/app/index.js');
    expect(redactHomeDirectory('at /home/DEV/app/index.js', POSIX_HOME, false)).toBe('at /home/DEV/app/index.js');
  });

  it('leaves a longer name that merely starts with the home path alone', () => {
    expect(redactHomeDirectory('/home/developer/x', POSIX_HOME, false)).toBe('/home/developer/x');
  });

  it('tolerates a trailing separator on the home path', () => {
    expect(redactHomeDirectory('/home/dev/x', '/home/dev/', false)).toBe('~/x');
  });

  it('is a no-op for an empty home directory or empty text', () => {
    expect(redactHomeDirectory('/home/dev/x', '', false)).toBe('/home/dev/x');
    expect(redactHomeDirectory('', POSIX_HOME, false)).toBe('');
  });
});

describe('summarizeStderrTail', () => {
  it("picks the first line naming an error out of Node's module-load dump", () => {
    const dump = [
      'node:internal/modules/cjs/loader:1228',
      '  throw err;',
      '  ^',
      '',
      "Error: Cannot find module 'onnxruntime-common'",
      'Require stack:',
      '- ~/app/x.js',
    ].join('\n');
    expect(summarizeStderrTail(dump)).toBe("Error: Cannot find module 'onnxruntime-common'");
  });

  it('falls back to the first non-empty line when nothing names an error', () => {
    expect(summarizeStderrTail('\n\n  onnxruntime: warning about initializers  \nmore')).toBe(
      'onnxruntime: warning about initializers',
    );
  });

  it('returns null for blank input', () => {
    expect(summarizeStderrTail('')).toBeNull();
    expect(summarizeStderrTail('\n  \n')).toBeNull();
  });

  it('truncates a long line to the cap with an ellipsis', () => {
    const summary = summarizeStderrTail(`Error: ${'x'.repeat(300)}`, 40);
    expect(summary).not.toBeNull();
    expect(summary?.length).toBe(40);
    expect(summary?.endsWith('...')).toBe(true);
  });
});

describe('captureWorkerStderr', () => {
  function makeStream(): EventEmitter & { asReadable: () => NodeJS.ReadableStream } {
    const emitter = new EventEmitter() as EventEmitter & { asReadable: () => NodeJS.ReadableStream };
    emitter.asReadable = () => emitter as unknown as NodeJS.ReadableStream;
    return emitter;
  }

  it('drains a piped stderr into the tail', () => {
    const stream = makeStream();
    const tail = makeTail();
    captureWorkerStderr({ stderr: stream.asReadable() }, tail, false);
    stream.emit('data', Buffer.from('boom\n'));
    stream.emit('data', 'bang\n');
    expect(tail.snapshot()).toBe('boom\nbang');
  });

  it('is a no-op when the child has no stderr (stdio not piped)', () => {
    const tail = makeTail();
    expect(() => captureWorkerStderr({ stderr: null }, tail, true)).not.toThrow();
    expect(tail.snapshot()).toBe('');
  });

  it('passes chunks through to the raw process stderr only when asked (the dev-terminal parity path)', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const silent = makeStream();
      captureWorkerStderr({ stderr: silent.asReadable() }, makeTail(), false);
      silent.emit('data', 'quiet\n');
      expect(write).not.toHaveBeenCalled();

      const loud = makeStream();
      captureWorkerStderr({ stderr: loud.asReadable() }, makeTail(), true);
      loud.emit('data', 'loud\n');
      expect(write).toHaveBeenCalledWith('loud\n');
    } finally {
      write.mockRestore();
    }
  });

  it('swallows a stream error, since the exit handler owns a dying child', () => {
    const stream = makeStream();
    captureWorkerStderr({ stderr: stream.asReadable() }, makeTail(), false);
    // An EventEmitter with no 'error' listener would throw here.
    expect(() => stream.emit('error', new Error('EPIPE'))).not.toThrow();
  });
});

describe('UTILITY_PROCESS_STDIO', () => {
  it('pipes stderr only, with stdin and stdout ignored', () => {
    expect(UTILITY_PROCESS_STDIO).toEqual(['ignore', 'ignore', 'pipe']);
  });

  it('never mixes inherit with a real handle in the stdout/stderr slots (DESKTOP-S)', () => {
    // Electron leaves an `inherit` slot's Windows handle null and passes both
    // to ServiceProcessHost anyway. Electron's own patch to
    // child_process_launcher_helper_win.cc (not stock Chromium) arms the
    // child's inherit list when EITHER handle is valid, then fills the null
    // slot from GetStdHandle(), which is NULL in a packaged GUI process with no
    // console. SetHandleInformation on that null handle then fails a PCHECK in
    // launch_win.cc and kills the main process. All-inherit is safe (the list
    // is never built) and all-real is safe, so this checks the mix rather than
    // banning `inherit` outright.
    const [stdin, ...outputs] = UTILITY_PROCESS_STDIO;
    expect(stdin).toBe('ignore'); // Electron supports nothing else here.
    const inheritCount = outputs.filter((mode) => mode === 'inherit').length;
    expect(inheritCount === 0 || inheritCount === outputs.length).toBe(true);
  });
});

describe('utilityProcess.fork call sites', () => {
  it('every utilityProcess.fork call passes the shared UTILITY_PROCESS_STDIO constant, never an inline literal', () => {
    // The value-level tests above (and the ones in embed-client.test.ts /
    // line-count-client.test.ts) only pin what UTILITY_PROCESS_STDIO equals -
    // they use deep equality, so a call site that inlines its own literal
    // array matching today's value would pass them silently. That defeats the
    // "one place this is decided" invariant this constant exists for: the
    // NEXT time it changes for a good reason, a duplicated literal is exactly
    // how DESKTOP-S (or its next variant) comes back at a call site nobody
    // remembered to update. This scans source text for the identifier itself.
    const repoRoot = path.resolve(__dirname, '../..');
    const scanRoot = path.join(repoRoot, 'src/main');
    const offenders: string[] = [];

    function collectSourceFiles(directory: string): string[] {
      const files: string[] = [];
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          files.push(...collectSourceFiles(fullPath));
        } else if (fullPath.endsWith('.ts') && !fullPath.endsWith('.d.ts')) {
          files.push(fullPath);
        }
      }
      return files;
    }

    for (const filePath of collectSourceFiles(scanRoot)) {
      const relPath = path.relative(repoRoot, filePath).replace(/\\/g, '/');
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
      lines.forEach((line, index) => {
        if (!/utilityProcess\.fork\s*\(/.test(line)) return;
        // A small window past the call line covers a fork() options object
        // that wraps onto following lines, not just the single-line form both
        // current call sites use.
        const window = lines.slice(index, index + 4).join('\n');
        if (!/stdio:\s*UTILITY_PROCESS_STDIO\b/.test(window)) {
          offenders.push(`${relPath}:${index + 1}`);
        }
      });
    }

    expect(
      offenders,
      `Every utilityProcess.fork call must pass stdio: UTILITY_PROCESS_STDIO, never an inline array - see stderr-tail.ts for why the stdout/stderr slots must never mix inherit with a real handle (DESKTOP-S). Offenders:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
