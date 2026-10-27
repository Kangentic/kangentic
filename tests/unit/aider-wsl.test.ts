/**
 * An Aider installed in a WSL distro (#286): the session starts Aider's Linux
 * path, and Aider's idle notification publishes through the WSL hook transport.
 *
 * Aider runs its notifications command with `subprocess.run(command,
 * shell=True, capture_output=True)` and passes no stdin (aider/io.py
 * `ring_bell`), so the command inherits the terminal. The transport's `event`
 * mode reads its stdin into the record, so the command closes it: without
 * `</dev/null` the read waits on the user's keyboard and Aider never shows its
 * prompt. The last case runs the command's shape under a real `sh` with stdin
 * held open, which is what proves that.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AiderAdapter } from '../../src/main/agent/adapters/aider';
import { wslHookPaths, prepareWslHookTransport } from '../../src/main/agent/shared/wsl-hook-transport';
import type { CliTarget } from '../../src/main/agent/shared/cli-target';

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function makeSessionDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-aider-wsl-'));
  temporaryDirectories.push(directory);
  return directory;
}

const TARGET: CliTarget = {
  kind: 'wsl', distro: 'Ubuntu', linuxCliPath: '/home/dev/.local/bin/aider',
  facts: { distro: 'Ubuntu', homeLinux: '/home/dev', homeUnc: '\\\\wsl.localhost\\Ubuntu\\home\\dev', uncRoot: '\\\\wsl.localhost\\Ubuntu', interactivePath: '/usr/bin', env: {}, networkingMode: 'nat' },
};

describe('Aider in a WSL distro', () => {
  it('starts the Linux path and sends idle through the transport with stdin closed', () => {
    const sessionDirectory = makeSessionDirectory();
    const command = new AiderAdapter().buildCommand({
      agentPath: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\.local\\bin\\aider',
      taskId: 'task-1',
      cwd: sessionDirectory,
      permissionMode: 'default',
      shell: 'wsl -d Ubuntu',
      eventsOutputPath: path.join(sessionDirectory, 'events.jsonl'),
      cliTarget: TARGET,
    });

    expect(command.startsWith('/home/dev/.local/bin/aider ')).toBe(true);
    expect(command).toContain('--notifications --notifications-command ');
    expect(command).toMatch(/wsl-hook\.sh\W+ event idle <\/dev\/null'$/);
    expect(command).not.toContain('event-bridge.js');
    expect(fs.existsSync(wslHookPaths(sessionDirectory).signal)).toBe(true);
  });

  it('keeps the node bridge command on this machine', () => {
    const sessionDirectory = makeSessionDirectory();
    const command = new AiderAdapter().buildCommand({
      agentPath: '/usr/bin/aider',
      taskId: 'task-1',
      cwd: sessionDirectory,
      permissionMode: 'default',
      shell: 'bash',
      eventsOutputPath: path.join(sessionDirectory, 'events.jsonl'),
    });
    expect(command).toContain('event-bridge.js');
    expect(command).not.toContain('wsl-hook.sh');
    expect(fs.existsSync(wslHookPaths(sessionDirectory).directory)).toBe(false);
  });
});

const shAvailable = spawnSync('sh', ['-c', 'exit 0']).status === 0;

describe.runIf(shAvailable)('the notification command under a real sh (needs sh)', () => {
  // Red-green: without `</dev/null` this run waits on the open stdin until the
  // timeout, as Aider would wait on the user's keyboard.
  it('publishes the idle event and exits with the terminal still open on stdin', async () => {
    const sessionDirectory = makeSessionDirectory();
    const paths = prepareWslHookTransport(sessionDirectory);
    const scriptPath = paths.script.replace(/\\/g, '/');
    const child = spawn('sh', ['-c', `sh '${scriptPath}' event idle </dev/null`], { stdio: ['pipe', 'pipe', 'pipe'] });
    // stdin stays open, as a terminal does.
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => { child.kill(); resolve(null); }, 5_000);
      child.on('exit', (exitCode) => { clearTimeout(timer); resolve(exitCode); });
    });
    expect(code).toBe(0);
    const records = fs.readdirSync(paths.inbox).filter((name) => name.endsWith('.rec'));
    expect(records).toHaveLength(1);
    expect(fs.readFileSync(path.join(paths.inbox, records[0]), 'utf-8').split('\n').slice(0, 2)).toEqual(['K1', 'idle']);
  });
});

describe.skipIf(shAvailable)('the notification command under a real sh', () => {
  it.skip('needs sh on PATH (Git Bash on Windows); CI\'s Linux runner has it', () => undefined);
});
