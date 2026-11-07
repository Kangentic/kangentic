/**
 * scripts/package-smoke.mjs, the packaged-app smoke the package-smoke workflow
 * runs on Windows, macOS and Linux. The launch itself needs a packaged build,
 * so this pins the pure parts: which executable it runs, what it types and
 * looks for, how it quits, and which log lines fail it, including that every
 * log line it watches for still exists in src/main.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { __testing } from '../../scripts/package-smoke.mjs';
import { selectEngine } from '../../src/main/transcription/engines/engine-selection';
import type { DictationConfig, DictationHardwareProfile } from '../../src/shared/types';

const {
  SMOKE_MARKER,
  SMOKE_COMMAND,
  LEFTOVER_SCRIPT,
  LEFTOVER_COMMAND,
  DICTATION_SMOKE_OPTIONS,
  FAILURE_MARKERS,
  resolveAppExecutable,
  quitRouteFor,
  launchArguments,
  appEnvironment,
  stripTerminalControls,
  findFailureMarkers,
  scanRunLines,
} = __testing;

const PACKAGE = { name: 'kangentic', productName: 'Kangentic' };
const REPO_ROOT = path.resolve(__dirname, '../..');

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(entryPath));
    else if (/\.(ts|js)$/.test(entry.name)) files.push(entryPath);
  }
  return files;
}

describe('package smoke: the dictation worker step', () => {
  // The step exists to load the addon in the finished app with nothing to download. A selection
  // that picked up a model here would spend a CI leg on a 600 MB fetch, or fail it on a slow one.
  it.each([
    ['a capable machine', { cpuModel: 'x', cpuCores: 16, totalRamGb: 32, hasAvx2: true, gpu: 'none', platform: 'win32', arch: 'x64' }],
    ['a low-end machine', { cpuModel: 'x', cpuCores: 2, totalRamGb: 4, hasAvx2: false, gpu: 'none', platform: 'linux', arch: 'arm64' }],
  ] as Array<[string, DictationHardwareProfile]>)('selects no model on %s', (_label, profile) => {
    const selection = selectEngine(profile, { enabled: true, ...DICTATION_SMOKE_OPTIONS } as DictationConfig);
    expect(selection.models).toEqual([]);
    expect(selection.isRemote).toBe(true);
  });
});

describe('package smoke: the leftover the reap step stops', () => {
  it('starts a detached process that outlives its launcher, works in the project, and names its pid', async () => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'package-smoke-leftover-')));
    fs.writeFileSync(path.join(directory, 'leftover.js'), LEFTOVER_SCRIPT);
    let pid = 0;
    const running = (candidate: number) => {
      try {
        process.kill(candidate, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      expect(LEFTOVER_COMMAND).toBe('node leftover.js');
      // The launcher returns at once: the leftover holds none of its pipes.
      execFileSync(process.execPath, ['leftover.js'], { cwd: directory, stdio: 'ignore', timeout: 10_000 });
      pid = Number(fs.readFileSync(path.join(directory, 'leftover.pid'), 'utf8'));
      expect(pid).toBeGreaterThan(0);
      expect(running(pid)).toBe(true);
      // Linux only (CI's unit tier): /proc exposes a live process's working directory.
      if (process.platform === 'linux') {
        expect(fs.realpathSync(fs.readlinkSync(`/proc/${pid}/cwd`))).toBe(directory);
      }
    } finally {
      if (pid > 0 && running(pid)) process.kill(pid, 'SIGKILL');
      // Windows holds the directory for up to ~100 ms after the process reads
      // as gone (measured), and `rmSync`'s own retries do not cover that EPERM.
      for (let attempt = 0; ; attempt += 1) {
        try {
          fs.rmSync(directory, { recursive: true, force: true });
          break;
        } catch (error) {
          if (attempt >= 30) throw error;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    }
  });
});

describe('package smoke: the executable it runs', () => {
  let outDir: string;

  beforeEach(() => {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'package-smoke-out-'));
  });
  afterEach(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  function place(relativePath: string): string {
    const filePath = path.join(outDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '');
    return filePath;
  }

  it('finds the Windows exe by productName', () => {
    const exe = place(path.join('win-unpacked', 'Kangentic.exe'));
    place(path.join('linux-unpacked', 'kangentic'));
    expect(resolveAppExecutable(outDir, 'win32', PACKAGE)).toBe(exe);
  });

  it('finds the Linux executable by name, an arch-suffixed directory included', () => {
    const exe = place(path.join('linux-arm64-unpacked', 'kangentic'));
    expect(resolveAppExecutable(outDir, 'linux', PACKAGE)).toBe(exe);
  });

  it('finds the macOS binary inside the app bundle', () => {
    const exe = place(path.join('mac-arm64', 'Kangentic.app', 'Contents', 'MacOS', 'Kangentic'));
    expect(resolveAppExecutable(outDir, 'darwin', PACKAGE)).toBe(exe);
  });

  it('fails loudly with no packaged app, naming what it found', () => {
    place(path.join('win-unpacked', 'Kangentic.exe'));
    expect(() => resolveAppExecutable(outDir, 'darwin', PACKAGE)).toThrow(/No packaged darwin app .*win-unpacked/);
    expect(() => resolveAppExecutable(path.join(outDir, 'missing'), 'win32', PACKAGE)).toThrow(/npm run package/);
  });

  it('refuses to pick between two packaged apps', () => {
    place(path.join('mac', 'Kangentic.app', 'Contents', 'MacOS', 'Kangentic'));
    place(path.join('mac-arm64', 'Kangentic.app', 'Contents', 'MacOS', 'Kangentic'));
    expect(() => resolveAppExecutable(outDir, 'darwin', PACKAGE)).toThrow(/More than one/);
  });
});

describe('package smoke: the terminal check', () => {
  it('never types the marker it looks for, and the shell joins it back', () => {
    expect(SMOKE_COMMAND).not.toContain(SMOKE_MARKER);
    expect(SMOKE_COMMAND.replace(/"/g, '')).toBe(`echo ${SMOKE_MARKER}`);
  });

  it('reads the marker through colour codes, but not from the typed line', () => {
    const typedLine = `PS> & echo KANGENTIC_SMOKE\x1b[36m"_"\x1b[0mOK\r\n`;
    const output = `\x1b]0;pwsh\x07\x1b[?25l${SMOKE_MARKER}\x1b[K\r\n`;
    expect(stripTerminalControls(typedLine)).not.toContain(SMOKE_MARKER);
    expect(stripTerminalControls(typedLine + output)).toContain(SMOKE_MARKER);
  });
});

describe('package smoke: launching and quitting', () => {
  it('quits by closing the window except on macOS, which keeps a windowless app running', () => {
    expect(quitRouteFor('win32')).toBe('close-window');
    expect(quitRouteFor('linux')).toBe('close-window');
    expect(quitRouteFor('darwin')).toBe('sigterm');
  });

  it('isolates the data and user data, and drops the sandbox on Linux only', () => {
    const linux = launchArguments('linux', '/scratch/data', '/scratch/user-data', 9222);
    expect(linux).toEqual(['--data-dir=/scratch/data', '--user-data-dir=/scratch/user-data', '--remote-debugging-port=9222', '--no-sandbox']);
    expect(launchArguments('win32', 'D', 'U', 1)).not.toContain('--no-sandbox');
    expect(launchArguments('darwin', 'D', 'U', 1)).not.toContain('--no-sandbox');
  });

  it('strips what would redirect or alter the app, and turns telemetry off', () => {
    const environment = appEnvironment({ PATH: '/bin', KANGENTIC_DATA_DIR: '/real', NODE_ENV: 'test', ELECTRON_RUN_AS_NODE: '1' });
    expect(environment).toEqual({ PATH: '/bin', KANGENTIC_TELEMETRY: '0' });
  });
});

describe('package smoke: the log check', () => {
  it('fails on each crash and fallback line the app writes', () => {
    const lines = [
      '{"level":"error","args":["[utility-process] retrieval worker exited with code 1 (crash 1 of 3)"]}',
      '{"level":"error","args":["[pty-host] exited unexpectedly (code 3221225477); every terminal it held has ended"]}',
      '{"level":"warn","args":["[pty-host] fork failed:","Error"]}',
      '{"level":"error","args":["[pty-host] gave up restarting after repeated crashes; running terminals in the main process for the rest of this run"]}',
      '{"level":"warn","args":["[retrieval] retrieval worker fork failed:","Error"]}',
      '{"level":"warn","args":["[retrieval-worker] sqlite-vec unavailable, semantic search disabled:","Error"]}',
      '{"level":"warn","args":["[transcription] dictation worker fork failed:","Error"]}',
      '{"level":"error","args":["[SHUTDOWN] hard-failsafe:fired"]}',
      '[SHUTDOWN] pty-drain:timeout 1500ms lingering=4242 blind=0',
      '{"level":"warn","args":["[TASK-REAP] reap failed (non-fatal): Cannot find module koffi"]}',
      '{"level":"warn","args":["[TASK-REAP] host reap failed (non-fatal):","PtyHostTimeoutError: The pty host did not answer reapTaggedProcesses in time"]}',
      '{"level":"warn","args":["[PTY-HOST] Toolhelp process listing failed; the watcher falls back to the PowerShell probe:","Error"]}',
    ];
    const found = findFailureMarkers(lines);
    expect(found).toHaveLength(FAILURE_MARKERS.length);
    expect(new Set(found.map((entry: { reason: string }) => entry.reason)).size).toBe(FAILURE_MARKERS.length);
  });

  it('fails on a utility worker that hung or never forked, not only on one that exited', () => {
    // The restart policy logs a hang in the in-app signal's words, with no "exited with code".
    const found = findFailureMarkers([
      '{"level":"warn","args":["[utility-process] kangentic-retrieval did not answer projects.summaries in time (crash 1 of 3)","(no stderr captured)"]}',
      '{"level":"warn","args":["[utility-process] kangentic-retrieval did not start in time (crash 2 of 3)","(no stderr captured)"]}',
      '{"level":"warn","args":["[utility-process] kangentic-embeddings failed to start (crash 1 of 3)","(no stderr captured)"]}',
    ]);
    expect(found).toHaveLength(3);
    expect(new Set(found.map((entry: { reason: string }) => entry.reason))).toEqual(new Set([FAILURE_MARKERS[0].reason]));
  });

  it('passes the warnings an unpublished build writes on every run', () => {
    expect(findFailureMarkers([
      '{"level":"warn","args":["[UPDATER] Skipping init: app-update.yml not found in the resources directory."]}',
      '{"level":"warn","args":["[pty-host] answered a heartbeat after 1200 ms"]}',
      '{"level":"log","args":["[pty-host] forked"]}',
      '[SHUTDOWN] pty-drain:start n=2 blind=0',
      '[SHUTDOWN] pty-drain:done 225ms',
    ])).toEqual([]);
  });

  it('fails on a drain timeout that only the app output carries (the macOS SIGTERM route)', () => {
    // A packaged build exits on a signal before it writes its queued log lines.
    const { failures } = scanRunLines([], ['[SHUTDOWN] pty-drain:timeout 1500ms lingering=4242 blind=0']);
    expect(failures).toHaveLength(1);
  });

  it('fails on a marker that only the log file carries', () => {
    const record = '{"ts":"2026-01-01T00:00:00.000Z","level":"log","source":"main","args":["[SHUTDOWN] hard-failsafe:fired"]}';
    const { failures } = scanRunLines([record], []);
    expect(failures).toHaveLength(1);
  });

  it('lists each output drain line once, and a JSON log record of the same line adds no copy', () => {
    const drainLine = '[SHUTDOWN] pty-drain:done 225ms';
    const record = '{"ts":"2026-01-01T00:00:00.000Z","level":"log","source":"main","args":["[SHUTDOWN] pty-drain:done 225ms"]}';
    const { drainLines } = scanRunLines([record], ['[SHUTDOWN] pty-drain:start n=2 blind=0', drainLine]);
    expect(drainLines).toEqual(['[SHUTDOWN] pty-drain:start n=2 blind=0', drainLine]);
  });

  it('still matches a marker behind the output echo time prefix', () => {
    const { failures } = scanRunLines([], ['[10:38:16] [SHUTDOWN] pty-drain:timeout 1500ms lingering=4242 blind=0']);
    expect(failures).toHaveLength(1);
  });

  it('watches for log lines that still exist in src/main', () => {
    const source = sourceFiles(path.join(REPO_ROOT, 'src', 'main')).map((file) => fs.readFileSync(file, 'utf8')).join('\n');
    for (const marker of FAILURE_MARKERS) {
      expect(source, `"${marker.sourceText}" is no longer in src/main; update FAILURE_MARKERS in scripts/package-smoke.mjs`).toContain(marker.sourceText);
    }
  });
});
