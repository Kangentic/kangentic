/**
 * Reading ssh's own passphrase prompt for a refused sign-in (#913). BatchMode reports a passphrase-protected
 * key and a wrong key identically, so one repeated attempt runs with SSH_ASKPASS pointed at a helper that
 * records the prompt and refuses it. What a user loses if this breaks: a refusal that does not say the key
 * wants a passphrase (the reviewer's report), or an attempt that waits for input no one can give.
 *
 * The runner here stands in for ssh by running the helper it was given, the way ssh does for a prompt. The
 * helper is the real program, run by a real shell on each OS.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { captureAskpassProgram, captureKeyPrompt, promptingArgs } from '../../src/main/remote/ssh-key-prompt';
import type { SshRunner, SshRunnerConfig } from '../../src/main/remote/link/ssh-run';

const execFileAsync = promisify(execFile);

/** ssh asks for a passphrase by running the helper with the prompt as its one argument. */
async function runHelper(helper: string, prompt: string, env: NodeJS.ProcessEnv): Promise<void> {
  try {
    if (process.platform === 'win32') {
      // How ssh.exe starts it: one command line, the prompt quoted, nothing for cmd to split.
      // `/s` strips the outer pair of quotes, so the whole line is wrapped in one more.
      await execFileAsync('cmd.exe', ['/d', '/s', '/c', `""${helper}" "${prompt}""`], { env: { ...process.env, ...env }, windowsVerbatimArguments: true });
    } else {
      await execFileAsync(helper, [prompt], { env: { ...process.env, ...env } });
    }
  } catch {
    // The helper exits 1 on purpose: ssh gets no answer.
  }
}

function askingRunner(prompts: string[]): (config: SshRunnerConfig) => SshRunner {
  return (config) => async () => {
    const env = config.env ?? {};
    for (const prompt of prompts) await runHelper(String(env.SSH_ASKPASS), prompt, env);
    return { code: 255, stdout: '', stderr: 'dev@lab: Permission denied (publickey).' };
  };
}

describe('promptingArgs', () => {
  const connection = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ForwardAgent=no', 'dev@lab'];

  it('drops BatchMode, asks only for the key, once, against a pinned host key, and keeps the destination last', () => {
    expect(promptingArgs(connection)).toEqual([
      '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ForwardAgent=no',
      '-o', 'BatchMode=no',
      '-o', 'PreferredAuthentications=publickey',
      '-o', 'NumberOfPasswordPrompts=1',
      '-o', 'StrictHostKeyChecking=yes',
      'dev@lab',
    ]);
  });

  it('keeps a key file the connection names', () => {
    expect(promptingArgs([...connection.slice(0, -1), '-i', '/home/dev/.ssh/id', '-o', 'IdentitiesOnly=yes', 'dev@lab'])).toContain('/home/dev/.ssh/id');
  });
});

describe('captureAskpassProgram', () => {
  it('appends the prompt to the named file and refuses it, in a script sh runs', () => {
    const program = captureAskpassProgram('linux');
    expect(program.fileName).toBe('askpass-capture.sh');
    expect(program.content).toContain('>> "$KANGENTIC_ASKPASS_PROMPT_FILE"');
    expect(program.content).toContain('exit 1');
  });

  it('keeps cmd from parsing the prompt again on Windows, whose key path may hold an ampersand', () => {
    const program = captureAskpassProgram('win32');
    expect(program.fileName).toBe('askpass-capture.cmd');
    expect(program.content).toContain('set "PROMPT_TEXT=%~1"');
    expect(program.content).toContain('echo(!PROMPT_TEXT!');
    expect(program.content).toContain('exit /b 1');
  });
});

describe('captureKeyPrompt', () => {
  let scratch: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-key-prompt-test-'));
  });

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  const keyPrompt = (keyPath: string) => `Enter passphrase for key '${keyPath}': `;

  it('returns the prompt ssh asked, exactly as its text, and leaves nothing behind', async () => {
    const prompt = keyPrompt('/home/dev/.ssh/id_ed25519');
    const result = await captureKeyPrompt(['-o', 'BatchMode=yes', 'dev@lab'], {
      sshPath: 'ssh', createRunner: askingRunner([prompt]), temporaryDirectory: scratch,
    });

    expect(result).toBe(prompt.trim());
    expect(fs.readdirSync(scratch)).toEqual([]);
  });

  it('returns every prompt of a config that names more than one key, once each', async () => {
    const result = await captureKeyPrompt(['dev@lab'], {
      sshPath: 'ssh',
      createRunner: askingRunner([keyPrompt('/home/dev/.ssh/work'), keyPrompt('/home/dev/.ssh/lab'), keyPrompt('/home/dev/.ssh/work')]),
      temporaryDirectory: scratch,
    });

    expect(result).toBe(`${keyPrompt('/home/dev/.ssh/work').trim()}\n${keyPrompt('/home/dev/.ssh/lab').trim()}`);
  });

  it.runIf(process.platform === 'win32')('keeps a key path with an ampersand whole, and runs nothing it names', async () => {
    const prompt = keyPrompt('C:\\Users\\dev\\R&D\\id_ed25519');
    const result = await captureKeyPrompt(['dev@lab'], { sshPath: 'ssh', createRunner: askingRunner([prompt]), temporaryDirectory: scratch });

    expect(result).toBe(prompt.trim());
  });

  it('returns null when ssh asked for nothing, as a wrong key or a client too old to run the helper', async () => {
    const result = await captureKeyPrompt(['dev@lab'], { sshPath: 'ssh', createRunner: askingRunner([]), temporaryDirectory: scratch });

    expect(result).toBeNull();
    expect(fs.readdirSync(scratch)).toEqual([]);
  });

  it('returns null, and throws nothing, when ssh cannot be run', async () => {
    const result = await captureKeyPrompt(['dev@lab'], {
      sshPath: 'ssh',
      createRunner: () => async () => { throw new Error('spawn ssh ENOENT'); },
      temporaryDirectory: scratch,
    });

    expect(result).toBeNull();
    expect(fs.readdirSync(scratch)).toEqual([]);
  });

  it('runs ssh with the helper forced and the prompt file named, and never with BatchMode', async () => {
    let seen: SshRunnerConfig | null = null;
    await captureKeyPrompt(['-o', 'BatchMode=yes', 'dev@lab'], {
      sshPath: 'ssh',
      createRunner: (config) => { seen = config; return async () => ({ code: 255, stdout: '', stderr: '' }); },
      temporaryDirectory: scratch,
    });

    const config = seen as SshRunnerConfig | null;
    expect(config?.env?.SSH_ASKPASS_REQUIRE).toBe('force');
    expect(config?.env?.SSH_ASKPASS).toMatch(/askpass-capture\.(sh|cmd)$/);
    expect(config?.env?.KANGENTIC_ASKPASS_PROMPT_FILE).toMatch(/prompt\.txt$/);
    expect(config?.args).not.toContain('BatchMode=yes');
    expect(config?.args).toContain('BatchMode=no');
  });
});
