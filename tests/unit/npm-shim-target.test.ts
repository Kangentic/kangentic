/**
 * Unit tests for src/main/agent/shared/npm-shim-target.ts: the parser that
 * reads the launched script out of an npm cmd-shim, so AgentDetector can skip
 * a shim whose target is gone without spending a version probe on it.
 *
 * Pure: nothing here touches the disk. The fake shim directory is derived
 * from os.tmpdir() only so path.dirname / path.join behave the same on the
 * Windows dev machine and the Linux CI runner.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import {
  isNpmShimCandidate,
  parseNpmShimTarget,
  npmShimTargetPath,
  missingNpmShimTarget,
  directLaunchOfBatchShim,
  batchShimGiveUpOf,
  MAX_SHIM_HOPS,
} from '../../src/main/agent/shared/npm-shim-target';
import {
  npmCmdShim,
  npmDirectCmdShim,
  legacyNpmCmdShim,
  minimalCmdShim,
  npmPs1Shim,
  npmShShim,
  pnpmCmdShim,
  pnpmPs1CmdShim,
  powerShellTrampolineCmdShim,
} from '../fixtures/npm-shim-fixtures';

const CMD_TARGET = 'node_modules\\@google\\gemini-cli\\bundle\\gemini.js';
const PS1_TARGET = 'node_modules/@google/gemini-cli/bundle/gemini.js';

describe('directLaunchOfBatchShim', () => {
  const directory = path.join(os.tmpdir(), 'shims');
  const shimPath = path.join(directory, 'gemini.cmd');
  const target = path.join(directory, 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js');
  const siblingNode = path.join(directory, 'node.exe');

  /** A fake disk: the files named are the only ones on it, with any path in `alsoOnDisk`. */
  function fakeDisk(
    files: Record<string, string>,
    alsoOnDisk: string[] = [],
  ): { readFile: (candidate: string) => string; fileExists: (candidate: string) => boolean } {
    return {
      readFile: (candidate) => {
        const content = files[candidate];
        if (content === undefined) throw new Error('ENOENT');
        return content;
      },
      fileExists: (candidate) => candidate in files || alsoOnDisk.includes(candidate),
    };
  }

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

  // Sentry DESKTOP-3Y gave up with one word for every such target, so the
  // report could not say which layout its user had. Each shape has its own.
  it.each([
    ['a PowerShell script the shim hands to node', 'bin\\tool.ps1', 'target_ps1'],
    ['the extensionless sh script cmd-shim hands to sh', 'node_modules\\.bin\\claude', 'target_extensionless'],
    ['a shell script', 'bin\\tool.sh', 'target_other'],
    ['a Python script', 'bin\\tool.py', 'target_other'],
  ])('refuses %s target and names its shape', (_label, relativeTarget, expected) => {
    const dependencies = { readFile: () => npmCmdShim(relativeTarget), fileExists: () => true };
    expect(directLaunchOfBatchShim(shimPath, dependencies)).toBeNull();
    expect(batchShimGiveUpOf(shimPath, dependencies)).toBe(expected);
  });

  // Sentry DESKTOP-3Y again, on 0.60.0: `target_ps1` refused every launch past
  // cmd's typed budget on an install whose `claude.cmd` runs a `.ps1`.
  describe('a shim whose target is a PowerShell script', () => {
    const ps1Target = 'node_modules\\some-pkg\\bin\\tool.ps1';
    const scriptPath = path.join(directory, 'node_modules', 'some-pkg', 'bin', 'tool.ps1');
    const siblingPwsh = path.join(directory, 'pwsh.exe');
    const everythingBut = (missing: string) => (candidate: string): boolean => candidate !== missing;

    it.each([
      ['pnpm', pnpmPs1CmdShim(ps1Target)],
      ['npm (cmd-shim 8.0.0) for a pwsh shebang', npmCmdShim(ps1Target, { program: 'pwsh' })],
      ['npm (cmd-shim 9.0.2) for a pwsh shebang', npmCmdShim(ps1Target, { program: 'pwsh', cmdShimVersion: '9.0.2' })],
    ])('starts the pwsh that %s names, beside the shim when it is there', (_generator, shim) => {
      const noSibling = { readFile: () => shim, fileExists: everythingBut(siblingPwsh) };
      expect(directLaunchOfBatchShim(shimPath, noSibling)).toEqual({ program: 'pwsh', script: scriptPath });
      expect(batchShimGiveUpOf(shimPath, noSibling)).toBeNull();

      const withSibling = { readFile: () => shim, fileExists: () => true };
      expect(directLaunchOfBatchShim(shimPath, withSibling)).toEqual({ program: siblingPwsh, script: scriptPath });
    });

    it('carries the flags a shebang gave the program, which both generators write ahead of the script', () => {
      const shims = [
        pnpmPs1CmdShim(ps1Target, { programArguments: '-NoProfile' }),
        npmCmdShim(ps1Target, { program: 'pwsh', programArguments: '-NoProfile' }),
      ];
      for (const shim of shims) {
        expect(directLaunchOfBatchShim(shimPath, { readFile: () => shim, fileExists: everythingBut(siblingPwsh) }))
          .toEqual({ program: 'pwsh', programArguments: ['-NoProfile'], script: scriptPath });
      }
    });

    it('carries a hand-written trampoline\'s flags in order, its execution policy included', () => {
      const trampoline = powerShellTrampolineCmdShim('@powershell -NoProfile -ExecutionPolicy Bypass -File', 'claude.ps1');
      // A powershell.exe beside the shim is not the one a bare name starts.
      const launch = directLaunchOfBatchShim(shimPath, { readFile: () => trampoline, fileExists: () => true });
      expect(launch).toEqual({
        program: 'powershell',
        programArguments: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File'],
        script: path.join(directory, 'claude.ps1'),
      });
    });

    describe('handed to a PowerShell named by its full path', () => {
      const script = path.join(directory, 'claude.ps1');
      const windowsPowerShell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
      const systemRootShim = powerShellTrampolineCmdShim(
        '"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -File',
        'claude.ps1',
      );

      it('starts a path written out literally', () => {
        const pwsh = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
        const shim = powerShellTrampolineCmdShim(`@"${pwsh}" -NoProfile -File`, 'claude.ps1');
        expect(directLaunchOfBatchShim(shimPath, { readFile: () => shim, fileExists: () => true }))
          .toEqual({ program: pwsh, programArguments: ['-NoProfile', '-File'], script });
      });

      it('reads each %NAME% as cmd would, whatever the case of the name', () => {
        const dependencies = { readFile: () => systemRootShim, fileExists: () => true, environment: { SYSTEMROOT: 'C:\\Windows' } };
        expect(directLaunchOfBatchShim(shimPath, dependencies))
          .toEqual({ program: windowsPowerShell, programArguments: ['-NoProfile', '-File'], script });
      });

      it('refuses a name that is not set, and a file that is not there', () => {
        const unset = { readFile: () => systemRootShim, fileExists: () => true, environment: {} };
        expect(directLaunchOfBatchShim(shimPath, unset)).toBeNull();
        expect(batchShimGiveUpOf(shimPath, unset)).toBe('target_ps1');

        const missing = {
          readFile: () => systemRootShim,
          fileExists: (candidate: string): boolean => candidate !== windowsPowerShell,
          environment: { SystemRoot: 'C:\\Windows' },
        };
        expect(batchShimGiveUpOf(shimPath, missing)).toBe('target_ps1');
      });

      it('refuses a path relative to wherever the shim is run from', () => {
        const shim = powerShellTrampolineCmdShim('"tools\\pwsh.exe" -File', 'claude.ps1');
        expect(batchShimGiveUpOf(shimPath, { readFile: () => shim, fileExists: () => true })).toBe('target_ps1');
      });

      describe('with no environment passed', () => {
        afterEach(() => {
          vi.unstubAllEnvs();
        });

        it('reads a %NAME% in the program path from process.env', () => {
          vi.stubEnv('KANGENTIC_TEST_POWERSHELL_HOME', 'C:\\Tools');
          const shim = powerShellTrampolineCmdShim('"%KANGENTIC_TEST_POWERSHELL_HOME%\\pwsh.exe" -File', 'claude.ps1');
          expect(directLaunchOfBatchShim(shimPath, { readFile: () => shim, fileExists: () => true }))
            .toEqual({ program: 'C:\\Tools\\pwsh.exe', programArguments: ['-File'], script });
        });
      });

      it('refuses a program path that names no drive', () => {
        const noDriveShims = [
          systemRootShim,
          powerShellTrampolineCmdShim('"\\tools\\pwsh.exe" -File', 'claude.ps1'),
        ];
        for (const shim of noDriveShims) {
          const dependencies = { readFile: () => shim, fileExists: () => true, environment: { SystemRoot: '' } };
          expect(directLaunchOfBatchShim(shimPath, dependencies)).toBeNull();
          expect(batchShimGiveUpOf(shimPath, dependencies)).toBe('target_ps1');
        }
      });

      it('starts a program on a share, which is a full path', () => {
        const shim = powerShellTrampolineCmdShim('"\\\\server\\share\\pwsh.exe" -File', 'claude.ps1');
        expect(directLaunchOfBatchShim(shimPath, { readFile: () => shim, fileExists: () => true }))
          .toEqual({ program: '\\\\server\\share\\pwsh.exe', programArguments: ['-File'], script });
      });
    });

    it('reads through an outer shim to it, and looks for pwsh.exe beside the inner one', () => {
      const innerShimPath = path.join(directory, 'node_modules', '.bin', 'tool.cmd');
      const innerPwsh = path.join(directory, 'node_modules', '.bin', 'pwsh.exe');
      const dependencies = fakeDisk({
        [shimPath]: npmDirectCmdShim('node_modules\\.bin\\tool.cmd'),
        [innerShimPath]: pnpmPs1CmdShim('..\\some-pkg\\bin\\tool.ps1'),
        [innerPwsh]: '',
        [scriptPath]: '',
      });
      expect(directLaunchOfBatchShim(shimPath, dependencies)).toEqual({ program: innerPwsh, script: scriptPath });
    });

    describe('behind an outer shim of its own', () => {
      const innerShimPath = path.join(directory, 'node_modules', '.bin', 'tool.cmd');

      it('gives up as node_path when the outer shim sets NODE_PATH', () => {
        const dependencies = fakeDisk({
          [shimPath]: pnpmCmdShim('node_modules\\.bin\\tool.cmd', { nodeScript: false, nodePath: 'C:\\Users\\dev\\pnpm\\node_modules' }),
          [innerShimPath]: pnpmPs1CmdShim('..\\some-pkg\\bin\\tool.ps1'),
          [scriptPath]: '',
        });
        expect(directLaunchOfBatchShim(shimPath, dependencies)).toBeNull();
        expect(batchShimGiveUpOf(shimPath, dependencies)).toBe('node_path');
      });

      it('gives up as target_ps1 when the outer shim sets a variable of its own, which a direct start would drop', () => {
        const outerShim = [
          '@echo off',
          'set ANTHROPIC_BASE_URL=https://proxy.invalid',
          '"%~dp0node_modules\\.bin\\tool.cmd" %*',
          '',
        ].join('\r\n');
        const dependencies = fakeDisk({
          [shimPath]: outerShim,
          [innerShimPath]: pnpmPs1CmdShim('..\\some-pkg\\bin\\tool.ps1'),
          [scriptPath]: '',
        });
        expect(directLaunchOfBatchShim(shimPath, dependencies)).toBeNull();
        expect(batchShimGiveUpOf(shimPath, dependencies)).toBe('target_ps1');
      });
    });

    it('names the shape of a script called with no program before it names NODE_PATH', () => {
      const shim = '@SET "NODE_PATH=C:\\mock\\node_modules"\r\n' + npmDirectCmdShim(ps1Target);
      expect(batchShimGiveUpOf(shimPath, { readFile: () => shim, fileExists: () => true })).toBe('target_ps1');
    });

    it('starts a target whose extension is upper case as any other', () => {
      const shim = pnpmPs1CmdShim('node_modules\\some-pkg\\bin\\Tool.PS1');
      const upperCaseScript = path.join(directory, 'node_modules', 'some-pkg', 'bin', 'Tool.PS1');
      expect(directLaunchOfBatchShim(shimPath, { readFile: () => shim, fileExists: everythingBut(siblingPwsh) }))
        .toEqual({ program: 'pwsh', script: upperCaseScript });
    });

    it('carries a flag holding a dot or a colon as written', () => {
      const shim = powerShellTrampolineCmdShim('@powershell -Version 5.1 -ExecutionPolicy:Bypass -File', 'claude.ps1');
      expect(directLaunchOfBatchShim(shimPath, { readFile: () => shim, fileExists: () => true })).toEqual({
        program: 'powershell',
        programArguments: ['-Version', '5.1', '-ExecutionPolicy:Bypass', '-File'],
        script: path.join(directory, 'claude.ps1'),
      });
    });

    it('skips a line that names the script without passing the arguments on, and starts the real one', () => {
      const shim = [
        '@echo off',
        'if not exist "%~dp0claude.ps1" exit /b 1',
        'powershell -NoProfile -File "%~dp0claude.ps1" %*',
        '',
      ].join('\r\n');
      expect(directLaunchOfBatchShim(shimPath, { readFile: () => shim, fileExists: () => true })).toEqual({
        program: 'powershell',
        programArguments: ['-NoProfile', '-File'],
        script: path.join(directory, 'claude.ps1'),
      });
    });

    it('lets a parenthesis end the command before the program, and reads %~dp0pwsh.exe as the one beside the shim', () => {
      const shim = [
        '@echo off',
        'if exist "%~dp0pwsh.exe" ( "%~dp0pwsh.exe" -File "%~dp0claude.ps1" %*',
        ') else ( pwsh -File "%~dp0claude.ps1" %*',
        ')',
        '',
      ].join('\r\n');
      const claudeScript = path.join(directory, 'claude.ps1');
      expect(directLaunchOfBatchShim(shimPath, { readFile: () => shim, fileExists: everythingBut(siblingPwsh) }))
        .toEqual({ program: 'pwsh', programArguments: ['-File'], script: claudeScript });
      expect(directLaunchOfBatchShim(shimPath, { readFile: () => shim, fileExists: () => true }))
        .toEqual({ program: siblingPwsh, programArguments: ['-File'], script: claudeScript });
    });

    describe('that names only the pwsh.exe beside it, with no separator after %~dp0', () => {
      const shim = powerShellTrampolineCmdShim('@"%~dp0pwsh.exe" -NoProfile -File', 'claude.ps1');

      it('starts it when it is there', () => {
        expect(directLaunchOfBatchShim(shimPath, { readFile: () => shim, fileExists: () => true })).toEqual({
          program: siblingPwsh,
          programArguments: ['-NoProfile', '-File'],
          script: path.join(directory, 'claude.ps1'),
        });
      });

      it('refuses it when it is not, since the shim names no bare program to fall back to', () => {
        const dependencies = { readFile: () => shim, fileExists: everythingBut(siblingPwsh) };
        expect(directLaunchOfBatchShim(shimPath, dependencies)).toBeNull();
        expect(batchShimGiveUpOf(shimPath, dependencies)).toBe('target_ps1');
      });
    });

    const trampolineLine = '@powershell -NoProfile -File "%~dp0claude.ps1"';
    it.each([
      ['calls the script with no program, as npm does for one with no shebang', npmDirectCmdShim(ps1Target)],
      // Scoop's shim picks this way too, but around an absolute path, so it reads
      // as `unparsed` before it gets here (the `parseNpmShimTarget` case below).
      [
        'picks pwsh or powershell when it runs',
        [
          '@echo off',
          'where /q pwsh.exe',
          'if %errorlevel% equ 0 (',
          '    pwsh -noprofile -file "%~dp0claude.ps1" %*',
          ') else (',
          '    powershell -noprofile -file "%~dp0claude.ps1" %*',
          ')',
          '',
        ].join('\r\n'),
      ],
      ['gives its PowerShell a flag that is not a plain word', powerShellTrampolineCmdShim('@powershell -WindowStyle "Hidden" -File', 'claude.ps1')],
      ['adds an argument of its own after the script', ['@echo off', `${trampolineLine} --verbose %*`, ''].join('\r\n')],
      [
        'sets a variable of its own, which a direct start would lose',
        ['@echo off', 'set ANTHROPIC_BASE_URL=https://proxy.invalid', `${trampolineLine} %*`, ''].join('\r\n'),
      ],
      ['gives its PowerShell a flag that starts with a slash, which Git Bash would rewrite into a path', powerShellTrampolineCmdShim('@powershell /NoProfile -File', 'claude.ps1')],
      [
        'starts the same program with different flags on two lines',
        [
          '@echo off',
          'if defined CI (',
          '  pwsh -NoProfile -File "%~dp0claude.ps1" %*',
          ') else (',
          '  pwsh -File "%~dp0claude.ps1" %*',
          ')',
          '',
        ].join('\r\n'),
      ],
      [
        'names different program paths on two lines',
        [
          '@echo off',
          'if exist "C:\\a\\pwsh.exe" (',
          '  "C:\\a\\pwsh.exe" -File "%~dp0claude.ps1" %*',
          ') else (',
          '  "C:\\b\\pwsh.exe" -File "%~dp0claude.ps1" %*',
          ')',
          '',
        ].join('\r\n'),
      ],
      ['names the script only where it never passes the arguments on', ['@echo off', trampolineLine, ''].join('\r\n')],
      [
        'runs a second command after the arguments on one start line, beside a clean one',
        [
          '@echo off',
          'if defined CI (',
          '  powershell -NoProfile -File "%~dp0claude.ps1" %*',
          ') else (',
          '  powershell -NoProfile -File "%~dp0claude.ps1" %* & echo done',
          ')',
          '',
        ].join('\r\n'),
      ],
      ['puts the script inside an open quote', powerShellTrampolineCmdShim('@powershell -Command "echo', 'claude.ps1')],
      [
        'holds its program in a variable it never sets, beside a clean start line',
        [
          '@echo off',
          'if defined PWSH (',
          '  "%PWSH%" -File "%~dp0claude.ps1" %*',
          ') else (',
          '  pwsh -File "%~dp0claude.ps1" %*',
          ')',
          '',
        ].join('\r\n'),
      ],
    ])('still refuses a shim that %s', (_label, shim) => {
      const dependencies = { readFile: () => shim, fileExists: () => true };
      expect(directLaunchOfBatchShim(shimPath, dependencies)).toBeNull();
      expect(batchShimGiveUpOf(shimPath, dependencies)).toBe('target_ps1');
    });

    it.each([
      ['a quoted set behind an echo-off at sign', '@set "FOO=1"'],
      ['a set after an ampersand', 'echo x & set FOO=1'],
      ['a set /p prompt', 'set /p FOO=x'],
      ['a set /a sum', 'set /a FOO=1'],
      ['a set in upper case', 'SET foo=1'],
      ['a set inside a parenthesized block', 'if defined CI (set FOO=1)'],
      ['a name with a character outside letters, digits and underscore', 'set "MY-VAR=1"'],
      ['a set straight after a pipe character', 'ver >nul ||set FOO=1'],
    ])('refuses a shim with %s, as a variable of its own', (_label, setLine) => {
      const shim = ['@echo off', setLine, `${trampolineLine} %*`, ''].join('\r\n');
      const dependencies = { readFile: () => shim, fileExists: () => true };
      expect(directLaunchOfBatchShim(shimPath, dependencies)).toBeNull();
      expect(batchShimGiveUpOf(shimPath, dependencies)).toBe('target_ps1');
    });

    it('refuses one behind a shim that sets NODE_PATH, since the script may start node', () => {
      const shim = pnpmPs1CmdShim(ps1Target, { nodePath: 'C:\\Users\\dev\\AppData\\Local\\pnpm\\global\\5\\node_modules\\.pnpm\\node_modules' });
      const dependencies = { readFile: () => shim, fileExists: () => true };
      expect(directLaunchOfBatchShim(shimPath, dependencies)).toBeNull();
      expect(batchShimGiveUpOf(shimPath, dependencies)).toBe('node_path');
    });
  });

  describe('a shim whose target is another shim', () => {
    // A global bin that calls the package's `node_modules\.bin\<name>.cmd`.
    const innerShimPath = path.join(directory, 'node_modules', '.bin', 'claude.cmd');
    const innerTarget = '..\\@anthropic-ai\\claude-code\\cli.js';
    const scriptPath = path.join(directory, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    const innerSiblingNode = path.join(directory, 'node_modules', '.bin', 'node.exe');

    function filesOf(files: Record<string, string>): ReturnType<typeof fakeDisk> {
      return fakeDisk(files, [scriptPath]);
    }

    it.each([
      ['npm', npmDirectCmdShim('node_modules\\.bin\\claude.cmd')],
      ['pnpm', pnpmCmdShim('node_modules\\.bin\\claude.cmd', { nodeScript: false })],
    ])('starts what the inner shim starts, under an outer %s shim', (_manager, outerShim) => {
      const dependencies = filesOf({ [shimPath]: outerShim, [innerShimPath]: npmCmdShim(innerTarget) });
      expect(directLaunchOfBatchShim(shimPath, dependencies)).toEqual({ program: 'node', script: scriptPath });
      expect(batchShimGiveUpOf(shimPath, dependencies)).toBeNull();
    });

    it('prefers the node.exe beside the inner shim, which is the one that runs node', () => {
      const dependencies = filesOf({
        [shimPath]: npmDirectCmdShim('node_modules\\.bin\\claude.cmd'),
        [innerShimPath]: npmCmdShim(innerTarget),
        [innerSiblingNode]: '',
      });
      expect(directLaunchOfBatchShim(shimPath, dependencies)).toEqual({ program: innerSiblingNode, script: scriptPath });
    });

    it('starts a native program at the end of the chain directly', () => {
      const exePath = path.join(directory, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
      const dependencies = filesOf({
        [shimPath]: npmDirectCmdShim('node_modules\\.bin\\claude.cmd'),
        [innerShimPath]: npmCmdShim('..\\@anthropic-ai\\claude-code\\bin\\claude.exe'),
        [exePath]: '',
      });
      expect(directLaunchOfBatchShim(shimPath, dependencies)).toEqual({ program: exePath, script: null });
    });

    it('refuses a Node script when any shim of the chain sets NODE_PATH', () => {
      const dependencies = filesOf({
        [shimPath]: pnpmCmdShim('node_modules\\.bin\\claude.cmd', { nodeScript: false, nodePath: 'C:\\Users\\dev\\pnpm\\node_modules' }),
        [innerShimPath]: npmCmdShim(innerTarget),
      });
      expect(directLaunchOfBatchShim(shimPath, dependencies)).toBeNull();
      expect(batchShimGiveUpOf(shimPath, dependencies)).toBe('node_path');
    });

    it('follows an inner shim that is a .bat file', () => {
      const innerBatPath = path.join(directory, 'node_modules', '.bin', 'claude.bat');
      const dependencies = filesOf({
        [shimPath]: npmDirectCmdShim('node_modules\\.bin\\claude.bat'),
        [innerBatPath]: npmCmdShim(innerTarget),
      });
      expect(directLaunchOfBatchShim(shimPath, dependencies)).toEqual({ program: 'node', script: scriptPath });
      expect(batchShimGiveUpOf(shimPath, dependencies)).toBeNull();
    });

    it('starts a native program directly even when an outer shim sets NODE_PATH', () => {
      const exePath = path.join(directory, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
      const dependencies = filesOf({
        [shimPath]: pnpmCmdShim('node_modules\\.bin\\claude.cmd', { nodeScript: false, nodePath: 'C:\\Users\\dev\\pnpm\\node_modules' }),
        [innerShimPath]: npmCmdShim('..\\@anthropic-ai\\claude-code\\bin\\claude.exe'),
        [exePath]: '',
      });
      expect(directLaunchOfBatchShim(shimPath, dependencies)).toEqual({ program: exePath, script: null });
      expect(batchShimGiveUpOf(shimPath, dependencies)).toBeNull();
    });

    it('passes on why an inner shim gave up', () => {
      const dependencies = filesOf({
        [shimPath]: npmDirectCmdShim('node_modules\\.bin\\claude.cmd'),
        [innerShimPath]: '@echo hello',
      });
      expect(batchShimGiveUpOf(shimPath, dependencies)).toBe('unparsed');
    });

    it(`gives up on a chain longer than ${MAX_SHIM_HOPS} shims`, () => {
      const files: Record<string, string> = {};
      let current = shimPath;
      for (let hop = 1; hop <= MAX_SHIM_HOPS; hop++) {
        files[current] = npmDirectCmdShim(`next${hop}.cmd`);
        current = path.join(directory, `next${hop}.cmd`);
      }
      files[current] = npmCmdShim(innerTarget);
      expect(directLaunchOfBatchShim(shimPath, filesOf(files))).toBeNull();
      expect(batchShimGiveUpOf(shimPath, filesOf(files))).toBe('target_batch');
    });

    it('resolves a chain exactly as long as the limit', () => {
      const files: Record<string, string> = {};
      let current = shimPath;
      for (let hop = 1; hop < MAX_SHIM_HOPS; hop++) {
        files[current] = npmDirectCmdShim(`next${hop}.cmd`);
        current = path.join(directory, `next${hop}.cmd`);
      }
      files[current] = npmCmdShim('node_modules\\@anthropic-ai\\claude-code\\cli.js');
      expect(directLaunchOfBatchShim(shimPath, filesOf(files))).toEqual({ program: 'node', script: scriptPath });
    });

    it('gives up on a shim that names itself', () => {
      const dependencies = filesOf({ [shimPath]: npmDirectCmdShim('gemini.cmd') });
      expect(batchShimGiveUpOf(shimPath, dependencies)).toBe('target_batch');
    });
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
