/**
 * A Codex installed in a WSL distro (#286): named by the path the distro sees,
 * its working directory too, its hooks run the WSL hook transport's script
 * from a workspace copy (the command must be the same for every session, since
 * Codex trusts a hook by a hash of it), its hook trust is read from the distro's
 * own binary, and its directory trust goes in the distro's config.toml. Paths
 * here are built from the OS temp folder, so every expectation converts them
 * the way the code does.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexCommandBuilder } from '../../src/main/agent/adapters/codex/command-builder';
import { codexHookDefinitions } from '../../src/main/agent/adapters/codex/hook-manager';
import { readCodexHookTrust } from '../../src/main/agent/adapters/codex/hook-trust';
import { ensureWorktreeTrust } from '../../src/main/agent/adapters/codex/trust-manager';
import { codexHomeDir } from '../../src/main/agent/adapters/codex/config-toml';
import { cliPathForTarget, hostPathForTarget, type CliTarget } from '../../src/main/agent/shared/cli-target';
import { WSL_HOOK_SCRIPT, wslHookPaths } from '../../src/main/agent/shared/wsl-hook-transport';
import { quoteArg } from '../../src/shared/paths';
import type { CliChildProcess } from '../../src/main/utility-process/off-main-cli';

const SHELL = 'wsl -d Ubuntu';
let workspace: string;
let distroHome: string;
let target: CliTarget;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-codex-wsl-workspace-'));
  distroHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-codex-wsl-home-'));
  target = {
    kind: 'wsl',
    distro: 'Ubuntu',
    linuxCliPath: '/home/dev/.nvm/versions/node/v24.22.1/bin/codex',
    facts: {
      distro: 'Ubuntu', homeLinux: '/home/dev', homeUnc: distroHome, uncRoot: '\\\\wsl.localhost\\Ubuntu',
      interactivePath: '/usr/bin', env: {}, networkingMode: 'nat',
    },
  };
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(distroHome, { recursive: true, force: true });
});

describe('a Codex installed in a WSL distro: the command', () => {
  // Red-green: quoting `codexPath` fails the head; `toForwardSlash` for -C
  // fails on Windows; building the node hook overrides fails the hook
  // assertions; skipping the copy or the transport fails the file ones.
  it('runs by the distro path in the distro\'s view of its folder, with hooks through the transport script', () => {
    const sessionDirectory = path.join(workspace, '.kangentic', 'sessions', 'codex-wsl');
    const command = new CodexCommandBuilder().buildCodexCommand({
      codexPath: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\.nvm\\versions\\node\\v24.22.1\\bin\\codex',
      taskId: 'task-1',
      cwd: workspace,
      permissionMode: 'acceptEdits',
      shell: SHELL,
      eventsOutputPath: path.join(sessionDirectory, 'events.jsonl'),
      codexHookStateOverride: "hooks.state={'/x:stop:0:0'={trusted_hash='sha256:abc'}}",
      cliTarget: target,
    });

    expect(command.startsWith(quoteArg(target.linuxCliPath, SHELL))).toBe(true);
    expect(command).toContain(`-C ${quoteArg(cliPathForTarget(workspace, target), SHELL)}`);
    expect(command).toContain('sh .kangentic/codex-wsl-hook.sh event');
    expect(command).not.toContain('codex-event-bridge');
    expect(fs.readFileSync(path.join(workspace, '.kangentic', 'codex-wsl-hook.sh'), 'utf-8')).toBe(WSL_HOOK_SCRIPT);
    expect(fs.existsSync(wslHookPaths(sessionDirectory).signal)).toBe(true);
  });

  it('keeps every distro hook command to bare tokens, the same for every session', () => {
    const wsl = codexHookDefinitions('wsl');
    const node = codexHookDefinitions('node');
    expect(wsl).toHaveLength(node.length);
    wsl.forEach((definition, index) => {
      expect(definition.command).toMatch(/^sh \.kangentic\/codex-wsl-hook\.sh event /);
      // The same event and directives the node bridge is given.
      expect(definition.command.split(' ').slice(3)).toEqual(node[index].command.split(' ').slice(3));
    });
  });
});

describe('a Codex installed in a WSL distro: hook trust', () => {
  it('asks the distro\'s own binary, with its scratch home and folder in the distro\'s view', async () => {
    const definitions = codexHookDefinitions('wsl');
    const written: string[] = [];
    let spawned: { cwd: string; environment?: Record<string, string>; target?: CliTarget | null } | null = null;
    const stdout = Object.assign(new EventEmitter(), { resume: () => undefined });
    const stdin = Object.assign(new EventEmitter(), {
      write: (chunk: string) => {
        written.push(chunk);
        const message = JSON.parse(chunk) as { id?: number; method: string };
        if (message.id === 1) setImmediate(() => stdout.emit('data', Buffer.from(`${JSON.stringify({ id: 1, result: {} })}\n`)));
        if (message.id === 2) setImmediate(() => stdout.emit('data', Buffer.from(`${JSON.stringify({ id: 2, result: { data: [{ hooks: [], warnings: [], errors: [] }] } })}\n`)));
        return true;
      },
      end: () => undefined,
    });
    const child = Object.assign(new EventEmitter(), {
      exitCode: 0, signalCode: null, stdout, stderr: Object.assign(new EventEmitter(), { resume: () => undefined }), stdin, kill: () => true, stopTree: () => undefined,
    }) as unknown as CliChildProcess;

    await readCodexHookTrust('\\\\wsl.localhost\\Ubuntu\\codex', definitions, (_cliPath, _args, cwd, environment, spawnTarget) => {
      spawned = { cwd, environment, target: spawnTarget };
      return child;
    }, target);

    expect(spawned).not.toBeNull();
    expect(spawned!.target).toBe(target);
    expect(spawned!.environment?.CODEX_HOME).toBe(cliPathForTarget(path.join(path.dirname(spawned!.cwd), 'home'), target));
    const listRequest = JSON.parse(written[2]) as { params: { cwds: string[] } };
    expect(listRequest.params.cwds).toEqual([cliPathForTarget(spawned!.cwd, target)]);
    fs.rmSync(path.dirname(spawned!.cwd), { recursive: true, force: true });
  });
});

describe('a Codex installed in a WSL distro: directory trust', () => {
  // Red-green: writing this machine's config.toml, or the Windows path as the
  // key, fails these.
  it('trusts the folder in the distro\'s config.toml, keyed by the distro\'s view of it', async () => {
    await ensureWorktreeTrust(workspace, target);

    const written = fs.readFileSync(path.join(distroHome, '.codex', 'config.toml'), 'utf-8');
    expect(written).toContain(`[projects.'${cliPathForTarget(path.resolve(workspace), target)}']`);
    expect(written).toContain('trust_level = "trusted"');
  });

  it('follows the CODEX_HOME the distro\'s shell sets', () => {
    const withOverride = { ...target, facts: { ...target.facts, env: { CODEX_HOME: '/home/dev/.config/codex' } } };
    expect(codexHomeDir(withOverride)).toBe(hostPathForTarget('/home/dev/.config/codex', withOverride));
    expect(codexHomeDir(target)).toBe(path.join(distroHome, '.codex'));
  });
});
