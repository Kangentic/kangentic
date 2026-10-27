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
  type WslHookPaths,
} from '../../src/main/agent/shared/wsl-hook-transport';
import { WslHookInbox } from '../../src/main/pty/readers/wsl-hook-inbox';
import type { McpRelayInput } from '../../src/main/pty/readers/wsl-mcp-relay';
import type { CliPlace } from '../../src/main/agent/shared/cli-target';
import { extractTool, extractToolId } from '../../src/main/agent/shared/directive-builders';
import { planApprovalDecisionPath } from '../../src/main/agent/shared/plan-approval-hook';

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

/** Options for `vi.waitFor`: its default budget is 1 s, short of two 250 ms polls under CI load. */
const WAIT = { timeout: 5_000, interval: 20 };

/** A prepared session folder with an empty events file, as the spawn leaves it. */
function prepareSession(): { sessionDirectory: string; paths: WslHookPaths; eventsPath: string } {
  const sessionDirectory = makeSessionDirectory();
  const paths = prepareWslHookTransport(sessionDirectory);
  const eventsPath = path.join(sessionDirectory, 'events.jsonl');
  fs.writeFileSync(eventsPath, '');
  return { sessionDirectory, paths, eventsPath };
}

/** The bytes of a published file: the version line, the head, the argument line, then the stdin. */
function hookRecord(head: string, argument: string, body: string): string {
  return `K1\n${head}\n${argument}\n${body}`;
}

/** Publish a file as the script does: under a dotted temporary name, then renamed into place. */
function publishHookFile(directory: string, fileName: string, content: string): void {
  const temporary = path.join(directory, `.${fileName}.tmp`);
  fs.writeFileSync(temporary, content);
  fs.renameSync(temporary, path.join(directory, fileName));
}

/** The lines of the session's bridge error log, which sits beside the events file. */
function readErrorLogLines(eventsPath: string): string[] {
  try {
    return fs.readFileSync(path.join(path.dirname(eventsPath), 'events-bridge.error.log'), 'utf-8')
      .split('\n').filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

/** The same plan approval spec and stdin the end-to-end plan approval case sends. */
const PLAN_APPROVAL_SPEC = Buffer.from(JSON.stringify({
  toolField: 'tool_name', tool: 'ExitPlanMode', inputField: 'tool_input',
  reply: { decision: 'allow', input: '{{toolInput}}', mode: '{{mode}}' },
})).toString('base64');
const PLAN_APPROVAL_STDIN = JSON.stringify({ tool_name: 'ExitPlanMode', tool_input: { plan: 'do it' } });

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

// The test budget is wider than WAIT, so a wait that never succeeds fails with
// its own assertion instead of vitest's bare 5 s timeout.
describe('the inbox answers requests', { timeout: 15_000 }, () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const REQUEST_NAME = '1767225600000000001-7';

  /**
   * Publish one request, start the inbox, and return the response the hook
   * would print. The inbox writes the response before it removes the request,
   * so once the request is gone its response is in place. A plan approval
   * appends its marker before it writes the response, so a caller can read the
   * events file right after this returns, with nothing more to wait for.
   */
  async function answerOneRequest(session: ReturnType<typeof prepareSession>, content: string): Promise<string> {
    const requestPath = path.join(session.paths.requests, `${REQUEST_NAME}.req`);
    publishHookFile(session.paths.requests, `${REQUEST_NAME}.req`, content);
    startInbox(session.sessionDirectory, session.eventsPath);
    await vi.waitFor(() => expect(fs.existsSync(requestPath)).toBe(false), WAIT);
    return fs.readFileSync(path.join(session.paths.responses, `${REQUEST_NAME}.res`), 'utf-8');
  }

  // Red-green: without the empty response the hook waits out its whole wait
  // for an answer that never comes, and the `.res` read below throws.
  it('answers a request that is not a hook record with an empty response and removes it', async () => {
    const session = prepareSession();

    const response = await answerOneRequest(session, 'this is not a hook request');

    expect(response).toBe('');
    expect(fs.readdirSync(session.paths.requests)).toEqual([]);
  });

  it('answers a request of an unknown kind with an empty response and removes it', async () => {
    const session = prepareSession();

    const response = await answerOneRequest(session, hookRecord('no-such-kind', '', '{}'));

    expect(response).toBe('');
    expect(fs.readdirSync(session.paths.requests)).toEqual([]);
    expect(readEventLines(session.eventsPath)).toEqual([]);
  });

  // The two cases below send the request the control case at the end of this
  // describe answers with a marker, so only the decision differs. Red-green: an
  // inbox that answers a plan whose decision is missing or declines it appends
  // the marker and prints the approval.
  it('answers a plan approval with nothing, and no marker, when there is no decision file', async () => {
    const session = prepareSession();

    const response = await answerOneRequest(session, hookRecord('plan-approval', PLAN_APPROVAL_SPEC, PLAN_APPROVAL_STDIN));

    expect(response).toBe('');
    expect(readEventLines(session.eventsPath)).toEqual([]);
  });

  it('answers a plan approval with nothing, and no marker, when the decision does not approve', async () => {
    const session = prepareSession();
    fs.writeFileSync(
      planApprovalDecisionPath(session.sessionDirectory),
      JSON.stringify({ approve: false, mode: 'acceptEdits', detail: 'Moved to Executing' }),
    );

    const response = await answerOneRequest(session, hookRecord('plan-approval', PLAN_APPROVAL_SPEC, PLAN_APPROVAL_STDIN));

    expect(response).toBe('');
    expect(readEventLines(session.eventsPath)).toEqual([]);
  });

  it('writes the marker and prints the approval when the decision approves (the control for the two cases above)', async () => {
    const session = prepareSession();
    fs.writeFileSync(
      planApprovalDecisionPath(session.sessionDirectory),
      JSON.stringify({ approve: true, mode: 'acceptEdits', detail: 'Moved to Executing' }),
    );

    const response = await answerOneRequest(session, hookRecord('plan-approval', PLAN_APPROVAL_SPEC, PLAN_APPROVAL_STDIN));

    expect(JSON.parse(response)).toEqual({ decision: 'allow', input: { plan: 'do it' }, mode: 'acceptEdits' });
    const markers = readEventLines(session.eventsPath).map((line) => JSON.parse(line) as { type: string; detail: string });
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ type: 'plan_approval_sent', detail: 'Moved to Executing' });
  });

  // The session ended while the decision file was being read: its events file
  // is gone or going, so a marker would outlive it, and nobody waits on a
  // response. The read is held open from a readFile stub, which makes the
  // moment exact: the inbox closes after the request has been taken and
  // before the decision comes back. The decision approves, so an inbox that
  // forgot the check appends the marker (a declining decision would append
  // nothing either way). Closing from inside relayMcp instead would end the
  // drain at its loop guard, before the decision is ever read.
  it('appends no marker and writes no response when the inbox closes while the decision is being read', async () => {
    const session = prepareSession();
    const decisionPath = planApprovalDecisionPath(session.sessionDirectory);
    const decisionText = JSON.stringify({ approve: true, mode: 'acceptEdits', detail: 'Moved to Executing' });
    fs.writeFileSync(decisionPath, decisionText);
    publishHookFile(session.paths.requests, `${REQUEST_NAME}.req`, hookRecord('plan-approval', PLAN_APPROVAL_SPEC, PLAN_APPROVAL_STDIN));

    const originalReadFile = fs.promises.readFile.bind(fs.promises) as (file: unknown, ...rest: unknown[]) => Promise<unknown>;
    let decisionReadRequested = false;
    let finishDecisionRead: () => void = () => undefined;
    vi.spyOn(fs.promises, 'readFile').mockImplementation(((file: unknown, ...rest: unknown[]) => {
      if (file !== decisionPath) return originalReadFile(file, ...rest);
      decisionReadRequested = true;
      return new Promise<string>((resolve) => { finishDecisionRead = () => resolve(decisionText); });
    }) as unknown as typeof fs.promises.readFile);
    const writeFileSpy = vi.spyOn(fs.promises, 'writeFile');

    const inbox = startInbox(session.sessionDirectory, session.eventsPath);
    await vi.waitFor(() => expect(decisionReadRequested).toBe(true), WAIT);
    inbox.close();
    finishDecisionRead();
    // Everything the inbox does with the decision once it is in hand is
    // microtasks and synchronous calls, so one pass of the event loop lets a
    // marker append and a response write begin. This is not a timed wait.
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(readEventLines(session.eventsPath)).toEqual([]);
    expect(writeFileSpy.mock.calls.filter(([target]) => String(target).startsWith(session.paths.responses))).toEqual([]);
    expect(fs.readdirSync(session.paths.responses)).toEqual([]);
  });

  // A relay that fails answers nothing: the bridge reports its own timeout.
  // Red-green: a request left in requests/ is relayed again on every poll;
  // a name that is never released is never relayed again, so the second wait
  // below times out; a response written on failure shows in responses/.
  it('drops a request whose relay fails, writes no response, and relays the same name again later', async () => {
    const session = prepareSession();
    const requestPath = path.join(session.paths.requests, `${REQUEST_NAME}.req`);
    const responsePath = path.join(session.paths.responses, `${REQUEST_NAME}.res`);
    const request = hookRecord('mcp', 'secret-token http://127.0.0.1:4100/mcp/p/s', '{"jsonrpc":"2.0","id":3,"method":"tools/call"}');
    const answer = '{"jsonrpc":"2.0","id":3,"result":{}}\n';
    const relayMcp = vi.fn<(input: McpRelayInput) => Promise<string>>()
      .mockRejectedValueOnce(new Error('relay refused'))
      .mockResolvedValueOnce(answer);
    const inbox = new WslHookInbox({ sessionDirectory: session.sessionDirectory, eventsOutputPath: session.eventsPath, onAppended: () => undefined, relayMcp });
    openInboxes.push(inbox);
    publishHookFile(session.paths.requests, `${REQUEST_NAME}.req`, request);
    inbox.start();

    await vi.waitFor(() => expect(fs.existsSync(requestPath)).toBe(false), WAIT);
    expect(relayMcp).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(session.paths.responses)).toEqual([]);
    await vi.waitFor(() => expect(readErrorLogLines(session.eventsPath).some((line) => line.includes('mcp relay refused'))).toBe(true), WAIT);

    publishHookFile(session.paths.requests, `${REQUEST_NAME}.req`, request);
    fs.appendFileSync(session.paths.signal, 'x');
    await vi.waitFor(() => expect(relayMcp).toHaveBeenCalledTimes(2), WAIT);
    await vi.waitFor(() => expect(fs.readFileSync(responsePath, 'utf-8')).toBe(answer), WAIT);
    await vi.waitFor(() => expect(fs.existsSync(requestPath)).toBe(false), WAIT);
  });
});

describe('the inbox ingests events', { timeout: 15_000 }, () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Red-green: a file that is not a record, left in inbox/, is read again on
  // every poll and logs again each time; a drain that drops it without a word
  // hides a hook that writes a format Kangentic does not read.
  it('deletes a file that is not a hook record and logs it in the bridge error log', async () => {
    const session = prepareSession();
    const fileName = '1767225600000000001-7.rec';
    const onAppended = vi.fn();
    publishHookFile(session.paths.inbox, fileName, 'this is not a hook record');
    const inbox = new WslHookInbox({ sessionDirectory: session.sessionDirectory, eventsOutputPath: session.eventsPath, onAppended });
    openInboxes.push(inbox);
    inbox.start();

    await vi.waitFor(() => expect(fs.existsSync(path.join(session.paths.inbox, fileName))).toBe(false), WAIT);
    await vi.waitFor(() => expect(readErrorLogLines(session.eventsPath).some((line) => line.includes(`not a hook record: ${fileName}`))).toBe(true), WAIT);

    expect(readEventLines(session.eventsPath)).toEqual([]);
    expect(onAppended).not.toHaveBeenCalled();
  });

  // Red-green: without `lastIngestFailure` every drain logs the same failure
  // again (the poll drains every 250 ms while files are pending, so a file the
  // events path keeps refusing fills the log); the log-write count after the
  // three extra drains is then at least 4, not 1. A drain that removed the
  // files after a failed append would leave nothing for the later drains to
  // try, so the count of append attempts stays below 3. The directory at the
  // events path makes the append fail on every OS. The files are real records:
  // a file that is not one adds no lines, so the append is never tried.
  it('keeps the files and logs an append failure once, then ingests them when the events file is writable', async () => {
    const sessionDirectory = makeSessionDirectory();
    const paths = prepareWslHookTransport(sessionDirectory);
    const eventsPath = path.join(sessionDirectory, 'events.jsonl');
    const errorLogPath = path.join(sessionDirectory, 'events-bridge.error.log');
    fs.mkdirSync(eventsPath);
    const names = ['1767225600000000001-7.rec', '1767225600000000002-8.rec'];
    publishHookFile(paths.inbox, names[0], hookRecord('prompt', '', '{}'));
    publishHookFile(paths.inbox, names[1], hookRecord('session_end', '', '{}'));
    const appendAttemptSpy = vi.spyOn(fs, 'appendFileSync');
    const errorLogWriteSpy = vi.spyOn(fs.promises, 'appendFile');
    const appendAttempts = (): number => appendAttemptSpy.mock.calls.filter(([target]) => target === eventsPath).length;
    const errorLogWrites = (): number => errorLogWriteSpy.mock.calls.filter(([target]) => target === errorLogPath).length;
    const ingestFailures = (): string[] => readErrorLogLines(eventsPath).filter((line) => line.includes(' ingest '));

    const inbox = startInbox(sessionDirectory, eventsPath);
    await vi.waitFor(() => expect(errorLogWrites()).toBe(1), WAIT);

    // Three more drains that fail the same way. drainSync runs the append in
    // the call, so the counts below are exact and wait for nothing.
    const attemptsBefore = appendAttempts();
    for (let drain = 0; drain < 3; drain += 1) inbox.drainSync();
    expect(appendAttempts() - attemptsBefore).toBeGreaterThanOrEqual(3);
    expect(errorLogWrites()).toBe(1);
    expect(fs.readdirSync(paths.inbox).sort()).toEqual(names);
    await vi.waitFor(() => expect(ingestFailures()).toHaveLength(1), WAIT);

    // The events path is writable again: the next drain appends, then removes.
    fs.rmdirSync(eventsPath);
    fs.appendFileSync(paths.signal, 'x');
    await vi.waitFor(() => {
      const types = readEventLines(eventsPath).map((line) => (JSON.parse(line) as { type: string }).type);
      expect(types).toEqual(['prompt', 'session_end']);
    }, WAIT);
    await vi.waitFor(() => expect(fs.readdirSync(paths.inbox)).toEqual([]), WAIT);
    expect(errorLogWrites()).toBe(1);
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

  // The real wait is 1000 tries of 10 ms, so the run uses a copy of the script
  // with 3 tries. The copy sits beside the hook folder, and finds the folder
  // through KANGENTIC_WSL_HOOK_DIR, as a Codex workspace copy does. No inbox
  // runs, so nothing answers.
  // Red-green: without the `rm -f` in the timeout branch the request stays in
  // requests/, and the inbox would answer it later, for a hook nobody waits on
  // (a plan approval answered then marks the plan approved while the CLI asks
  // the user). Without the exit the loop never ends and the test times out.
  it('prints nothing, exits 0 and removes its own request when no answer comes in time', async () => {
    const sessionDirectory = makeSessionDirectory();
    const paths = prepareWslHookTransport(sessionDirectory);
    const shortWait = WSL_HOOK_SCRIPT.replace('-gt 1000', '-gt 3');
    // Says why, instead of waiting out the real 10 s, if the wait is ever written another way.
    expect(shortWait).not.toBe(WSL_HOOK_SCRIPT);
    const copy = path.join(sessionDirectory, 'wsl-hook-short-wait.sh');
    fs.writeFileSync(copy, shortWait);

    const result = await runScript(sessionDirectory, ['reply', 'plan-approval', PLAN_APPROVAL_SPEC], PLAN_APPROVAL_STDIN, {
      scriptPath: copy,
      env: { KANGENTIC_WSL_HOOK_DIR: paths.directory },
    });

    expect(result).toEqual({ stdout: '', code: 0 });
    // The script writes the signal byte only after its request is renamed into
    // place, so the empty requests/ below is the script's own removal and not
    // a publish that never happened.
    expect(fs.readFileSync(paths.signal, 'utf-8')).toBe('x');
    expect(fs.readdirSync(paths.requests)).toEqual([]);
    expect(fs.readdirSync(paths.responses)).toEqual([]);
  });

  /**
   * The env that puts a `date` stub first on PATH: `+%s%N` gets
   * `nanosecondsBody` (a shell command), `+%s` gets a fixed second. Null when
   * the host's `sh` does not run the stub (a PATH entry that is not
   * executable, such as a noexec temp folder), which the callers skip on.
   */
  function dateStubEnv(nanosecondsBody: string): Record<string, string> | null {
    const stubDirectory = makeSessionDirectory();
    const stubPath = path.join(stubDirectory, 'date');
    const stub = ['#!/bin/sh', 'case "$1" in', `  "+%s%N") ${nanosecondsBody} ;;`, '  "+%s") echo 1767225600 ;;', 'esac', ''].join('\n');
    fs.writeFileSync(stubPath, stub);
    fs.chmodSync(stubPath, 0o755);
    // Windows spells the variable `Path`: overriding `PATH` would add a second key.
    const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
    const env = { [pathKey]: `${stubDirectory}${path.delimiter}${process.env[pathKey] ?? ''}` };
    const probe = spawnSync('sh', ['-c', 'date +%s'], { env: { ...process.env, ...env }, encoding: 'utf-8' });
    return probe.stdout.trim() === '1767225600' ? env : null;
  }

  // `stamp` asks `date` for epoch nanoseconds and falls back to whole seconds
  // and nine zeros when the answer is not all digits: busybox prints a literal
  // `%N`, and a `date` without the format prints nothing. The stub makes the
  // host's `date` do each, whatever it is. Red-green: with no fallback the
  // file is named for the literal `1767225600%N`, or for nothing, which fails
  // the name pattern and gives the inbox no time to take the event from. The
  // exact time also pins the nine zeros: ten would not parse as epoch ms.
  it.for([
    { label: 'a literal %N, as busybox prints', nanosecondsBody: 'echo "1767225600%N"' },
    { label: 'nothing, as a date without the format does', nanosecondsBody: 'exit 1' },
  ])('names a file by whole seconds when date answers $label', async ({ nanosecondsBody }, { skip }) => {
    const env = dateStubEnv(nanosecondsBody);
    // Skipped, not failed, where a PATH stub cannot reach sh on this host: the
    // fallback is not reachable from here then, and CI's Linux runner runs it.
    if (!env) skip('a date stub on PATH does not reach sh on this host');
    const sessionDirectory = makeSessionDirectory();
    const paths = prepareWslHookTransport(sessionDirectory);

    const result = await runScript(sessionDirectory, ['event', 'prompt'], '{}', { env });

    expect(result).toEqual({ stdout: '', code: 0 });
    const published = fs.readdirSync(paths.inbox);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatch(/^\d{19}-\d+\.rec$/);
    expect(published[0].startsWith('1767225600000000000-')).toBe(true);
    expect(wslHookRecordTime(published[0])).toBe(1767225600000);
  });
});

describe.skipIf(shAvailable)('the script and the inbox together', () => {
  it.skip('needs sh on PATH (Git Bash on Windows); CI\'s Linux runner has it', () => undefined);
});
