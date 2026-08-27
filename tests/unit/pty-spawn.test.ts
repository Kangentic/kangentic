import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
}));

import {
  resolveShellArgs,
  buildSpawnEnv,
  resolveSpawnCwd,
  diagnoseSpawnFailure,
  FULL_REPAINT_ENV_KEY,
  SCROLL_SPEED_ENV_KEY,
} from '../../src/main/pty/spawn/pty-spawn';
import { buildSpawnClearPrelude } from '../../src/shared/paths';

describe('buildSpawnClearPrelude', () => {
  // The prelude makes the SHELL erase its own startup preamble and command
  // echo the moment the agent command executes - the source-level guard that
  // stays valid no matter how pwsh/ConPTY reshape their startup bytes (pwsh
  // 7.6 started emitting \x1b[?25l and \x1b[2J in the preamble, which broke
  // every heuristic that keyed on those markers).
  it('uses Clear-Host for the PowerShell family', () => {
    expect(buildSpawnClearPrelude('pwsh')).toBe('Clear-Host; ');
    expect(buildSpawnClearPrelude('powershell.exe')).toBe('Clear-Host; ');
    expect(buildSpawnClearPrelude('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe('Clear-Host; ');
  });

  it('uses cls with cmd chaining for cmd.exe', () => {
    expect(buildSpawnClearPrelude('cmd')).toBe('cls & ');
    expect(buildSpawnClearPrelude('C:\\Windows\\System32\\cmd.exe')).toBe('cls & ');
  });

  it('uses clear for POSIX-ish shells (bash, zsh, fish, nu, WSL, git-bash)', () => {
    for (const shell of ['bash', 'zsh', 'fish', 'nu', 'wsl -d Ubuntu', 'C:\\Program Files\\Git\\bin\\bash.exe']) {
      expect(buildSpawnClearPrelude(shell)).toBe('clear; ');
    }
  });
});

describe('resolveShellArgs', () => {
  it('splits WSL specs into exe + args, appending .exe for the ConPTY resolver', () => {
    // node-pty's ConPTY executable search cannot resolve an extension-less
    // bare name; `wsl` spawns as exit -1 with zero output while `wsl.exe` works.
    expect(resolveShellArgs('wsl -d Ubuntu')).toEqual({ exe: 'wsl.exe', args: ['-d', 'Ubuntu'] });
  });

  it('does not double-append .exe when a hand-edited config already carries it', () => {
    // A hand-edited config may already store the WSL spec with the .exe
    // suffix. The gate must recognize `wsl.exe ...` as a WSL spec (not fall
    // through to the catch-all branch), and the suffix guard must not
    // append a second .exe on top of an already-suffixed executable.
    expect(resolveShellArgs('wsl.exe -d Ubuntu')).toEqual({ exe: 'wsl.exe', args: ['-d', 'Ubuntu'] });
  });

  it('preserves the original casing of an already-suffixed WSL executable', () => {
    // The gate lowercases the spec to decide whether it is a WSL invocation,
    // but the returned exe keeps the caller's original casing.
    expect(resolveShellArgs('WSL.EXE -d Ubuntu')).toEqual({ exe: 'WSL.EXE', args: ['-d', 'Ubuntu'] });
  });

  it('returns cmd with no args', () => {
    expect(resolveShellArgs('cmd.exe')).toEqual({ exe: 'cmd.exe', args: [] });
  });

  it('passes -NoLogo to powershell/pwsh', () => {
    expect(resolveShellArgs('powershell')).toEqual({ exe: 'powershell', args: ['-NoLogo'] });
    expect(resolveShellArgs('pwsh')).toEqual({ exe: 'pwsh', args: ['-NoLogo'] });
  });

  it('passes nothing to fish and nushell', () => {
    expect(resolveShellArgs('/usr/bin/fish')).toEqual({ exe: '/usr/bin/fish', args: [] });
    expect(resolveShellArgs('/usr/bin/nu')).toEqual({ exe: '/usr/bin/nu', args: [] });
  });

  it('defaults to --login for bash/zsh', () => {
    expect(resolveShellArgs('/bin/bash')).toEqual({ exe: '/bin/bash', args: ['--login'] });
    expect(resolveShellArgs('/bin/zsh')).toEqual({ exe: '/bin/zsh', args: ['--login'] });
  });

  it('is case-insensitive', () => {
    expect(resolveShellArgs('CMD.EXE')).toEqual({ exe: 'CMD.EXE', args: [] });
    expect(resolveShellArgs('PowerShell')).toEqual({ exe: 'PowerShell', args: ['-NoLogo'] });
  });
});

describe('buildSpawnEnv', () => {
  it('strips CLAUDECODE so a spawned Claude CLI does not abort', () => {
    const env = buildSpawnEnv({ CLAUDECODE: '1', OTHER: 'kept' });
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.OTHER).toBe('kept');
  });

  it('strips every parent Claude session identity marker (CLAUDE_CODE_*)', () => {
    // Leaked from a parent Claude session, these make the spawned child attach
    // to the parent's identity and never persist its own --session-id
    // transcript, so a later --resume reports "No conversation found".
    const env = buildSpawnEnv({
      CLAUDECODE: '1',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_SESSION_ID: 'parent-session-uuid',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_EXECPATH: 'C:/Users/dev/.local/bin/claude.exe',
      OTHER: 'kept',
    });
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(env.CLAUDE_CODE_EXECPATH).toBeUndefined();
    expect(env.OTHER).toBe('kept');
  });

  it('preserves ANTHROPIC_* auth keys (BYOK / API auth must pass through)', () => {
    const env = buildSpawnEnv({ ANTHROPIC_API_KEY: 'sk-test', CLAUDE_CODE_SESSION_ID: 'parent' });
    expect(env.ANTHROPIC_API_KEY).toBe('sk-test');
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
  });

  it('inherits process.env but lets input override', () => {
    const original = process.env.PATH;
    const env = buildSpawnEnv({ PATH: '/custom' });
    expect(env.PATH).toBe('/custom');
    expect(original).toBe(process.env.PATH); // process.env untouched
  });

  it('handles undefined input', () => {
    const env = buildSpawnEnv(undefined);
    expect(env.CLAUDECODE).toBeUndefined();
  });
});

// Claude Code's fullscreen TUI intermittently omits history entries from its
// incremental scrolled-view updates (anthropics/claude-code#83714). The
// full-repaint flag removes the incremental path; Kangentic defaults it on
// for Windows spawns, matching Claude Code's own agent-view practice. These
// pin the keeplist so the identity-marker strip cannot silently swallow it,
// and the default so a refactor cannot silently widen or drop it.
describe('buildSpawnEnv full-repaint keeplist', () => {
  let savedHostValue: string | undefined;

  beforeEach(() => {
    // Hermetic: the host machine may legitimately export the flag globally.
    savedHostValue = process.env[FULL_REPAINT_ENV_KEY];
    delete process.env[FULL_REPAINT_ENV_KEY];
  });

  afterEach(() => {
    if (savedHostValue === undefined) delete process.env[FULL_REPAINT_ENV_KEY];
    else process.env[FULL_REPAINT_ENV_KEY] = savedHostValue;
  });

  it('defaults the flag on for win32 spawns', () => {
    const env = buildSpawnEnv({}, 'win32');
    expect(env[FULL_REPAINT_ENV_KEY]).toBe('1');
  });

  it('does NOT default it on non-Windows platforms', () => {
    const env = buildSpawnEnv({}, 'linux');
    expect(env[FULL_REPAINT_ENV_KEY]).toBeUndefined();
  });

  it('keeps an explicit value over the default (user opt-out wins)', () => {
    const env = buildSpawnEnv({ [FULL_REPAINT_ENV_KEY]: '0' }, 'win32');
    expect(env[FULL_REPAINT_ENV_KEY]).toBe('0');
  });

  it('keeplists the flag through the strip while identity markers still drop', () => {
    const env = buildSpawnEnv(
      {
        [FULL_REPAINT_ENV_KEY]: '1',
        CLAUDECODE: '1',
        CLAUDE_CODE_SESSION_ID: 'parent-session-uuid',
      },
      'linux',
    );
    expect(env[FULL_REPAINT_ENV_KEY]).toBe('1');
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
  });
});

// CLAUDE_CODE_SCROLL_SPEED is keeplisted (a user's exported tuning survives
// the identity-marker strip) but deliberately NOT defaulted: a default of 3
// was shipped and reverted the same day, because the fullscreen TUI's
// differential renderer mis-assembles frames on large scrolled jumps and the
// 3x multiplier tripled every coalesced-read jump past that threshold. The
// CLI default of 1 matches the native terminals verified clean. These pin the
// no-default decision and the keeplist survival.
describe('buildSpawnEnv scroll-speed keeplist', () => {
  let savedHostValue: string | undefined;

  beforeEach(() => {
    // Hermetic: a dogfooding machine may legitimately export the key globally.
    savedHostValue = process.env[SCROLL_SPEED_ENV_KEY];
    delete process.env[SCROLL_SPEED_ENV_KEY];
  });

  afterEach(() => {
    if (savedHostValue === undefined) delete process.env[SCROLL_SPEED_ENV_KEY];
    else process.env[SCROLL_SPEED_ENV_KEY] = savedHostValue;
  });

  it.each(['win32', 'linux', 'darwin'] as const)(
    'applies NO default on %s - the CLI default of 1 is the clean-scroll regime',
    (platform) => {
      const env = buildSpawnEnv({}, platform);
      expect(env[SCROLL_SPEED_ENV_KEY]).toBeUndefined();
    },
  );

  it('keeplists an explicit user value through the strip while identity markers still drop', () => {
    const env = buildSpawnEnv(
      {
        [SCROLL_SPEED_ENV_KEY]: '5',
        CLAUDECODE: '1',
        CLAUDE_CODE_SESSION_ID: 'parent-session-uuid',
      },
      'linux',
    );
    expect(env[SCROLL_SPEED_ENV_KEY]).toBe('5');
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
  });
});

// Claude Code exports NO_COLOR=1 into its tool shells alongside CLAUDECODE, so
// a dev/preview Kangentic launched from inside a Claude Code session would
// otherwise force-dim every color-capable CLI in every agent PTY (agy honors
// NO_COLOR and drops to monochrome). The strip is provenance-gated: NO_COLOR
// is dropped only when CLAUDECODE proves it leaked from a Claude Code launch.
// A bare NO_COLOR is a deliberate user preference and passes through, and an
// explicit per-spawn NO_COLOR from a caller always survives.
describe('buildSpawnEnv NO_COLOR strip', () => {
  const hermeticKeys = ['NO_COLOR', 'CLAUDECODE'] as const;
  let savedHostValues: Record<string, string | undefined>;

  beforeEach(() => {
    // Hermetic: dogfood machines run this suite from inside Claude Code,
    // where both keys are genuinely exported.
    savedHostValues = {};
    for (const key of hermeticKeys) {
      savedHostValues[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of hermeticKeys) {
      if (savedHostValues[key] === undefined) delete process.env[key];
      else process.env[key] = savedHostValues[key];
    }
  });

  it('strips a NO_COLOR leaked from a Claude Code launch (the dev/preview scenario)', () => {
    process.env.NO_COLOR = '1';
    process.env.CLAUDECODE = '1';
    const env = buildSpawnEnv(undefined);
    expect(env.NO_COLOR).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
  });

  it('strips it when CLAUDECODE arrives via inputEnv (the check reads the merged env)', () => {
    process.env.NO_COLOR = '1';
    const env = buildSpawnEnv({ CLAUDECODE: '1' });
    expect(env.NO_COLOR).toBeUndefined();
  });

  it('preserves a bare NO_COLOR without CLAUDECODE (deliberate user preference)', () => {
    process.env.NO_COLOR = '1';
    expect(buildSpawnEnv(undefined).NO_COLOR).toBe('1');
    expect(buildSpawnEnv({}).NO_COLOR).toBe('1');
  });

  it('keeps an explicit inputEnv NO_COLOR while still stripping CLAUDECODE', () => {
    process.env.CLAUDECODE = '1';
    const env = buildSpawnEnv({ NO_COLOR: '1' });
    expect(env.NO_COLOR).toBe('1');
    expect(env.CLAUDECODE).toBeUndefined();
  });

  it('keeps an explicit inputEnv NO_COLOR even when CLAUDECODE rides inputEnv too', () => {
    const env = buildSpawnEnv({ CLAUDECODE: '1', NO_COLOR: '1' });
    expect(env.NO_COLOR).toBe('1');
    expect(env.CLAUDECODE).toBeUndefined();
  });
});

// node-pty turns the `name` spawn option into the child's TERM only on POSIX
// (unixTerminal.js assigns `env.TERM = name`; the Windows agent computes the
// name and never touches the env), so a child of a PowerShell-launched
// Kangentic sees no TERM at all and capability-detecting TUIs render
// monochrome. The default fills that gap without overriding anything the
// user's environment already carries.
describe('buildSpawnEnv TERM default', () => {
  let savedHostTerm: string | undefined;

  beforeEach(() => {
    // Hermetic: the host shell (Git Bash, CI's Linux runner) may export TERM.
    savedHostTerm = process.env.TERM;
    delete process.env.TERM;
  });

  afterEach(() => {
    if (savedHostTerm === undefined) delete process.env.TERM;
    else process.env.TERM = savedHostTerm;
  });

  it('defaults TERM to xterm-256color when absent (the PowerShell-launch case)', () => {
    expect(buildSpawnEnv(undefined).TERM).toBe('xterm-256color');
  });

  it('treats an empty TERM as absent', () => {
    process.env.TERM = '';
    expect(buildSpawnEnv(undefined).TERM).toBe('xterm-256color');
  });

  it('preserves an inherited TERM verbatim (user environment wins)', () => {
    process.env.TERM = 'screen';
    expect(buildSpawnEnv(undefined).TERM).toBe('screen');
  });

  it('preserves an explicit inputEnv TERM (per-spawn caller choice wins)', () => {
    expect(buildSpawnEnv({ TERM: 'xterm' }).TERM).toBe('xterm');
  });

  it('applies on every platform (the platform arg gates only the full-repaint flag)', () => {
    expect(buildSpawnEnv({}, 'linux').TERM).toBe('xterm-256color');
    expect(buildSpawnEnv({}, 'win32').TERM).toBe('xterm-256color');
    expect(buildSpawnEnv({}, 'darwin').TERM).toBe('xterm-256color');
  });
});

describe('resolveSpawnCwd', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the cwd unchanged when it exists', () => {
    const existing = os.homedir();
    const result = resolveSpawnCwd({
      requestedCwd: existing,
      shellName: '/bin/bash',
      platform: 'linux',
    });
    expect(result.effectiveCwd).toBe(existing);
    expect(result.cwdFixupCommand).toBeNull();
  });

  it('falls back to home when cwd does not exist', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const result = resolveSpawnCwd({
      requestedCwd: '/does/not/exist',
      shellName: '/bin/bash',
      platform: 'linux',
    });
    expect(result.effectiveCwd).toBe(os.homedir());
  });

  it('emits a pushd fixup for UNC paths under cmd.exe on Windows', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const result = resolveSpawnCwd({
      requestedCwd: '\\\\server\\share\\project',
      shellName: 'cmd.exe',
      platform: 'win32',
    });
    expect(result.effectiveCwd).toBe(os.homedir());
    expect(result.cwdFixupCommand).toBe('pushd "\\\\server\\share\\project"');
  });

  it('does NOT emit a pushd fixup for UNC paths under PowerShell', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const result = resolveSpawnCwd({
      requestedCwd: '\\\\server\\share\\project',
      shellName: 'powershell',
      platform: 'win32',
    });
    expect(result.effectiveCwd).toBe('\\\\server\\share\\project');
    expect(result.cwdFixupCommand).toBeNull();
  });

  it('does NOT emit a pushd fixup on non-Windows platforms', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const result = resolveSpawnCwd({
      requestedCwd: '\\\\server\\share\\project',
      shellName: 'cmd.exe',
      platform: 'linux',
    });
    expect(result.cwdFixupCommand).toBeNull();
  });

  // Windows PowerShell 5.1 treats `[` / `]` in its startup path as wildcards
  // and falls back to $PSHOME, so the agent CLI runs in the wrong folder. The
  // Win32 cwd is still valid, so effectiveCwd is left unchanged and a
  // Set-Location -LiteralPath fixup corrects the provider location.
  it('emits a Set-Location fixup for bracketed paths under powershell on Windows', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const result = resolveSpawnCwd({
      requestedCwd: 'C:\\Users\\dev\\[foo]\\bar',
      shellName: 'powershell',
      platform: 'win32',
    });
    expect(result.effectiveCwd).toBe('C:\\Users\\dev\\[foo]\\bar');
    expect(result.cwdFixupCommand).toBe("Set-Location -LiteralPath 'C:\\Users\\dev\\[foo]\\bar'");
  });

  it('emits the Set-Location fixup for pwsh too (family-wide)', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const result = resolveSpawnCwd({
      requestedCwd: 'C:\\Users\\dev\\[foo]\\bar',
      shellName: 'pwsh',
      platform: 'win32',
    });
    expect(result.cwdFixupCommand).toBe("Set-Location -LiteralPath 'C:\\Users\\dev\\[foo]\\bar'");
  });

  it('matches a full PowerShell 7 exe path (powershell substring in the folder name)', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const result = resolveSpawnCwd({
      requestedCwd: 'C:\\Users\\dev\\[foo]\\bar',
      shellName: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      platform: 'win32',
    });
    expect(result.cwdFixupCommand).toBe("Set-Location -LiteralPath 'C:\\Users\\dev\\[foo]\\bar'");
  });

  it('doubles single quotes inside a bracketed path for the fixup', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const result = resolveSpawnCwd({
      requestedCwd: "C:\\Users\\dev\\[o'brien]\\bar",
      shellName: 'powershell',
      platform: 'win32',
    });
    expect(result.cwdFixupCommand).toBe("Set-Location -LiteralPath 'C:\\Users\\dev\\[o''brien]\\bar'");
  });

  it('emits the Set-Location fixup for a bracketed UNC path under PowerShell', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const result = resolveSpawnCwd({
      requestedCwd: '\\\\server\\share\\[x]',
      shellName: 'powershell',
      platform: 'win32',
    });
    expect(result.effectiveCwd).toBe('\\\\server\\share\\[x]');
    expect(result.cwdFixupCommand).toBe("Set-Location -LiteralPath '\\\\server\\share\\[x]'");
  });

  it('does NOT emit a fixup for a nonexistent bracketed cwd (falls back to home)', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    // Mock homedir to a bracket-free placeholder so the assertion is hermetic
    // and does not depend on the host's real home directory.
    vi.spyOn(os, 'homedir').mockReturnValue('C:\\Users\\dev');
    const result = resolveSpawnCwd({
      requestedCwd: 'C:\\Users\\dev\\[foo]\\bar',
      shellName: 'powershell',
      platform: 'win32',
    });
    expect(result.effectiveCwd).toBe(os.homedir());
    expect(result.cwdFixupCommand).toBeNull();
  });

  it('does NOT emit a fixup for bracketed paths under cmd.exe (cmd is bracket-safe)', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const result = resolveSpawnCwd({
      requestedCwd: 'C:\\Users\\dev\\[foo]\\bar',
      shellName: 'cmd.exe',
      platform: 'win32',
    });
    expect(result.cwdFixupCommand).toBeNull();
  });

  // A bracketed UNC path under cmd.exe must still take the UNC pushd branch
  // (which precedes the PowerShell bracket branch), not the Set-Location one:
  // cmd cannot use a UNC cwd, and cmd handles brackets fine. This pins the
  // branch precedence so a future reorder can't silently emit Set-Location.
  it('emits the pushd fixup (not Set-Location) for a bracketed UNC path under cmd.exe', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const result = resolveSpawnCwd({
      requestedCwd: '\\\\server\\share\\[x]',
      shellName: 'cmd.exe',
      platform: 'win32',
    });
    expect(result.effectiveCwd).toBe(os.homedir());
    expect(result.cwdFixupCommand).toBe('pushd "\\\\server\\share\\[x]"');
  });

  // The cmd branch matches on the basename (via isCmdShell), NOT a raw
  // substring: a shell whose PATH merely contains "cmd" (e.g. Cmder's
  // cmder.exe) must not be misclassified as cmd.exe and have its cwd
  // force-replaced with home plus a spurious pushd written into the PTY.
  it('does NOT emit a pushd fixup for a non-cmd shell whose path contains "cmd" (e.g. cmder)', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const result = resolveSpawnCwd({
      requestedCwd: '\\\\server\\share\\project',
      shellName: 'C:\\tools\\cmder\\cmder.exe',
      platform: 'win32',
    });
    expect(result.effectiveCwd).toBe('\\\\server\\share\\project');
    expect(result.cwdFixupCommand).toBeNull();
  });

  it('does NOT emit a fixup for bracketed paths under bash', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const result = resolveSpawnCwd({
      requestedCwd: 'C:\\Users\\dev\\[foo]\\bar',
      shellName: '/bin/bash',
      platform: 'win32',
    });
    expect(result.cwdFixupCommand).toBeNull();
  });

  it('does NOT emit a fixup for bracketed paths under WSL', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const result = resolveSpawnCwd({
      requestedCwd: 'C:\\Users\\dev\\[foo]\\bar',
      shellName: 'wsl -d Ubuntu',
      platform: 'win32',
    });
    expect(result.cwdFixupCommand).toBeNull();
  });

  it('does NOT emit a fixup for a plain (bracket-free) path under PowerShell', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const result = resolveSpawnCwd({
      requestedCwd: 'C:\\Users\\dev\\project',
      shellName: 'powershell',
      platform: 'win32',
    });
    expect(result.cwdFixupCommand).toBeNull();
  });

  it('does NOT emit a Set-Location fixup for bracketed paths on non-Windows', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const result = resolveSpawnCwd({
      requestedCwd: '/home/dev/[foo]/bar',
      shellName: 'pwsh',
      platform: 'linux',
    });
    expect(result.cwdFixupCommand).toBeNull();
  });
});

describe('diagnoseSpawnFailure', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds a posix_spawnp-specific scrollback message with dev-mode chmod instructions', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => String(p).includes('/bin/bash'));
    const result = diagnoseSpawnFailure({
      err: new Error('posix_spawnp failed: EACCES'),
      shellExe: '/bin/bash',
      effectiveCwd: '/home/user/project',
      originalCwd: '/home/user/project',
    });
    expect(result.errorMessage).toContain('posix_spawnp');
    expect(result.scrollbackSuffix).toContain('spawn-helper');
    expect(result.scrollbackSuffix).toContain('chmod +x');
    expect(result.shellExists).toBe(true);
    expect(result.cwdExists).toBe(false);
  });

  it('points packaged-app users at reinstall rather than chmod', () => {
    const result = diagnoseSpawnFailure({
      err: new Error('posix_spawnp failed'),
      shellExe: '/Applications/Kangentic.app/Contents/Resources/app.asar/node_modules/node-pty/bin/sh',
      effectiveCwd: '/Users/dev/project',
      originalCwd: '/Users/dev/project',
    });
    expect(result.scrollbackSuffix).toContain('Reinstalling');
    expect(result.scrollbackSuffix).not.toContain('chmod');
  });

  it('emits an empty scrollback suffix for unrelated errors', () => {
    const result = diagnoseSpawnFailure({
      err: new Error('ENOENT: no such file'),
      shellExe: '/missing/shell',
      effectiveCwd: '/tmp',
      originalCwd: '/tmp',
    });
    expect(result.scrollbackSuffix).toBe('');
  });

  it('carries the errno code through', () => {
    const err: NodeJS.ErrnoException = new Error('EACCES');
    err.code = 'EACCES';
    err.errno = -13;
    const result = diagnoseSpawnFailure({
      err,
      shellExe: '/bin/bash',
      effectiveCwd: '/tmp',
      originalCwd: '/tmp',
    });
    expect(result.errno).toBe('EACCES');
  });

  it('handles non-Error throwables', () => {
    const result = diagnoseSpawnFailure({
      err: 'weird string error',
      shellExe: '/bin/bash',
      effectiveCwd: '/tmp',
      originalCwd: '/tmp',
    });
    expect(result.errorMessage).toBe('weird string error');
  });
});
