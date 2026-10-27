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
import { describe, it, expect, afterEach } from 'vitest';
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
  wslStatusLineCommand,
} from '../../src/main/agent/shared/wsl-hook-transport';
import { WslHookInbox } from '../../src/main/pty/readers/wsl-hook-inbox';
import { extractTool, extractToolId } from '../../src/main/agent/shared/directive-builders';

/** The directives a tool_start hook carries, from the real builders. */
function buildToolStartDirectives(): string[] {
  return [extractTool('tool_name'), extractToolId(['tool_use_id'])];
}

const PLACE = {
  kind: 'wsl' as const,
  distro: 'Ubuntu',
  facts: {
    distro: 'Ubuntu', homeLinux: '/home/dev', homeUnc: '\\\\wsl.localhost\\Ubuntu\\home\\dev',
    uncRoot: '\\\\wsl.localhost\\Ubuntu', interactivePath: '/usr/bin', env: {}, networkingMode: 'nat' as const,
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
function runScript(sessionDirectory: string, args: string[], stdin: string): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', [wslHookPaths(sessionDirectory).script, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
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
