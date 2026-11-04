/**
 * warpVersionLaunch against the real file system. warp-adapter.test.ts mocks
 * existsSync to always be true, so the "program is missing" outcome can only
 * be pinned here.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { warpVersionLaunch } from '../../src/main/agent/adapters/warp/version-detector';

describe('warpVersionLaunch against the real file system', () => {
  let workFolder: string;

  beforeEach(() => {
    workFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-warp-detector-'));
  });

  afterEach(() => {
    fs.rmSync(workFolder, { recursive: true, force: true });
  });

  function shimNaming(exePath: string): string {
    const shimPath = path.join(workFolder, 'oz.cmd');
    fs.writeFileSync(shimPath, `@echo off\r\nset "WARP_CLI_MODE=1"\r\n"${exePath}" %*\r\n`);
    return shimPath;
  }

  it('probes the shim as found when the program it names is not on disk', () => {
    const missingExe = path.join(workFolder, 'missing', 'warp.exe');
    expect(warpVersionLaunch(shimNaming(missingExe), 'win32')).toBeNull();
  });

  // The program path is read as a Windows path, so it only resolves to a real
  // file on Windows.
  it.runIf(process.platform === 'win32')('starts the program the shim names when it exists', () => {
    const exePath = path.join(workFolder, 'warp.exe');
    fs.writeFileSync(exePath, '');
    expect(warpVersionLaunch(shimNaming(exePath), 'win32')).toEqual({
      file: path.win32.normalize(exePath),
      env: { WARP_CLI_MODE: '1' },
    });
  });
});
