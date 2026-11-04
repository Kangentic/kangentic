/**
 * Unit tests for KimiAdapter against Kimi Code CLI 2.x: detection, the command,
 * the session environment, id capture, and registry integration.
 *
 * Every flag and format comes from the CLI's docs and source at 2.4.1 (see the
 * adapter's header). None has been checked against a real run, so these pin our
 * reading of them, and a change of the CLI's shape needs a real probe first.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KimiCommandBuilder, kimiPermissionFlags } from '../../src/main/agent/adapters/kimi/command-builder';
import { lastAssistantText, parseKimiVersion } from '../../src/main/agent/adapters/kimi/kimi-adapter';
import type { SpawnCommandOptions } from '../../src/main/agent/agent-adapter';
import type { PermissionMode } from '../../src/shared/types';
import {
  agentDisplayName,
  agentShortName,
  agentInstallUrl,
} from '../../src/renderer/utils/agent-display-name';

let mockWhichResult: string | Error = '/usr/bin/kimi';
let mockExecVersionStdout = '2.4.1\n';
let mockExecVersionShouldFail = false;
let execVersionCallCount = 0;

vi.mock('which', () => ({
  default: async () => {
    if (mockWhichResult instanceof Error) throw mockWhichResult;
    return mockWhichResult;
  },
}));

vi.mock('../../src/main/agent/shared/exec-version', () => ({
  execVersion: async () => {
    execVersionCallCount++;
    if (mockExecVersionShouldFail) throw new Error('command not found');
    return { stdout: mockExecVersionStdout, stderr: '' };
  },
}));

const { KimiAdapter } = await import('../../src/main/agent/adapters/kimi');

const SESSION_ID = 'session_73013240-b192-422f-99a3-7cf37eac045a';

function makeOptions(overrides: Partial<SpawnCommandOptions> = {}): SpawnCommandOptions {
  return {
    agentPath: '/usr/bin/kimi',
    taskId: 'task-1',
    cwd: '/projects/my-app',
    permissionMode: 'default',
    shell: 'bash',
    mcpServerEnabled: false,
    ...overrides,
  };
}

describe('KimiAdapter', () => {
  let adapter: InstanceType<typeof KimiAdapter>;
  let home: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    adapter = new KimiAdapter();
    mockWhichResult = '/usr/bin/kimi';
    mockExecVersionStdout = '2.4.1\n';
    mockExecVersionShouldFail = false;
    execVersionCallCount = 0;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-kimi-adapter-'));
    savedHome = process.env.KIMI_CODE_HOME;
    process.env.KIMI_CODE_HOME = home;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = savedHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  describe('declarations', () => {
    it('owns no session id, and captures the CLI\'s own', () => {
      expect(adapter.supportsCallerSessionId).toBe(false);
      expect(adapter.capturesInteractiveSessionId).toBe(true);
    });

    it('types every prompt in: its interactive session takes none on the command line', () => {
      expect(adapter.freshPromptDelivery).toBe('typed');
      expect(adapter.resumePromptDelivery).toBe('typed');
    });

    it('offers each of the CLI\'s modes, and the ones it lacks not at all', () => {
      expect(adapter.permissions.map((entry) => entry.mode)).toEqual(['plan', 'default', 'auto', 'bypassPermissions']);
      expect(adapter.defaultPermission).toBe('default');
    });

    it('names the tools its transcripts are read by', () => {
      expect(adapter.subagentSpawnToolName).toBe('Agent');
      expect(adapter.fileChangeTools).toEqual([{ tool: 'Write', pathField: 'path' }, { tool: 'Edit', pathField: 'path' }]);
    });

    it('cannot be the Workflow agent', async () => {
      const { canBeWorkflowAgent } = await import('../../src/main/agent/shared/workflow-agent-capability');
      expect(canBeWorkflowAgent(adapter)).toBe(false);
      // Each reason stands on its own.
      expect(canBeWorkflowAgent({ kangenticMcp: 'per-session', supportsCallerSessionId: true, freshPromptDelivery: 'typed' })).toBe(false);
      expect(canBeWorkflowAgent({ kangenticMcp: 'per-session', supportsCallerSessionId: true })).toBe(true);
      // The folder-shared server alone rules it out: the id and prompt delivery would pass.
      expect(canBeWorkflowAgent({ kangenticMcp: 'shared-folder', supportsCallerSessionId: true })).toBe(false);
    });

    it('reads turn ends from the wire, keeps a parser per session, and scopes transcript reads by time', () => {
      expect(adapter.runtime.reportsTurnEnd).toBe(true);
      expect(adapter.runtime.activity.kind).toBe('hooks_and_pty');
      expect(typeof adapter.runtime.sessionHistory?.createParse).toBe('function');
      expect(adapter.scopesTranscriptReadsByTime).toBe(true);
    });
  });

  describe('prompt and first-output detection', () => {
    const detectIdle = (data: string): boolean => {
      const activity = adapter.runtime.activity;
      return activity.kind === 'hooks_and_pty' ? activity.detectIdle?.(data) ?? false : false;
    };

    it.each(['x\n> ', 'x\n❯ ', '\x1b[?25l> '])('sees an input prompt glyph alone on the cursor row in %j', (data) => {
      expect(detectIdle(data)).toBe(true);
    });

    it('does not take working output for a prompt', () => {
      expect(detectIdle('Doing work...')).toBe(false);
      expect(detectIdle('a > b')).toBe(false);
    });

    it('takes the cursor hiding as the first drawn frame, and nothing else', () => {
      expect(adapter.detectFirstOutput('\x1b[?25l')).toBe(true);
      expect(adapter.detectFirstOutput('plain shell banner')).toBe(false);
    });
  });

  describe('detect', () => {
    /** The detector stats what it probes, so the path has to exist. */
    function installedCli(): string {
      const cliPath = path.join(home, 'kimi');
      fs.writeFileSync(cliPath, '');
      return cliPath;
    }

    it('reads the bare version 2.x prints', async () => {
      const cliPath = installedCli();
      expect(await adapter.detect(cliPath)).toMatchObject({ found: true, path: cliPath, version: '2.4.1' });
    });

    it('falls back to which when no override path', async () => {
      mockWhichResult = installedCli();
      expect(await adapter.detect()).toMatchObject({ found: true, path: mockWhichResult });
    });

    it('does not take the archived 1.x CLI for Kimi Code, which runs no agent from 1.52', async () => {
      mockExecVersionStdout = 'kimi, version 1.52.0\nkimi-cli is no longer maintained.\n';
      expect((await adapter.detect(installedCli())).found).toBe(false);
    });

    it('caches detection until invalidated', async () => {
      const cliPath = installedCli();
      await adapter.detect(cliPath);
      await adapter.detect(cliPath);
      expect(execVersionCallCount).toBe(1);
      adapter.invalidateDetectionCache();
      await adapter.detect(cliPath);
      expect(execVersionCallCount).toBe(2);
    });
  });

  describe('parseKimiVersion', () => {
    it.each([
      ['2.4.1', '2.4.1'],
      ['v2.5.0-canary.20261102033430-40590f6', '2.5.0-canary.20261102033430-40590f6'],
      ['kimi 3.0.0', '3.0.0'],
      // Kimi Code's own releases before 2.0.0, which print the same bare version.
      ['0.43.1', '0.43.1'],
    ])('reads %s', (raw, version) => {
      expect(parseKimiVersion(raw)).toBe(version);
    });

    it.each(['kimi, version 1.37.0', 'kimi-cli, version 1.0.0', 'not a version', ''])('refuses %s', (raw) => {
      expect(parseKimiVersion(raw)).toBeNull();
    });
  });

  describe('buildCommand', () => {
    it('starts the CLI bare, with no working-directory flag', () => {
      const command = adapter.buildCommand(makeOptions());
      expect(command).toContain('/usr/bin/kimi');
      expect(command).not.toContain('-w');
      expect(command).not.toContain('--work-dir');
    });

    it('never carries a prompt, fresh or resumed', () => {
      expect(adapter.buildCommand(makeOptions({ prompt: 'do the thing' }))).not.toContain('do the thing');
      expect(adapter.buildCommand(makeOptions({ prompt: 'do the thing', sessionId: SESSION_ID, resume: true }))).not.toContain('do the thing');
    });

    it('resumes by --session, and continues only when asked', () => {
      expect(adapter.buildCommand(makeOptions({ sessionId: SESSION_ID, resume: true }))).toContain(`--session ${SESSION_ID}`);
      const builder = new KimiCommandBuilder();
      const base = { kimiPath: '/usr/bin/kimi', taskId: 't', cwd: '/w', permissionMode: 'default' as const, shell: 'bash' };
      expect(builder.buildKimiCommand({ ...base, useContinueFallback: true })).toContain('--continue');
      // The two conflict in the CLI, and the explicit id wins.
      const both = builder.buildKimiCommand({ ...base, sessionId: SESSION_ID, useContinueFallback: true });
      expect(both).toContain('--session');
      expect(both).not.toContain('--continue');
    });

    it('passes a model alias, and none when blank', () => {
      expect(adapter.buildCommand(makeOptions({ model: 'kimi-code/k3' }))).toContain('--model');
      expect(adapter.buildCommand(makeOptions({ model: '  ' }))).not.toContain('--model');
    });

    it('maps every permission mode to the CLI\'s flag', () => {
      const expected: Array<[PermissionMode, string[]]> = [
        ['plan', ['--plan']],
        ['default', []],
        ['auto', ['--yolo']],
        ['bypassPermissions', ['--auto']],
        ['acceptEdits', []],
        ['dontAsk', []],
      ];
      for (const [mode, flags] of expected) expect(kimiPermissionFlags(mode)).toEqual(flags);
    });

    it('writes Kangentic\'s server into the folder, and strips it with the last session', () => {
      const cwd = path.join(home, 'project');
      fs.mkdirSync(cwd);
      const session = path.join(home, 'session');
      const configPath = path.join(cwd, '.kimi-code', 'mcp.json');
      const options = (ptySessionId: string) => makeOptions({
        cwd,
        ptySessionId,
        mcpServerEnabled: true,
        mcpServerUrl: 'http://127.0.0.1:9000/mcp/p',
        mcpServerToken: 'secret-token',
        statusOutputPath: path.join(session, 'status.json'),
      });

      const command = adapter.buildCommand(options('session-1'));
      adapter.buildCommand(options('session-2'));
      expect(command).not.toContain('secret-token');
      expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).mcpServers.kangentic).toEqual({
        url: 'http://127.0.0.1:9000/mcp/p',
        bearerTokenEnvVar: 'KANGENTIC_MCP_TOKEN',
      });

      adapter.removeHooks(cwd, 'session-1');
      expect(fs.existsSync(configPath)).toBe(true);
      adapter.removeHooks(cwd, 'session-2');
      expect(fs.existsSync(configPath)).toBe(false);
    });

    it('writes nothing with no token, which the server would refuse', () => {
      const cwd = path.join(home, 'project');
      fs.mkdirSync(cwd);
      adapter.buildCommand(makeOptions({ cwd, mcpServerEnabled: true, mcpServerUrl: 'http://127.0.0.1:9000/mcp/p', statusOutputPath: path.join(home, 'status.json') }));
      expect(fs.existsSync(path.join(cwd, '.kimi-code'))).toBe(false);
    });
  });

  describe('buildEnv', () => {
    it('answers the folder trust prompt and the update preflight for the process', () => {
      const env = adapter.buildEnv(makeOptions());
      expect(env?.KIMI_CODE_TRUST_WORKSPACE).toBe('1');
      expect(env?.KIMI_CODE_NO_AUTO_UPDATE).toBe('1');
    });

    // The folder's mcp.json only names this variable, so without it every
    // Kangentic tool call fails with the server unauthenticated.
    it('carries the MCP token, only for a session whose MCP is wired', () => {
      const wired = makeOptions({ mcpServerEnabled: true, mcpServerUrl: 'http://127.0.0.1:9000/mcp/p', mcpServerToken: 'token-1' });
      expect(adapter.buildEnv(wired)?.KANGENTIC_MCP_TOKEN).toBe('token-1');
      expect(adapter.buildEnv(makeOptions())?.KANGENTIC_MCP_TOKEN).toBeUndefined();
      expect(adapter.buildEnv({ ...wired, mcpServerEnabled: false })?.KANGENTIC_MCP_TOKEN).toBeUndefined();
    });

    // The screen's default is "Migrate now", so the typed first prompt's Enter
    // would pick it. A relative name needs no translation for a WSL distro.
    it('points the legacy data folder at a relative path, which turns the migration screen off', () => {
      const shareDir = adapter.buildEnv(makeOptions())?.KIMI_SHARE_DIR ?? '';
      expect(shareDir).not.toBe('');
      expect(path.isAbsolute(shareDir)).toBe(false);
    });

    it('carries a column\'s effort, which has no flag', () => {
      expect(adapter.buildEnv(makeOptions({ effort: 'high' }))?.KIMI_MODEL_THINKING_EFFORT).toBe('high');
    });
  });

  describe('runtime.sessionId.fromOutput', () => {
    const fromOutput = (data: string) => adapter.runtime.sessionId?.fromOutput?.(data) ?? null;

    it('reads the welcome box on a resume', () => {
      expect(fromOutput(`│ Directory: /w │\n│ Session:   ${SESSION_ID} │`)).toBe(SESSION_ID);
    });

    it('reads the exit hint', () => {
      expect(fromOutput(`To resume this session: kimi -r ${SESSION_ID}`)).toBe(SESSION_ID);
    });

    it('reads the ULID form the docs show', () => {
      expect(fromOutput('Session:   01HZ5K3M9QXV7T2B4N8R6WYCDE')).toBe('01HZ5K3M9QXV7T2B4N8R6WYCDE');
    });

    it('takes a ULID of exactly 26 characters and nothing longer', () => {
      const ulid = '01HZ5K3M9QXV7T2B4N8R6WYCDE';
      expect(ulid).toHaveLength(26);
      expect(fromOutput(`Session: ${ulid}`)).toBe(ulid);
      expect(fromOutput(`Session: ${'A'.repeat(30)}`)).toBeNull();
      expect(fromOutput(`kimi -r ${'A'.repeat(30)}`)).toBeNull();
    });

    it('reads nothing from a new session\'s empty line or plain text', () => {
      expect(fromOutput('Session:   \nNo session yet')).toBeNull();
      expect(fromOutput('the session: it went well')).toBeNull();
    });
  });

  describe('getExitSequence', () => {
    it('stops a running turn, pauses, then quits, with no Ctrl+C an idle prompt only arms', () => {
      expect(adapter.getExitSequence()).toEqual(['\x1b', { delayMs: 400 }, '/exit\r']);
    });
  });

  describe('configuredModelFromCommand', () => {
    it('reads the alias from each shell\'s quoting', () => {
      expect(adapter.configuredModelFromCommand("'/usr/bin/kimi' --model 'kimi-code/k3'")?.id).toBe('kimi-code/k3');
      expect(adapter.configuredModelFromCommand('"C:/kimi.exe" --model "kimi-code/k3"')?.id).toBe('kimi-code/k3');
    });

    it('names it from the config, else by the alias', () => {
      fs.writeFileSync(path.join(home, 'config.toml'), '[models."kimi-code/k3"]\ndisplay_name = "K3"\n');
      expect(adapter.configuredModelFromCommand('kimi --model kimi-code/k3')?.displayName).toBe('K3');
      expect(adapter.configuredModelFromCommand('kimi --model other')?.displayName).toBe('other');
      expect(adapter.modelDisplayName('other')).toBeNull();
    });

    it('finds nothing with no flag', () => {
      expect(adapter.configuredModelFromCommand('kimi --plan')).toBeNull();
    });
  });

  describe('probeAuth', () => {
    it('is true with a credential, and with a configured model', async () => {
      await expect(adapter.probeAuth('/usr/bin/kimi')).resolves.toBe(false);
      fs.mkdirSync(path.join(home, 'credentials'));
      await expect(adapter.probeAuth('/usr/bin/kimi')).resolves.toBe(false);
      fs.writeFileSync(path.join(home, 'credentials', 'kimi-code.json'), '{}');
      await expect(adapter.probeAuth('/usr/bin/kimi')).resolves.toBe(true);
      fs.rmSync(path.join(home, 'credentials'), { recursive: true, force: true });
      fs.writeFileSync(path.join(home, 'config.toml'), '[models.mine]\nmodel = "x"\n');
      await expect(adapter.probeAuth('/usr/bin/kimi')).resolves.toBe(true);
    });
  });

  describe('probeAuth: unreadable and empty credential folders', () => {
    it('cannot tell when credentials is a file, rather than guessing signed out', async () => {
      fs.writeFileSync(path.join(home, 'credentials'), 'not a folder');
      fs.writeFileSync(path.join(home, 'config.toml'), '[models.mine]\nmodel = "x"\n');
      await expect(adapter.probeAuth('/usr/bin/kimi')).resolves.toBeNull();
    });

    it('falls through to the configured models when the folder holds no credential file', async () => {
      fs.mkdirSync(path.join(home, 'credentials'));
      fs.writeFileSync(path.join(home, 'credentials', 'x.txt'), 'note');
      await expect(adapter.probeAuth('/usr/bin/kimi')).resolves.toBe(false);
      fs.writeFileSync(path.join(home, 'config.toml'), '[models.mine]\nmodel = "x"\n');
      await expect(adapter.probeAuth('/usr/bin/kimi')).resolves.toBe(true);
    });
  });

  describe('transcript reads by session', () => {
    const stepEnd = (input: number, output: number, time: number) => JSON.stringify({
      type: 'context.append_loop_event',
      event: { type: 'step.end', uuid: `s${input}`, usage: { inputOther: input, output } },
      time,
    });
    const toolCall = (toolCallId: string, name: string, time: number) => JSON.stringify({
      type: 'context.append_loop_event',
      event: { type: 'tool.call', stepUuid: 's', toolCallId, name, args: {} },
      time,
    });

    function indexSession(sessionDir: string): void {
      fs.appendFileSync(
        path.join(home, 'session_index.jsonl'),
        JSON.stringify({ sessionId: SESSION_ID, sessionDir, workDir: '/projects/my-app' }) + '\n',
      );
    }

    function writeFile(filePath: string, lines: string[]): string {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, lines.join('\n') + '\n');
      return filePath;
    }

    it('reads the wire file the index locates in preference to a stale transcriptPath', async () => {
      const sessionDir = path.join(home, 'sessions', 'ws', SESSION_ID);
      writeFile(path.join(sessionDir, 'agents', 'main', 'wire.jsonl'), [stepEnd(100, 7, 1_792_000_000_000), toolCall('c1', 'Read', 1_792_000_000_000)]);
      const stale = writeFile(path.join(home, 'stale.jsonl'), [stepEnd(1, 1, 1_792_000_000_000), toolCall('c9', 'Bash', 1_792_000_000_000)]);
      indexSession(sessionDir);

      await expect(adapter.transcriptUsage({ transcriptPath: stale, agentSessionId: SESSION_ID })).resolves.toEqual({ inputTokens: 100, outputTokens: 7 });
      const counts = await adapter.transcriptToolCounts({ transcriptPath: stale, agentSessionId: SESSION_ID, sinceMs: 0, untilMs: 1_792_000_000_001 });
      expect(counts?.toolBreakdown.map((stat) => stat.toolName)).toEqual(['Read']);
    });

    it('falls back to transcriptPath for a session the index does not know, and answers nothing with neither', async () => {
      const given = writeFile(path.join(home, 'given.jsonl'), [stepEnd(5, 2, 1_792_000_000_000)]);
      await expect(adapter.transcriptUsage({ transcriptPath: given, agentSessionId: SESSION_ID })).resolves.toEqual({ inputTokens: 5, outputTokens: 2 });
      await expect(adapter.transcriptUsage({ agentSessionId: SESSION_ID })).resolves.toBeNull();
      await expect(adapter.transcriptToolCounts({})).resolves.toBeNull();
    });

    it('signs and reads a session\'s subagent files, and reports an unknown session as having none', async () => {
      const sessionDir = path.join(home, 'sessions', 'ws', SESSION_ID);
      writeFile(path.join(sessionDir, 'agents', 'main', 'wire.jsonl'), [
        JSON.stringify({ type: 'subagent.spawned', subagentId: 'agent-0', subagentName: 'explore', parentToolCallId: 'call-1', time: 1 }),
      ]);
      writeFile(path.join(sessionDir, 'agents', 'agent-0', 'wire.jsonl'), [stepEnd(40, 3, 1_792_000_000_000)]);
      indexSession(sessionDir);

      expect(adapter.statSubagentTranscripts(SESSION_ID, '/projects/my-app')?.fileCount).toBe(1);
      const parsed = await adapter.parseSubagentUsage(SESSION_ID, '/projects/my-app');
      expect(parsed).toMatchObject({ directoryPresent: true, complete: true });
      expect(parsed.turns).toHaveLength(1);
      expect(parsed.turns[0]).toMatchObject({ subagentId: 'agent-0', agentType: 'explore', parentToolUseId: 'call-1' });

      expect(adapter.statSubagentTranscripts('session_unknown', '/projects/my-app')).toBeNull();
      await expect(adapter.parseSubagentUsage('session_unknown', '/projects/my-app')).resolves.toMatchObject({ directoryPresent: false, turns: [], spawnLinks: [] });
    });
  });

  describe('proveConversationGone', () => {
    it('proves only what the index records', async () => {
      await expect(adapter.proveConversationGone({ agentSessionId: SESSION_ID })).resolves.toBe(false);
      fs.writeFileSync(path.join(home, 'session_index.jsonl'), JSON.stringify({ sessionId: SESSION_ID, deleted: true }) + '\n');
      await expect(adapter.proveConversationGone({ agentSessionId: SESSION_ID })).resolves.toBe(true);
    });
  });

  describe('getInjectionSequence', () => {
    it('types nothing, since /model opens a picker', () => {
      expect(adapter.getInjectionSequence({ model: 'a', modelChanged: true, effort: null, effortChanged: false })).toEqual([]);
    });
  });
});

describe('lastAssistantText', () => {
  it('takes the last assistant line of a stream-json run', () => {
    const stdout = [
      JSON.stringify({ role: 'meta', type: 'system.version', version: '2.4.1' }),
      JSON.stringify({ role: 'assistant', content: 'first' }),
      JSON.stringify({ role: 'tool', tool_call_id: 'c', content: 'output' }),
      JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'Fix the login flow' }] }),
      JSON.stringify({ role: 'assistant', tool_calls: [] }),
      JSON.stringify({ role: 'meta', type: 'session.resume_hint', session_id: 's' }),
      'not json',
    ].join('\n');
    expect(lastAssistantText(stdout)).toBe('Fix the login flow');
  });

  it('is empty with no assistant line, which fails the run', () => {
    expect(lastAssistantText('nothing here')).toBe('');
  });
});

describe('Agent Registry', () => {
  it('registers the adapter by name and session type', async () => {
    const { agentRegistry } = await import('../../src/main/agent/agent-registry');
    expect(agentRegistry.getOrThrow('kimi').sessionType).toBe('kimi_agent');
    expect(agentRegistry.getBySessionType('kimi_agent')?.name).toBe('kimi');
  });
});

describe('agent-display-name - kimi entry', () => {
  it('names Kimi Code and points at its live repo, not the archived one', () => {
    expect(agentDisplayName('kimi')).toBe('Kimi Code');
    expect(agentShortName('kimi')).toBe('Kimi');
    expect(agentInstallUrl('kimi')).toBe('https://github.com/MoonshotAI/kimi-code');
  });
});
