/**
 * A Codex CLI on a remote host over SSH (#913), run through the real adapter code and the real file
 * sync against a fake host (tests/unit/helpers/fake-ssh-host.ts). The host's `codex` and `sh` answer from
 * a script here, so it proves the files, the commands Kangentic runs on the host and the command it
 * builds, not that a real Codex accepts them or answers `app-server` as scripted. In particular the
 * read sends the whole `app-server` conversation as one input and reads the answer afterwards; whether
 * Codex answers a pipelined request before it sees the end of its input is not proven here.
 *
 * What a user loses if a test here fails:
 * - the trust tests: Codex stops at "Do you trust this directory?" on every session on the host, the
 *   user's own trust decisions in their config.toml are overwritten, or a deny is overruled.
 * - the hook trust tests: the session silently runs with no hooks (the board never sees it work), or it
 *   is given hooks Codex has not trusted and stops at the "Hooks need review" dialog.
 * - the command tests: Codex starts in a folder that exists only on this computer, has no Kangentic
 *   tools, or this computer's paths and the session token reach the host.
 * - the auto_command test: a command typed into a working session on a host is read as undelivered
 *   and the session is restarted.
 * - the session id test: a session on a host waits for rollout files that cannot be there.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAdapter } from '../../src/main/agent/adapters/codex';
import { readCodexHookTrustOnHost } from '../../src/main/agent/adapters/codex/hook-trust';
import { createCodexCommandInjectionVerifier } from '../../src/main/agent/adapters/codex/command-injection-verifier';
import { codexHookDefinitions } from '../../src/main/agent/adapters/codex/hook-manager';
import { CodexSessionHistoryParser } from '../../src/main/agent/adapters/codex/session-history-parser';
import { WSL_HOOK_SCRIPT } from '../../src/main/agent/shared/wsl-hook-transport';
import { settleHostFiles } from '../../src/main/remote/host-file-sync';
import type { HostCommandRequest, HostCommandResult } from '../../src/main/remote/protocol/messages';
import { toStoredCliTarget, type SshCliPlace } from '../../src/main/agent/shared/cli-target';
import { FakeSshHost, makeFakeSshWorkspace, type FakeSshWorkspace } from './helpers/fake-ssh-host';
import { MCP_TOKEN, SESSION_ID, expectNoLocalPaths, sessionFolders, spawnOnHost } from './ssh-adapter-spawn-harness';

const workspaces: FakeSshWorkspace[] = [];

afterEach(async () => {
  for (const workspace of workspaces.splice(0)) await workspace.dispose();
});

async function newWorkspace(): Promise<FakeSshWorkspace> {
  const workspace = await makeFakeSshWorkspace();
  workspaces.push(workspace);
  return workspace;
}

const TASK_TAG = '3f2a9c1e-7b64-4d2a-9c11-0a1b2c3d4e5f';
const SCRATCH ='/tmp/kangentic-codex-hooks-Ab12Cd';
const USER_CONFIG = 'model = "user-model"\n\n[projects.\'/srv/other\']\ntrust_level = "trusted"\n';

const configFile = (workspace: FakeSshWorkspace): string => `${workspace.hostHome}/.codex/config.toml`;
const hookScript = (workspace: FakeSshWorkspace): string => `${workspace.hostProject}/.kangentic/codex-wsl-hook.sh`;

function ok(stdout: string): HostCommandResult {
  return { code: 0, stdout, stderr: '', timedOut: false };
}

/** What Codex's `hooks/list` answers for exactly the hooks Kangentic passed, each with a hash of its own. */
function hooksListAnswer(): unknown {
  return {
    data: [{
      hooks: codexHookDefinitions('wsl').map((definition, index) => ({
        source: 'sessionFlags',
        key: `<session-flags>/config.toml:hook${index}:0:0`,
        currentHash: `sha256:${String(index).repeat(64)}`,
        command: definition.command,
        timeoutSec: definition.timeoutSeconds,
      })),
      errors: [],
      warnings: [],
    }],
  };
}

interface FakeCodex {
  appServerRuns: HostCommandRequest[];
  removed: HostCommandRequest[];
  version: string;
}

/** Installs a `codex`, an `sh` that makes the scratch folder and an `rm` on the fake host. */
function installCodex(host: FakeSshHost, answer: (request: HostCommandRequest) => HostCommandResult = () => ok(`${JSON.stringify({ id: 1, result: {} })}\n${JSON.stringify({ id: 2, result: hooksListAnswer() })}\n`)): FakeCodex {
  const fake: FakeCodex = { appServerRuns: [], removed: [], version: 'codex-cli 0.163.0' };
  host.commandResults.set('codex', (request) => {
    if (request.args[0] === '--version') return ok(`${fake.version}\n`);
    fake.appServerRuns.push(request);
    return answer(request);
  });
  host.commandResults.set('sh', () => ok(SCRATCH));
  host.commandResults.set('rm', (request) => {
    fake.removed.push(request);
    return ok('');
  });
  return fake;
}

/** The script the hook trust read runs on the host to make its scratch folders, taken from the command it sends. */
async function scratchScriptSent(): Promise<string> {
  const sent: HostCommandRequest[] = [];
  const place = {
    kind: 'ssh',
    files: {
      runCommand: async (request: HostCommandRequest): Promise<HostCommandResult> => {
        sent.push(request);
        return { code: 1, stdout: '', stderr: '', timedOut: false };
      },
    },
  } as unknown as SshCliPlace;
  await expect(readCodexHookTrustOnHost(place, codexHookDefinitions('wsl'))).rejects.toThrow('could not make a scratch folder');
  expect(sent[0].file).toBe('sh');
  return sent[0].args[1];
}

// The scratch folder is named in a command typed on the host, so a TMPDIR the host's shell would split is not used,
// and a folder that could not be finished is not left behind. Needs a POSIX sh, mktemp and mkdir.
describe.skipIf(process.platform === 'win32')('the script that makes the hook trust read\'s scratch folder, run for real with sh', () => {
  const SCRATCH_FOLDER_SHAPE = /^\/[^\s'"]*kangentic-codex-hooks-[A-Za-z0-9]+$/;
  const cleanup: string[] = [];

  afterEach(() => {
    for (const target of cleanup.splice(0)) fs.rmSync(target, { recursive: true, force: true });
  });

  it('falls back to /tmp for a TMPDIR holding a space, and prints a folder the read accepts, with home and folder inside', async () => {
    const script = await scratchScriptSent();

    const run = spawnSync('sh', ['-c', script], { encoding: 'utf8', env: { ...process.env, TMPDIR: '/tmp/a folder with spaces' } });

    expect(run.status).toBe(0);
    cleanup.push(run.stdout);
    expect(run.stdout).toMatch(SCRATCH_FOLDER_SHAPE);
    expect(run.stdout.startsWith('/tmp/kangentic-codex-hooks-')).toBe(true);
    expect(fs.statSync(`${run.stdout}/home`).isDirectory()).toBe(true);
    expect(fs.statSync(`${run.stdout}/folder`).isDirectory()).toBe(true);
  });

  it('removes the folder and exits non-zero when the folders inside it cannot be made', async () => {
    const script = await scratchScriptSent();
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-scratch-base-'));
    cleanup.push(base);
    // A `mkdir` that always fails, ahead of the real one. mktemp is a different program and still works.
    const stubs = path.join(base, 'stubs');
    fs.mkdirSync(stubs);
    fs.writeFileSync(path.join(stubs, 'mkdir'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    // The script uses the base only when its characters are plain, and /tmp otherwise: look where it will make the folder.
    const scratchBase = /^[A-Za-z0-9/._-]+$/.test(base) ? base : '/tmp';
    const before = fs.readdirSync(scratchBase).filter((name) => name.startsWith('kangentic-codex-hooks-'));

    const run = spawnSync('sh', ['-c', script], { encoding: 'utf8', env: { ...process.env, TMPDIR: base, PATH: `${stubs}${path.delimiter}${process.env.PATH ?? ''}` } });

    expect(run.status).not.toBe(0);
    expect(run.stdout).toBe('');
    const after = fs.readdirSync(scratchBase).filter((name) => name.startsWith('kangentic-codex-hooks-'));
    expect(after).toEqual(before);
  });
});

describe('a Codex session on a remote host', () => {
  it('declares the CLI name and the files it edits', () => {
    const adapter = new CodexAdapter();
    expect(adapter.remoteCliName).toBe('codex');
    expect(adapter.remoteFiles()).toEqual({ home: ['.codex/config.toml'], project: ['.kangentic/codex-wsl-hook.sh'] });
  });

  it('trusts the project folder in the host\'s config.toml and keeps what the user has there', async () => {
    const workspace = await newWorkspace();
    workspace.host.files.set(configFile(workspace), USER_CONFIG);
    await spawnOnHost(new CodexAdapter(), workspace, 'codex');

    expect(workspace.host.files.get(configFile(workspace))).toBe(`${USER_CONFIG}\n[projects.'${workspace.hostProject}']\ntrust_level = "trusted"\n`);
    expect(workspace.host.modes.get(configFile(workspace))).toBe(0o600);
  });

  it('does not overrule a decision the user recorded for the folder', async () => {
    const workspace = await newWorkspace();
    const denied = `[projects.'${workspace.hostProject}']\ntrust_level = "untrusted"\n`;
    workspace.host.files.set(configFile(workspace), denied);
    await spawnOnHost(new CodexAdapter(), workspace, 'codex');

    expect(workspace.host.files.get(configFile(workspace))).toBe(denied);
    expect(workspace.host.writes).not.toContain(configFile(workspace));
  });

  it('reads a path on the host as Linux does: another spelling of the case is another folder', async () => {
    const workspace = await newWorkspace();
    const otherCase = `[projects.'${workspace.hostProject.toUpperCase()}']\ntrust_level = "untrusted"\n`;
    workspace.host.files.set(configFile(workspace), otherCase);
    await spawnOnHost(new CodexAdapter(), workspace, 'codex');

    expect(workspace.host.files.get(configFile(workspace))).toContain(`[projects.'${workspace.hostProject}']\ntrust_level = "trusted"`);
  });

  describe('its hooks', () => {
    it('are read from the host\'s own Codex in a scratch folder there, then passed with the trust Codex reported', async () => {
      const workspace = await newWorkspace();
      const fake = installCodex(workspace.host);
      const spawn = await spawnOnHost(new CodexAdapter(), workspace, 'codex');

      expect(fake.appServerRuns).toHaveLength(1);
      const run = fake.appServerRuns[0];
      expect(run.env).toEqual({ CODEX_HOME: `${SCRATCH}/home` });
      const overrides = codexHookDefinitions('wsl').map((definition) => definition.override);
      expect(run.args).toEqual(['app-server', ...overrides.flatMap((override) => ['-c', override])]);
      const messages = (run.stdin ?? '').trim().split('\n').map((line) => JSON.parse(line) as { method: string; id?: number; params?: { cwds?: string[] } });
      expect(messages.map((message) => message.method)).toEqual(['initialize', 'initialized', 'hooks/list']);
      expect(messages[2].params?.cwds).toEqual([`${SCRATCH}/folder`]);
      expect(fake.removed.map((request) => request.args)).toEqual([['-rf', '--', SCRATCH]]);

      // The session is passed the same hooks, the hash Codex reported, and the script the hooks run.
      expect(spawn.command).toContain('hooks.state=');
      expect(spawn.command).toContain('sha256:0000000000000000000000000000000000000000000000000000000000000000');
      // The overrides reach the host's shell inside single quotes, each of their own `'` written `'\''`.
      const unquoted = spawn.command.replaceAll("'\\''", "'");
      for (const definition of codexHookDefinitions('wsl')) expect(unquoted).toContain(definition.override);
      expect(workspace.host.files.get(hookScript(workspace))).toBe(WSL_HOOK_SCRIPT);
      expect(workspace.host.modes.get(hookScript(workspace))).toBe(0o755);
    });

    it('are read once per host and version, and again when the host\'s Codex changes', async () => {
      const workspace = await newWorkspace();
      const fake = installCodex(workspace.host);
      const adapter = new CodexAdapter();
      await spawnOnHost(adapter, workspace, 'codex');
      await spawnOnHost(adapter, workspace, 'codex');
      expect(fake.appServerRuns).toHaveLength(1);

      fake.version = 'codex-cli 0.170.0';
      await spawnOnHost(adapter, workspace, 'codex');
      expect(fake.appServerRuns).toHaveLength(2);
    });

    it('are used when the answer arrived before the read was stopped at its bound', async () => {
      const workspace = await newWorkspace();
      installCodex(workspace.host, () => ({ code: null, stdout: `${JSON.stringify({ id: 2, result: hooksListAnswer() })}\n`, stderr: '', timedOut: true }));
      const spawn = await spawnOnHost(new CodexAdapter(), workspace, 'codex');

      expect(spawn.command).toContain('hooks.state=');
    });

    it('are left out when Codex never answered, so the session runs on the activity timer instead', async () => {
      const workspace = await newWorkspace();
      installCodex(workspace.host, () => ({ code: null, stdout: '', stderr: '', timedOut: true }));
      const spawn = await spawnOnHost(new CodexAdapter(), workspace, 'codex');

      expect(spawn.command).not.toContain('hooks.');
      expect(spawn.command).toContain('mcp_servers.kangentic.command=');
    });

    it('are left out when Codex does not list them as passed, which would otherwise open its review dialog', async () => {
      const workspace = await newWorkspace();
      installCodex(workspace.host, () => ok(`${JSON.stringify({ id: 2, result: { data: [{ hooks: [], errors: [], warnings: [] }] } })}\n`));
      const spawn = await spawnOnHost(new CodexAdapter(), workspace, 'codex');

      expect(spawn.command).not.toContain('hooks.');
    });

    it('are left out when the host has no Codex to ask', async () => {
      const workspace = await newWorkspace();
      const spawn = await spawnOnHost(new CodexAdapter(), workspace, 'codex');

      expect(spawn.command).not.toContain('hooks.');
      expect(workspace.host.commands.map((request) => request.file)).toEqual(['codex']);
    });
  });

  it('starts codex in the project\'s folder on the host, wired to the MCP bridge there, with no path or token of this computer', async () => {
    const workspace = await newWorkspace();
    installCodex(workspace.host);
    const spawn = await spawnOnHost(new CodexAdapter(), workspace, 'codex', { taskProcessTag: TASK_TAG });

    expect(spawn.command.startsWith('codex ')).toBe(true);
    expect(spawn.command).toContain(`-C ${workspace.hostProject} `);
    expect(spawn.command).toContain(`${sessionFolders(workspace).host}/wsl-hooks/wsl-hook.sh`);
    expect(spawn.command).toContain('mcp_servers.kangentic.env_vars=');
    expect(spawn.command).toContain(`shell_environment_policy.set.KANGENTIC_TASK_ID=${TASK_TAG}`);
    expect(spawn.command).not.toContain(MCP_TOKEN);
    expect(spawn.env).toEqual({ KANGENTIC_MCP_TOKEN: MCP_TOKEN });
    for (const content of workspace.host.files.values()) expect(content).not.toContain(MCP_TOKEN);
    expectNoLocalPaths(workspace, spawn);
  });

  it('keeps the trust entry and the script on release, which every session in the folder shares, and writes nothing else', async () => {
    const workspace = await newWorkspace();
    installCodex(workspace.host);
    workspace.host.files.set(configFile(workspace), USER_CONFIG);
    const adapter = new CodexAdapter();
    await spawnOnHost(adapter, workspace, 'codex');

    adapter.removeHooks(workspace.projectFolder, SESSION_ID);
    await settleHostFiles(SESSION_ID);

    expect(workspace.host.files.get(configFile(workspace))).toContain(`[projects.'${workspace.hostProject}']`);
    expect(workspace.host.files.has(hookScript(workspace))).toBe(true);
    expect([...workspace.host.files.keys()].sort()).toEqual([configFile(workspace), hookScript(workspace)].sort());
  });

  it('finds no rollout and does not wait for one', async () => {
    const workspace = await newWorkspace();
    const started = Date.now();
    const stored = toStoredCliTarget(workspace.place);
    expect(await CodexSessionHistoryParser.captureSessionIdFromFilesystem({ spawnedAt: new Date(), cwd: workspace.projectFolder, cliTarget: stored })).toBeNull();
    expect(await CodexSessionHistoryParser.locate({ agentSessionId: '3f2a9c1e-7b64-4d2a-9c11-0a1b2c3d4e5f', cwd: workspace.projectFolder, cliTarget: stored })).toBeNull();
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('takes an auto_command typed into a session on a host as delivered, instead of restarting the session over a rollout it cannot read', async () => {
    const workspace = await newWorkspace();
    const confirmed = await createCodexCommandInjectionVerifier()({
      type: 'command-injection',
      text: 'run the tests',
      agentSessionId: '3f2a9c1e-7b64-4d2a-9c11-0a1b2c3d4e5f',
      cwd: workspace.projectFolder,
      cliTarget: toStoredCliTarget(workspace.place),
      verify: 'submitted',
    });
    expect(confirmed).toBe(true);
  });
});
