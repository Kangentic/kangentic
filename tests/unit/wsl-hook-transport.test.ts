/**
 * The WSL hook transport (`wsl-hook-transport.ts`, `wsl-hook-inbox.ts`): a
 * distro CLI's hooks run one `sh` script that publishes a file per call, and
 * Kangentic does the node bridges' work on those files.
 *
 * The end-to-end cases run the real script under `sh` against the real inbox,
 * so the format the script writes and the format the inbox reads are checked
 * against each other, not against a copy. They need `sh`, which CI's Linux and
 * macOS runners have; a Windows machine without Git Bash skips them, saying so.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  WSL_HOOK_SCRIPT,
  parseWslHookRecord,
  prepareWslHookTransport,
  wslHookEventCommand,
  wslHookPaths,
  wslHookRecordTime,
  wslHookReplyCommand,
  wslMcpServerLaunch,
  wslReachesLoopback,
  wslStatusLineCommand,
} from '../../src/main/agent/shared/wsl-hook-transport';
import { WslHookInbox } from '../../src/main/pty/readers/wsl-hook-inbox';
import type { McpRelayInput } from '../../src/main/pty/readers/wsl-mcp-relay';
import type { CliPlace } from '../../src/main/agent/shared/cli-target';
import { extractTool, extractToolId } from '../../src/main/agent/shared/directive-builders';

/** The directives a tool_start hook carries, from the real builders. */
function buildToolStartDirectives(): string[] {
  return [extractTool('tool_name'), extractToolId(['tool_use_id'])];
}

const PLACE: CliPlace = {
  kind: 'wsl',
  distro: 'Ubuntu',
  facts: {
    distro: 'Ubuntu', homeLinux: '/home/dev', homeUnc: '\\\\wsl.localhost\\Ubuntu\\home\\dev',
    uncRoot: '\\\\wsl.localhost\\Ubuntu', interactivePath: '/usr/bin', env: {}, networkingMode: 'nat',
  },
};

const temporaryDirectories: string[] = [];
const openInboxes: WslHookInbox[] = [];

function makeSessionDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-wsl-hooks-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const inbox of openInboxes.splice(0)) inbox.close();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const shAvailable = spawnSync('sh', ['-c', 'exit 0']).status === 0;

/** Run the session's script under sh with `stdin`, as a CLI runs a hook. */
function runScript(
  sessionDirectory: string,
  args: string[],
  stdin: string,
  options: { scriptPath?: string; env?: Record<string, string> } = {},
): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', [options.scriptPath ?? wslHookPaths(sessionDirectory).script, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...options.env },
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8'); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, code }));
    child.stdin.end(stdin);
  });
}

async function waitFor<T>(read: () => T | null, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function readEventLines(eventsPath: string): string[] {
  try {
    return fs.readFileSync(eventsPath, 'utf-8').split('\n').filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

function startInbox(sessionDirectory: string, eventsPath: string): WslHookInbox {
  const inbox = new WslHookInbox({ sessionDirectory, eventsOutputPath: eventsPath, onAppended: () => undefined });
  openInboxes.push(inbox);
  inbox.start();
  return inbox;
}

describe('the hook script', () => {
  it('is LF only, so sh runs it whatever the checkout\'s line endings', () => {
    expect(WSL_HOOK_SCRIPT).not.toContain('\r');
    expect(WSL_HOOK_SCRIPT.endsWith('\n')).toBe(true);
  });

  it('is written per session with its folders and signal file', () => {
    const sessionDirectory = makeSessionDirectory();
    const paths = prepareWslHookTransport(sessionDirectory);
    expect(fs.readFileSync(paths.script, 'utf-8')).toBe(WSL_HOOK_SCRIPT);
    expect(fs.readFileSync(paths.signal, 'utf-8')).toBe('');
    for (const folder of [paths.inbox, paths.requests, paths.responses]) expect(fs.statSync(folder).isDirectory()).toBe(true);
  });
});

describe('hook commands', () => {
  const sessionDirectory = 'C:\\Users\\dev\\proj\\.kangentic\\sessions\\s1';
  const paths = wslHookPaths(sessionDirectory);

  it('runs the script by its distro path with sh, the event type and directives as they are', () => {
    expect(wslHookEventCommand(paths, PLACE, 'tool_start', 'extractTool:eyJ9', 'extractToolId:eyJ9'))
      .toBe('sh "/mnt/c/Users/dev/proj/.kangentic/sessions/s1/wsl-hooks/wsl-hook.sh" event tool_start extractTool:eyJ9 extractToolId:eyJ9');
  });

  it('asks for a reply by kind and spec, with no path in the command', () => {
    expect(wslHookReplyCommand(paths, PLACE, 'plan-approval', 'c3BlYw=='))
      .toBe('sh "/mnt/c/Users/dev/proj/.kangentic/sessions/s1/wsl-hooks/wsl-hook.sh" reply plan-approval c3BlYw==');
  });

  it('points the status line at the status file the distro sees', () => {
    expect(wslStatusLineCommand(paths, PLACE, `${sessionDirectory}\\status.json`))
      .toBe('sh "/mnt/c/Users/dev/proj/.kangentic/sessions/s1/wsl-hooks/wsl-hook.sh" status "/mnt/c/Users/dev/proj/.kangentic/sessions/s1/status.json"');
  });

  it('starts the MCP bridge as sh with the script, the mode and the URL, and no token', () => {
    expect(wslMcpServerLaunch(paths, PLACE, 'http://127.0.0.1:4100/mcp/project-1/session-1')).toEqual({
      command: 'sh',
      args: ['/mnt/c/Users/dev/proj/.kangentic/sessions/s1/wsl-hooks/wsl-hook.sh', 'mcp', 'http://127.0.0.1:4100/mcp/project-1/session-1'],
    });
  });

  it('dials the MCP URL itself only on mirrored networking, where loopback is the host\'s', () => {
    expect(wslReachesLoopback({ ...PLACE, facts: { ...PLACE.facts, networkingMode: 'mirrored' } })).toBe(true);
    expect(wslReachesLoopback(PLACE)).toBe(false);
    expect(wslReachesLoopback({ ...PLACE, facts: { ...PLACE.facts, networkingMode: 'unknown' } })).toBe(false);
  });
});

describe('the inbox relays MCP messages', () => {
  // A tool call can run for minutes, so each message is relayed on its own:
  // the hooks' answers and the events never wait behind one. Red-green:
  // awaiting the relay in the drain loop holds the hint's answer until the
  // relay returns, and dropping the in-flight set relays a message twice.
  function writeRequest(directory: string, name: string, head: string, argument: string, body: string): void {
    fs.writeFileSync(path.join(directory, `${name}.req`), `K1\n${head}\n${argument}\n${body}`);
  }

  it('relays each message once with its token, URL and body, and answers the hooks meanwhile', async () => {
    const sessionDirectory = makeSessionDirectory();
    const paths = prepareWslHookTransport(sessionDirectory);
    const eventsPath = path.join(sessionDirectory, 'events.jsonl');
    fs.writeFileSync(eventsPath, '');
    let releaseRelay: (answer: string) => void = () => undefined;
    const relayMcp = vi.fn((_input: McpRelayInput) => new Promise<string>((resolve) => { releaseRelay = resolve; }));
    const inbox = new WslHookInbox({ sessionDirectory, eventsOutputPath: eventsPath, onAppended: () => undefined, relayMcp });
    openInboxes.push(inbox);

    writeRequest(paths.requests, '1767225600000000001-7', 'mcp', 'secret-token http://127.0.0.1:4100/mcp/p/s', '{"jsonrpc":"2.0","id":3,"method":"tools/call"}');
    const hintSpec = Buffer.from(JSON.stringify({ toolField: 'tool_name', tools: ['NoSuchTool'], inputField: 'tool_input', commandField: 'command', responseField: 'tool_response', idFields: ['id'], optOutFlag: '--x', reply: { x: 1 } })).toString('base64');
    writeRequest(paths.requests, '1767225600000000002-8', 'background-shell-hint', hintSpec, '{"tool_name":"Read"}');
    inbox.start();

    // The hint is answered while the MCP message is still being relayed.
    await waitFor(() => (fs.existsSync(path.join(paths.responses, '1767225600000000002-8.res')) ? true : null));
    expect(fs.existsSync(path.join(paths.responses, '1767225600000000001-7.res'))).toBe(false);
    fs.writeFileSync(paths.signal, 'xx');
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(relayMcp).toHaveBeenCalledTimes(1);
    expect(relayMcp.mock.calls[0][0]).toMatchObject({
      argument: 'secret-token http://127.0.0.1:4100/mcp/p/s',
      body: '{"jsonrpc":"2.0","id":3,"method":"tools/call"}',
    });

    releaseRelay('{"jsonrpc":"2.0","id":3,"result":{}}\n');
    const answer = await waitFor(() => {
      try { return fs.readFileSync(path.join(paths.responses, '1767225600000000001-7.res'), 'utf-8'); } catch { return null; }
    });
    expect(answer).toBe('{"jsonrpc":"2.0","id":3,"result":{}}\n');
    await waitFor(() => (fs.readdirSync(paths.requests).length === 0 ? true : null));
  });

  it('ends a relay still running when the session ends', async () => {
    const sessionDirectory = makeSessionDirectory();
    const paths = prepareWslHookTransport(sessionDirectory);
    const eventsPath = path.join(sessionDirectory, 'events.jsonl');
    fs.writeFileSync(eventsPath, '');
    let relaySignal: AbortSignal | undefined;
    const relayMcp = vi.fn((input: McpRelayInput) => {
      relaySignal = input.signal;
      return new Promise<string>(() => undefined);
    });
    const inbox = new WslHookInbox({ sessionDirectory, eventsOutputPath: eventsPath, onAppended: () => undefined, relayMcp });
    writeRequest(paths.requests, '1767225600000000001-7', 'mcp', 'token http://127.0.0.1:4100/mcp/p', '{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
    inbox.start();
    await waitFor(() => (relayMcp.mock.calls.length > 0 ? true : null));

    inbox.close();

    expect(relaySignal?.aborted).toBe(true);
  });
});

describe('records', () => {
  it('reads a record back as its head, argument and stdin, the stdin byte for byte', () => {
    expect(parseWslHookRecord('K1\ntool_start\na:1 b:2\n{"x":"line\\nbreak"}\nmore'))
      .toEqual({ head: 'tool_start', argument: 'a:1 b:2', stdin: '{"x":"line\\nbreak"}\nmore' });
    expect(parseWslHookRecord('K1\nidle\n\n')).toEqual({ head: 'idle', argument: '', stdin: '' });
  });

  it('refuses anything this format did not write', () => {
    expect(parseWslHookRecord('K2\nidle\n\n')).toBeNull();
    expect(parseWslHookRecord('K1\nidle')).toBeNull();
  });

  it('takes the event time from the name, in epoch ms', () => {
    expect(wslHookRecordTime('1767225600123456789-4242.rec')).toBe(1767225600123);
    expect(wslHookRecordTime('.1767225600123456789-4242.tmp')).toBeNull();
    expect(wslHookRecordTime('garbage.rec')).toBeNull();
  });
});

describe.runIf(shAvailable)('the script and the inbox together (needs sh)', () => {
  it('turns an event into the line the event bridge writes, timed by the hook', async () => {
    const sessionDirectory = makeSessionDirectory();
    prepareWslHookTransport(sessionDirectory);
    const eventsPath = path.join(sessionDirectory, 'events.jsonl');
    fs.writeFileSync(eventsPath, '');
    startInbox(sessionDirectory, eventsPath);

    const before = Date.now();
    const result = await runScript(
      sessionDirectory,
      ['event', 'tool_start', ...buildToolStartDirectives()],
      JSON.stringify({ tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: { command: 'ls' } }),
    );
    expect(result).toEqual({ stdout: '', code: 0 });

    const lines = await waitFor(() => { const read = readEventLines(eventsPath); return read.length > 0 ? read : null; });
    const event = JSON.parse(lines[0]) as { ts: number; type: string; tool: string; toolId: string };
    expect(event).toMatchObject({ type: 'tool_start', tool: 'Bash', toolId: 'toolu_1' });
    expect(event.ts).toBeGreaterThanOrEqual(before - 1_000);
    expect(event.ts).toBeLessThanOrEqual(Date.now());
    // The file is gone once its line is in.
    await waitFor(() => (fs.readdirSync(wslHookPaths(sessionDirectory).inbox).length === 0 ? true : null));
  });

  it('keeps every event of parallel hooks, large payloads included, in the order they ran', async () => {
    const sessionDirectory = makeSessionDirectory();
    prepareWslHookTransport(sessionDirectory);
    const eventsPath = path.join(sessionDirectory, 'events.jsonl');
    fs.writeFileSync(eventsPath, '');
    startInbox(sessionDirectory, eventsPath);

    const big = 'x'.repeat(200_000);
    await Promise.all(Array.from({ length: 12 }, (_unused, index) => runScript(
      sessionDirectory,
      ['event', 'tool_start', ...buildToolStartDirectives()],
      JSON.stringify({ tool_name: 'Write', tool_use_id: `toolu_${index}`, tool_input: { content: index % 3 === 0 ? big : 'small' } }),
    )));

    const lines = await waitFor(() => { const read = readEventLines(eventsPath); return read.length >= 12 ? read : null; });
    const ids = lines.map((line) => (JSON.parse(line) as { toolId: string }).toolId).sort();
    expect(ids).toEqual(Array.from({ length: 12 }, (_unused, index) => `toolu_${index}`).sort());
    // Each file is stamped when its stdin is read, just before its rename, so
    // lines land in the order the files appeared. Two hooks finishing together
    // can swap by the few ms between one's stamp and its rename (1 ms measured
    // with a real distro Claude's parallel tools), as the node bridge's appends can.
    const times = lines.map((line) => (JSON.parse(line) as { ts: number }).ts);
    const worstInversion = times.reduce((worst, time, index) => (index === 0 ? 0 : Math.max(worst, times[index - 1] - time)), 0);
    expect(worstInversion).toBeLessThanOrEqual(250);
  });

  it('answers a background shell hint request, and prints nothing for a call it does not answer', async () => {
    const sessionDirectory = makeSessionDirectory();
    prepareWslHookTransport(sessionDirectory);
    const eventsPath = path.join(sessionDirectory, 'events.jsonl');
    fs.writeFileSync(eventsPath, '');
    startInbox(sessionDirectory, eventsPath);
    const spec = Buffer.from(JSON.stringify({
      toolField: 'tool_name', tools: ['Bash'], inputField: 'tool_input', commandField: 'command',
      responseField: 'tool_response', idFields: ['backgroundTaskId'], optOutFlag: '--no-hold',
      reply: { additionalContext: 'shell {{shellId}}' },
    })).toString('base64');

    const answered = await runScript(sessionDirectory, ['reply', 'background-shell-hint', spec],
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'npm run dev' }, tool_response: { backgroundTaskId: 'abc123' } }));
    const ignored = await runScript(sessionDirectory, ['reply', 'background-shell-hint', spec],
      JSON.stringify({ tool_name: 'Read', tool_input: {}, tool_response: {} }));

    expect(answered).toEqual({ stdout: JSON.stringify({ additionalContext: 'shell abc123' }), code: 0 });
    expect(ignored).toEqual({ stdout: '', code: 0 });
    expect(fs.readdirSync(wslHookPaths(sessionDirectory).responses)).toEqual([]);
  });

  it('approves a plan with the marker in the events file before the answer is printed', async () => {
    const sessionDirectory = makeSessionDirectory();
    prepareWslHookTransport(sessionDirectory);
    const eventsPath = path.join(sessionDirectory, 'events.jsonl');
    fs.writeFileSync(eventsPath, '');
    fs.writeFileSync(path.join(sessionDirectory, 'plan-approval.json'), JSON.stringify({ approve: true, mode: 'acceptEdits', detail: 'Moved to Executing' }));
    startInbox(sessionDirectory, eventsPath);
    const spec = Buffer.from(JSON.stringify({
      toolField: 'tool_name', tool: 'ExitPlanMode', inputField: 'tool_input',
      reply: { decision: 'allow', input: '{{toolInput}}', mode: '{{mode}}' },
    })).toString('base64');

    const result = await runScript(sessionDirectory, ['reply', 'plan-approval', spec],
      JSON.stringify({ tool_name: 'ExitPlanMode', tool_input: { plan: 'do it' } }));

    expect(JSON.parse(result.stdout)).toEqual({ decision: 'allow', input: { plan: 'do it' }, mode: 'acceptEdits' });
    const marker = JSON.parse(readEventLines(eventsPath)[0]) as { type: string; detail: string };
    expect(marker).toMatchObject({ type: 'plan_approval_sent', detail: 'Moved to Executing' });
  });

  it('writes the status line\'s JSON over the status file by a rename', async () => {
    const sessionDirectory = makeSessionDirectory();
    prepareWslHookTransport(sessionDirectory);
    const statusPath = path.join(sessionDirectory, 'status.json');
    fs.writeFileSync(statusPath, '{"old":true}');

    const result = await runScript(sessionDirectory, ['status', statusPath], '{"model":{"id":"m"}}');

    expect(result).toEqual({ stdout: '', code: 0 });
    expect(fs.readFileSync(statusPath, 'utf-8')).toBe('{"model":{"id":"m"}}');
    expect(fs.readdirSync(sessionDirectory).filter((name) => name.includes('.tmp'))).toEqual([]);
  });

  // Codex runs one workspace copy of the script for every session in a folder.
  // Red-green: a script that only reads `$0`'s folder publishes beside the copy.
  it('publishes into the folder KANGENTIC_WSL_HOOK_DIR names, from a copy anywhere', async () => {
    const sessionDirectory = makeSessionDirectory();
    const paths = prepareWslHookTransport(sessionDirectory);
    const eventsPath = path.join(sessionDirectory, 'events.jsonl');
    fs.writeFileSync(eventsPath, '');
    startInbox(sessionDirectory, eventsPath);
    const workspace = makeSessionDirectory();
    const copy = path.join(workspace, 'codex-wsl-hook.sh');
    fs.writeFileSync(copy, WSL_HOOK_SCRIPT);

    await runScript(sessionDirectory, ['event', 'prompt'], '{}', { scriptPath: copy, env: { KANGENTIC_WSL_HOOK_DIR: paths.directory } });

    const lines = await waitFor(() => { const read = readEventLines(eventsPath); return read.length > 0 ? read : null; });
    expect((JSON.parse(lines[0]) as { type: string }).type).toBe('prompt');
    expect(fs.readdirSync(workspace)).toEqual(['codex-wsl-hook.sh']);
  });

  // The bridge a distro CLI starts as its stdio MCP server. Red-green: a pipe
  // into publish (`printf | publish`) loses the name the wait loop needs, and
  // the script prints nothing; an unquoted expansion of the line mangles the
  // `$`, the backslash or the backtick.
  it('serves MCP over stdio: a line in, the relay\'s answer out, nothing for a notification', async () => {
    const sessionDirectory = makeSessionDirectory();
    const paths = prepareWslHookTransport(sessionDirectory);
    const eventsPath = path.join(sessionDirectory, 'events.jsonl');
    fs.writeFileSync(eventsPath, '');
    const relayed: McpRelayInput[] = [];
    const relayMcp = vi.fn(async (input: McpRelayInput) => {
      relayed.push(input);
      const message = JSON.parse(input.body) as { id?: number };
      return message.id === undefined ? '' : `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { echoed: input.body.trimEnd() } })}\n`;
    });
    const inbox = new WslHookInbox({ sessionDirectory, eventsOutputPath: eventsPath, onAppended: () => undefined, relayMcp });
    openInboxes.push(inbox);
    inbox.start();

    const awkward = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { text: 'cost $HOME \\ `uname` "quoted"' } });
    const input = [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      awkward,
    ].join('\n') + '\n';
    const result = await runScript(sessionDirectory, ['mcp', 'http://127.0.0.1:4100/mcp/p/s'], input, { env: { KANGENTIC_MCP_TOKEN: 'secret-token' } });

    const answers = result.stdout.split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line) as { id: number; result: { echoed: string } });
    expect(answers.map((answer) => answer.id)).toEqual([1, 2]);
    expect(answers[1].result.echoed).toBe(awkward);
    expect(relayed.map((entry) => entry.argument)).toEqual(Array(3).fill('secret-token http://127.0.0.1:4100/mcp/p/s'));
    // Byte for byte, with the line break the here-document ends it with.
    expect(relayed[2].body).toBe(`${awkward}\n`);
    expect(fs.readdirSync(paths.responses)).toEqual([]);
  });

  it('drains what is still waiting synchronously, for the exit flush', async () => {
    const sessionDirectory = makeSessionDirectory();
    const paths = prepareWslHookTransport(sessionDirectory);
    const eventsPath = path.join(sessionDirectory, 'events.jsonl');
    fs.writeFileSync(eventsPath, '');
    // Published while nothing watches, as a SessionEnd lands while the CLI exits.
    await runScript(sessionDirectory, ['event', 'session_end'], '{}');
    const inbox = new WslHookInbox({ sessionDirectory, eventsOutputPath: eventsPath, onAppended: () => undefined });
    openInboxes.push(inbox);
    inbox.start();
    inbox.drainSync();

    expect(readEventLines(eventsPath).map((line) => (JSON.parse(line) as { type: string }).type)).toEqual(['session_end']);
    expect(fs.readdirSync(paths.inbox)).toEqual([]);
  });
});

describe.skipIf(shAvailable)('the script and the inbox together', () => {
  it.skip('needs sh on PATH (Git Bash on Windows); CI\'s Linux runner has it', () => undefined);
});
