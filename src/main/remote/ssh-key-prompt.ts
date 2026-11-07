/**
 * What `ssh` itself says when a key needs a passphrase (#913). Every Kangentic connection runs with
 * BatchMode, so a host whose key is passphrase-protected and not in an agent fails with the same
 * `Permission denied (publickey)` as a wrong key, and a user who sees only that cannot tell the two apart.
 * A terminal asks `Enter passphrase for key '...'`. The prompt is ssh's own text, so showing it adds no
 * wording of ours.
 *
 * To read it without ever asking anyone, the one failed attempt is repeated once with `SSH_ASKPASS` set to a
 * small helper and `SSH_ASKPASS_REQUIRE=force`, which makes ssh run the helper for any prompt even with no
 * terminal and no display. The helper writes the prompt it was given to a file and exits 1, so ssh gets no
 * answer and goes on to fail as it did. Nothing is installed: the helper is a few lines Kangentic writes into
 * the temporary folder for the attempt, as the password sign-in does (`askpassProgram`). An ssh older than 8.4
 * ignores `SSH_ASKPASS_REQUIRE` and runs no helper, so nothing is captured and the plain error stands.
 *
 * Imports nothing of electron.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SshRunner, SshRunnerConfig } from './link/ssh-run';

/** The environment variable that names the file the helper writes the prompt into. */
const PROMPT_FILE_VARIABLE = 'KANGENTIC_ASKPASS_PROMPT_FILE';

/** One attempt, bounded: ssh was already reached once, so this is a connect and a refusal. */
const CAPTURE_TIMEOUT_MS = 20_000;

/**
 * The program `ssh` runs for a prompt: it appends the prompt to the file and exits 1, which ssh reads as no answer.
 * On Windows the prompt passes through cmd, which would run an `&` in a key path as a second command: the value is
 * stored in a quoted `set` and printed through delayed expansion, which cmd does not parse again.
 */
export function captureAskpassProgram(platform: NodeJS.Platform): { fileName: string; content: string } {
  if (platform === 'win32') {
    return {
      fileName: 'askpass-capture.cmd',
      content: [
        '@echo off',
        'setlocal DisableDelayedExpansion',
        'set "PROMPT_TEXT=%~1"',
        'setlocal EnableDelayedExpansion',
        `>>"%${PROMPT_FILE_VARIABLE}%" echo(!PROMPT_TEXT!`,
        'exit /b 1',
        '',
      ].join('\r\n'),
    };
  }
  return {
    fileName: 'askpass-capture.sh',
    content: `#!/bin/sh\nprintf '%s\\n' "$1" >> "$${PROMPT_FILE_VARIABLE}"\nexit 1\n`,
  };
}

/**
 * The failed attempt's arguments, made to ask: no BatchMode, only the key sign-in, one try, and a host key that
 * must already be pinned (an unpinned host would put its host-key question through the helper and be read as
 * the prompt). The destination stays last.
 */
export function promptingArgs(args: readonly string[]): string[] {
  const destination = args[args.length - 1];
  const options: string[] = [];
  for (let index = 0; index < args.length - 1; index++) {
    if (args[index] === '-o' && args[index + 1] === 'BatchMode=yes') {
      index += 1;
      continue;
    }
    options.push(args[index]);
  }
  return [
    ...options,
    '-o', 'BatchMode=no',
    '-o', 'PreferredAuthentications=publickey',
    '-o', 'NumberOfPasswordPrompts=1',
    '-o', 'StrictHostKeyChecking=yes',
    destination,
  ];
}

export interface KeyPromptDeps {
  sshPath: string;
  createRunner: (config: SshRunnerConfig) => SshRunner;
  /** Where the helper and the prompt file live for the attempt. */
  temporaryDirectory?: string;
  platform?: NodeJS.Platform;
}

/**
 * The prompt lines `ssh` produced for a connection with these arguments, joined, or null when it asked for
 * nothing (a wrong key, a missing key, an ssh too old to run the helper) or could not be run. Never throws.
 */
export async function captureKeyPrompt(args: readonly string[], deps: KeyPromptDeps): Promise<string | null> {
  const scratch = path.join(deps.temporaryDirectory ?? os.tmpdir(), `kangentic-prompt-${randomBytes(6).toString('hex')}`);
  try {
    await fs.mkdir(scratch, { recursive: true, mode: 0o700 });
    const program = captureAskpassProgram(deps.platform ?? process.platform);
    const helper = path.join(scratch, program.fileName);
    const promptFile = path.join(scratch, 'prompt.txt');
    await fs.writeFile(helper, program.content, { mode: 0o700 });
    const run = deps.createRunner({
      sshPath: deps.sshPath,
      args: promptingArgs(args),
      env: {
        SSH_ASKPASS: helper,
        SSH_ASKPASS_REQUIRE: 'force',
        // Older clients only use a helper when a display is set.
        DISPLAY: process.env.DISPLAY ?? 'kangentic:0',
        [PROMPT_FILE_VARIABLE]: promptFile,
      },
    });
    await run('true', { timeoutMs: CAPTURE_TIMEOUT_MS });
    const lines = (await fs.readFile(promptFile, 'utf8')).split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
    const unique = [...new Set(lines)];
    return unique.length > 0 ? unique.join('\n') : null;
  } catch {
    return null;
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}
