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
  directLaunchOfBatchShim,
  batchShimGiveUpOf,
} from '../../src/main/agent/shared/npm-shim-target';
import { npmCmdShim, legacyNpmCmdShim, minimalCmdShim, npmPs1Shim, npmShShim, pnpmCmdShim } from '../fixtures/npm-shim-fixtures';

const CMD_TARGET = 'node_modules\\@google\\gemini-cli\\bundle\\gemini.js';
const PS1_TARGET = 'node_modules/@google/gemini-cli/bundle/gemini.js';

describe('directLaunchOfBatchShim', () => {
  const directory = path.join(os.tmpdir(), 'shims');
  const shimPath = path.join(directory, 'gemini.cmd');
  const target = path.join(directory, 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js');
  const siblingNode = path.join(directory, 'node.exe');

  it('runs a Node script with the bare node the shim falls back to', () => {
    const launch = directLaunchOfBatchShim(shimPath, {
      readFile: () => npmCmdShim(CMD_TARGET),
      fileExists: (candidate) => candidate === target,
    });
    expect(launch).toEqual({ program: 'node', script: target });
  });

  it('prefers the node.exe beside the shim, as the shim does', () => {
    const launch = directLaunchOfBatchShim(shimPath, {
      readFile: () => npmCmdShim(CMD_TARGET),
      fileExists: () => true,
    });
    expect(launch).toEqual({ program: siblingNode, script: target });
  });

  it('runs a binary target as it is', () => {
    const binaryTarget = 'node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
    const launch = directLaunchOfBatchShim(shimPath, {
      readFile: () => npmCmdShim(binaryTarget),
      fileExists: () => true,
    });
    expect(launch?.script).toBeNull();
    expect(launch?.program.endsWith('claude.exe')).toBe(true);
  });

  it('refuses a target that is gone, since starting it would fail with no error', () => {
    const dependencies = { readFile: () => npmCmdShim(CMD_TARGET), fileExists: () => false };
    expect(directLaunchOfBatchShim(shimPath, dependencies)).toBeNull();
    expect(batchShimGiveUpOf(shimPath, dependencies)).toBe('target_missing');
  });

  it('refuses a file that is no shim, and one it cannot read, and says which', () => {
    const notAShim = { readFile: () => '@echo hello', fileExists: () => true };
    expect(directLaunchOfBatchShim(shimPath, notAShim)).toBeNull();
    expect(batchShimGiveUpOf(shimPath, notAShim)).toBe('unparsed');
    const unreadable = { readFile: (): string => { throw new Error('EACCES'); }, fileExists: () => true };
    expect(directLaunchOfBatchShim(shimPath, unreadable)).toBeNull();
    expect(batchShimGiveUpOf(shimPath, unreadable)).toBe('unreadable');
  });

  it('refuses a target that is neither a program nor a Node script', () => {
    const dependencies = { readFile: () => npmCmdShim('bin\\tool.sh'), fileExists: () => true };
    expect(directLaunchOfBatchShim(shimPath, dependencies)).toBeNull();
    expect(batchShimGiveUpOf(shimPath, dependencies)).toBe('target_not_script');
  });

  it('gives up as target_missing when the existence check itself throws', () => {
    const dependencies = {
      readFile: () => npmCmdShim(CMD_TARGET),
      fileExists: (): boolean => { throw new Error('EPERM'); },
    };
    expect(directLaunchOfBatchShim(shimPath, dependencies)).toBeNull();
    expect(batchShimGiveUpOf(shimPath, dependencies)).toBe('target_missing');
  });

  it('launches an npm-style shim with an .exe target directly though its text mentions NODE_PATH', () => {
    const exeTarget = 'node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
    const shimText = `${npmCmdShim(exeTarget)}\r\nREM SET "NODE_PATH=C:\\mock\\node_modules"\r\n`;
    expect(shimText).toContain('NODE_PATH');
    const dependencies = { readFile: () => shimText, fileExists: () => true };

    const launch = directLaunchOfBatchShim(shimPath, dependencies);
    expect(launch?.script).toBeNull();
    expect(launch?.program.endsWith('claude.exe')).toBe(true);
    expect(batchShimGiveUpOf(shimPath, dependencies)).toBeNull();
  });

  it('gives no reason for a shim it resolves', () => {
    expect(batchShimGiveUpOf(shimPath, { readFile: () => npmCmdShim(CMD_TARGET), fileExists: () => true })).toBeNull();
  });

  describe('a pnpm shim', () => {
    const NODE_PATH = 'C:\\Users\\dev\\AppData\\Local\\pnpm\\global\\5\\node_modules\\.pnpm\\node_modules';
    const exeTarget = 'global\\5\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
    const scriptTarget = 'global\\5\\node_modules\\@google\\gemini-cli\\bundle\\gemini.js';

    it('starts a native .exe target directly, though the shim sets NODE_PATH', () => {
      const pnpmShim = pnpmCmdShim(exeTarget, { nodeScript: false, nodePath: NODE_PATH });
      expect(pnpmShim).toContain('NODE_PATH');
      const launch = directLaunchOfBatchShim(shimPath, { readFile: () => pnpmShim, fileExists: () => true });
      expect(launch).toEqual({ program: path.join(directory, ...exeTarget.split('\\')), script: null });
    });

    it('starts a Node script with no NODE_PATH block as the shim does', () => {
      const pnpmShim = pnpmCmdShim(scriptTarget, { nodeScript: true });
      const scriptPath = path.join(directory, ...scriptTarget.split('\\'));
      const launch = directLaunchOfBatchShim(shimPath, { readFile: () => pnpmShim, fileExists: (candidate) => candidate === scriptPath });
      expect(launch).toEqual({ program: 'node', script: scriptPath });
    });

    it('refuses a Node script whose shim sets NODE_PATH, because the script may read it', () => {
      const pnpmShim = pnpmCmdShim(scriptTarget, { nodeScript: true, nodePath: NODE_PATH });
      expect(parseNpmShimTarget(pnpmShim)).not.toBeNull();
      expect(directLaunchOfBatchShim(shimPath, { readFile: () => pnpmShim, fileExists: () => true })).toBeNull();
      expect(batchShimGiveUpOf(shimPath, { readFile: () => pnpmShim, fileExists: () => true })).toBe('node_path');
    });
  });
});

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
