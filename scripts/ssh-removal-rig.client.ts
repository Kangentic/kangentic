/**
 * The client half of the #913 removal rig (`node scripts/ssh-link-rig.mjs --client removal --work <dir>`): what
 * removing, adding back and editing a host do on a real host, through the real link, helper, `ssh` and admin.
 * The unit tier fakes all three, so this is what proves two things only a host can.
 *
 * Leftovers: a Remove with the link down leaves its agents running. A new link hangs up the sessions of the hidden
 * projects, and only those. A foreground process under a shell stands in for an agent, because the hangup goes to
 * the shell and the agent is what must end.
 *
 * Sign-in: a sign-in that cannot get in is refused with ssh's own words, and the only key stays on the host. One
 * that can replaces it, and the old key really comes off `authorized_keys`.
 *
 * Not product code, and `tsconfig.json` covers `src/` only, so `npm run typecheck` does not see it.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { PtyHostClient } from '../src/main/pty/host/pty-host-client';
import { RemoteLink, type RemoteLinkState } from '../src/main/remote/link/remote-link';
import { openSshStream } from '../src/main/remote/link/ssh-connection';
import { createSshRunner } from '../src/main/remote/link/ssh-run';
import { installHost, type HostAsset } from '../src/main/remote/link/host-installer';
import { RemoteHostService } from '../src/main/remote/remote-host-service';
import { SshHostAdmin, type SshHostAdminDeps } from '../src/main/remote/ssh-host-admin';
import { createHostKey, runProgram, type RunProgram, type SshSetupDeps } from '../src/main/remote/ssh-setup';
import type { HelperMethod, HelperRequestMap } from '../src/main/remote/protocol/messages';
import type { SshHost } from '../src/shared/types';

interface Options {
  sshPath: string;
  sshKeygenPath: string;
  sshArgs: string[];
  /** The connection's options without the key or the destination, as a user's own setup would give them. */
  sshOptions: string[];
  destination: string;
  rigKeyPath: string;
  workDirectory: string;
  asset: HostAsset;
}

const options = JSON.parse(process.argv[2]) as Options;
const HOST_ID = '00000000-0000-4000-8000-000000000913';
const HIDDEN_PROJECT = 'rig-hidden-project';
const OTHER_PROJECT = 'rig-other-project';
const AGENT_MARK = 'sleep 7913';
let remoteCommand = '';
const checks: Array<{ name: string; passed: boolean; detail?: string }> = [];

function check(name: string, passed: boolean, detail?: string): void {
  checks.push({ name, passed, ...(detail ? { detail } : {}) });
  process.stderr.write(`[${passed ? 'ok' : 'FAILED'}] ${name}${detail ? `: ${detail}` : ''}\n`);
}

const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(description: string, condition: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${description}`);
    await sleep(20);
  }
}

function openLink(): { link: RemoteLink; connected: () => boolean } {
  let state: RemoteLinkState = 'connecting';
  const streams: Duplex[] = [];
  const link = new RemoteLink({
    identity: { installId: 'ssh-removal-rig', bootId: randomUUID(), label: 'the rig client' },
    connect: async () => {
      const stream = openSshStream({ sshPath: options.sshPath, args: options.sshArgs, remoteCommand });
      streams.push(stream);
      return stream;
    },
    reconnect: { initialDelayMs: 100, maxDelayMs: 1000 },
    endpoint: { heartbeatMs: 1000, deadAfterMs: 6000 },
    log: (line) => process.stderr.write(`[link] ${line}\n`),
  });
  link.setHandlers({ onStateChanged: (next) => { state = next; } });
  return { link, connected: () => state === 'connected' };
}

/** A shell with a process in the foreground, as a login shell runs an agent. */
function agentSpawn(sessionId: string, projectId: string) {
  return {
    sessionId,
    projectId,
    agentName: null,
    transient: false,
    file: '/bin/bash',
    args: ['-c', `${AGENT_MARK}; true`],
    cwd: '/home/dev',
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/home/dev', TERM: 'xterm-256color' },
    cols: 120,
    rows: 30,
    carryoverFromSessionId: null,
    agentSessionIdKnown: false,
    taskId: randomUUID(),
  };
}

async function leftoverSessions(): Promise<void> {
  const first = openLink();
  first.link.start();
  await waitFor('the first connection', first.connected, 30_000);
  const client = new PtyHostClient(first.link);
  for (const [sessionId, projectId] of [['left-running', HIDDEN_PROJECT], ['elsewhere', OTHER_PROJECT]]) {
    const outcome = await client.spawn(agentSpawn(sessionId, projectId));
    if (!outcome.ok) throw outcome.error;
  }
  await sleep(500);

  // The Remove with the link down: nothing reaches the host, and the agents go on.
  first.link.stop();

  const second = openLink();
  second.link.start();
  await waitFor('the new link', second.connected, 30_000);
  const send: (request: { op: string; method?: string; params?: unknown }) => Promise<unknown> = async (request) => {
    if (request.op !== 'helper') throw new Error(`the rig has no ${request.op}`);
    return second.link.requestHelper(request.method as HelperMethod, request.params as HelperRequestMap[HelperMethod]['params']);
  };
  const service = new RemoteHostService({
    sshPath: options.sshPath,
    hosts: { getById: () => undefined, list: () => [] },
    send: send as never,
    asset: () => null,
    identity: { installId: 'ssh-removal-rig', label: 'the rig client' },
    liveSessions: () => [],
  });
  const processesRunning = async (): Promise<number> => {
    const result = await second.link.requestHelper('runCommand', { file: 'sh', args: ['-c', 'pgrep -fc "^sleep 7913$"'], timeoutMs: 10_000 });
    return Number(result.stdout.trim());
  };

  const before = await second.link.requestHelper('snapshot', {});
  check('both agents outlived the link', before.sessions.filter((record) => record.alive).length === 2);
  check('both agent processes are running', (await processesRunning()) === 2);

  const ended = await service.endSessionsLeftRunning(HOST_ID, new Set([HIDDEN_PROJECT]));
  check('it reports one session ended', ended === 1, `ended ${ended}`);

  const after = await second.link.requestHelper('snapshot', {});
  const alive = (sessionId: string): boolean | undefined => after.sessions.find((record) => record.sessionId === sessionId)?.alive;
  check('the hidden project\'s session is gone from the helper', alive('left-running') === false);
  check('another project\'s session is left running', alive('elsewhere') === true);
  await sleep(1000);
  check('the hangup reached the process under the shell, and only that one', (await processesRunning()) === 1, `${await processesRunning()} left`);
  check('a second pass finds nothing to do', (await service.endSessionsLeftRunning(HOST_ID, new Set([HIDDEN_PROJECT]))) === 0);

  await signIn(second.link);
  second.link.stop();
}

async function signIn(link: RemoteLink): Promise<void> {
  const configDirectory = path.join(options.workDirectory, 'config');
  // ssh.exe refuses a key its folder's ACL lets anyone else read, and a scratch folder's can. The product's fix for
  // that is on the PR branch, not here, and it is not what this rig is testing.
  const protect = (args: string[]): void => {
    const keyAt = args.indexOf('-i');
    if (process.platform !== 'win32' || keyAt === -1 || !fs.existsSync(args[keyAt + 1])) return;
    execFileSync('icacls', [args[keyAt + 1], '/inheritance:r', '/grant:r', `${process.env.USERNAME}:F`], { stdio: 'ignore' });
  };
  const run: RunProgram = (file, args, runOptions) => {
    protect(args);
    return runProgram(file, args, runOptions);
  };
  const setup: SshSetupDeps = {
    sshPath: options.sshPath,
    sshKeygenPath: options.sshKeygenPath,
    sshOptions: options.sshOptions,
    run,
    configDirectory,
    temporaryDirectory: options.workDirectory,
    platform: process.platform,
    homeDirectory: options.workDirectory,
  };
  const pair = await createHostKey(HOST_ID, setup);
  await link.requestHelper('runCommand', {
    file: 'sh',
    args: ['-c', 'printf "%s\\n" "$1" >> "$HOME/.ssh/authorized_keys"', 'kangentic-rig', pair.publicKey],
    timeoutMs: 10_000,
  });

  const row: SshHost = {
    id: HOST_ID, name: 'Rig', destination: options.destination, key_path: pair.privateKeyPath, key_created: true,
    created_at: new Date().toISOString(), removed_at: null, reveal_pending: false,
  };
  const madeKey = pair.privateKeyPath;
  const hosts = {
    list: () => [row],
    listRemoved: () => [],
    getById: () => row,
    setKey: (_id: string, keyPath: string | null, keyCreated: boolean) => { row.key_path = keyPath; row.key_created = keyCreated; return row; },
    setDestination: (_id: string, destination: string) => { row.destination = destination; return row; },
    rename: (_id: string, name: string) => { row.name = name; return row; },
  };
  const hosting = {
    hosts,
    hostService: { disconnect: async () => undefined },
    status: { get: () => undefined },
    connectHost: async () => undefined,
    expectFirstConnect: () => undefined,
  };
  const admin = new SshHostAdmin({
    hosting: hosting as unknown as SshHostAdminDeps['hosting'],
    projects: { listOnHost: () => [] },
    setup,
    removeProject: async () => undefined,
    suspendProjectSessions: async () => undefined,
    remoteProjectsRoot: path.join(options.workDirectory, 'remote-projects'),
    newShellFolder: () => path.join(options.workDirectory, 'remote-projects', randomUUID()),
    log: (line) => process.stderr.write(`[admin] ${line}\n`),
  });
  const authorizedKeys = async (): Promise<string> => (await link.requestHelper('readFile', { path: '/home/dev/.ssh/authorized_keys' })).content ?? '';
  const signsIn = async (keyPath: string): Promise<boolean> => {
    if (!fs.existsSync(keyPath)) return false;
    const args = [...options.sshOptions, '-o', 'BatchMode=yes', '-i', keyPath, '-o', 'IdentitiesOnly=yes', options.destination, 'true'];
    protect(args);
    return (await runProgram(options.sshPath, args, { timeout: 20_000 })).code === 0;
  };

  check('the key Kangentic made signs in', await signsIn(madeKey));

  let refusal = '';
  await admin.updateHost(HOST_ID, { name: 'Rig', destination: options.destination, signIn: { method: 'config' } }).catch((error: unknown) => {
    refusal = error instanceof Error ? error.message : String(error);
  });
  check('a sign-in that cannot get in is refused with ssh\'s words', /Permission denied/.test(refusal), refusal);
  check('the row kept its key', row.key_path === madeKey && row.key_created);
  check('the old key stayed on the host', (await authorizedKeys()).includes(pair.publicKey));
  check('the old key still signs in', await signsIn(madeKey));
  check('no aside folder is left', !fs.existsSync(`${path.dirname(madeKey)}.previous`));

  await admin.updateHost(HOST_ID, { name: 'Rig', destination: options.destination, signIn: { method: 'key-file', keyFilePath: options.rigKeyPath } });
  check('a sign-in that gets in is saved', row.key_path !== madeKey && !row.key_created, row.key_path ?? 'none');
  check('the old key came off the host', !(await authorizedKeys()).includes(pair.publicKey));
  check('the new key signs in', await signsIn(row.key_path ?? ''));
  check('no aside folder is left after it', !fs.existsSync(`${path.dirname(madeKey)}.previous`));
}

async function main(): Promise<void> {
  fs.mkdirSync(options.workDirectory, { recursive: true });
  const run = createSshRunner({ sshPath: options.sshPath, args: options.sshArgs });
  remoteCommand = (await installHost(run, options.asset)).relayCommand;
  await leftoverSessions();
  const failed = checks.filter((entry) => !entry.passed);
  process.stdout.write(`${JSON.stringify({ allPassed: failed.length === 0, passed: checks.length - failed.length, of: checks.length, failed }, null, 2)}\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(2);
});
