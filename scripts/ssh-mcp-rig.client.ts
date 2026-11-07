/**
 * The client half of the #913 MCP rig (`node scripts/ssh-link-rig.mjs --client mcp --work <dir>`): what an agent's
 * Kangentic tool calls do on a real host while the link drops and the app is away, through the real link, helper,
 * `ssh`, relay and hook inbox, with the real bridge script run by the host's own `sh`. The unit tier runs the same
 * parts over an in-memory stream, so this is what proves the parts that need a real connection to be killed.
 *
 * A call is answered once, and a call the link drops under still gets its one answer. A call nobody takes ends in an
 * error for its id, and is never run afterwards when its frame is delivered late. An answer past the link's frame is
 * an error that says so, and a request past the limit is refused at once.
 *
 * Not product code, and `tsconfig.json` covers `src/` only, so `npm run typecheck` does not see it.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { RemoteLink } from '../src/main/remote/link/remote-link';
import { openSshStream } from '../src/main/remote/link/ssh-connection';
import { createSshRunner, posixShellCommand } from '../src/main/remote/link/ssh-run';
import { installHost, type HostAsset } from '../src/main/remote/link/host-installer';
import { RemoteSessionRelay, type RemoteSessionFiles } from '../src/main/remote/remote-session-relay';
import { WslHookInbox } from '../src/main/pty/readers/wsl-hook-inbox';
import {
  WSL_HOOK_SCRIPT,
  WSL_MCP_NOT_TAKEN_MESSAGE,
  WSL_MCP_REQUEST_MAX_CHARS,
  WSL_MCP_TAKE_WAIT_SECONDS,
  prepareWslHookTransport,
} from '../src/main/agent/shared/wsl-hook-transport';
import type { SshCliPlace } from '../src/main/agent/shared/cli-target';

interface Options {
  sshPath: string;
  sshArgs: string[];
  workDirectory: string;
  asset: HostAsset;
}

const options = JSON.parse(process.argv[2]) as Options;
const HOST_ID = 'rig-host';
const HOST_HOME = '/home/dev';
const HOST_PROJECT = `${HOST_HOME}/project`;
const HOST_HOOKS = `${HOST_PROJECT}/.kangentic/sessions/s1/wsl-hooks`;
let remoteCommand = '';
const checks: Array<{ name: string; passed: boolean; detail?: string }> = [];

function check(name: string, passed: boolean, detail?: string): void {
  checks.push({ name, passed, ...(detail ? { detail } : {}) });
  process.stderr.write(`[${passed ? 'ok' : 'FAILED'}] ${name}${detail ? `: ${detail}` : ''}\n`);
}

const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(description: string, condition: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (!(await condition())) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${description}`);
    await sleep(100);
  }
}

/** What the fake MCP server does with the next call: how long it takes, and how big its answer is. */
const server = { delayMs: 0, answerBytes: 0, executions: [] as string[] };

interface Desktop {
  link: RemoteLink;
  dropLink(): void;
  restoreLink(): void;
  host(file: string, args: string[], stdin?: string): Promise<string>;
}

/** The app's side: a link whose connection a test can cut and hold down, the relay, and the hook inbox. */
async function startDesktop(): Promise<Desktop> {
  let down = false;
  const waiters: Array<() => void> = [];
  const streams: Duplex[] = [];
  const link = new RemoteLink({
    identity: { installId: 'ssh-mcp-rig', bootId: randomUUID(), label: 'the rig client' },
    connect: async () => {
      while (down) await new Promise<void>((resolve) => waiters.push(resolve));
      const stream = openSshStream({ sshPath: options.sshPath, args: options.sshArgs, remoteCommand });
      streams.push(stream);
      return stream;
    },
    reconnect: { initialDelayMs: 100, maxDelayMs: 500 },
    endpoint: { heartbeatMs: 1000, deadAfterMs: 6000 },
    log: (line) => process.stderr.write(`[link] ${line}\n`),
  });
  let connected = false;
  link.setHandlers({ onStateChanged: (next) => { connected = next === 'connected'; } });
  link.start();
  await waitFor('the link', () => connected, 30_000);

  const files: RemoteSessionFiles = {
    writeFiles: (_hostId, fileList, directories) => link.requestHelper('writeFiles', { files: fileList, ...(directories ? { directories } : {}) }),
    writeFileRaw: (_hostId, filePath, content, mode) => link.requestHelperRaw('writeFileRaw', { path: filePath, ...(mode === undefined ? {} : { mode }) }, Buffer.from(content, 'utf8')),
    watchHooks: (_hostId, sessionId, directory, statusFile) => link.requestHelper('watchHooks', { sessionId, directory, ...(statusFile ? { statusFile } : {}) }),
    unwatchHooks: (_hostId, sessionId) => link.requestHelper('unwatchHooks', { sessionId }),
    watchFiles: (_hostId, sessionId, tailed, searches) => link.requestHelper('watchFiles', { sessionId, files: tailed, ...(searches?.length ? { searches } : {}) }),
    unwatchFiles: (_hostId, sessionId) => link.requestHelper('unwatchFiles', { sessionId }),
    removeFiles: (_hostId, paths) => link.requestHelper('removeFiles', { paths }),
    removeEmptyDirectories: (_hostId, paths) => link.requestHelper('removeEmptyDirectories', { paths }),
    runCommand: (_hostId, request) => link.requestHelper('runCommand', request),
  };
  const relay = new RemoteSessionRelay({ files, log: (line) => process.stderr.write(`[relay] ${line}\n`) });
  link.setEventListener((event) => {
    if (event.type === 'hookFile') relay.deliver(event);
    if (event.type === 'fileChunk') relay.deliverChunk(event);
  });

  const host = async (file: string, args: string[], stdin?: string): Promise<string> => {
    const result = await link.requestHelper('runCommand', { file, args, ...(stdin === undefined ? {} : { stdin }), timeoutMs: 20_000 });
    return result.stdout;
  };
  await host('mkdir', ['-p', HOST_PROJECT]);

  const shellFolder = path.join(options.workDirectory, 'shell');
  const localSession = path.join(shellFolder, '.kangentic', 'sessions', 's1');
  fs.mkdirSync(localSession, { recursive: true });
  prepareWslHookTransport(localSession);
  fs.writeFileSync(path.join(localSession, 'settings.json'), '{"hooks":{}}');
  fs.writeFileSync(path.join(localSession, 'mcp.json'), '{"mcpServers":{}}');
  const eventsPath = path.join(localSession, 'events.jsonl');
  fs.writeFileSync(eventsPath, '');
  const inbox = new WslHookInbox({
    sessionDirectory: localSession,
    eventsOutputPath: eventsPath,
    onAppended: () => undefined,
    relayMcp: async (input) => {
      server.executions.push(input.body.trim());
      await sleep(server.delayMs);
      const id = (JSON.parse(input.body) as { id: number }).id;
      const padding = server.answerBytes > 0 ? 'z'.repeat(server.answerBytes) : '';
      return `${JSON.stringify({ jsonrpc: '2.0', id, result: { ok: true, padding } })}\n`;
    },
  });
  inbox.start();
  const place: SshCliPlace = {
    kind: 'ssh', hostId: HOST_ID, home: HOST_HOME, shellName: 'sh',
    localHome: path.join(options.workDirectory, 'mirror'),
    roots: [{ local: shellFolder, host: HOST_PROJECT }],
  };
  await relay.register({ hostId: HOST_ID, sessionId: 's1', place, localSessionDirectory: localSession, statusOutputPath: path.join(localSession, 'status.json') });

  return {
    link,
    host,
    dropLink: () => { down = true; for (const stream of streams.splice(0)) stream.destroy(); },
    restoreLink: () => { down = false; for (const resume of waiters.splice(0)) resume(); },
  };
}

let callCounter = 0;

/**
 * Starts the bridge on the host in the background, the way an agent's CLI does, and returns where its output lands.
 * Reached by a direct `ssh`, never through the link, because the link is what a scenario cuts: the agent on the host
 * does not depend on it.
 */
async function startBridge(_desktop: Desktop, script: string, line: string): Promise<{ output: () => Promise<string>; requestFiles: () => Promise<string> }> {
  const direct = createSshRunner({ sshPath: options.sshPath, args: options.sshArgs });
  callCounter += 1;
  const base = `${HOST_HOME}/bridge-${callCounter}`;
  await direct(posixShellCommand(`cat > "${base}.in"`), { stdin: Buffer.from(`${line}\n`) });
  await direct(posixShellCommand(`(KANGENTIC_MCP_TOKEN=rig-token sh "${script}" mcp http://127.0.0.1:1/mcp/rig < "${base}.in" > "${base}.out" 2>&1 &); exit 0`));
  return {
    output: async () => (await direct(posixShellCommand(`cat "${base}.out" 2>/dev/null; true`))).stdout,
    requestFiles: async () => (await direct(posixShellCommand(`ls "${HOST_HOOKS}/requests" 2>/dev/null; true`))).stdout,
  };
}

const call = (id: number, extra = '') => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'kangentic_move_task', note: extra } });
const answers = (text: string) => text.split('\n').filter((entry) => entry.length > 0).map((entry) => JSON.parse(entry) as { id?: number; result?: unknown; error?: { message: string } });

async function scenarios(desktop: Desktop): Promise<void> {
  const realScript = `${HOST_HOOKS}/wsl-hook.sh`;
  // The clock is read from the 401st try on, and a call waits `take` seconds to be taken: the same logic, a short wait.
  const shortScript = WSL_HOOK_SCRIPT.replace('"$tries" -ge 401', '"$tries" -ge 4').replace(`"$elapsed" -ge ${WSL_MCP_TAKE_WAIT_SECONDS}`, '"$elapsed" -ge 3');
  await desktop.link.requestHelper('writeFiles', { files: [{ path: `${HOST_HOOKS}/short.sh`, content: shortScript, mode: 0o755 }] });

  // 1. The ordinary call.
  server.executions.length = 0;
  let bridge = await startBridge(desktop, realScript, call(1));
  await waitFor('the first answer', async () => (await bridge.output()).includes('"ok":true'), 20_000);
  check('a call is answered', answers(await bridge.output()).length === 1);
  check('and run once', server.executions.length === 1);
  check('and its request is gone from the host', (await bridge.requestFiles()).trim() === '');

  // 2. The link drops while the call runs: the one answer still arrives, and nothing runs twice.
  server.executions.length = 0;
  server.delayMs = 4_000;
  bridge = await startBridge(desktop, realScript, call(2));
  await sleep(1_000);
  desktop.dropLink();
  await sleep(2_500);
  desktop.restoreLink();
  await waitFor('the answer after the drop', async () => (await bridge.output()).includes('"ok":true'), 40_000);
  check('a call the link drops under still gets its answer', answers(await bridge.output())[0]?.id === 2);
  check('and ran exactly once', server.executions.length === 1, `ran ${server.executions.length} times`);
  server.delayMs = 0;

  // 3. The link is down when the call is made, longer than the call waits to be taken.
  server.executions.length = 0;
  desktop.dropLink();
  bridge = await startBridge(desktop, `${HOST_HOOKS}/short.sh`, call(3));
  await waitFor('the bridge to give up', async () => (await bridge.output()).includes('did not take this call'), 40_000);
  const given = answers(await bridge.output())[0];
  check('a call nobody takes ends in an error for its id', given?.id === 3 && given.error?.message === WSL_MCP_NOT_TAKEN_MESSAGE);
  check('and the bridge removed its own request', (await bridge.requestFiles()).trim() === '');
  desktop.restoreLink();
  await sleep(4_000);
  check('and the frame delivered after the link came back runs nothing', server.executions.length === 0, `ran ${server.executions.length} times`);

  // 4. An answer past the link's frame.
  server.executions.length = 0;
  server.answerBytes = 1_200_000;
  bridge = await startBridge(desktop, realScript, call(4));
  await waitFor('the oversize answer', async () => (await bridge.output()).includes('saveToFile'), 30_000);
  const large = answers(await bridge.output())[0];
  check('an answer past the frame is an error that says to save to a file', large?.id === 4 && Boolean(large.error?.message.includes('saveToFile')));
  server.answerBytes = 0;

  // 5. A request past the limit.
  server.executions.length = 0;
  bridge = await startBridge(desktop, realScript, call(5, 'a'.repeat(WSL_MCP_REQUEST_MAX_CHARS + 100)));
  await waitFor('the refusal', async () => (await bridge.output()).includes('Send less in one call'), 20_000);
  check('a request past the limit is refused at once, with an error for its id', answers(await bridge.output())[0]?.id === 5);
  check('and nothing was sent', server.executions.length === 0 && (await bridge.requestFiles()).trim() === '');

  // 6. The real wait, with the link down for all of it.
  desktop.dropLink();
  const started = Date.now();
  bridge = await startBridge(desktop, realScript, call(6));
  await waitFor('the real wait to end', async () => (await bridge.output()).includes('did not take this call'), (WSL_MCP_TAKE_WAIT_SECONDS + 25) * 1000);
  const seconds = (Date.now() - started) / 1000;
  check(`with the app away, the real script ends the call in about ${WSL_MCP_TAKE_WAIT_SECONDS} seconds`, seconds >= WSL_MCP_TAKE_WAIT_SECONDS - 2 && seconds <= WSL_MCP_TAKE_WAIT_SECONDS + 15, `${seconds.toFixed(1)} s`);
  desktop.restoreLink();
}

async function main(): Promise<void> {
  fs.mkdirSync(options.workDirectory, { recursive: true });
  const run = createSshRunner({ sshPath: options.sshPath, args: options.sshArgs });
  remoteCommand = (await installHost(run, options.asset)).relayCommand;
  const desktop = await startDesktop();
  try {
    await scenarios(desktop);
  } finally {
    desktop.link.stop();
  }
  const failed = checks.filter((entry) => !entry.passed);
  process.stdout.write(`${JSON.stringify({ allPassed: failed.length === 0, passed: checks.length - failed.length, of: checks.length, failed }, null, 2)}\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(2);
});
