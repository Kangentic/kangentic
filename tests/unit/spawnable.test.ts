/**
 * scripts/lib/spawnable.js resolves an agent CLI to something a child process can start, and flags
 * the arguments a shim's interpreter would re-parse. Both capture scripts
 * (capture-agent-scrollback.js and capture-demo-archived-runs.mjs) lean on it, and nothing else
 * exercised it.
 *
 * Everything here is platform neutral, so it runs the same on a Windows box and on CI's Linux:
 *
 * - `process.platform` is read when `toSpawnable` is CALLED, so each test sets it explicitly. The
 *   direct-wrapping cases force 'linux' (the PATH lookup is skipped there) and the ranking cases
 *   force 'win32'.
 * - The module destructures `execFileSync` from `node:child_process` when it LOADS, so the stub for
 *   where.exe is installed on the real module object first and the module is then re-required,
 *   fresh, with the stub in place. No process is ever spawned.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

type ReparsingShell = 'cmd' | 'powershell';

interface Spawnable {
  file: string;
  args: string[];
  shell: ReparsingShell | null;
}

interface SpawnableModule {
  toSpawnable: (exe: string, args: string[]) => Spawnable;
  shellReparsedArgument: (spawnable: Spawnable) => string | null;
  childAgentEnv: () => Record<string, string | undefined>;
}

const require = createRequire(import.meta.url);
const SPAWNABLE_PATH = require.resolve('../../scripts/lib/spawnable.js');
const childProcessModule = require('node:child_process') as typeof import('node:child_process');

const NPM_DIRECTORY = 'C:\\Users\\dev\\AppData\\Roaming\\npm';
const POWERSHELL_FLAGS = ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File'];

/** What the stubbed where.exe does for the current test. */
let lookupOutcome: { stdout: string } | { failure: Error };
/** Every where.exe invocation the module made, in order. */
let lookupCalls: Array<{ file: string; args: readonly string[] }>;
let spawnableModule: SpawnableModule;

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

function lookupReturns(stdout: string): void {
  lookupOutcome = { stdout };
}

function lookupFails(): void {
  lookupOutcome = { failure: new Error('Command failed: where.exe (exit code 1)') };
}

function stubbedExecFileSync(file: string, args: readonly string[]): string {
  lookupCalls.push({ file, args });
  if ('failure' in lookupOutcome) throw lookupOutcome.failure;
  return lookupOutcome.stdout;
}

beforeEach(() => {
  lookupCalls = [];
  lookupFails();
  vi.spyOn(childProcessModule, 'execFileSync').mockImplementation(
    stubbedExecFileSync as unknown as typeof childProcessModule.execFileSync,
  );
  // Fresh load so the destructured execFileSync is the stub, never a cached real one.
  delete require.cache[SPAWNABLE_PATH];
  spawnableModule = require(SPAWNABLE_PATH) as SpawnableModule;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete require.cache[SPAWNABLE_PATH];
  if (originalPlatformDescriptor) Object.defineProperty(process, 'platform', originalPlatformDescriptor);
});

describe('toSpawnable off Windows (no PATH lookup, wrap by extension)', () => {
  it.each(['linux', 'darwin'] as const)('never shells out to where.exe on %s', (platform) => {
    setPlatform(platform);

    spawnableModule.toSpawnable('claude', ['-p', 'hello']);
    spawnableModule.toSpawnable('shim.cmd', []);
    spawnableModule.toSpawnable('shim.ps1', []);

    expect(lookupCalls).toEqual([]);
  });

  it.each(['shim.ps1', 'SHIM.PS1', '/opt/tools/shim.Ps1'])('wraps %s in powershell, keeping every caller argument after the resolved path', (exe) => {
    setPlatform('linux');
    const callerArgs = ['--model', 'sonnet', 'a b'];

    const spawnable = spawnableModule.toSpawnable(exe, callerArgs);

    expect(spawnable).toEqual({
      file: 'powershell.exe',
      args: [...POWERSHELL_FLAGS, exe, '--model', 'sonnet', 'a b'],
      shell: 'powershell',
    });
    expect(callerArgs).toEqual(['--model', 'sonnet', 'a b']);
  });

  it.each(['shim.cmd', 'SHIM.CMD', 'shim.bat', 'SHIM.BAT', '/opt/tools/shim.Cmd'])('wraps %s in cmd.exe, keeping every caller argument after the resolved path', (exe) => {
    setPlatform('linux');
    const callerArgs = ['--model', 'sonnet', 'a b'];

    const spawnable = spawnableModule.toSpawnable(exe, callerArgs);

    expect(spawnable).toEqual({
      file: 'cmd.exe',
      args: ['/d', '/c', exe, '--model', 'sonnet', 'a b'],
      shell: 'cmd',
    });
    expect(callerArgs).toEqual(['--model', 'sonnet', 'a b']);
  });

  it.each(['claude', '/usr/local/bin/claude', 'tool.exe', 'tool.cmd.d', 'tool.ps1x', 'tool.batch'])('starts %s directly with no shell', (exe) => {
    setPlatform('linux');
    const callerArgs = ['-p', 'hello'];

    const spawnable = spawnableModule.toSpawnable(exe, callerArgs);

    expect(spawnable).toEqual({ file: exe, args: ['-p', 'hello'], shell: null });
  });
});

describe('toSpawnable on Windows (where.exe ranking, stubbed)', () => {
  beforeEach(() => {
    setPlatform('win32');
  });

  it('asks where.exe for the bare name it was given', () => {
    lookupReturns(`${NPM_DIRECTORY}\\claude.cmd\r\n`);

    spawnableModule.toSpawnable('claude', []);

    expect(lookupCalls).toHaveLength(1);
    expect(lookupCalls[0].file).toBe('where.exe');
    expect(lookupCalls[0].args).toEqual(['claude']);
  });

  it('prefers a native .exe over every shim, whatever order where.exe lists them in', () => {
    // The extensionless shell script first, .ps1 before .cmd, .exe last: the worst order for a
    // chooser that takes the first line or ranks the shims the wrong way round.
    lookupReturns([
      `${NPM_DIRECTORY}\\claude`,
      `${NPM_DIRECTORY}\\claude.ps1`,
      `${NPM_DIRECTORY}\\claude.cmd`,
      'C:\\Tools\\claude.exe',
      '',
    ].join('\r\n') + '\r\n');

    const spawnable = spawnableModule.toSpawnable('claude', ['--resume', 'abc']);

    expect(spawnable).toEqual({ file: 'C:\\Tools\\claude.exe', args: ['--resume', 'abc'], shell: null });
  });

  it('prefers .cmd over .ps1 and over the extensionless script, and wraps it in cmd.exe', () => {
    lookupReturns([
      `${NPM_DIRECTORY}\\claude`,
      `${NPM_DIRECTORY}\\claude.ps1`,
      `${NPM_DIRECTORY}\\claude.cmd`,
    ].join('\r\n') + '\r\n');

    const spawnable = spawnableModule.toSpawnable('claude', ['--resume', 'abc']);

    expect(spawnable).toEqual({
      file: 'cmd.exe',
      args: ['/d', '/c', `${NPM_DIRECTORY}\\claude.cmd`, '--resume', 'abc'],
      shell: 'cmd',
    });
  });

  it('takes .ps1 over the extensionless script when there is no .exe or .cmd, and wraps it in powershell', () => {
    lookupReturns(`${NPM_DIRECTORY}\\claude\r\n${NPM_DIRECTORY}\\claude.ps1\r\n`);

    const spawnable = spawnableModule.toSpawnable('claude', ['--resume', 'abc']);

    expect(spawnable).toEqual({
      file: 'powershell.exe',
      args: [...POWERSHELL_FLAGS, `${NPM_DIRECTORY}\\claude.ps1`, '--resume', 'abc'],
      shell: 'powershell',
    });
  });

  it('ranks .bat with .cmd, ahead of the extensionless script, and wraps it in cmd.exe', () => {
    lookupReturns('C:\\bin\\tool\r\nC:\\bin\\tool.bat\r\n');

    const spawnable = spawnableModule.toSpawnable('tool', []);

    expect(spawnable).toEqual({ file: 'cmd.exe', args: ['/d', '/c', 'C:\\bin\\tool.bat'], shell: 'cmd' });
  });

  it('ranks extensions case-insensitively', () => {
    lookupReturns('C:\\bin\\tool.PS1\r\nC:\\bin\\tool.CMD\r\n');

    const spawnable = spawnableModule.toSpawnable('tool', []);

    expect(spawnable).toEqual({ file: 'cmd.exe', args: ['/d', '/c', 'C:\\bin\\tool.CMD'], shell: 'cmd' });
  });

  it('keeps PATH order between candidates of the same rank', () => {
    lookupReturns('C:\\first\\tool.cmd\r\nC:\\second\\tool.cmd\r\n');

    const spawnable = spawnableModule.toSpawnable('tool', []);

    expect(spawnable.args[2]).toBe('C:\\first\\tool.cmd');
  });

  it.each(['\r\n', '\n'])('trims each line and ignores blank ones, with %j line endings', (separator) => {
    lookupReturns(['', '   ', '  C:\\bin\\tool.cmd  ', '', ''].join(separator));

    const spawnable = spawnableModule.toSpawnable('tool', []);

    expect(spawnable).toEqual({ file: 'cmd.exe', args: ['/d', '/c', 'C:\\bin\\tool.cmd'], shell: 'cmd' });
  });

  it('throws "Could not find <exe> on PATH" when where.exe exits non-zero', () => {
    lookupFails();

    expect(() => spawnableModule.toSpawnable('some-tool', [])).toThrow('Could not find some-tool on PATH');
  });

  it('throws the same error when where.exe prints nothing', () => {
    lookupReturns('');

    expect(() => spawnableModule.toSpawnable('some-tool', [])).toThrow('Could not find some-tool on PATH');
  });

  it('throws the same error when where.exe prints only blank lines', () => {
    lookupReturns('\r\n   \r\n\r\n');

    expect(() => spawnableModule.toSpawnable('some-tool', [])).toThrow('Could not find some-tool on PATH');
  });
});

describe('shellReparsedArgument', () => {
  const CMD_REPARSED = ['%', '"', '^', '&', '|', '<', '>', '\r', '\n'];
  const POWERSHELL_REPARSED = ['"', '$', '`', '\r', '\n'];
  const cmdSpawnable = (args: string[]): Spawnable => ({ file: 'cmd.exe', args, shell: 'cmd' });
  const powershellSpawnable = (args: string[]): Spawnable => ({ file: 'powershell.exe', args, shell: 'powershell' });

  it('returns null for a spawnable that starts directly, whatever its arguments hold', () => {
    const direct: Spawnable = { file: 'claude', args: ['50%', '"quoted"', '$HOME', '`tick`', 'a&b', 'line\nbreak'], shell: null };

    expect(spawnableModule.shellReparsedArgument(direct)).toBeNull();
  });

  describe('cmd', () => {
    it.each(CMD_REPARSED)('flags an argument containing %j', (character) => {
      const offending = `before${character}after`;

      expect(spawnableModule.shellReparsedArgument(cmdSpawnable(['--flag', offending]))).toBe(offending);
    });

    it.each(['$', '`'])('does not flag %j, which only powershell re-parses', (character) => {
      expect(spawnableModule.shellReparsedArgument(cmdSpawnable([`before${character}after`]))).toBeNull();
    });

    it('returns null when no argument would be re-parsed, and null (not undefined) for no arguments', () => {
      const clean = ['/d', '/c', 'C:\\Users\\dev\\tool.cmd', '--model', 'sonnet-4', "it's", 'a b', '--flag=value', '-p', ''];

      expect(spawnableModule.shellReparsedArgument(cmdSpawnable(clean))).toBeNull();
      expect(spawnableModule.shellReparsedArgument(cmdSpawnable([]))).toBeNull();
    });

    it('returns the FIRST offending argument, not a later one', () => {
      expect(spawnableModule.shellReparsedArgument(cmdSpawnable(['clean', 'first&bad', 'second|bad']))).toBe('first&bad');
    });

    // cmd.exe's /c strips the first and last quote of a line that opens with one and holds more
    // than two, so a quoted shim path loses its quotes as soon as another argument is quoted.
    describe('a shim path Node has to quote', () => {
      const spacedShim = 'C:\\Users\\dev\\Program Files\\npm\\claude.cmd';

      it.each([
        ['an argument with a space', ['-p', 'Title: a prompt']],
        ['an argument with a tab', ['-p', 'Title:\ta prompt']],
        ['an empty argument', ['-p', '']],
      ])('is flagged when the caller passes %s', (_label, callerArgs) => {
        expect(spawnableModule.shellReparsedArgument(cmdSpawnable(['/d', '/c', spacedShim, ...callerArgs]))).toBe(spacedShim);
      });

      it('is not flagged when no caller argument is quoted, which cmd.exe runs as written', () => {
        expect(spawnableModule.shellReparsedArgument(cmdSpawnable(['/d', '/c', spacedShim, '--version']))).toBeNull();
      });

      it('is not flagged for a powershell shim, whose -File keeps its quotes', () => {
        const spacedScript = 'C:\\Users\\dev\\Program Files\\npm\\claude.ps1';

        expect(spawnableModule.shellReparsedArgument(powershellSpawnable([...POWERSHELL_FLAGS, spacedScript, '-p', 'Title: a prompt']))).toBeNull();
      });
    });
  });

  describe('powershell', () => {
    it.each(POWERSHELL_REPARSED)('flags an argument containing %j', (character) => {
      const offending = `before${character}after`;

      expect(spawnableModule.shellReparsedArgument(powershellSpawnable(['--flag', offending]))).toBe(offending);
    });

    it.each(['%', '^', '&', '|', '<', '>'])('does not flag %j, which only cmd re-parses', (character) => {
      expect(spawnableModule.shellReparsedArgument(powershellSpawnable([`before${character}after`]))).toBeNull();
    });

    it('returns null when no argument would be re-parsed, and null (not undefined) for no arguments', () => {
      const clean = [...POWERSHELL_FLAGS, 'C:\\Users\\dev\\tool.ps1', '--model', 'sonnet-4', "it's", 'a b', '50%', 'a&b'];

      expect(spawnableModule.shellReparsedArgument(powershellSpawnable(clean))).toBeNull();
      expect(spawnableModule.shellReparsedArgument(powershellSpawnable([]))).toBeNull();
    });

    it('returns the FIRST offending argument, not a later one', () => {
      expect(spawnableModule.shellReparsedArgument(powershellSpawnable(['clean', 'first$bad', 'second"bad']))).toBe('first$bad');
    });
  });

  describe('on a spawnable built by toSpawnable', () => {
    beforeEach(() => {
      setPlatform('linux');
    });

    it('does not trip on the interpreter flags it adds itself', () => {
      expect(spawnableModule.shellReparsedArgument(spawnableModule.toSpawnable('shim.cmd', ['-p', 'hello']))).toBeNull();
      expect(spawnableModule.shellReparsedArgument(spawnableModule.toSpawnable('shim.ps1', ['-p', 'hello']))).toBeNull();
    });

    it('names the caller argument its shim would re-parse', () => {
      expect(spawnableModule.shellReparsedArgument(spawnableModule.toSpawnable('shim.cmd', ['-p', '50% done']))).toBe('50% done');
      expect(spawnableModule.shellReparsedArgument(spawnableModule.toSpawnable('shim.ps1', ['-p', 'cost $5']))).toBe('cost $5');
    });

    it('ignores a character the shim does not re-parse, and every character for a direct start', () => {
      expect(spawnableModule.shellReparsedArgument(spawnableModule.toSpawnable('shim.cmd', ['cost $5']))).toBeNull();
      expect(spawnableModule.shellReparsedArgument(spawnableModule.toSpawnable('shim.ps1', ['50% done']))).toBeNull();
      expect(spawnableModule.shellReparsedArgument(spawnableModule.toSpawnable('claude', ['50% "done" $5']))).toBeNull();
    });

    it('names the shim path itself when it holds a space and a caller argument is quoted', () => {
      const spacedShim = '/opt/Program Files/claude.cmd';

      expect(spawnableModule.shellReparsedArgument(spawnableModule.toSpawnable(spacedShim, ['-p', 'Title: a prompt']))).toBe(spacedShim);
    });
  });
});

describe('childAgentEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('drops the variables a Claude Code session sets for itself and keeps the rest', () => {
    vi.stubEnv('CLAUDECODE', '1');
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', 'cli');
    vi.stubEnv('CLAUDE_CODE_SSE_PORT', '12345');
    vi.stubEnv('CLAUDE_CONFIG_NOTE', 'kept: not a CLAUDE_CODE_ variable');
    vi.stubEnv('SPAWNABLE_TEST_MARKER', 'kept');

    const env = spawnableModule.childAgentEnv();

    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(env.CLAUDE_CODE_SSE_PORT).toBeUndefined();
    expect(env.CLAUDE_CONFIG_NOTE).toBe('kept: not a CLAUDE_CODE_ variable');
    expect(env.SPAWNABLE_TEST_MARKER).toBe('kept');
  });

  it('returns a copy, so a caller editing it leaves process.env alone', () => {
    vi.stubEnv('SPAWNABLE_TEST_MARKER', 'original');

    const env = spawnableModule.childAgentEnv();
    env.SPAWNABLE_TEST_MARKER = 'edited';

    expect(process.env.SPAWNABLE_TEST_MARKER).toBe('original');
  });
});
