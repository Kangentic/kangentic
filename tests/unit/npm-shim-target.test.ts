/**
 * Unit tests for src/main/agent/shared/npm-shim-target.ts: the parser that
 * reads the launched script out of an npm cmd-shim, so AgentDetector can skip
 * a shim whose target is gone without spending a version probe on it.
 *
 * Pure: nothing here touches the disk. The fake shim directory is derived
 * from os.tmpdir() only so path.dirname / path.join behave the same on the
 * Windows dev machine and the Linux CI runner.
 */
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import {
  isNpmShimCandidate,
  parseNpmShimTarget,
  npmShimTargetPath,
  missingNpmShimTarget,
} from '../../src/main/agent/shared/npm-shim-target';
import { npmCmdShim, legacyNpmCmdShim, minimalCmdShim, npmPs1Shim, npmShShim } from '../fixtures/npm-shim-fixtures';

const CMD_TARGET = 'node_modules\\@google\\gemini-cli\\bundle\\gemini.js';
const PS1_TARGET = 'node_modules/@google/gemini-cli/bundle/gemini.js';

describe('isNpmShimCandidate', () => {
  it.each(['gemini.CMD', 'gemini.cmd', 'tool.bat', 'gemini.ps1'])('accepts %s', (candidatePath) => {
    expect(isNpmShimCandidate(candidatePath)).toBe(true);
  });

  it.each(['claude.EXE', 'gemini', 'gemini.js', 'gemini.cmd.bak'])('rejects %s', (candidatePath) => {
    expect(isNpmShimCandidate(candidatePath)).toBe(false);
  });
});

describe('parseNpmShimTarget', () => {
  it('reads the script out of the 2026 npm .cmd shim, not the IF EXIST node.exe line', () => {
    expect(parseNpmShimTarget(npmCmdShim(CMD_TARGET))).toBe(CMD_TARGET);
  });

  it('reads the script out of the legacy %~dp0 .cmd shim', () => {
    expect(parseNpmShimTarget(legacyNpmCmdShim(CMD_TARGET))).toBe(CMD_TARGET);
  });

  it('reads the script out of the minimal fixture form with no separator after %~dp0', () => {
    expect(parseNpmShimTarget(minimalCmdShim('mock-gemini.js'))).toBe('mock-gemini.js');
  });

  it('reads the script out of the npm .ps1 shim, dropping the node$exe launcher references', () => {
    expect(parseNpmShimTarget(npmPs1Shim(PS1_TARGET))).toBe(PS1_TARGET);
  });

  it('reads the script out of a real extensionless sh shim, dropping the $basedir/node launcher', () => {
    expect(parseNpmShimTarget(npmShShim('../vitest/vitest.mjs'))).toBe('../vitest/vitest.mjs');
  });

  it('reads a $basedir_win reference', () => {
    expect(parseNpmShimTarget('exec "$PROG_EXE"  "$basedir_win/receiver.js" "$@"\n')).toBe('receiver.js');
  });

  it('returns null for empty content', () => {
    expect(parseNpmShimTarget('')).toBeNull();
  });

  it('returns null for a Scoop-style shim that quotes an absolute path', () => {
    const scoopShim = ['@rem shim', '@"C:\\Users\\dev\\scoop\\apps\\tool\\current\\tool.exe" %*', ''].join('\r\n');
    expect(parseNpmShimTarget(scoopShim)).toBeNull();
  });

  it('returns null for a batch file that only references node.exe next to itself', () => {
    const nodeOnly = ['@IF EXIST "%~dp0\\node.exe" (', '  "%~dp0\\node.exe" %*', ')', ''].join('\r\n');
    expect(parseNpmShimTarget(nodeOnly)).toBeNull();
  });
});

describe('npmShimTargetPath', () => {
  const shimDirectory = path.join(os.tmpdir(), 'kangentic-shim-dir');
  const shimPath = path.join(shimDirectory, 'gemini.cmd');
  const expectedTarget = path.join(shimDirectory, 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js');

  it('resolves a backslash target against the shim directory', () => {
    const resolved = npmShimTargetPath(shimPath, { readFile: () => npmCmdShim(CMD_TARGET) });
    expect(resolved).toBe(expectedTarget);
  });

  it('resolves a forward-slash target against the shim directory', () => {
    const resolved = npmShimTargetPath(shimPath, { readFile: () => npmPs1Shim(PS1_TARGET) });
    expect(resolved).toBe(expectedTarget);
  });

  it('returns null when the shim cannot be read', () => {
    const resolved = npmShimTargetPath(shimPath, {
      readFile: () => {
        throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
      },
    });
    expect(resolved).toBeNull();
  });

  it('returns null when the content is not an npm shim', () => {
    expect(npmShimTargetPath(shimPath, { readFile: () => '@echo off\r\necho 1.2.3\r\n' })).toBeNull();
  });
});

describe('missingNpmShimTarget', () => {
  const shimDirectory = path.join(os.tmpdir(), 'kangentic-shim-dir');
  const shimPath = path.join(shimDirectory, 'gemini.cmd');
  const expectedTarget = path.join(shimDirectory, 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js');

  it('returns the absolute target when the shim parses and the target is absent', () => {
    const missing = missingNpmShimTarget(shimPath, {
      readFile: () => npmCmdShim(CMD_TARGET),
      fileExists: () => false,
    });
    expect(missing).toBe(expectedTarget);
  });

  it('returns null when the target exists', () => {
    const checkedPaths: string[] = [];
    const missing = missingNpmShimTarget(shimPath, {
      readFile: () => npmCmdShim(CMD_TARGET),
      fileExists: (candidatePath) => {
        checkedPaths.push(candidatePath);
        return true;
      },
    });
    expect(missing).toBeNull();
    expect(checkedPaths).toEqual([expectedTarget]);
  });

  it('returns null when the shim cannot be read, so the caller falls back to a normal probe', () => {
    const missing = missingNpmShimTarget(shimPath, {
      readFile: () => {
        throw new Error('EACCES');
      },
      fileExists: () => false,
    });
    expect(missing).toBeNull();
  });

  it('returns null for a non-shim, without consulting fileExists', () => {
    const fileExists = () => {
      throw new Error('fileExists must not be called for a non-shim');
    };
    expect(missingNpmShimTarget(shimPath, { readFile: () => 'echo 1.2.3', fileExists })).toBeNull();
  });

  it('treats a throwing fileExists as unknown rather than failing detection', () => {
    const missing = missingNpmShimTarget(shimPath, {
      readFile: () => npmCmdShim(CMD_TARGET),
      fileExists: () => {
        throw new TypeError('existsSync is not a function');
      },
    });
    expect(missing).toBeNull();
  });
});
