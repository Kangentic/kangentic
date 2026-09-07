/**
 * AgentDetector against real npm shim files on a temp filesystem: the case
 * where `which` hands back a stale shim ahead of the real install.
 *
 * Background: on Windows the `which` package searches the working directory
 * before PATH and, without `all`, returns only its first hit; `isexe` checks
 * that the shim exists, never that its target does. A repo root holding a
 * gemini.cmd left behind by an uninstalled local package therefore hid a
 * working `%APPDATA%\npm\gemini.cmd`, and detection reported NOT FOUND with a
 * "likely a different tool" explanation. The detector now enumerates every
 * match, skips a shim whose target is gone without spawning it, and says why
 * each match was passed over.
 *
 * `node:fs` is NOT mocked here on purpose: the dead-shim pre-check reads the
 * shim and stats its target, and that has to run against a real directory.
 * `which` and `execVersion` are the only doubles.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const whichState = vi.hoisted(() => ({ matches: [] as string[] }));

vi.mock('which', () => ({
  default: vi.fn(async () => whichState.matches),
}));

const execVersionMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/main/agent/shared/exec-version', () => ({
  execVersion: execVersionMock,
}));

import { AgentDetector } from '../../src/main/agent/shared/agent-detector';
import { npmCmdShim, npmPs1Shim } from '../fixtures/npm-shim-fixtures';

const CMD_TARGET = 'node_modules\\@google\\gemini-cli\\bundle\\gemini.js';
const PS1_TARGET = 'node_modules/@google/gemini-cli/bundle/gemini.js';

/** What node prints when an npm shim's target script is gone. */
const CANNOT_FIND_MODULE_STDERR = [
  'node:internal/modules/cjs/loader:1228',
  '  throw err;',
  '  ^',
  '',
  "Error: Cannot find module 'C:\\Users\\dev\\project\\node_modules\\@google\\gemini-cli\\bundle\\gemini.js'",
].join('\n');

let tempDir: string;
let projectDir: string;
let npmDir: string;
let deadCmdShimPath: string;
let deadPs1ShimPath: string;
let liveShimPath: string;
let missingTargetPath: string;
let plainCmdPath: string;

let warnSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

function probeRejection(): Error {
  return Object.assign(new Error('Command failed'), { code: 1, stderr: CANNOT_FIND_MODULE_STDERR });
}

function makeDetector(parseVersion: (raw: string) => string | null = (raw) => raw.trim() || null): AgentDetector {
  return new AgentDetector({ binaryName: 'gemini', parseVersion });
}

function warnLines(): string[] {
  return warnSpy.mock.calls.map((call) => call.map(String).join(' '));
}

function notFoundLine(): string {
  const line = warnLines().find((entry) => entry.startsWith('[agent-detect] gemini: NOT FOUND'));
  if (line === undefined) throw new Error(`no NOT FOUND line among: ${JSON.stringify(warnLines())}`);
  return line;
}

function probedPaths(): string[] {
  return execVersionMock.mock.calls.map((call) => String(call[0]));
}

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-dead-shim-'));
  projectDir = path.join(tempDir, 'project');
  npmDir = path.join(tempDir, 'npm');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(npmDir, { recursive: true });

  // The project root: both shims present, the package they launch removed.
  deadCmdShimPath = path.join(projectDir, 'gemini.cmd');
  deadPs1ShimPath = path.join(projectDir, 'gemini.ps1');
  fs.writeFileSync(deadCmdShimPath, npmCmdShim(CMD_TARGET));
  fs.writeFileSync(deadPs1ShimPath, npmPs1Shim(PS1_TARGET));
  missingTargetPath = path.join(projectDir, 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js');

  // The global npm prefix: the same shim pair with its target in place.
  liveShimPath = path.join(npmDir, 'gemini.cmd');
  fs.writeFileSync(liveShimPath, npmCmdShim(CMD_TARGET));
  fs.writeFileSync(path.join(npmDir, 'gemini.ps1'), npmPs1Shim(PS1_TARGET));
  const liveTargetDir = path.join(npmDir, 'node_modules', '@google', 'gemini-cli', 'bundle');
  fs.mkdirSync(liveTargetDir, { recursive: true });
  fs.writeFileSync(path.join(liveTargetDir, 'gemini.js'), '');

  // A hand-written batch file that is not an npm shim at all.
  plainCmdPath = path.join(projectDir, 'tool.cmd');
  fs.writeFileSync(plainCmdPath, '@echo off\r\necho 1.2.3\r\n');
});

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  whichState.matches = [];
  execVersionMock.mockReset();
  execVersionMock.mockImplementation(async (candidatePath: string) => {
    if (candidatePath === liveShimPath) return { stdout: '0.37.0\n', stderr: '' };
    throw probeRejection();
  });
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  logSpy.mockRestore();
});

describe('AgentDetector - a dead npm shim ahead of the real install', () => {
  it('skips the dead .cmd shim without probing it and finds the live one behind it', async () => {
    whichState.matches = [deadCmdShimPath, liveShimPath];

    const result = await makeDetector().detect();

    expect(result).toEqual({ found: true, path: liveShimPath, version: '0.37.0' });
    expect(probedPaths()).toEqual([liveShimPath]);
  });

  it('names the missing target in the skip line', async () => {
    whichState.matches = [deadCmdShimPath, liveShimPath];

    await makeDetector().detect();

    const skipLine = warnLines().find((entry) => entry.includes('npm shim whose target'));
    expect(skipLine).toBeDefined();
    expect(skipLine).toContain(deadCmdShimPath);
    expect(skipLine).toContain(`whose target ${missingTargetPath} does not exist`);
    expect(skipLine).toContain('skipping it without a version probe');
  });

  it('skips a dead .ps1 shim the same way', async () => {
    whichState.matches = [deadPs1ShimPath, liveShimPath];

    const result = await makeDetector().detect();

    expect(result.path).toBe(liveShimPath);
    expect(probedPaths()).toEqual([liveShimPath]);
  });

  it('reports NOT FOUND with an accurate summary when the dead shim is the only match', async () => {
    whichState.matches = [deadCmdShimPath];

    const result = await makeDetector().detect();

    expect(result).toEqual({ found: false, path: null, version: null });
    expect(execVersionMock).not.toHaveBeenCalled();
    expect(notFoundLine()).toContain('PATH matches tried: gemini: 1 found, 0 probed, 1 skipped as dead npm shims');
  });
});

describe('AgentDetector - matches that are not dead shims', () => {
  it('probes a hand-written .cmd that is not an npm shim, and says the probe failed rather than "a different tool"', async () => {
    whichState.matches = [plainCmdPath, liveShimPath];

    const result = await makeDetector().detect();

    expect(result.path).toBe(liveShimPath);
    expect(probedPaths()).toEqual([plainCmdPath, liveShimPath]);
    const failureLine = warnLines().find((entry) => entry.includes(plainCmdPath));
    expect(failureLine).toContain('its --version probe failed (exit code 1: Error: Cannot find module');
    expect(failureLine).not.toContain('did not match this agent');
  });

  it('keeps the "did not match this agent" wording for a probe that answers in another tool\'s format', async () => {
    whichState.matches = [plainCmdPath, liveShimPath];
    execVersionMock.mockImplementation(async (candidatePath: string) => {
      if (candidatePath === liveShimPath) return { stdout: '0.37.0\n', stderr: '' };
      return { stdout: 'UNRELATED_TOOL 4.0.0\n', stderr: '' };
    });

    const result = await makeDetector((raw) => (/^\d/.test(raw) ? raw.trim() : null)).detect();

    expect(result.path).toBe(liveShimPath);
    const failureLine = warnLines().find((entry) => entry.includes(plainCmdPath));
    expect(failureLine).toContain('did not match this agent (likely a different tool publishing the same name)');
  });

  it('passes over a match that no longer exists on disk without probing it', async () => {
    const ghostPath = path.join(projectDir, 'ghost.cmd');
    whichState.matches = [ghostPath, liveShimPath];

    const result = await makeDetector().detect();

    expect(result.path).toBe(liveShimPath);
    expect(probedPaths()).toEqual([liveShimPath]);
    const ghostLine = warnLines().find((entry) => entry.includes(ghostPath));
    expect(ghostLine).toContain('but the file does not exist on disk; trying the next match');
  });

  it('probes an exact duplicate match only once', async () => {
    whichState.matches = [plainCmdPath, plainCmdPath, liveShimPath];

    await makeDetector().detect();

    expect(probedPaths()).toEqual([plainCmdPath, liveShimPath]);
  });

  it.runIf(process.platform === 'win32')('probes a case-variant duplicate only once on Windows', async () => {
    whichState.matches = [plainCmdPath, plainCmdPath.toUpperCase(), liveShimPath];

    await makeDetector().detect();

    expect(probedPaths()).toEqual([plainCmdPath, liveShimPath]);
  });

  it('stops probing at the per-name cap and says how many matches were left untried', async () => {
    // Its own directory, torn down here: projectDir is shared by every test in
    // this file, and six extra files left in it would be waiting for the first
    // test that reads the directory rather than a fixed match list.
    const capDir = fs.mkdtempSync(path.join(tempDir, 'cap-'));
    const failingPaths = Array.from({ length: 6 }, (_unused, index) => {
      const failingPath = path.join(capDir, `fail-${index}.cmd`);
      fs.writeFileSync(failingPath, '@echo off\r\nexit /b 1\r\n');
      return failingPath;
    });
    whichState.matches = [...failingPaths, liveShimPath];

    const result = await makeDetector().detect();

    expect(result.found).toBe(false);
    expect(probedPaths()).toEqual(failingPaths.slice(0, 4));
    expect(notFoundLine()).toContain('gemini: 7 found, 4 probed, 0 skipped as dead npm shims, 3 beyond the cap of 4 not tried');

    fs.rmSync(capDir, { recursive: true, force: true });
  });
});

describe('AgentDetector - the probe cap counts probes, not matches', () => {
  it('does not let a run of dead shims push the live install outside the probe window', async () => {
    // Own subdirectory, torn down here: projectDir is shared by every test in
    // this file, and five extra dead shims left in it would be waiting for
    // whichever test reads that directory next.
    const manyDeadShimsDir = fs.mkdtempSync(path.join(tempDir, 'many-dead-'));
    const deadShimPaths = Array.from({ length: 5 }, (_unused, index) => {
      if (index % 2 === 0) {
        const deadCmdPath = path.join(manyDeadShimsDir, `dead-${index}.cmd`);
        fs.writeFileSync(deadCmdPath, npmCmdShim(CMD_TARGET));
        return deadCmdPath;
      }
      const deadPs1Path = path.join(manyDeadShimsDir, `dead-${index}.ps1`);
      fs.writeFileSync(deadPs1Path, npmPs1Shim(PS1_TARGET));
      return deadPs1Path;
    });
    whichState.matches = [...deadShimPaths, liveShimPath];

    const result = await makeDetector().detect();

    expect(result).toEqual({ found: true, path: liveShimPath, version: '0.37.0' });
    expect(probedPaths()).toEqual([liveShimPath]);

    fs.rmSync(manyDeadShimsDir, { recursive: true, force: true });
  });

  it('spends exactly the probe cap when dead shims are interleaved with probe-failing matches', async () => {
    // Own subdirectory, torn down here for the same reason as above.
    const budgetDir = fs.mkdtempSync(path.join(tempDir, 'budget-'));
    const deadShimPaths = Array.from({ length: 3 }, (_unused, index) => {
      const deadShimPath = path.join(budgetDir, `dead-${index}.cmd`);
      fs.writeFileSync(deadShimPath, npmCmdShim(CMD_TARGET));
      return deadShimPath;
    });
    const failingPaths = Array.from({ length: 6 }, (_unused, index) => {
      const failingPath = path.join(budgetDir, `fail-${index}.cmd`);
      fs.writeFileSync(failingPath, '@echo off\r\nexit /b 1\r\n');
      return failingPath;
    });
    whichState.matches = [
      deadShimPaths[0], failingPaths[0],
      deadShimPaths[1], failingPaths[1],
      deadShimPaths[2], failingPaths[2],
      failingPaths[3], failingPaths[4], failingPaths[5],
      liveShimPath,
    ];

    const result = await makeDetector().detect();

    expect(result.found).toBe(false);
    expect(probedPaths()).toEqual(failingPaths.slice(0, 4));
    expect(execVersionMock).toHaveBeenCalledTimes(4);
    expect(notFoundLine()).toContain(
      'gemini: 10 found, 4 probed, 3 skipped as dead npm shims, 3 beyond the cap of 4 not tried',
    );

    fs.rmSync(budgetDir, { recursive: true, force: true });
  });
});

describe('describeProbeError - the non-numeric-code branches', () => {
  it('describes a killed probe as timed out with its signal', async () => {
    whichState.matches = [plainCmdPath, liveShimPath];
    execVersionMock.mockImplementation(async (candidatePath: string) => {
      if (candidatePath === liveShimPath) return { stdout: '0.37.0\n', stderr: '' };
      throw Object.assign(new Error('Command timed out'), { killed: true, signal: 'SIGTERM' });
    });

    await makeDetector().detect();

    const failureLine = warnLines().find((entry) => entry.includes(plainCmdPath));
    expect(failureLine).toContain('its --version probe failed (timed out (SIGTERM))');
  });

  it('describes a spawn failure by its string error code', async () => {
    whichState.matches = [plainCmdPath, liveShimPath];
    execVersionMock.mockImplementation(async (candidatePath: string) => {
      if (candidatePath === liveShimPath) return { stdout: '0.37.0\n', stderr: '' };
      throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    });

    await makeDetector().detect();

    const failureLine = warnLines().find((entry) => entry.includes(plainCmdPath));
    expect(failureLine).toContain('its --version probe failed (ENOENT)');
  });

  it('falls through to the error message when neither a code, a signal, nor killed is set', async () => {
    whichState.matches = [plainCmdPath, liveShimPath];
    execVersionMock.mockImplementation(async (candidatePath: string) => {
      if (candidatePath === liveShimPath) return { stdout: '0.37.0\n', stderr: '' };
      throw new Error('some message');
    });

    await makeDetector().detect();

    const failureLine = warnLines().find((entry) => entry.includes(plainCmdPath));
    expect(failureLine).toContain('its --version probe failed (some message)');
  });
});

describe('describeProbeError - stderr line selection and truncation', () => {
  it('prefers the stderr line that mentions "error" over an earlier non-error line', async () => {
    const stderrWithPrecedingNoise = ['Loading configuration...', 'Error: cannot resolve module'].join('\n');
    whichState.matches = [plainCmdPath, liveShimPath];
    execVersionMock.mockImplementation(async (candidatePath: string) => {
      if (candidatePath === liveShimPath) return { stdout: '0.37.0\n', stderr: '' };
      throw Object.assign(new Error('Command failed'), { code: 1, stderr: stderrWithPrecedingNoise });
    });

    await makeDetector().detect();

    const failureLine = warnLines().find((entry) => entry.includes(plainCmdPath));
    expect(failureLine).toContain('exit code 1: Error: cannot resolve module');
    expect(failureLine).not.toContain('Loading configuration');
  });

  it('truncates a stderr line longer than the configured max length and appends the ellipsis suffix', async () => {
    const longErrorLine = `Error: ${'a'.repeat(250)}`;
    whichState.matches = [plainCmdPath, liveShimPath];
    execVersionMock.mockImplementation(async (candidatePath: string) => {
      if (candidatePath === liveShimPath) return { stdout: '0.37.0\n', stderr: '' };
      throw Object.assign(new Error('Command failed'), { code: 1, stderr: longErrorLine });
    });

    await makeDetector().detect();

    const failureLine = warnLines().find((entry) => entry.includes(plainCmdPath));
    expect(failureLine).toBeDefined();
    const detailMatch = (failureLine ?? '').match(/exit code 1: ([\s\S]*?)\); trying the next match\.$/);
    expect(detailMatch).not.toBeNull();
    const emittedDetail = detailMatch?.[1] ?? '';
    const expectedDetail = `${longErrorLine.slice(0, 200)}...`;
    expect(emittedDetail).toBe(expectedDetail);
    expect(emittedDetail.length).toBe(203);
  });
});

describe('AgentDetector - the npm shim size guard', () => {
  it('probes an oversized same-extension file instead of treating it as a dead shim', async () => {
    // Own subdirectory, torn down here: a 64KB+ file left behind in a shared
    // directory would linger for whichever test reads that directory next.
    const oversizedShimDir = fs.mkdtempSync(path.join(tempDir, 'oversized-'));
    const oversizedShimPath = path.join(oversizedShimDir, 'gemini.cmd');
    const oversizedShimContent = `${npmCmdShim(CMD_TARGET)}REM ${'x'.repeat(70000)}\r\n`;
    fs.writeFileSync(oversizedShimPath, oversizedShimContent);
    expect(fs.statSync(oversizedShimPath).size).toBeGreaterThan(64 * 1024);

    whichState.matches = [oversizedShimPath, liveShimPath];

    const result = await makeDetector().detect();

    expect(result.path).toBe(liveShimPath);
    expect(probedPaths()).toEqual([oversizedShimPath, liveShimPath]);
    const failureLine = warnLines().find((entry) => entry.includes(oversizedShimPath));
    expect(failureLine).toContain('its --version probe failed');
    expect(failureLine).not.toContain('npm shim whose target');

    fs.rmSync(oversizedShimDir, { recursive: true, force: true });
  });
});
