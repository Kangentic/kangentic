import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createLinuxGpuZygoteProbe,
  findUnsandboxedZygotePid,
  parseProcStat,
  readZygoteState,
} from '../../src/main/diagnostics/linux-gpu-zygote';

/**
 * linux-gpu-zygote.ts reads `/proc` to say whether the Linux GPU process's
 * zygote was alive when Chromium fell back (DESKTOP-W). These tests build a
 * fake `/proc` under the OS temp dir, so they run the same on every platform.
 * The file contents follow the real formats (stat fields, NUL-separated
 * cmdline, the limits table, the loadavg line), and the thread count and
 * process limit are the values an Electron 41 run on Ubuntu 24.04 read.
 *
 * The load-bearing assertions:
 *   - discovery picks the browser's OWN unsandboxed zygote, never a process
 *     that merely carries its argv. A zygote's forked children (the GPU
 *     process among them) keep the zygote's command line, so matching argv
 *     alone would pick the GPU process;
 *   - the state reads `dead` for a missing entry, a zombie and a reused pid,
 *     and `unknown` only when there is no evidence;
 *   - the probe remembers the pid it found, because by the time the fallback
 *     asks, the zygote may already be gone.
 */

const BROWSER_PID = 3037;
const UNSANDBOXED_ZYGOTE_PID = 3041;
const SANDBOXED_ZYGOTE_PID = 3042;
const GPU_PID = 3067;

const UNSANDBOXED_ARGV = ['/opt/Kangentic/kangentic', '--type=zygote', '--no-zygote-sandbox', '--enable-crash-reporter'];
const SANDBOXED_ARGV = ['/opt/Kangentic/kangentic', '--type=zygote', '--enable-crash-reporter'];

let procRoot: string;

function writeProcFile(relativePath: string, content: string): void {
  const filePath = path.join(procRoot, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function statLine(pid: number, state: string, parentPid: number, name = 'kangentic'): string {
  return `${pid} (${name}) ${state} ${parentPid} ${parentPid} ${parentPid} 0 -1 4194624 1234 0 0 0 12 3 0 0 20 0 18 0 81234 0 0\n`;
}

function writeProcess(pid: number, state: string, parentPid: number, argv: string[]): void {
  writeProcFile(`${pid}/stat`, statLine(pid, state, parentPid));
  writeProcFile(`${pid}/cmdline`, argv.join('\0') + '\0');
}

/** The browser, its two zygotes, and the GPU process forked from the
 *  unsandboxed zygote with that zygote's argv. */
function writeHealthyTree(options: { childrenFiles: boolean }): void {
  writeProcess(BROWSER_PID, 'S', 1, ['/opt/Kangentic/kangentic']);
  writeProcess(UNSANDBOXED_ZYGOTE_PID, 'S', BROWSER_PID, UNSANDBOXED_ARGV);
  writeProcess(SANDBOXED_ZYGOTE_PID, 'S', BROWSER_PID, SANDBOXED_ARGV);
  writeProcess(GPU_PID, 'S', UNSANDBOXED_ZYGOTE_PID, UNSANDBOXED_ARGV);
  if (options.childrenFiles) {
    // Children are listed per thread; the zygotes come from the main thread.
    writeProcFile(`${BROWSER_PID}/task/${BROWSER_PID}/children`, `${SANDBOXED_ZYGOTE_PID} ${UNSANDBOXED_ZYGOTE_PID} `);
    writeProcFile(`${BROWSER_PID}/task/3040/children`, '');
  }
  writeProcFile('loadavg', '0.52 0.58 0.59 3/970 3041\n');
  writeProcFile(
    'self/limits',
    [
      'Limit                     Soft Limit           Hard Limit           Units     ',
      'Max cpu time              unlimited            unlimited            seconds   ',
      'Max processes             123561               123561               processes ',
      'Max open files            1024                 524288               files     ',
      '',
    ].join('\n'),
  );
}

beforeEach(() => {
  procRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-fake-proc-'));
});

afterEach(() => {
  fs.rmSync(procRoot, { recursive: true, force: true });
});

describe('parseProcStat', () => {
  it('reads state and parent pid after the LAST paren, since a command name can hold spaces and parens', () => {
    expect(parseProcStat('123 (my (weird) name) Z 45 45 45 0 -1')).toEqual({ state: 'Z', parentPid: 45 });
    expect(parseProcStat(statLine(3041, 'S', 3037))).toEqual({ state: 'S', parentPid: 3037 });
  });

  it('returns null on a line it cannot read', () => {
    expect(parseProcStat('')).toBeNull();
    expect(parseProcStat('123 no parens here')).toBeNull();
    expect(parseProcStat('123 (kangentic) S notanumber')).toBeNull();
  });
});

describe('findUnsandboxedZygotePid', () => {
  it("finds the browser's unsandboxed zygote from the per-thread children files", () => {
    writeHealthyTree({ childrenFiles: true });
    expect(findUnsandboxedZygotePid(procRoot, BROWSER_PID)).toBe(UNSANDBOXED_ZYGOTE_PID);
  });

  it('scans every process when the children files are missing (a kernel without CONFIG_PROC_CHILDREN)', () => {
    writeHealthyTree({ childrenFiles: false });
    expect(findUnsandboxedZygotePid(procRoot, BROWSER_PID)).toBe(UNSANDBOXED_ZYGOTE_PID);
  });

  it('falls back to the full scan when task/ exists and lists threads but none has a readable children file', () => {
    writeHealthyTree({ childrenFiles: false });
    // task/<tid>/ exists, so the readdir that lists thread ids succeeds, but
    // no thread has a children file underneath it. That must read as "no
    // evidence" (null), not as an empty child list - an empty array would
    // short-circuit findUnsandboxedZygotePid past the scan it needs here.
    fs.mkdirSync(path.join(procRoot, String(BROWSER_PID), 'task', String(BROWSER_PID)), { recursive: true });
    fs.mkdirSync(path.join(procRoot, String(BROWSER_PID), 'task', '3040'), { recursive: true });

    expect(findUnsandboxedZygotePid(procRoot, BROWSER_PID)).toBe(UNSANDBOXED_ZYGOTE_PID);
  });

  it("never picks the GPU process, which carries the zygote's argv but is the zygote's child", () => {
    // Only the GPU process has the unsandboxed argv among these, and it is
    // not a direct child of the browser.
    writeProcess(BROWSER_PID, 'S', 1, ['/opt/Kangentic/kangentic']);
    writeProcess(SANDBOXED_ZYGOTE_PID, 'S', BROWSER_PID, SANDBOXED_ARGV);
    writeProcess(GPU_PID, 'S', UNSANDBOXED_ZYGOTE_PID, UNSANDBOXED_ARGV);
    expect(findUnsandboxedZygotePid(procRoot, BROWSER_PID)).toBeNull();
  });

  it('returns null rather than throwing when /proc cannot be read at all', () => {
    expect(findUnsandboxedZygotePid(path.join(procRoot, 'missing'), BROWSER_PID)).toBeNull();
  });

  it('matches a zygote whose cmdline was rewritten by setproctitle (one space-joined string, NUL padded), and does not match the sandboxed zygote written the same way', () => {
    writeHealthyTree({ childrenFiles: true });
    // Chromium ships a setproctitle that rewrites argv[0] in place, so a
    // process that renamed its own title reads /proc/<pid>/cmdline back as
    // one space-joined string with trailing NUL padding, not the normal
    // NUL-separated argv vector.
    writeProcFile(
      `${UNSANDBOXED_ZYGOTE_PID}/cmdline`,
      '/opt/Kangentic/kangentic --type=zygote --no-zygote-sandbox --enable-crash-reporter' + '\0\0\0',
    );
    writeProcFile(
      `${SANDBOXED_ZYGOTE_PID}/cmdline`,
      '/opt/Kangentic/kangentic --type=zygote --enable-crash-reporter' + '\0\0\0',
    );

    expect(findUnsandboxedZygotePid(procRoot, BROWSER_PID)).toBe(UNSANDBOXED_ZYGOTE_PID);

    // The sandboxed zygote, written the same rewritten-title way, must still
    // not match once it is the only zygote in reach.
    writeProcFile(`${BROWSER_PID}/task/${BROWSER_PID}/children`, `${SANDBOXED_ZYGOTE_PID} `);
    expect(findUnsandboxedZygotePid(procRoot, BROWSER_PID)).toBeNull();
  });
});

describe('readZygoteState', () => {
  it('is alive while the zygote is running under the browser', () => {
    writeHealthyTree({ childrenFiles: true });
    expect(readZygoteState(procRoot, UNSANDBOXED_ZYGOTE_PID, BROWSER_PID)).toBe('alive');
  });

  it('is dead when the zygote is gone, a zombie, or its pid now belongs to another parent', () => {
    writeHealthyTree({ childrenFiles: true });
    fs.rmSync(path.join(procRoot, String(UNSANDBOXED_ZYGOTE_PID)), { recursive: true, force: true });
    expect(readZygoteState(procRoot, UNSANDBOXED_ZYGOTE_PID, BROWSER_PID)).toBe('dead');

    writeProcess(UNSANDBOXED_ZYGOTE_PID, 'Z', BROWSER_PID, []);
    expect(readZygoteState(procRoot, UNSANDBOXED_ZYGOTE_PID, BROWSER_PID)).toBe('dead');

    writeProcess(UNSANDBOXED_ZYGOTE_PID, 'S', 1, ['/usr/bin/some-other-program']);
    expect(readZygoteState(procRoot, UNSANDBOXED_ZYGOTE_PID, BROWSER_PID)).toBe('dead');
  });

  it('is unknown when the entry exists but cannot be parsed', () => {
    writeProcFile(`${UNSANDBOXED_ZYGOTE_PID}/stat`, 'garbage');
    expect(readZygoteState(procRoot, UNSANDBOXED_ZYGOTE_PID, BROWSER_PID)).toBe('unknown');
  });

  it('is unknown, not dead, on a non-ENOENT read error (a directory sits where the stat file should be)', () => {
    // readFileSync on a directory throws EISDIR on both Windows and Linux,
    // which is a different failure than the missing-entry ENOENT the "dead"
    // branch is reserved for. An unreadable entry that still exists is no
    // evidence either way.
    fs.mkdirSync(path.join(procRoot, String(UNSANDBOXED_ZYGOTE_PID), 'stat'), { recursive: true });
    expect(readZygoteState(procRoot, UNSANDBOXED_ZYGOTE_PID, BROWSER_PID)).toBe('unknown');
  });
});

describe('createLinuxGpuZygoteProbe', () => {
  it('reads the zygote state, the system-wide thread count, and the soft process limit', () => {
    writeHealthyTree({ childrenFiles: true });
    const probe = createLinuxGpuZygoteProbe(BROWSER_PID, procRoot);
    probe.discover();
    expect(probe.snapshot()).toEqual({ zygote: 'alive', schedulingEntities: 970, maxUserProcesses: '123561' });
  });

  it('remembers the zygote it found, so a zygote that dies later reads dead rather than unknown (the DESKTOP-W moment)', () => {
    writeHealthyTree({ childrenFiles: true });
    const probe = createLinuxGpuZygoteProbe(BROWSER_PID, procRoot);
    probe.discover();

    fs.rmSync(path.join(procRoot, String(UNSANDBOXED_ZYGOTE_PID)), { recursive: true, force: true });
    fs.writeFileSync(path.join(procRoot, `${BROWSER_PID}/task/${BROWSER_PID}/children`), `${SANDBOXED_ZYGOTE_PID} `);
    // A second discover must not search again and forget the dead pid.
    probe.discover();

    expect(probe.snapshot().zygote).toBe('dead');
  });

  it('reads unknown before discovery, and when no zygote was found', () => {
    writeHealthyTree({ childrenFiles: true });
    expect(createLinuxGpuZygoteProbe(BROWSER_PID, procRoot).snapshot().zygote).toBe('unknown');

    const probeForOtherBrowser = createLinuxGpuZygoteProbe(9999, procRoot);
    probeForOtherBrowser.discover();
    expect(probeForOtherBrowser.snapshot().zygote).toBe('unknown');
  });

  it("keeps an 'unlimited' process limit as written", () => {
    writeHealthyTree({ childrenFiles: true });
    writeProcFile('self/limits', 'Limit Soft Hard Units\nMax processes             unlimited            unlimited            processes \n');
    expect(createLinuxGpuZygoteProbe(BROWSER_PID, procRoot).snapshot().maxUserProcesses).toBe('unlimited');
  });

  it("reads schedulingEntities as null when loadavg's fourth field has no running/total split", () => {
    writeHealthyTree({ childrenFiles: true });
    // No slash in the fourth field: a malformed or unusually old kernel's
    // /proc/loadavg. total ends up undefined, and the reader must treat
    // that as no evidence rather than parsing garbage into a number.
    writeProcFile('loadavg', '0.52 0.58 0.59 3 3041\n');
    const probe = createLinuxGpuZygoteProbe(BROWSER_PID, procRoot);
    probe.discover();
    expect(probe.snapshot()).toEqual({ zygote: 'alive', schedulingEntities: null, maxUserProcesses: '123561' });
  });

  it('reads maxUserProcesses as null when self/limits carries no Max processes line', () => {
    writeHealthyTree({ childrenFiles: true });
    // A limits table missing the Max processes row entirely. The other rows
    // must not be mistaken for it.
    writeProcFile(
      'self/limits',
      [
        'Limit                     Soft Limit           Hard Limit           Units     ',
        'Max open files            1024                 524288               files     ',
        '',
      ].join('\n'),
    );
    const probe = createLinuxGpuZygoteProbe(BROWSER_PID, procRoot);
    probe.discover();
    expect(probe.snapshot()).toEqual({ zygote: 'alive', schedulingEntities: 970, maxUserProcesses: null });
  });

  it('never throws, and degrades every field when /proc is unreadable', () => {
    const probe = createLinuxGpuZygoteProbe(BROWSER_PID, path.join(procRoot, 'missing'));
    expect(() => probe.discover()).not.toThrow();
    expect(probe.snapshot()).toEqual({ zygote: 'unknown', schedulingEntities: null, maxUserProcesses: null });
  });
});
