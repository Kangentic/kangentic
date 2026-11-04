/**
 * Gemini's built command and the readers that take it apart again.
 *
 * `modelFromGeminiCommand` reads the model back out of a command the REAL
 * builder produced, so every case here builds its command with
 * `GeminiCommandBuilder` and the shell's own quoting (`quoteArg`), never a
 * hand-written string, except where the input is deliberately malformed. The
 * WSL case pins the literal distro path, not a value computed with
 * `cliPathForTarget`, which would pass even with the conversion removed.
 * `parseTranscriptWindow` and `transcriptUsage` are pinned on their two edges:
 * no chat file, and an explicit `transcriptPath`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GeminiAdapter, GeminiCommandBuilder } from '../../src/main/agent/adapters/gemini';
import { modelFromGeminiCommand } from '../../src/main/agent/adapters/gemini/model-display-name';
import { geminiSubagentDirectory } from '../../src/main/agent/adapters/gemini/subagent-usage';
import { resetGeminiUsageCursorsForTests } from '../../src/main/agent/adapters/gemini/transcript-usage';
import type { GeminiCommandOptions } from '../../src/main/agent/adapters/gemini';
import type { CliTarget } from '../../src/main/agent/shared/cli-target';

const MODEL = 'gemini-2.5-pro';

/** Build with the real builder. No eventsOutputPath or MCP wiring, so it writes no settings file. */
function build(overrides: Partial<GeminiCommandOptions>): string {
  return new GeminiCommandBuilder().buildGeminiCommand({
    geminiPath: '/usr/bin/gemini',
    taskId: 'task-1',
    cwd: '/mock/project',
    permissionMode: 'default',
    model: MODEL,
    ...overrides,
  });
}

describe('modelFromGeminiCommand on commands the real builder produced', () => {
  it('reads the model past a bash-quoted readable directory holding an apostrophe', () => {
    const command = build({ shell: 'bash', readableDirectories: ['/mock/o\'brien'] });
    expect(command).toContain('\'/mock/o\'\\\'\'brien\'');
    expect(modelFromGeminiCommand(command)).toBe(MODEL);
  });

  it('reads the model past a fish-quoted readable directory holding an apostrophe', () => {
    const command = build({ shell: 'fish', readableDirectories: ['/mock/o\'brien'] });
    expect(command).toContain('\'/mock/o\\\'brien\'');
    expect(modelFromGeminiCommand(command)).toBe(MODEL);
  });

  it('reads the model past a PowerShell directory whose trailing backslash meets the closing quote', () => {
    const command = build({ shell: 'pwsh', readableDirectories: ['C:\\Users\\dev\\proj\\'] });
    expect(command).toContain('\\"');
    expect(modelFromGeminiCommand(command)).toBe(MODEL);
  });

  it('reads the model past a nushell directory holding a double quote and spaces', () => {
    const command = build({ shell: 'nu', readableDirectories: ['/mock/my "dir"'] });
    expect(command).toContain('\\"dir\\"');
    expect(modelFromGeminiCommand(command)).toBe(MODEL);
  });

  it('reads the model past a nushell directory holding a space', () => {
    const command = build({ shell: 'nu', readableDirectories: ['/mock/my dir'] });
    expect(command).toContain('"/mock/my dir"');
    expect(modelFromGeminiCommand(command)).toBe(MODEL);
  });
});

describe('modelFromGeminiCommand across the single-quote readings (fish escapes, then POSIX literal)', () => {
  const adapter = new GeminiAdapter();

  it('reads the model past a bash-quoted drive root, whose trailing backslash is literal in a POSIX single quote', () => {
    const command = build({ shell: 'bash', readableDirectories: ['C:\\'] });
    expect(command).toContain('\'C:\\\'');
    expect(modelFromGeminiCommand(command)).toBe(MODEL);
    expect(adapter.configuredModelFromCommand(command)).toEqual({ id: MODEL, displayName: 'Gemini 2.5 Pro' });
  });

  it('reads the model past a Git Bash drive root', () => {
    const command = build({ shell: 'C:\\Program Files\\Git\\bin\\bash.exe', readableDirectories: ['C:\\'] });
    expect(modelFromGeminiCommand(command)).toBe(MODEL);
  });

  it('returns no model for the same bash command built without one', () => {
    const command = build({ shell: 'bash', model: undefined, readableDirectories: ['C:\\'] });
    expect(command).not.toContain('--model');
    expect(modelFromGeminiCommand(command)).toBeNull();
    expect(adapter.configuredModelFromCommand(command)).toBeNull();
  });

  it('reads the model past a fish directory holding an apostrophe followed by a space', () => {
    const command = build({ shell: 'fish', readableDirectories: ['/home/dev/o\' brien'] });
    expect(command).toContain('\'/home/dev/o\\\' brien\'');
    expect(modelFromGeminiCommand(command)).toBe(MODEL);
  });

  it('reads the model past a PowerShell drive root', () => {
    expect(modelFromGeminiCommand(build({ shell: 'pwsh', readableDirectories: ['C:\\'] }))).toBe(MODEL);
  });

  it('reads the model past a nushell drive root', () => {
    expect(modelFromGeminiCommand(build({ shell: 'nu', readableDirectories: ['C:\\'] }))).toBe(MODEL);
  });
});

describe('modelFromGeminiCommand with no usable value', () => {
  it('returns null for a --model with nothing after it', () => {
    expect(modelFromGeminiCommand('/usr/bin/gemini --model')).toBeNull();
  });

  it('returns null for a --model whose quoted value is empty', () => {
    expect(modelFromGeminiCommand('/usr/bin/gemini --model ""')).toBeNull();
  });
});

describe('GeminiCommandBuilder readable directories for a Gemini in a WSL distro', () => {
  const place: CliTarget = {
    kind: 'wsl', distro: 'Ubuntu', linuxCliPath: '/home/dev/.local/bin/gemini',
    facts: {
      distro: 'Ubuntu', homeLinux: '/home/dev', homeUnc: '\\\\wsl.localhost\\Ubuntu\\home\\dev',
      uncRoot: '\\\\wsl.localhost\\Ubuntu', interactivePath: '/usr/bin', env: {}, networkingMode: 'mirrored',
    },
  };

  it('hands a Windows-form directory to the distro as its literal /mnt path', () => {
    // toWslPath is a pure string rewrite, so this holds on a Linux host too.
    const command = build({ shell: 'wsl -d Ubuntu', cliTarget: place, readableDirectories: ['C:\\Users\\dev\\other'] });
    expect(command).toContain('--include-directories /mnt/c/Users/dev/other');
    expect(command).not.toContain('C:');
  });
});

describe('Gemini in a WSL distro: the chat path the CLI reports', () => {
  const place: CliTarget = {
    kind: 'wsl', distro: 'Ubuntu', linuxCliPath: '/home/dev/.local/bin/gemini',
    facts: {
      distro: 'Ubuntu', homeLinux: '/home/dev', homeUnc: '\\\\wsl.localhost\\Ubuntu\\home\\dev',
      uncRoot: '\\\\wsl.localhost\\Ubuntu', interactivePath: '/usr/bin', env: {}, networkingMode: 'mirrored',
    },
  };

  // path.win32 semantics are what make the dirname/basename split of a UNC path work.
  it.runIf(process.platform === 'win32')('puts the subagent folder in the distro\'s chats folder as a UNC path', () => {
    const reported = '/home/dev/.gemini/tmp/proj/chats/session-2026-10-01T09-00-7d21b8e4.jsonl';
    const directory = geminiSubagentDirectory('7d21b8e4-5a63-4f0c-b19d-3e8a2c6f4b70', '/home/dev/elsewhere', place, reported);
    expect(directory).toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\dev\\.gemini\\tmp\\proj\\chats\\7d21b8e4-5a63-4f0c-b19d-3e8a2c6f4b70',
    );
  });
});

describe('GeminiAdapter transcript reads', () => {
  let workDirectory: string;
  let savedGeminiHome: string | undefined;

  beforeEach(() => {
    resetGeminiUsageCursorsForTests();
    workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-gemini-words-'));
    savedGeminiHome = process.env.GEMINI_CLI_HOME;
    process.env.GEMINI_CLI_HOME = path.join(workDirectory, 'gemini-home');
    fs.mkdirSync(process.env.GEMINI_CLI_HOME, { recursive: true });
  });

  afterEach(() => {
    if (savedGeminiHome === undefined) delete process.env.GEMINI_CLI_HOME;
    else process.env.GEMINI_CLI_HOME = savedGeminiHome;
    fs.rmSync(workDirectory, { recursive: true, force: true });
  });

  it('parseTranscriptWindow with no chat file for the id returns an empty window at the start byte', async () => {
    const window = await new GeminiAdapter().parseTranscriptWindow(
      '3f2a9c1e-7b64-4d2a-9c11-0a1b2c3d4e5f', path.join(workDirectory, 'project'), 128, 4096,
    );
    expect(window).toEqual({
      entries: [], sourcePath: null, nextByteOffset: 128, totalBytes: 0, firstByteOffset: 128, endByte: 128,
    });
  });

  describe('a run window over a chat file found by agentSessionId and cwd', () => {
    const SESSION_ID = '7d21b8e4-5a63-4f0c-b19d-3e8a2c6f4b70';
    const at = (minute: number): string => new Date(Date.UTC(2026, 9, 1, 9, minute)).toISOString();
    const output = (text: string): unknown => [{ functionResponse: { id: 'x', name: 'tool', response: { output: text } } }];
    let projectCwd: string;

    beforeEach(() => {
      projectCwd = path.join(workDirectory, 'work', 'petclinic');
      const chatsFolder = path.join(process.env.GEMINI_CLI_HOME as string, '.gemini', 'tmp', 'petclinic', 'chats');
      fs.mkdirSync(chatsFolder, { recursive: true });
      const lines = [
        { sessionId: SESSION_ID, projectHash: '4c1e9a07', startTime: at(0), kind: 'main' },
        { id: 'g1', timestamp: at(1), type: 'gemini', content: '', toolCalls: [
          { id: 'call-1', name: 'read_file', args: {}, status: 'success', timestamp: at(1), result: output('x'.repeat(40)) },
        ] },
        { id: 'g2', timestamp: at(10), type: 'gemini', content: '', toolCalls: [
          { id: 'call-2', name: 'run_shell_command', args: {}, status: 'success', timestamp: at(10), result: output('y'.repeat(400)) },
          { id: 'call-3', name: 'run_shell_command', args: {}, status: 'success', timestamp: at(11), result: output('y'.repeat(400)) },
        ] },
      ];
      fs.writeFileSync(
        path.join(chatsFolder, 'session-2026-10-01T09-00-7d21b8e4.jsonl'),
        lines.map((line) => `${JSON.stringify(line)}\n`).join(''),
      );
    });

    it('transcriptToolCounts counts only the calls inside the window', async () => {
      const adapter = new GeminiAdapter();
      const base = { agentSessionId: SESSION_ID, cwd: projectCwd };
      const runOne = await adapter.transcriptToolCounts({ ...base, sinceMs: 0, untilMs: Date.parse(at(5)) });
      const runTwo = await adapter.transcriptToolCounts({ ...base, sinceMs: Date.parse(at(5)), untilMs: null });
      expect(runOne).toMatchObject({ toolCallCount: 1 });
      expect(runTwo).toMatchObject({ toolCallCount: 2 });
    });

    it('transcriptToolResultTokens sums only the results inside the window', async () => {
      const adapter = new GeminiAdapter();
      const base = { agentSessionId: SESSION_ID, cwd: projectCwd };
      const runOne = await adapter.transcriptToolResultTokens({ ...base, sinceMs: 0, untilMs: Date.parse(at(5)) });
      const runTwo = await adapter.transcriptToolResultTokens({ ...base, sinceMs: Date.parse(at(5)), untilMs: null });
      expect(Object.keys(runOne ?? {})).toEqual(['read_file']);
      expect(Object.keys(runTwo ?? {})).toEqual(['run_shell_command']);
    });
  });

  it('transcriptUsage reads an explicit transcriptPath outside Gemini\'s chats folder', async () => {
    const chatPath = path.join(workDirectory, 'elsewhere', 'run.jsonl');
    fs.mkdirSync(path.dirname(chatPath), { recursive: true });
    const lines = [
      { id: 'u1', type: 'user', content: 'hi' },
      { id: 'm1', type: 'gemini', tokens: { input: 100, cached: 40, output: 20, thoughts: 5, total: 125 } },
    ];
    fs.writeFileSync(chatPath, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');

    const usage = await new GeminiAdapter().transcriptUsage({ transcriptPath: chatPath });
    // Input is the full input side (cached included); output adds the thinking tokens.
    expect(usage).toEqual({ inputTokens: 100, outputTokens: 25 });
  });
});
