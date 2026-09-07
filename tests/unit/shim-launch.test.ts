/**
 * Unit tests for resolveShimLaunch (src/main/agent/shared/shim-launch.ts),
 * the spawn-chokepoint step that keeps a multi-line prompt intact when an
 * npm-installed agent CLI resolved to its Windows `.cmd` shim (#353).
 *
 * Every dependency is injected, so each case runs on Linux CI without a
 * Windows host, a real shim, or a PowerShell process. The real chain (real
 * PowerShell 5.1 / 7 and Git Bash driving real npm-format shims) is proven by
 * tests/unit/windows-cmd-shim-multiline-prompt.test.ts on Windows.
 *
 * Red-green: dropping the extension gate fails the "never touches the
 * filesystem" cases; keying the probe cache globally instead of per shell
 * fails the two-host case; deriving the sibling with posix path.join fails the
 * backslash case on Linux; forgetting to flatten on the fallback fails the
 * no-sibling and blocked-policy cases.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  resolveShimLaunch,
  resetShimLaunchCacheForTests,
  isWindowsBatchShim,
  shimSibling,
  executionPolicyAllowsScripts,
  probeExecutionPolicy,
  type ShimLaunchDependencies,
} from '../../src/main/agent/shared/shim-launch';
import { buildTaskXml } from '../../src/main/agent/shared/prompt-xml';
import { sanitizeForPty } from '../../src/shared/paths';

// The probe is the module's only child-process access. execFile is replaced
// through its promisify.custom hook because the module awaits
// `promisify(execFile)`, which resolves `{ stdout, stderr }` only through that
// hook (a plain callback mock would resolve the bare stdout string).
const execFileProbe = vi.hoisted(() => ({
  calls: [] as Array<{ file: string; args: readonly string[]; options: Record<string, unknown> }>,
  result: { stdout: 'RemoteSigned\r\n', stderr: '' } as { stdout: string; stderr: string } | Error,
}));

vi.mock('node:child_process', () => {
  const promisified = async (file: string, args: readonly string[], options: Record<string, unknown>) => {
    execFileProbe.calls.push({ file, args, options });
    if (execFileProbe.result instanceof Error) throw execFileProbe.result;
    return execFileProbe.result;
  };
  const execFile = Object.assign(
    () => {
      throw new Error('shim-launch never uses the callback form of execFile');
    },
    { [Symbol.for('nodejs.util.promisify.custom')]: promisified },
  );
  return { execFile };
});

const CMD_HEAD = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.CMD';
const PS1_SIBLING = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.ps1';
const SH_SIBLING = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\codex';
const SECOND_CMD_HEAD = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\gemini.cmd';
const PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';
const CMD_EXE = 'C:\\Windows\\System32\\cmd.exe';
const WSL = 'wsl -d Ubuntu';
const NATIVE_EXE = 'C:\\Users\\dev\\.local\\bin\\claude.exe';
const EXTENSIONLESS_HEAD = 'C:\\Users\\dev\\.local\\bin\\claude';

// The real producer, so line 1 is exactly `<task>`: the line the bug left behind.
const MULTILINE_PROMPT = buildTaskXml({ title: 'Fix login', description: 'Step 1.\n\nStep 2.' });

function makeDependencies(overrides: Partial<ShimLaunchDependencies> = {}) {
  return {
    platform: 'win32' as NodeJS.Platform,
    fileExists: vi.fn((candidatePath: string) => candidatePath === PS1_SIBLING || candidatePath === SH_SIBLING),
    readFileHead: vi.fn(() => '#!/bin/sh'),
    probeExecutionPolicy: vi.fn(async (): Promise<string | null> => 'RemoteSigned'),
    warn: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  resetShimLaunchCacheForTests();
  execFileProbe.calls.length = 0;
  execFileProbe.result = { stdout: 'RemoteSigned\r\n', stderr: '' };
});

describe('resolveShimLaunch: inputs that never rewrite', () => {
  it.each([
    ['linux', PWSH, CMD_HEAD, 'a .CMD head under pwsh on linux'],
    ['darwin', PWSH, CMD_HEAD, 'a .CMD head under pwsh on darwin'],
    ['win32', CMD_EXE, CMD_HEAD, 'a cmd.exe host (quoteArg already flattens for it)'],
    ['win32', WSL, CMD_HEAD, 'a WSL host (cannot launch a .cmd at all; documented)'],
    ['win32', PWSH, NATIVE_EXE, 'a native .exe head'],
    ['win32', PWSH, EXTENSIONLESS_HEAD, 'an extensionless head'],
    ['win32', undefined, CMD_HEAD, 'an undefined shell'],
  ] as const)('leaves %s / %s / %s untouched (%s)', async (platform, shell, agentPath) => {
    const dependencies = makeDependencies({ platform });

    const result = await resolveShimLaunch({ agentPath, shell, prompt: MULTILINE_PROMPT }, dependencies);

    expect(result.agentPath).toBe(agentPath);
    expect(result.prompt).toBe(MULTILINE_PROMPT);
    expect(result.strategy).toBe('unchanged');
    // The gates come first, so no filesystem or process access on this path.
    expect(dependencies.fileExists).not.toHaveBeenCalled();
    expect(dependencies.readFileHead).not.toHaveBeenCalled();
    expect(dependencies.probeExecutionPolicy).not.toHaveBeenCalled();
    expect(dependencies.warn).not.toHaveBeenCalled();
  });
});

describe('resolveShimLaunch: PowerShell host with a batch shim head', () => {
  it('swaps a .CMD head for its .ps1 sibling under pwsh when the sibling exists and the policy allows scripts', async () => {
    const dependencies = makeDependencies();

    const result = await resolveShimLaunch({ agentPath: CMD_HEAD, shell: PWSH, prompt: MULTILINE_PROMPT }, dependencies);

    expect(result.agentPath).toBe(PS1_SIBLING);
    expect(result.prompt).toBe(MULTILINE_PROMPT);
    expect(result.strategy).toBe('ps1-sibling');
    expect(dependencies.warn).not.toHaveBeenCalled();
  });

  it.each(['RemoteSigned', 'Unrestricted', 'Bypass'])('treats the %s policy as permissive', async (policy) => {
    const dependencies = makeDependencies({ probeExecutionPolicy: vi.fn(async () => policy) });

    const result = await resolveShimLaunch({ agentPath: CMD_HEAD, shell: PWSH, prompt: MULTILINE_PROMPT }, dependencies);

    expect(result.strategy).toBe('ps1-sibling');
  });

  it('normalises probe output (surrounding whitespace, mixed case) before comparing', async () => {
    const dependencies = makeDependencies({ probeExecutionPolicy: vi.fn(async () => '  remotesigned\r\n') });

    const result = await resolveShimLaunch({ agentPath: CMD_HEAD, shell: PWSH, prompt: MULTILINE_PROMPT }, dependencies);

    expect(result.strategy).toBe('ps1-sibling');
  });

  it.each([
    ['the pwsh 7 full path', PWSH],
    ['the Windows PowerShell 5.1 full path', POWERSHELL],
    ['a bare powershell name', 'powershell'],
    ['a bare pwsh name', 'pwsh'],
  ])('swaps under %s', async (_label, shell) => {
    const result = await resolveShimLaunch({ agentPath: CMD_HEAD, shell, prompt: MULTILINE_PROMPT }, makeDependencies());

    expect(result.agentPath).toBe(PS1_SIBLING);
    expect(result.strategy).toBe('ps1-sibling');
  });

  it.each(['.cmd', '.Cmd', '.CMD', '.bat', '.BAT'])('matches the %s extension case-insensitively', async (extension) => {
    const agentPath = `C:\\Users\\dev\\AppData\\Roaming\\npm\\codex${extension}`;
    const dependencies = makeDependencies();

    const result = await resolveShimLaunch({ agentPath, shell: PWSH, prompt: MULTILINE_PROMPT }, dependencies);

    expect(dependencies.fileExists).toHaveBeenCalledWith(PS1_SIBLING);
    expect(result.agentPath).toBe(PS1_SIBLING);
  });

  it('derives the sibling with the original backslash separators intact', async () => {
    // On Linux CI `path` is posix, so a path.join-based derivation would hand
    // fileExists a mangled string. The exact expected string is the guard.
    const dependencies = makeDependencies();

    await resolveShimLaunch({ agentPath: CMD_HEAD, shell: PWSH, prompt: MULTILINE_PROMPT }, dependencies);

    expect(dependencies.fileExists).toHaveBeenCalledTimes(1);
    expect(dependencies.fileExists).toHaveBeenCalledWith(PS1_SIBLING);
  });

  it('keeps the .cmd head and flattens the prompt when no .ps1 sibling exists', async () => {
    const dependencies = makeDependencies({ fileExists: vi.fn(() => false) });

    const result = await resolveShimLaunch({ agentPath: CMD_HEAD, shell: PWSH, prompt: MULTILINE_PROMPT }, dependencies);

    expect(result.agentPath).toBe(CMD_HEAD);
    expect(result.prompt).toBe(sanitizeForPty(MULTILINE_PROMPT));
    expect(result.prompt).not.toContain('\n');
    expect(result.prompt).toContain('<title>Fix login</title>');
    expect(result.strategy).toBe('flattened-prompt');
    // Nothing to probe when there is no script to run.
    expect(dependencies.probeExecutionPolicy).not.toHaveBeenCalled();
    expect(dependencies.warn).toHaveBeenCalledTimes(1);
    const message = dependencies.warn.mock.calls[0][0];
    expect(message).toContain(CMD_HEAD);
    expect(message).toContain(PS1_SIBLING);
  });

  it.each([
    ['Restricted', 'Restricted'],
    ['AllSigned', 'AllSigned'],
    ['Undefined', 'Undefined'],
    ['a null (failed) probe', null],
  ])('keeps the .cmd head and flattens the prompt when the policy is %s', async (_label, policy) => {
    const dependencies = makeDependencies({ probeExecutionPolicy: vi.fn(async () => policy) });

    const result = await resolveShimLaunch({ agentPath: CMD_HEAD, shell: PWSH, prompt: MULTILINE_PROMPT }, dependencies);

    expect(result.agentPath).toBe(CMD_HEAD);
    expect(result.prompt).toBe(sanitizeForPty(MULTILINE_PROMPT));
    expect(result.strategy).toBe('flattened-prompt');
    expect(dependencies.warn).toHaveBeenCalledTimes(1);
    const message = dependencies.warn.mock.calls[0][0];
    expect(message).toContain(PS1_SIBLING);
    expect(message).toContain('Set-ExecutionPolicy RemoteSigned -Scope CurrentUser');
  });

  it('keeps the .cmd head and flattens the prompt when the probe rejects', async () => {
    const dependencies = makeDependencies({
      probeExecutionPolicy: vi.fn(async () => {
        throw new Error('spawn pwsh ENOENT');
      }),
    });

    const result = await resolveShimLaunch({ agentPath: CMD_HEAD, shell: PWSH, prompt: MULTILINE_PROMPT }, dependencies);

    expect(result.agentPath).toBe(CMD_HEAD);
    expect(result.strategy).toBe('flattened-prompt');
  });

  it('leaves an undefined prompt undefined on the flatten path and does not warn about it', async () => {
    // A resume or a Command Terminal carries no prompt, so nothing is degraded.
    const dependencies = makeDependencies({ fileExists: vi.fn(() => false) });

    const result = await resolveShimLaunch({ agentPath: CMD_HEAD, shell: PWSH, prompt: undefined }, dependencies);

    expect(result.agentPath).toBe(CMD_HEAD);
    expect(result.prompt).toBeUndefined();
    expect(result.strategy).toBe('flattened-prompt');
    expect(dependencies.warn).not.toHaveBeenCalled();
  });

  it('leaves an undefined prompt undefined on the .ps1 path', async () => {
    const result = await resolveShimLaunch({ agentPath: CMD_HEAD, shell: PWSH, prompt: undefined }, makeDependencies());

    expect(result.agentPath).toBe(PS1_SIBLING);
    expect(result.prompt).toBeUndefined();
  });

  it('never sanitises on the .ps1 path: backticks, dollar signs and blank lines come back by reference', async () => {
    const prompt = '<task>\n  <title>Use `code` and $HOME</title>\n\n\n</task>';

    const result = await resolveShimLaunch({ agentPath: CMD_HEAD, shell: PWSH, prompt }, makeDependencies());

    expect(result.prompt).toBe(prompt);
  });
});

describe('resolveShimLaunch: Git Bash host with a batch shim head', () => {
  it('swaps a .CMD head for its extensionless sh sibling when it exists and starts with a shebang', async () => {
    const dependencies = makeDependencies();

    const result = await resolveShimLaunch({ agentPath: CMD_HEAD, shell: GIT_BASH, prompt: MULTILINE_PROMPT }, dependencies);

    expect(result.agentPath).toBe(SH_SIBLING);
    expect(result.prompt).toBe(MULTILINE_PROMPT);
    expect(result.strategy).toBe('sh-sibling');
    expect(dependencies.fileExists).toHaveBeenCalledWith(SH_SIBLING);
    expect(dependencies.readFileHead).toHaveBeenCalledWith(SH_SIBLING);
    // No execution policy on this route.
    expect(dependencies.probeExecutionPolicy).not.toHaveBeenCalled();
    expect(dependencies.warn).not.toHaveBeenCalled();
  });

  it('keeps the .cmd head and flattens the prompt when the extensionless sibling has no shebang', async () => {
    const dependencies = makeDependencies({ readFileHead: vi.fn(() => 'MZ') });

    const result = await resolveShimLaunch({ agentPath: CMD_HEAD, shell: GIT_BASH, prompt: MULTILINE_PROMPT }, dependencies);

    expect(result.agentPath).toBe(CMD_HEAD);
    expect(result.prompt).toBe(sanitizeForPty(MULTILINE_PROMPT));
    expect(result.strategy).toBe('flattened-prompt');
    expect(dependencies.warn).toHaveBeenCalledTimes(1);
  });

  it('keeps the .cmd head and flattens the prompt when the extensionless sibling is missing', async () => {
    const dependencies = makeDependencies({ fileExists: vi.fn(() => false) });

    const result = await resolveShimLaunch({ agentPath: CMD_HEAD, shell: GIT_BASH, prompt: MULTILINE_PROMPT }, dependencies);

    expect(result.agentPath).toBe(CMD_HEAD);
    expect(result.strategy).toBe('flattened-prompt');
    expect(dependencies.readFileHead).not.toHaveBeenCalled();
    expect(dependencies.warn.mock.calls[0][0]).toContain(SH_SIBLING);
  });
});

describe('resolveShimLaunch: warn-once and per-shell policy cache', () => {
  it('warns exactly once per agent path when falling back, across repeated spawns', async () => {
    const dependencies = makeDependencies({ fileExists: vi.fn(() => false) });

    for (let spawnIndex = 0; spawnIndex < 3; spawnIndex += 1) {
      await resolveShimLaunch({ agentPath: CMD_HEAD, shell: PWSH, prompt: MULTILINE_PROMPT }, dependencies);
    }

    expect(dependencies.warn).toHaveBeenCalledTimes(1);
  });

  it('warns separately for a second agent path on the same shell', async () => {
    const dependencies = makeDependencies({ fileExists: vi.fn(() => false) });

    await resolveShimLaunch({ agentPath: CMD_HEAD, shell: PWSH, prompt: MULTILINE_PROMPT }, dependencies);
    await resolveShimLaunch({ agentPath: SECOND_CMD_HEAD, shell: PWSH, prompt: MULTILINE_PROMPT }, dependencies);

    expect(dependencies.warn).toHaveBeenCalledTimes(2);
    expect(dependencies.warn.mock.calls[1][0]).toContain(SECOND_CMD_HEAD);
  });

  it('probes the execution policy once per shell and serves later spawns from the cache', async () => {
    const dependencies = makeDependencies({ fileExists: vi.fn((candidatePath: string) => candidatePath.endsWith('.ps1')) });

    await resolveShimLaunch({ agentPath: CMD_HEAD, shell: PWSH, prompt: MULTILINE_PROMPT }, dependencies);
    await resolveShimLaunch({ agentPath: SECOND_CMD_HEAD, shell: PWSH, prompt: MULTILINE_PROMPT }, dependencies);

    expect(dependencies.probeExecutionPolicy).toHaveBeenCalledTimes(1);
  });

  it('keys the cache by shell, so pwsh and powershell.exe each get their own probe', async () => {
    // Windows PowerShell 5.1 and pwsh 7 keep separate execution policies
    // (5.1 defaults to Restricted on client editions, pwsh to RemoteSigned).
    const dependencies = makeDependencies();

    await resolveShimLaunch({ agentPath: CMD_HEAD, shell: PWSH, prompt: MULTILINE_PROMPT }, dependencies);
    await resolveShimLaunch({ agentPath: CMD_HEAD, shell: POWERSHELL, prompt: MULTILINE_PROMPT }, dependencies);

    expect(dependencies.probeExecutionPolicy).toHaveBeenCalledTimes(2);
    expect(dependencies.probeExecutionPolicy).toHaveBeenCalledWith(PWSH);
    expect(dependencies.probeExecutionPolicy).toHaveBeenCalledWith(POWERSHELL);
  });

  it('caches a failed probe for the process lifetime so a hung host does not delay every later spawn', async () => {
    const failingProbe = vi.fn(async (): Promise<string | null> => null);
    const permissiveProbe = vi.fn(async (): Promise<string | null> => 'RemoteSigned');

    const first = await resolveShimLaunch(
      { agentPath: CMD_HEAD, shell: PWSH, prompt: MULTILINE_PROMPT },
      makeDependencies({ probeExecutionPolicy: failingProbe }),
    );
    const second = await resolveShimLaunch(
      { agentPath: CMD_HEAD, shell: PWSH, prompt: MULTILINE_PROMPT },
      makeDependencies({ probeExecutionPolicy: permissiveProbe }),
    );

    expect(first.strategy).toBe('flattened-prompt');
    expect(second.strategy).toBe('flattened-prompt');
    expect(failingProbe).toHaveBeenCalledTimes(1);
    expect(permissiveProbe).not.toHaveBeenCalled();
  });

  it('resetShimLaunchCacheForTests clears both the policy cache and the warned set', async () => {
    const dependencies = makeDependencies({ probeExecutionPolicy: vi.fn(async () => 'Restricted') });

    await resolveShimLaunch({ agentPath: CMD_HEAD, shell: PWSH, prompt: MULTILINE_PROMPT }, dependencies);
    resetShimLaunchCacheForTests();
    await resolveShimLaunch({ agentPath: CMD_HEAD, shell: PWSH, prompt: MULTILINE_PROMPT }, dependencies);

    expect(dependencies.probeExecutionPolicy).toHaveBeenCalledTimes(2);
    expect(dependencies.warn).toHaveBeenCalledTimes(2);
  });
});

describe('shim-launch helpers', () => {
  it('isWindowsBatchShim matches .cmd and .bat in any case and nothing else', () => {
    expect(isWindowsBatchShim(CMD_HEAD)).toBe(true);
    expect(isWindowsBatchShim('C:\\npm\\gemini.cmd')).toBe(true);
    expect(isWindowsBatchShim('C:\\tools\\agent.bat')).toBe(true);
    expect(isWindowsBatchShim('C:\\tools\\agent.BAT')).toBe(true);

    expect(isWindowsBatchShim(NATIVE_EXE)).toBe(false);
    expect(isWindowsBatchShim(PS1_SIBLING)).toBe(false);
    expect(isWindowsBatchShim(EXTENSIONLESS_HEAD)).toBe(false);
    // A directory named like a shim does not make its extensionless child one.
    expect(isWindowsBatchShim('C:\\tools.cmd\\agent')).toBe(false);
  });

  it('shimSibling swaps only the final extension and keeps the base name, case, and separators', () => {
    expect(shimSibling(CMD_HEAD, '.ps1')).toBe(PS1_SIBLING);
    expect(shimSibling(CMD_HEAD, '')).toBe(SH_SIBLING);
    expect(shimSibling('C:/Users/dev/AppData/Roaming/npm/gemini.cmd', '.ps1')).toBe('C:/Users/dev/AppData/Roaming/npm/gemini.ps1');
    expect(shimSibling('C:\\tools.v2\\agent.bat', '')).toBe('C:\\tools.v2\\agent');
    expect(shimSibling('C:\\tools\\Cursor-Agent.CMD', '.ps1')).toBe('C:\\tools\\Cursor-Agent.ps1');
  });

  it('executionPolicyAllowsScripts accepts only the policies that run an unsigned local script', () => {
    expect(executionPolicyAllowsScripts('RemoteSigned')).toBe(true);
    expect(executionPolicyAllowsScripts('Unrestricted')).toBe(true);
    expect(executionPolicyAllowsScripts('Bypass')).toBe(true);
    expect(executionPolicyAllowsScripts('  bypass\r\n')).toBe(true);

    expect(executionPolicyAllowsScripts('Restricted')).toBe(false);
    expect(executionPolicyAllowsScripts('AllSigned')).toBe(false);
    expect(executionPolicyAllowsScripts('Undefined')).toBe(false);
    expect(executionPolicyAllowsScripts('')).toBe(false);
    expect(executionPolicyAllowsScripts(null)).toBe(false);
  });
});

describe('probeExecutionPolicy', () => {
  it('asks the host itself, hidden and with a timeout, and returns the trimmed policy name', async () => {
    const policy = await probeExecutionPolicy(PWSH);

    expect(policy).toBe('RemoteSigned');
    expect(execFileProbe.calls).toHaveLength(1);
    const call = execFileProbe.calls[0];
    // The same executable the PTY runs: 5.1 and 7 keep separate policies.
    expect(call.file).toBe(PWSH);
    expect(call.args).toEqual(['-NoProfile', '-NonInteractive', '-Command', 'Get-ExecutionPolicy']);
    expect(call.options).toMatchObject({ windowsHide: true, timeout: 5000 });
  });

  it('strips PSModulePath from the probe environment so a pwsh 7 ancestor cannot break 5.1 module autoload', async () => {
    // Measured: Windows PowerShell 5.1 launched under a PSModulePath that
    // lists pwsh 7's Modules directory fails to autoload the Security module
    // that owns Get-ExecutionPolicy, and the probe reported null on a Bypass
    // machine. Everything else in the environment must still pass through.
    const previous = process.env.PSModulePath;
    process.env.PSModulePath = 'C:\\Program Files\\PowerShell\\7\\Modules';
    process.env.KANGENTIC_PROBE_CANARY = 'kept';
    try {
      await probeExecutionPolicy(POWERSHELL);
    } finally {
      if (previous === undefined) delete process.env.PSModulePath;
      else process.env.PSModulePath = previous;
      delete process.env.KANGENTIC_PROBE_CANARY;
    }

    const environment = execFileProbe.calls[0].options.env as Record<string, string | undefined>;
    expect(environment).toBeDefined();
    expect(Object.keys(environment).map((name) => name.toLowerCase())).not.toContain('psmodulepath');
    expect(environment.KANGENTIC_PROBE_CANARY).toBe('kept');
  });

  it('resolves null when the host cannot be run', async () => {
    execFileProbe.result = new Error('spawn pwsh ENOENT');

    await expect(probeExecutionPolicy(PWSH)).resolves.toBeNull();
  });

  it('resolves null when the host prints nothing', async () => {
    execFileProbe.result = { stdout: '  \n', stderr: '' };

    await expect(probeExecutionPolicy(PWSH)).resolves.toBeNull();
  });
});
