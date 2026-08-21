/**
 * Grok Build adapter unit tests.
 *
 * Every empirical constant asserted here (version banner, session-store
 * encoding, updates.jsonl shapes, cost tick unit, hook payload fields) was
 * measured against grok 1.0.0 (3cd0d0cbce) - see the adapter files and
 * scripts/probe-grok.js for the provenance.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setParseWindowBytesForTests } from '../../src/main/agent/shared/transcript-truncation';
import { GrokAdapter } from '../../src/main/agent/adapters/grok/grok-adapter';
import { GrokCommandBuilder, grokMcpWiringEnabled } from '../../src/main/agent/adapters/grok/command-builder';
import type { GrokCommandOptions } from '../../src/main/agent/adapters/grok/command-builder';
import { parseGrokVersion, GrokDetector } from '../../src/main/agent/adapters/grok/detector';
import { buildGrokHooks, writeHooksFile, removeHooksFile } from '../../src/main/agent/adapters/grok/hook-manager';
import { writeMcpConfig, removeMcpConfig } from '../../src/main/agent/adapters/grok/mcp-config';
import {
  grokSessionDir,
  grokUpdatesJsonlPath,
  cwdToSessionsDirName,
  locateGrokUpdatesFile,
} from '../../src/main/agent/adapters/grok/session-paths';
import {
  GrokSessionHistoryParser,
  clearGrokModelsCacheMemo,
  grokModelDisplayName,
} from '../../src/main/agent/adapters/grok/session-history-parser';
import {
  parseGrokTranscript,
  unwrapUserQuery,
  grokTranscriptUsage,
  grokTranscriptToolCounts,
} from '../../src/main/agent/adapters/grok/transcript-parser';
import {
  extractGrokUserTurn,
  createGrokCommandInjectionVerifier,
} from '../../src/main/agent/adapters/grok/command-injection-verifier';
import { cleanGrokTranscript } from '../../src/main/agent/adapters/grok/transcript-cleanup';
import { discoverGrokCapabilities, clearGrokCapabilityMemo } from '../../src/main/agent/adapters/grok/capability-discovery';
import { ensureWorktreeTrust, removeWorktreeTrust } from '../../src/main/agent/adapters/grok/trust-manager';
import { migrateGrokProjectData } from '../../src/main/agent/adapters/grok/project-relocation';
import type { PermissionMode } from '../../src/shared/types';

const SESSION_ID = '01a00b63-e666-71b3-8a30-a1829680cfdc';

let tempGrokHome: string | null = null;
const originalGrokHome = process.env.GROK_HOME;

function useTempGrokHome(): string {
  tempGrokHome = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-home-'));
  process.env.GROK_HOME = tempGrokHome;
  clearGrokModelsCacheMemo();
  clearGrokCapabilityMemo();
  return tempGrokHome;
}

afterEach(() => {
  if (originalGrokHome === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = originalGrokHome;
  if (tempGrokHome) {
    fs.rmSync(tempGrokHome, { recursive: true, force: true });
    tempGrokHome = null;
  }
  clearGrokModelsCacheMemo();
  clearGrokCapabilityMemo();
});

// ---------------------------------------------------------------------------
// Identity + registry
// ---------------------------------------------------------------------------

describe('GrokAdapter identity', () => {
  const adapter = new GrokAdapter();

  it('declares the expected identity', () => {
    expect(adapter.name).toBe('grok');
    expect(adapter.displayName).toBe('Grok Build');
    expect(adapter.sessionType).toBe('grok_agent');
    expect(adapter.supportsCallerSessionId).toBe(true);
  });

  it('offers all six permission modes (1:1 CLI passthrough) with acceptEdits default', () => {
    const modes = adapter.permissions.map((entry) => entry.mode);
    expect(modes).toEqual(['plan', 'default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions']);
    expect(adapter.defaultPermission).toBe('acceptEdits');
  });

  it('declares the hooks-and-pty runtime with a live event parser and history tail', () => {
    expect(adapter.runtime.activity.kind).toBe('hooks_and_pty');
    expect(adapter.runtime.sessionId).toBeUndefined();
    expect(adapter.runtime.statusFile?.isFullRewrite).toBe(false);
    expect(adapter.runtime.statusFile?.parseStatus('{"anything": true}')).toBeNull();
    expect(adapter.runtime.statusFile?.parseEvent('{"ts":1,"type":"idle"}')).toEqual({ ts: 1, type: 'idle' });
    expect(adapter.runtime.sessionHistory?.isFullRewrite).toBe(false);
  });

  it('parseEvent returns null on malformed JSON rather than throwing', () => {
    // status-parser.ts's parseEvent is a bare JSON.parse with a try/catch;
    // pin the failure path so a future refactor cannot let a torn
    // events.jsonl line crash the reader instead of being skipped.
    expect(adapter.runtime.statusFile?.parseEvent('not json at all')).toBeNull();
  });

  it('is registered in the agent registry under name and session type', async () => {
    const { agentRegistry } = await import('../../src/main/agent/agent-registry');
    expect(agentRegistry.has('grok')).toBe(true);
    expect(agentRegistry.list()).toContain('grok');
    expect(agentRegistry.getBySessionType('grok_agent')?.name).toBe('grok');
  });

  it('has renderer display metadata', async () => {
    const { agentDisplayName, agentShortName, agentInstallUrl } = await import('../../src/renderer/utils/agent-display-name');
    expect(agentDisplayName('grok')).toBe('Grok Build');
    expect(agentShortName('grok')).toBe('Grok');
    expect(agentInstallUrl('grok')).toContain('grok-build');
  });

  it('detects first output on the cursor-hide sequence', () => {
    expect(adapter.detectFirstOutput('\x1b[?9001h\x1b[?1004h\x1b[?25l\x1b[2J')).toBe(true);
    expect(adapter.detectFirstOutput('plain shell noise')).toBe(false);
  });

  it('exits via Ctrl+C then /quit', () => {
    expect(adapter.getExitSequence()).toEqual(['\x03', '/quit\r']);
  });

  it('declares the confirm-only verification tier and no slash verification', () => {
    expect(adapter.canEscalateOnVerificationFailure()).toBe(false);
    expect(adapter.canVerifySlashSubmission()).toBe(false);
    expect(typeof adapter.getSubmissionVerifier('command-injection')).toBe('function');
    expect(adapter.getSubmissionVerifier('paste')).toBeNull();
  });

  it('falls back to respawn for model/effort changes (no unverifiable live injection)', () => {
    expect(adapter.getInjectionSequence({ model: 'grok-4.6', modelChanged: true, effort: 'high', effortChanged: true })).toEqual([]);
  });

  it('seeds the board card model from the built command', () => {
    expect(adapter.configuredModelFromCommand('grok -s x --model grok-4.6 -- "hi"')?.id).toBe('grok-4.6');
    expect(adapter.configuredModelFromCommand('grok -s x -- "hi"')).toBeNull();
  });

  it('resolves configuredModelFromCommand\'s displayName from the models cache, falling back to the raw id', () => {
    const home = useTempGrokHome();
    fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({
      models: { 'grok-4.6': { info: { id: 'grok-4.6', name: 'Grok 4.6', context_window: 500000 } } },
    }));
    expect(adapter.configuredModelFromCommand('grok -s x --model grok-4.6 -- "hi"'))
      .toEqual({ id: 'grok-4.6', displayName: 'Grok 4.6' });
    expect(adapter.configuredModelFromCommand('grok -s x --model grok-unlisted -- "hi"'))
      .toEqual({ id: 'grok-unlisted', displayName: 'grok-unlisted' });
  });

  it('only reads --model from the flag region before the end-of-options marker', () => {
    // A prompt that happens to contain the literal text "--model usage" must
    // never be misread as a real flag: only text BEFORE the ` -- ` marker
    // the builder emits ahead of the prompt is a candidate flag region
    // (the parseModelFromClaudeCommand precedent).
    expect(adapter.configuredModelFromCommand("grok -s x -- 'run --model usage now'")).toBeNull();
  });

  it('parses a single-quoted --model value (the unix quoteArg form)', () => {
    expect(adapter.configuredModelFromCommand("grok -s x --model 'my-model' -- 'hi'")?.id).toBe('my-model');
  });
});

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

describe('parseGrokVersion', () => {
  it('accepts the real banner and rejects foreign products', () => {
    expect(parseGrokVersion('grok 1.0.0 (3cd0d0cbce) [stable]')).toBe('1.0.0');
    expect(parseGrokVersion('Cursor Agent 1.0.0')).toBeNull();
    expect(parseGrokVersion('2026.04.29-c83a488')).toBeNull();
    expect(parseGrokVersion('codex-cli 0.128.0')).toBeNull();
  });
});

describe('GrokDetector fallback paths (platform-conditional binary name)', () => {
  // Private-config-access pattern established for GrokDetector in
  // cursor-grok-binary-collision.test.ts / for AntigravityDetector in
  // antigravity-adapter.test.ts. process.platform must be overridden BEFORE
  // constructing the detector: the fallback path is computed once in the
  // constructor, not read lazily per call.
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  function grokDetectorFallbackPaths(): string[] | undefined {
    return (new GrokDetector() as unknown as { config: { fallbackPaths?: string[] } }).config.fallbackPaths;
  }

  it('appends the home-directory fallback as grok.exe on win32', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const fallbackPaths = grokDetectorFallbackPaths();
    expect(fallbackPaths?.at(-1)).toBe(path.join(os.homedir(), '.grok', 'bin', 'grok.exe'));
  });

  it('appends the extensionless home-directory fallback elsewhere (darwin/linux)', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const linuxFallbackPaths = grokDetectorFallbackPaths();
    expect(linuxFallbackPaths?.at(-1)).toBe(path.join(os.homedir(), '.grok', 'bin', 'grok'));

    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const darwinFallbackPaths = grokDetectorFallbackPaths();
    expect(darwinFallbackPaths?.at(-1)).toBe(path.join(os.homedir(), '.grok', 'bin', 'grok'));
  });
});

// ---------------------------------------------------------------------------
// Command builder
// ---------------------------------------------------------------------------

describe('GrokCommandBuilder', () => {
  const builder = new GrokCommandBuilder();
  const baseOptions = {
    grokPath: '/usr/bin/grok',
    taskId: 'task-1',
    cwd: '/project',
    permissionMode: 'acceptEdits' as PermissionMode,
    shell: 'bash',
  };

  it('builds a new session with -s, permission passthrough, and a guarded positional prompt', () => {
    const command = builder.buildGrokCommand({
      ...baseOptions,
      sessionId: SESSION_ID,
      prompt: 'fix the bug',
    });
    expect(command).toContain(`-s ${SESSION_ID}`);
    expect(command).toContain('--permission-mode acceptEdits');
    expect(command).toContain("-- 'fix the bug'");
    expect(command).not.toContain('--resume');
    expect(command).not.toContain('--cwd');
    expect(command).not.toContain('--fullscreen');
    expect(command).not.toContain('--minimal');
    expect(command).not.toContain('--always-approve');
  });

  it('passes every permission mode through 1:1', () => {
    const modes: PermissionMode[] = ['default', 'plan', 'acceptEdits', 'dontAsk', 'bypassPermissions', 'auto'];
    for (const mode of modes) {
      const command = builder.buildGrokCommand({ ...baseOptions, permissionMode: mode });
      expect(command).toContain(`--permission-mode ${mode}`);
    }
  });

  it('resumes with --resume and never re-sends the prompt', () => {
    const command = builder.buildGrokCommand({
      ...baseOptions,
      sessionId: SESSION_ID,
      resume: true,
      prompt: 'fix the bug',
    });
    expect(command).toContain(`--resume ${SESSION_ID}`);
    expect(command).not.toContain(`-s ${SESSION_ID}`);
    expect(command).not.toContain('fix the bug');
  });

  it('emits model and effort flags only when set', () => {
    const bare = builder.buildGrokCommand({ ...baseOptions });
    expect(bare).not.toContain('--model');
    expect(bare).not.toContain('--reasoning-effort');

    const withOverrides = builder.buildGrokCommand({ ...baseOptions, model: 'grok-4.6', effort: 'xhigh' });
    expect(withOverrides).toContain('--model grok-4.6');
    expect(withOverrides).toContain('--reasoning-effort xhigh');
  });

  it('builds headless mode with -p and plain output', () => {
    const command = builder.buildGrokCommand({ ...baseOptions, nonInteractive: true, prompt: 'summarize this' });
    expect(command).toContain("-p 'summarize this'");
    expect(command).toContain('--output-format plain');
  });

  it('swaps double quotes on PowerShell to survive quoteArg escaping', () => {
    const command = builder.buildGrokCommand({
      ...baseOptions,
      shell: 'powershell',
      prompt: 'say "hello"',
    });
    expect(command).not.toContain('\\"hello\\"');
    expect(command).toContain("'hello'");
  });

  it('routes per-session values through env, never argv', () => {
    const options = {
      ...baseOptions,
      eventsOutputPath: '/project/.kangentic/sessions/s1/events.jsonl',
      mcpServerUrl: 'http://127.0.0.1:4100/mcp/p1/s1',
      mcpServerToken: 'secret-token',
    };
    expect(grokMcpWiringEnabled(options)).toBe(true);
    const env = builder.buildGrokEnv(options);
    expect(env).toEqual({
      KANGENTIC_EVENTS_PATH: '/project/.kangentic/sessions/s1/events.jsonl',
      KANGENTIC_MCP_URL: 'http://127.0.0.1:4100/mcp/p1/s1',
      KANGENTIC_MCP_TOKEN: 'secret-token',
    });
  });

  it('never leaks the MCP URL or token into argv, and pre-approves kangentic MCP tools', () => {
    const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-cmd-'));
    try {
      const command = builder.buildGrokCommand({
        ...baseOptions,
        cwd: tempCwd,
        sessionId: SESSION_ID,
        prompt: 'go',
        mcpServerUrl: 'http://127.0.0.1:4100/mcp/p1/s1',
        mcpServerToken: 'secret-token',
      });
      expect(command).not.toContain('secret-token');
      expect(command).not.toContain('127.0.0.1:4100');
      // The Claude-parity allow rule: without it, a board-driven session
      // stalls on grok's approval prompt for kangentic's own MCP tools.
      expect(command).toContain("--allow 'MCPTool(kangentic__*)'");
    } finally {
      fs.rmSync(tempCwd, { recursive: true, force: true });
    }
  });

  it('emits no MCP allow rule when the server is not attached', () => {
    const command = builder.buildGrokCommand({ ...baseOptions, sessionId: SESSION_ID, prompt: 'go' });
    expect(command).not.toContain('--allow');
  });

  it('suppresses MCP env when disabled or incomplete', () => {
    expect(builder.buildGrokEnv({ ...baseOptions })).toBeNull();
    expect(builder.buildGrokEnv({
      ...baseOptions,
      mcpServerEnabled: false,
      mcpServerUrl: 'http://x',
      mcpServerToken: 't',
    })).toBeNull();
    expect(grokMcpWiringEnabled({ ...baseOptions, mcpServerUrl: 'http://x' })).toBe(false);
  });

  it('returns ONLY the events path when events output is set and MCP wiring is not enabled', () => {
    // Distinct from the "routes per-session values through env" test above
    // (which sets all three env vars) and the "suppresses" test (which
    // asserts null): this pins the partial shape when only events wiring
    // applies.
    const env = builder.buildGrokEnv({
      ...baseOptions,
      eventsOutputPath: '/project/.kangentic/sessions/s1/events.jsonl',
    });
    expect(env).toEqual({
      KANGENTIC_EVENTS_PATH: '/project/.kangentic/sessions/s1/events.jsonl',
    });
  });

  it('quotePrompt falls back to process.platform detection when shell is undefined', () => {
    // Transient / Command Terminal spawns pass no shell. Mirrors the
    // property-descriptor platform-override pattern from
    // command-builder.test.ts ("undefined shell falls back to platform
    // detection").
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const winCommand = builder.buildGrokCommand({
        ...baseOptions,
        shell: undefined,
        sessionId: SESSION_ID,
        prompt: 'say "hello"',
      });
      expect(winCommand).not.toContain('\\"hello\\"');
      expect(winCommand).toContain("'hello'");

      Object.defineProperty(process, 'platform', { value: 'linux' });
      const posixCommand = builder.buildGrokCommand({
        ...baseOptions,
        shell: undefined,
        sessionId: SESSION_ID,
        prompt: 'say "hello"',
      });
      expect(posixCommand).toContain('"hello"');
      expect(posixCommand).not.toContain("'hello'");
    } finally {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
  });
});

// ---------------------------------------------------------------------------
// Hook manager + MCP config files
// ---------------------------------------------------------------------------

function decodeDirective(token: string): { kind: string; payload: unknown } {
  const colonIndex = token.indexOf(':');
  const kind = token.slice(0, colonIndex);
  const payload = JSON.parse(Buffer.from(token.slice(colonIndex + 1), 'base64').toString('utf8'));
  return { kind, payload };
}

describe('buildGrokHooks', () => {
  const hooks = buildGrokHooks('/bridge/event-bridge.js');

  it('wires every lifecycle event through the env-sentinel bridge command', () => {
    const expectedEvents = [
      'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'Stop',
      'StopFailure', 'SessionStart', 'SessionEnd', 'SubagentStart', 'SubagentStop',
      'PermissionDenied', 'Notification', 'PreCompact',
    ];
    expect(Object.keys(hooks).sort()).toEqual([...expectedEvents].sort());
    for (const entries of Object.values(hooks)) {
      for (const entry of entries) {
        for (const hook of entry.hooks) {
          expect(hook.command).toContain('"/bridge/event-bridge.js"');
          expect(hook.command).toContain('"env:KANGENTIC_EVENTS_PATH"');
        }
      }
    }
  });

  it("extracts grok's camelCase payload fields on tool events", () => {
    // Command shape: node "<bridge>" "env:KANGENTIC_EVENTS_PATH" <type> <directives...>
    const preToolCommand = hooks.PreToolUse[0].hooks[0].command;
    const tokens = preToolCommand.split(' ');
    expect(tokens[3]).toBe('tool_start');
    const directives = tokens.slice(4).map(decodeDirective);
    expect(directives[0]).toEqual({ kind: 'extractTool', payload: { field: 'toolName' } });
    expect(directives[1]).toEqual({ kind: 'extractToolId', payload: { fields: ['toolUseId'] } });
    // Pinned exactly (not toMatchObject) so a field silently dropped from or
    // added to buildGrokHooks's PreToolUse detail list is caught here.
    expect(directives[2]).toEqual({
      kind: 'extractDetail',
      payload: {
        fields: ['command', 'target_file', 'file_path', 'path', 'query', 'pattern', 'url', 'description'],
        nested: 'toolInput',
      },
    });
  });

  it('maps PostToolUse to tool_end with tool-name/tool-id extraction and NO error-detail directive', () => {
    // Unlike PostToolUseFailure (asserted below), a successful tool
    // completion carries no error/errorDetails directive - only the
    // tool-name and tool-id extractors.
    const postToolUseTokens = hooks.PostToolUse[0].hooks[0].command.split(' ');
    expect(postToolUseTokens[3]).toBe('tool_end');
    const directives = postToolUseTokens.slice(4).map(decodeDirective);
    expect(directives).toHaveLength(2);
    expect(directives[0]).toEqual({ kind: 'extractTool', payload: { field: 'toolName' } });
    expect(directives[1]).toEqual({ kind: 'extractToolId', payload: { fields: ['toolUseId'] } });
    expect(directives.some((directive) => directive.kind === 'extractDetail')).toBe(false);
  });

  it('maps Stop to idle and remaps transient StopFailure classes to turn_retrying', () => {
    expect(hooks.Stop[0].hooks[0].command.split(' ')[3]).toBe('idle');

    const stopFailureTokens = hooks.StopFailure[0].hooks[0].command.split(' ');
    expect(stopFailureTokens[3]).toBe('turn_failed');
    const directives = stopFailureTokens.slice(4).map(decodeDirective);
    const remaps = directives.filter((directive) => directive.kind === 'setTypeWhenDetailContains');
    expect(remaps.map((directive) => (directive.payload as { contains: string }).contains).sort())
      .toEqual(['rate_limit', 'server_error']);
  });

  it('decodes payload fields for PostToolUseFailure, SessionEnd, SubagentStart/Stop, PermissionDenied, Notification, and PreCompact', () => {
    const postToolUseFailureTokens = hooks.PostToolUseFailure[0].hooks[0].command.split(' ');
    expect(postToolUseFailureTokens[3]).toBe('tool_end');
    const postFailureDirectives = postToolUseFailureTokens.slice(4).map(decodeDirective);
    expect(postFailureDirectives[0]).toEqual({ kind: 'extractTool', payload: { field: 'toolName' } });
    expect(postFailureDirectives[1]).toEqual({ kind: 'extractToolId', payload: { fields: ['toolUseId'] } });
    expect(postFailureDirectives[2]).toEqual({ kind: 'extractDetail', payload: { fields: ['error', 'errorDetails'] } });

    const sessionEndTokens = hooks.SessionEnd[0].hooks[0].command.split(' ');
    expect(sessionEndTokens[3]).toBe('session_end');
    expect(sessionEndTokens).toHaveLength(4);

    const subagentStartTokens = hooks.SubagentStart[0].hooks[0].command.split(' ');
    expect(subagentStartTokens[3]).toBe('subagent_start');
    expect(decodeDirective(subagentStartTokens[4])).toEqual({
      kind: 'extractDetail', payload: { fields: ['subagentType', 'agentType'] },
    });

    const subagentStopTokens = hooks.SubagentStop[0].hooks[0].command.split(' ');
    expect(subagentStopTokens[3]).toBe('subagent_stop');
    expect(decodeDirective(subagentStopTokens[4])).toEqual({
      kind: 'extractDetail', payload: { fields: ['subagentType', 'agentType'] },
    });

    const permissionDeniedTokens = hooks.PermissionDenied[0].hooks[0].command.split(' ');
    expect(permissionDeniedTokens[3]).toBe('notification');
    expect(decodeDirective(permissionDeniedTokens[4])).toEqual({
      kind: 'extractDetail', payload: { fields: ['toolName', 'message'] },
    });

    const notificationTokens = hooks.Notification[0].hooks[0].command.split(' ');
    expect(notificationTokens[3]).toBe('notification');
    expect(decodeDirective(notificationTokens[4])).toEqual({
      kind: 'extractDetail', payload: { fields: ['message', 'notification', 'text'] },
    });

    const preCompactTokens = hooks.PreCompact[0].hooks[0].command.split(' ');
    expect(preCompactTokens[3]).toBe('compact');
    expect(preCompactTokens).toHaveLength(4);
  });
});

describe('git-exclude seeding', () => {
  const builder = new GrokCommandBuilder();
  let tempCwd: string;

  const excludePath = () => path.join(tempCwd, '.git', 'info', 'exclude');

  const build = (overrides: Partial<GrokCommandOptions> = {}) =>
    builder.buildGrokCommand({
      grokPath: '/usr/bin/grok',
      taskId: 'task-1',
      cwd: tempCwd,
      permissionMode: 'acceptEdits' as PermissionMode,
      shell: 'bash',
      ...overrides,
    });

  beforeEach(() => {
    tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-exclude-'));
    fs.mkdirSync(path.join(tempCwd, '.git'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempCwd, { recursive: true, force: true });
  });

  it('full spawn seeds the hook file, config.toml, and .kangentic/', () => {
    build({
      eventsOutputPath: path.join(tempCwd, '.kangentic', 'sessions', 's1', 'events.jsonl'),
      mcpServerUrl: 'http://127.0.0.1:4100/mcp/p1/s1',
      mcpServerToken: 'secret-token',
    });
    const content = fs.readFileSync(excludePath(), 'utf-8');
    expect(content).toContain('.grok/hooks/kangentic.json');
    expect(content).toContain('.grok/config.toml');
    expect(content).toContain('.kangentic/');
  });

  it('never excludes a pre-existing user config.toml, but still excludes the hook file', () => {
    // Also pins the seed-BEFORE-write ordering: after the build the managed
    // block has been appended, so a post-write existence check could never
    // distinguish the user's config.toml from a Kangentic-created one.
    fs.mkdirSync(path.join(tempCwd, '.grok'), { recursive: true });
    fs.writeFileSync(path.join(tempCwd, '.grok', 'config.toml'), '[settings]\ntheme = "dark"\n');
    build({
      eventsOutputPath: path.join(tempCwd, '.kangentic', 'sessions', 's1', 'events.jsonl'),
      mcpServerUrl: 'http://127.0.0.1:4100/mcp/p1/s1',
      mcpServerToken: 'secret-token',
    });
    const content = fs.readFileSync(excludePath(), 'utf-8');
    expect(content).not.toContain('.grok/config.toml');
    expect(content).toContain('.grok/hooks/kangentic.json');
  });

  it('events-only spawn seeds the hook file and .kangentic/ but not config.toml', () => {
    build({
      eventsOutputPath: path.join(tempCwd, '.kangentic', 'sessions', 's1', 'events.jsonl'),
      mcpServerEnabled: false,
    });
    const content = fs.readFileSync(excludePath(), 'utf-8');
    expect(content).toContain('.grok/hooks/kangentic.json');
    expect(content).toContain('.kangentic/');
    expect(content).not.toContain('.grok/config.toml');
  });

  it('MCP-only spawn (no eventsOutputPath) seeds config.toml and .kangentic/ but not the hook file', () => {
    build({
      mcpServerUrl: 'http://127.0.0.1:4100/mcp/p1/s1',
      mcpServerToken: 'secret-token',
    });
    const content = fs.readFileSync(excludePath(), 'utf-8');
    expect(content).toContain('.grok/config.toml');
    expect(content).toContain('.kangentic/');
    expect(content).not.toContain('.grok/hooks/kangentic.json');
  });

  it('seeds nothing when neither events nor MCP are wired', () => {
    build({ mcpServerEnabled: false });
    expect(fs.existsSync(excludePath())).toBe(false);
  });
});

describe('hooks file + MCP config lifecycle', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-proj-'));
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('writes a wholly-owned hooks file and prunes it (and empty dirs) on removal', () => {
    writeHooksFile(projectDir);
    const hooksPath = path.join(projectDir, '.grok', 'hooks', 'kangentic.json');
    const parsed = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
    expect(Object.keys(parsed.hooks)).toContain('Stop');

    removeHooksFile(projectDir);
    expect(fs.existsSync(hooksPath)).toBe(false);
    expect(fs.existsSync(path.join(projectDir, '.grok'))).toBe(false);
  });

  it('never deletes user hook files or a non-empty .grok directory', () => {
    const userHookPath = path.join(projectDir, '.grok', 'hooks', 'my-hooks.json');
    fs.mkdirSync(path.dirname(userHookPath), { recursive: true });
    fs.writeFileSync(userHookPath, '{"hooks":{}}');

    writeHooksFile(projectDir);
    removeHooksFile(projectDir);
    expect(fs.existsSync(userHookPath)).toBe(true);
  });

  it('swallows a writeHooksFile filesystem failure via console.error and never throws', () => {
    // '.grok' exists as a plain FILE, so mkdirSync(recursive) for
    // '.grok/hooks' fails with ENOTDIR - the write is best-effort, so the
    // failure must be logged and swallowed, never thrown.
    fs.writeFileSync(path.join(projectDir, '.grok'), 'not a directory');
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => writeHooksFile(projectDir)).not.toThrow();
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('swallows a removeHooksFile filesystem failure and never throws', () => {
    fs.writeFileSync(path.join(projectDir, '.grok'), 'not a directory');
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => removeHooksFile(projectDir)).not.toThrow();
    consoleErrorSpy.mockRestore();
  });

  it('writes a static env-referencing MCP block and strips only its own block', () => {
    const configPath = path.join(projectDir, '.grok', 'config.toml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const userContent = '[mcp_servers.mine]\nurl = "https://example.com/mcp"\n';
    fs.writeFileSync(configPath, userContent);

    writeMcpConfig(projectDir);
    const written = fs.readFileSync(configPath, 'utf-8');
    expect(written).toContain(userContent.trim());
    expect(written).toContain('[mcp_servers.kangentic]');
    expect(written).toContain('url = "${KANGENTIC_MCP_URL}"');
    expect(written).toContain('"X-Kangentic-Token" = "${KANGENTIC_MCP_TOKEN}"');

    // Idempotent: a second write does not duplicate the block.
    writeMcpConfig(projectDir);
    const rewritten = fs.readFileSync(configPath, 'utf-8');
    expect(rewritten.match(/\[mcp_servers\.kangentic\]/g)).toHaveLength(1);

    removeMcpConfig(projectDir);
    const remaining = fs.readFileSync(configPath, 'utf-8');
    expect(remaining).toContain('[mcp_servers.mine]');
    expect(remaining).not.toContain('kangentic');
  });

  it('deletes the config file (and empty .grok dir) when only our block existed', () => {
    writeMcpConfig(projectDir);
    const configPath = path.join(projectDir, '.grok', 'config.toml');
    expect(fs.existsSync(configPath)).toBe(true);

    removeMcpConfig(projectDir);
    expect(fs.existsSync(configPath)).toBe(false);
    expect(fs.existsSync(path.join(projectDir, '.grok'))).toBe(false);
  });

  it('refcounts wiring removal across concurrent sessions in one cwd', () => {
    const adapter = new GrokAdapter();
    const spawnOptions = {
      agentPath: '/usr/bin/grok',
      cwd: projectDir,
      permissionMode: 'acceptEdits' as PermissionMode,
      eventsOutputPath: path.join(projectDir, 'events.jsonl'),
    };
    adapter.buildCommand({ ...spawnOptions, taskId: 'task-a' });
    adapter.buildCommand({ ...spawnOptions, taskId: 'task-b' });
    const hooksPath = path.join(projectDir, '.grok', 'hooks', 'kangentic.json');
    expect(fs.existsSync(hooksPath)).toBe(true);

    adapter.removeHooks(projectDir, 'task-a');
    expect(fs.existsSync(hooksPath)).toBe(true);

    adapter.removeHooks(projectDir, 'task-b');
    expect(fs.existsSync(hooksPath)).toBe(false);
  });

  it('writes the sentinel MCP block to disk for an MCP-only spawn and refcounts its removal', () => {
    // No eventsOutputPath: this spawn participates ONLY in the MCP wiring,
    // not the hooks-file wiring, so the hooks file must never appear while
    // the config.toml block is written and refcounted exactly like the
    // events-driven case above.
    const adapter = new GrokAdapter();
    const spawnOptions = {
      agentPath: '/usr/bin/grok',
      cwd: projectDir,
      permissionMode: 'acceptEdits' as PermissionMode,
      mcpServerUrl: 'http://127.0.0.1:4100/mcp/p1/s1',
      mcpServerToken: 'secret-token',
    };
    adapter.buildCommand({ ...spawnOptions, taskId: 'task-a' });

    const configPath = path.join(projectDir, '.grok', 'config.toml');
    const hooksPath = path.join(projectDir, '.grok', 'hooks', 'kangentic.json');
    expect(fs.existsSync(hooksPath)).toBe(false);
    const written = fs.readFileSync(configPath, 'utf-8');
    expect(written).toContain('[mcp_servers.kangentic]');
    expect(written).toContain('url = "${KANGENTIC_MCP_URL}"');
    expect(written).toContain('"X-Kangentic-Token" = "${KANGENTIC_MCP_TOKEN}"');

    adapter.buildCommand({ ...spawnOptions, taskId: 'task-b' });
    adapter.removeHooks(projectDir, 'task-a');
    expect(fs.existsSync(configPath)).toBe(true);

    adapter.removeHooks(projectDir, 'task-b');
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('leaves no .kangentic-tmp or .kangentic-backup file behind after write and remove', () => {
    // writeMcpConfig / removeMcpConfig now go through the atomic
    // write-temp + rename helper with `backup: false` (config.toml is the
    // user's own file, and rename-replace already preserves the original on
    // any failure before the rename - a per-spawn backup file would litter
    // .grok/). Both the temp file and any backup file must be gone once the
    // write settles.
    const configPath = path.join(projectDir, '.grok', 'config.toml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '[settings]\ntheme = "dark"\n');

    writeMcpConfig(projectDir);
    expect(fs.existsSync(`${configPath}.kangentic-tmp`)).toBe(false);
    expect(fs.existsSync(`${configPath}.kangentic-backup`)).toBe(false);

    removeMcpConfig(projectDir);
    expect(fs.existsSync(`${configPath}.kangentic-tmp`)).toBe(false);
    expect(fs.existsSync(`${configPath}.kangentic-backup`)).toBe(false);
    expect(fs.readFileSync(configPath, 'utf-8')).toContain('[settings]');
  });

  it('recovers from a truncated managed block (BEGIN present, END missing) by dropping to EOF', () => {
    // Simulates a crash mid-flush: the sentinel BEGIN line landed on disk but
    // the write was cut off before the END sentinel. removeMcpConfig must
    // still drop the whole (partial) block rather than leaving a dangling
    // fragment, while preserving whatever preceded it.
    const configPath = path.join(projectDir, '.grok', 'config.toml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const userContent = '[mcp_servers.mine]\nurl = "https://example.com/mcp"\n';
    fs.writeFileSync(configPath, userContent);

    writeMcpConfig(projectDir);
    const wellFormed = fs.readFileSync(configPath, 'utf-8');
    const endSentinelIndex = wellFormed.indexOf('# END KANGENTIC MANAGED BLOCK');
    expect(endSentinelIndex).toBeGreaterThan(-1);
    const truncated = wellFormed.slice(0, endSentinelIndex);
    fs.writeFileSync(configPath, truncated);

    removeMcpConfig(projectDir);
    const remaining = fs.readFileSync(configPath, 'utf-8');
    expect(remaining).toContain(userContent.trim());
    expect(remaining).not.toContain('kangentic');
  });

  it('swallows a writeMcpConfig filesystem failure and never throws', () => {
    // Same ENOTDIR blocker as the hooks-file failure test above.
    fs.writeFileSync(path.join(projectDir, '.grok'), 'not a directory');
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => writeMcpConfig(projectDir)).not.toThrow();
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('inserts a separator newline before the managed block when existing content has none', () => {
    const configPath = path.join(projectDir, '.grok', 'config.toml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    // Deliberately NO trailing newline.
    const userContent = '[mcp_servers.mine]\nurl = "https://example.com/mcp"';
    fs.writeFileSync(configPath, userContent);

    writeMcpConfig(projectDir);
    const written = fs.readFileSync(configPath, 'utf-8');
    expect(written).toContain(`${userContent}\n# BEGIN KANGENTIC MANAGED BLOCK`);
    // Guards against the separator being dropped (block glued onto the
    // last user line) or doubled (a blank line inserted).
    expect(written).not.toContain(`${userContent}# BEGIN`);
    expect(written).not.toContain(`${userContent}\n\n# BEGIN`);
  });

  it('removeMcpConfig no-ops when the file does not exist', () => {
    const configPath = path.join(projectDir, '.grok', 'config.toml');
    expect(fs.existsSync(configPath)).toBe(false);
    expect(() => removeMcpConfig(projectDir)).not.toThrow();
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('removeMcpConfig no-ops when the file exists without the managed block marker', () => {
    const configPath = path.join(projectDir, '.grok', 'config.toml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const userContent = '[mcp_servers.mine]\nurl = "https://example.com/mcp"\n';
    fs.writeFileSync(configPath, userContent);

    removeMcpConfig(projectDir);
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(userContent);
  });
});

// ---------------------------------------------------------------------------
// Session paths
// ---------------------------------------------------------------------------

describe('session paths', () => {
  it('URL-encodes the raw cwd exactly as the CLI does', () => {
    // Byte-for-byte against a real on-disk session directory name.
    expect(cwdToSessionsDirName('C:\\Users\\dev\\Documents\\GitHub\\kangentic'))
      .toBe('C%3A%5CUsers%5Cdev%5CDocuments%5CGitHub%5Ckangentic');
    expect(cwdToSessionsDirName('/home/dev/project')).toBe('%2Fhome%2Fdev%2Fproject');
  });

  it('honors GROK_HOME for the session store root', () => {
    const home = useTempGrokHome();
    const dir = grokSessionDir('/home/dev/project', SESSION_ID);
    expect(dir).toBe(path.join(home, 'sessions', '%2Fhome%2Fdev%2Fproject', SESSION_ID));
  });
});

// ---------------------------------------------------------------------------
// Session history parser (updates.jsonl)
// ---------------------------------------------------------------------------

function updateLine(update: Record<string, unknown>, paramsMeta?: Record<string, unknown>): string {
  return JSON.stringify({
    timestamp: 1786162871,
    method: 'session/update',
    params: { sessionId: SESSION_ID, update, ...(paramsMeta ? { _meta: paramsMeta } : {}) },
  });
}

describe('GrokSessionHistoryParser', () => {
  it('maps turn_completed to Idle with cumulative cost at 1e-10 USD per tick', () => {
    const home = useTempGrokHome();
    fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({
      models: { 'grok-4.6': { info: { id: 'grok-4.6', name: 'Grok 4.6', context_window: 500000 } } },
    }));

    const content = [
      updateLine({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hi' }, _meta: { modelId: 'grok-4.6' } }),
      updateLine({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } }, { totalTokens: 50000 }),
      updateLine({
        sessionUpdate: 'turn_completed',
        stop_reason: 'end_turn',
        usage: { inputTokens: 541054, outputTokens: 1222, costUsdTicks: 236720000, apiDurationMs: 5980 },
      }),
    ].join('\n');

    const result = GrokSessionHistoryParser.parse(content, 'append');
    expect(result.activity).toBe('idle');
    expect(result.events).toEqual([]);
    expect(result.usage?.model.id).toBe('grok-4.6');
    expect(result.usage?.model.displayName).toBe('Grok 4.6');
    // Context occupancy comes from the running _meta.totalTokens, NEVER the
    // cumulative turn_completed inputTokens (541k would blow past the bar).
    expect(result.usage?.contextWindow.usedTokens).toBe(50000);
    expect(result.usage?.contextWindow.contextWindowSize).toBe(500000);
    expect(result.usage?.contextWindow.usedPercentage).toBeCloseTo(10, 5);
    // Pinned by a real headless run reporting both fields side by side.
    expect(result.usage?.cost.totalCostUsd).toBeCloseTo(0.023672, 6);
  });

  it('maps streaming chunks and tool activity to Thinking and holds through retries', () => {
    const thinking = GrokSessionHistoryParser.parse(
      updateLine({ sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'read_file' }),
      'append',
    );
    expect(thinking.activity).toBe('thinking');
    expect(thinking.events).toEqual([]);

    const retrying = GrokSessionHistoryParser.parse(
      updateLine({ sessionUpdate: 'retry_state', type: 'retrying', message: 'server busy' }),
      'append',
    );
    expect(retrying.activity).toBe('thinking');

    const failed = GrokSessionHistoryParser.parse(
      updateLine({ sessionUpdate: 'retry_state', type: 'failed', message: 'API error' }),
      'append',
    );
    expect(failed.activity).toBeNull();
  });

  it('tolerates malformed lines and unknown update types', () => {
    const content = [
      'not json at all',
      '{"params": "shape mismatch"}',
      updateLine({ sessionUpdate: 'hook_execution', event_name: 'pre_tool_use' }),
      updateLine({ sessionUpdate: 'some_future_type' }),
    ].join('\n');
    const result = GrokSessionHistoryParser.parse(content, 'append');
    expect(result.activity).toBeNull();
    expect(result.events).toEqual([]);
  });

  it('harvests params._meta.totalTokens on an unknown dispatch type (hook_execution)', () => {
    // The totalTokens harvest runs BEFORE the dispatch-type guard (it is a
    // sibling of `update`, not type-specific), so an update type the parser
    // does not otherwise dispatch on still contributes its context total
    // instead of leaving the ContextBar stale at the last dispatch-type line.
    const content = updateLine(
      { sessionUpdate: 'hook_execution' },
      { totalTokens: 70000 },
    );
    const result = GrokSessionHistoryParser.parse(content, 'append');
    expect(result.usage?.contextWindow.usedTokens).toBe(70000);
    expect(result.usage?.contextWindow.totalInputTokens).toBe(70000);
  });

  it('falls back to the LAST modelUsage key for the model id when no user_message_chunk carried one', () => {
    const home = useTempGrokHome();
    fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({
      models: { 'grok-4-fast': { info: { id: 'grok-4-fast', name: 'Grok 4 Fast', context_window: 128000 } } },
    }));

    // Only a turn_completed record - no user_message_chunk to carry
    // update._meta.modelId, so the model id must be resolved from the
    // modelUsage breakdown keys, taking the LAST one.
    const content = updateLine({
      sessionUpdate: 'turn_completed',
      stop_reason: 'end_turn',
      usage: {
        inputTokens: 500,
        outputTokens: 50,
        modelUsage: { 'grok-4-mini': { inputTokens: 200 }, 'grok-4-fast': { inputTokens: 300 } },
      },
    });

    const result = GrokSessionHistoryParser.parse(content, 'append');
    expect(result.usage?.model.id).toBe('grok-4-fast');
    expect(result.usage?.model.displayName).toBe('Grok 4 Fast');
  });

  it('harvests params._meta.totalTokens BEFORE the dispatch-type guard, so an all-unknown-type batch still yields context usage', () => {
    // Red-green: reverting the harvest to run AFTER isGrokDispatchType (its
    // pre-fix position) makes this go red, since hook_execution and
    // task_backgrounded are both unknown dispatch types and would be
    // skipped before ever reaching the totalTokens read.
    useTempGrokHome();
    const content = [
      updateLine({ sessionUpdate: 'hook_execution', event_name: 'pre_tool_use' }, { totalTokens: 12345 }),
      updateLine({ sessionUpdate: 'task_backgrounded' }, { totalTokens: 20000 }),
    ].join('\n');

    const result = GrokSessionHistoryParser.parse(content, 'append');
    expect(result.activity).toBeNull();
    expect(result.events).toEqual([]);
    // Both fields derive from the same harvested value.
    expect(result.usage?.contextWindow.usedTokens).toBe(20000);
    expect(result.usage?.contextWindow.totalInputTokens).toBe(20000);
    // No dispatch-type line ever carried a model id, so this is evidence the
    // usage came from the pre-dispatch harvest and not from some other path.
    expect(result.usage?.model).toBeUndefined();
  });

  it('buildUsage populates contextWindow.totalOutputTokens and cost.totalDurationMs from the raw usage fields', () => {
    const home = useTempGrokHome();
    fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({
      models: { 'grok-4.6': { info: { id: 'grok-4.6', name: 'Grok 4.6', context_window: 500000 } } },
    }));

    const content = [
      updateLine({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hi' }, _meta: { modelId: 'grok-4.6' } }),
      updateLine({
        sessionUpdate: 'turn_completed',
        stop_reason: 'end_turn',
        usage: { inputTokens: 100, outputTokens: 4321, apiDurationMs: 9876 },
      }),
    ].join('\n');

    const result = GrokSessionHistoryParser.parse(content, 'append');
    expect(result.usage?.contextWindow.totalOutputTokens).toBe(4321);
    expect(result.usage?.cost.totalDurationMs).toBe(9876);
  });
});

describe('grokModelDisplayName', () => {
  it('falls back to the raw model id when the model is absent from the cache', () => {
    const home = useTempGrokHome();
    fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({
      models: { 'grok-4.6': { info: { id: 'grok-4.6', name: 'Grok 4.6', context_window: 500000 } } },
    }));

    expect(grokModelDisplayName('grok-4.6')).toBe('Grok 4.6');
    expect(grokModelDisplayName('grok-does-not-exist')).toBe('grok-does-not-exist');
  });
});

// ---------------------------------------------------------------------------
// Transcript parser (chat_history.jsonl)
// ---------------------------------------------------------------------------

describe('parseGrokTranscript', () => {
  it('parses user turns, reasoning, assistant tool calls, and tool results', async () => {
    const home = useTempGrokHome();
    const cwd = '/home/dev/project';
    const sessionDir = path.join(home, 'sessions', cwdToSessionsDirName(cwd), SESSION_ID);
    fs.mkdirSync(sessionDir, { recursive: true });
    const records = [
      { type: 'system', content: 'You are Grok.' },
      { type: 'user', synthetic_reason: 'system_reminder', content: { type: 'text', text: 'injected context' } },
      { type: 'user', content: { type: 'text', text: '<user_query>\nfix the bug\n</user_query>' } },
      { type: 'reasoning', content: null, summary: 'Considering the fix.' },
      {
        type: 'assistant',
        content: 'On it.',
        model_id: 'grok-4.6',
        tool_calls: [{ id: 'call-1', name: 'read_file', arguments: '{"target_file":"a.ts"}' }],
      },
      { type: 'tool_result', tool_call_id: 'call-1', content: 'file contents' },
    ];
    fs.writeFileSync(
      path.join(sessionDir, 'chat_history.jsonl'),
      records.map((record) => JSON.stringify(record)).join('\n'),
    );

    const { entries, sourcePath } = await parseGrokTranscript(SESSION_ID, cwd);
    expect(sourcePath).toContain('chat_history.jsonl');
    expect(entries).toHaveLength(3);

    expect(entries[0]).toMatchObject({ kind: 'user', text: 'fix the bug' });
    expect(entries[1]).toMatchObject({ kind: 'assistant', model: 'grok-4.6' });
    const assistantEntry = entries[1] as { blocks: Array<{ type: string }> };
    expect(assistantEntry.blocks.map((block) => block.type)).toEqual(['thinking', 'text', 'tool_use']);
    const toolUse = assistantEntry.blocks[2] as { type: string; name: string; input: unknown };
    expect(toolUse.name).toBe('read_file');
    expect(toolUse.input).toEqual({ target_file: 'a.ts' });
    expect(entries[2]).toMatchObject({ kind: 'tool_result', toolUseId: 'call-1', content: 'file contents' });
  });

  it('returns empty on a missing file', async () => {
    useTempGrokHome();
    const { entries, sourcePath } = await parseGrokTranscript(SESSION_ID, '/nowhere');
    expect(entries).toEqual([]);
    expect(sourcePath).toBeNull();
  });

  it('keeps the raw arguments string when a tool call carries malformed JSON', async () => {
    const home = useTempGrokHome();
    const cwd = '/home/dev/malformed-args-project';
    const sessionDir = path.join(home, 'sessions', cwdToSessionsDirName(cwd), SESSION_ID);
    fs.mkdirSync(sessionDir, { recursive: true });
    const records = [
      { type: 'user', content: { type: 'text', text: '<user_query>\nrun it\n</user_query>' } },
      {
        type: 'assistant',
        content: 'On it.',
        tool_calls: [{ id: 'call-1', name: 'read_file', arguments: '{not valid json' }],
      },
    ];
    fs.writeFileSync(
      path.join(sessionDir, 'chat_history.jsonl'),
      records.map((record) => JSON.stringify(record)).join('\n'),
    );

    const { entries } = await parseGrokTranscript(SESSION_ID, cwd);
    const assistantEntry = entries[1] as { blocks: Array<{ type: string; input?: unknown }> };
    const toolUse = assistantEntry.blocks.find((block) => block.type === 'tool_use') as { input: unknown };
    expect(toolUse.input).toBe('{not valid json');
  });

  it('anchors each uuid to the ABSOLUTE physical line index, counting blank and skipped lines', async () => {
    const home = useTempGrokHome();
    const cwd = '/home/dev/line-index-project';
    const sessionDir = path.join(home, 'sessions', cwdToSessionsDirName(cwd), SESSION_ID);
    fs.mkdirSync(sessionDir, { recursive: true });

    // Deliberately interleaved with a blank line and a skipped 'system' record,
    // because `lineIndex` counts EVERY physical line - blank ones included -
    // while only some lines yield an entry. Written line by line rather than
    // via join() on the record list so the blanks are explicit.
    const lines = [
      JSON.stringify({ type: 'system', content: 'You are Grok.' }), // line 0, skipped
      '',                                                            // line 1, blank
      JSON.stringify({ type: 'user', content: { type: 'text', text: '<user_query>\nfix it\n</user_query>' } }), // line 2
      JSON.stringify({ type: 'assistant', content: 'On it.', model_id: 'grok-4.6' }), // line 3
      '',                                                            // line 4, blank
      JSON.stringify({ type: 'tool_result', tool_call_id: 'call-1', content: 'done' }), // line 5
    ];
    fs.writeFileSync(path.join(sessionDir, 'chat_history.jsonl'), lines.join('\n'));

    const { entries } = await parseGrokTranscript(SESSION_ID, cwd);

    // These uuids are the persisted citation anchors that `sliceTranscriptAroundUuid`
    // resolves against (see inspect-commands.ts), so the exact STRING is the
    // contract, not merely uniqueness or ordering. A reader that renumbers lines
    // (dropping blanks, or restarting the count inside a windowed read) still
    // produces well-formed, correctly ordered entries and would pass every other
    // assertion in this file while silently breaking every stored citation.
    expect(entries.map((entry) => entry.uuid)).toEqual([
      `${SESSION_ID}:2`,
      `${SESSION_ID}:3`,
      `${SESSION_ID}:5`,
    ]);
  });

  it('keeps uuids ABSOLUTE when the transcript exceeds the parse cap and only its tail is read', async () => {
    // The dangerous half of the line-index invariant. A large transcript is
    // read as a tail window, so line indices within that window start at 0 -
    // and numbering the entries from there would renumber every uuid the
    // moment a conversation grew past the cap, silently invalidating stored
    // citation anchors for exactly the longest sessions.
    const cap = 2 * 1024;
    setParseWindowBytesForTests(cap);
    try {
      const home = useTempGrokHome();
      const cwd = '/home/dev/absolute-uuid-project';
      const sessionDir = path.join(home, 'sessions', cwdToSessionsDirName(cwd), SESSION_ID);
      fs.mkdirSync(sessionDir, { recursive: true });

      const lines: string[] = [];
      let totalLines = 0;
      let written = 0;
      while (written <= cap * 2) {
        const line = JSON.stringify({
          type: 'user',
          content: { type: 'text', text: `<user_query>\nturn ${totalLines} ${'z'.repeat(120)}\n</user_query>` },
        });
        lines.push(line);
        written += Buffer.byteLength(`${line}\n`, 'utf-8');
        totalLines += 1;
      }
      fs.writeFileSync(path.join(sessionDir, 'chat_history.jsonl'), `${lines.join('\n')}\n`);

      const { entries } = await parseGrokTranscript(SESSION_ID, cwd);

      // Truncated, so the first physical line is NOT in the window.
      expect(entries.length).toBeLessThan(totalLines);

      // Every uuid still names its absolute physical line, and the last entry
      // is the file's last line - not a window-relative index.
      const parsedIndexes = entries
        .filter((entry) => entry.uuid.startsWith(`${SESSION_ID}:`))
        .map((entry) => Number(entry.uuid.slice(SESSION_ID.length + 1)));
      expect(parsedIndexes[0]).toBeGreaterThan(0);
      expect(parsedIndexes[parsedIndexes.length - 1]).toBe(totalLines - 1);
      // Contiguous and ascending: one uuid per physical line of the window.
      for (let offset = 1; offset < parsedIndexes.length; offset += 1) {
        expect(parsedIndexes[offset]).toBe(parsedIndexes[offset - 1] + 1);
      }
    } finally {
      setParseWindowBytesForTests();
    }
  });
});

describe('grokTranscriptUsage / grokTranscriptToolCounts', () => {
  it('takes the LAST turn_completed.usage, not the first or a sum', async () => {
    const home = useTempGrokHome();
    const cwd = '/home/dev/usage-project';
    const updatesPath = grokUpdatesJsonlPath(cwd, SESSION_ID);
    fs.mkdirSync(path.dirname(updatesPath), { recursive: true });
    const content = [
      updateLine({ sessionUpdate: 'turn_completed', usage: { inputTokens: 100, outputTokens: 20 } }),
      updateLine({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'more' } }),
      updateLine({ sessionUpdate: 'turn_completed', usage: { inputTokens: 300, outputTokens: 75 } }),
    ].join('\n');
    fs.writeFileSync(updatesPath, content);

    const usage = await grokTranscriptUsage(SESSION_ID, cwd);
    expect(usage).toEqual({ inputTokens: 300, outputTokens: 75 });
  });

  it('returns null when the updates file is missing', async () => {
    useTempGrokHome();
    const usage = await grokTranscriptUsage(SESSION_ID, '/nowhere');
    expect(usage).toBeNull();
  });

  it('grokTranscriptToolCounts returns null when the updates file is missing', async () => {
    // A missing file is a distinct code path from "file exists with zero
    // tool_call records" (covered below): streamJsonlRecords resolves
    // readWholeFile=false for a missing file, which must short-circuit to
    // null rather than falling through to report a hollow zero-count object.
    useTempGrokHome();
    const counts = await grokTranscriptToolCounts(SESSION_ID, '/nowhere');
    expect(counts).toBeNull();
  });

  it('skips a turn_completed whose usage.inputTokens/outputTokens are not numbers', async () => {
    const home = useTempGrokHome();
    const cwd = '/home/dev/non-numeric-usage-project';
    const updatesPath = grokUpdatesJsonlPath(cwd, SESSION_ID);
    fs.mkdirSync(path.dirname(updatesPath), { recursive: true });
    const content = [
      updateLine({ sessionUpdate: 'turn_completed', usage: { inputTokens: 100, outputTokens: 20 } }),
      // Malformed usage on the LAST turn_completed - must be skipped rather
      // than overwriting the valid earlier reading with garbage/NaN.
      updateLine({ sessionUpdate: 'turn_completed', usage: { inputTokens: '300', outputTokens: 75 } }),
    ].join('\n');
    fs.writeFileSync(updatesPath, content);

    const usage = await grokTranscriptUsage(SESSION_ID, cwd);
    expect(usage).toEqual({ inputTokens: 100, outputTokens: 20 });
  });

  it('tolerates a garbled line mid-file between valid turn_completed records', async () => {
    const home = useTempGrokHome();
    const cwd = '/home/dev/garbled-mid-file-project';
    const updatesPath = grokUpdatesJsonlPath(cwd, SESSION_ID);
    fs.mkdirSync(path.dirname(updatesPath), { recursive: true });
    const content = [
      updateLine({ sessionUpdate: 'turn_completed', usage: { inputTokens: 10, outputTokens: 1 } }),
      'not json at all - a partial write mid-flush',
      updateLine({ sessionUpdate: 'turn_completed', usage: { inputTokens: 200, outputTokens: 30 } }),
    ].join('\n');
    fs.writeFileSync(updatesPath, content);

    const usage = await grokTranscriptUsage(SESSION_ID, cwd);
    expect(usage).toEqual({ inputTokens: 200, outputTokens: 30 });
  });

  it('dedupes tool calls by toolCallId, names from _meta with a title fallback, and sorts the breakdown by callCount', async () => {
    const home = useTempGrokHome();
    const cwd = '/home/dev/tool-counts-project';
    const updatesPath = grokUpdatesJsonlPath(cwd, SESSION_ID);
    fs.mkdirSync(path.dirname(updatesPath), { recursive: true });
    const content = [
      // Same toolCallId twice - the duplicate must not be double-counted.
      updateLine({ sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'read_file' }),
      updateLine({ sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'read_file' }),
      // Name resolved from _meta['x.ai/tool'].name, ignoring the title.
      updateLine({ sessionUpdate: 'tool_call', toolCallId: 'call-2', title: 'ignored', _meta: { 'x.ai/tool': { name: 'edit_file' } } }),
      // No _meta - name falls back to title. Three distinct ids, all counted.
      updateLine({ sessionUpdate: 'tool_call', toolCallId: 'call-3', title: 'grep' }),
      updateLine({ sessionUpdate: 'tool_call', toolCallId: 'call-4', title: 'grep' }),
      updateLine({ sessionUpdate: 'tool_call', toolCallId: 'call-5', title: 'grep' }),
    ].join('\n');
    fs.writeFileSync(updatesPath, content);

    const counts = await grokTranscriptToolCounts(SESSION_ID, cwd);
    expect(counts?.toolCallCount).toBe(5);
    // The sort-by-callCount contract only orders by count, so only the top
    // (unambiguous) entry is asserted by position; the two count-1 entries
    // (an incidental tie) are asserted by membership, not position.
    expect(counts?.toolBreakdown?.[0]).toEqual({ toolName: 'grep', callCount: 3, totalDurationMs: 0, interruptedCount: 0 });
    expect(counts?.toolBreakdown).toEqual(expect.arrayContaining([
      { toolName: 'read_file', callCount: 1, totalDurationMs: 0, interruptedCount: 0 },
      { toolName: 'edit_file', callCount: 1, totalDurationMs: 0, interruptedCount: 0 },
    ]));
    expect(counts?.toolBreakdown).toHaveLength(3);
  });

  it('returns null when there are no tool calls', async () => {
    const home = useTempGrokHome();
    const cwd = '/home/dev/no-tools-project';
    const updatesPath = grokUpdatesJsonlPath(cwd, SESSION_ID);
    fs.mkdirSync(path.dirname(updatesPath), { recursive: true });
    fs.writeFileSync(updatesPath, updateLine({ sessionUpdate: 'turn_completed', usage: { inputTokens: 1, outputTokens: 1 } }));

    const counts = await grokTranscriptToolCounts(SESSION_ID, cwd);
    expect(counts).toBeNull();
  });
});

describe('GrokAdapter.transcriptUsage / transcriptToolCounts (missing session context)', () => {
  // Everything above exercises grokTranscriptUsage / grokTranscriptToolCounts
  // directly. This proves the REAL adapter methods short-circuit to null
  // before ever touching the filesystem when the caller omits
  // agentSessionId or cwd, matching the codex-adapter.test.ts precedent for
  // this guard shape.
  const adapter = new GrokAdapter();

  it('transcriptUsage returns null when agentSessionId is missing', async () => {
    expect(await adapter.transcriptUsage({ agentSessionId: null, cwd: '/home/dev/project' })).toBeNull();
  });

  it('transcriptUsage returns null when cwd is missing', async () => {
    expect(await adapter.transcriptUsage({ agentSessionId: SESSION_ID, cwd: null })).toBeNull();
  });

  it('transcriptToolCounts returns null when agentSessionId is missing', async () => {
    expect(await adapter.transcriptToolCounts({ agentSessionId: null, cwd: '/home/dev/project' })).toBeNull();
  });

  it('transcriptToolCounts returns null when cwd is missing', async () => {
    expect(await adapter.transcriptToolCounts({ agentSessionId: SESSION_ID, cwd: null })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Command-injection extractor
// ---------------------------------------------------------------------------

describe('extractGrokUserTurn', () => {
  it('extracts a genuine typed turn, unwrapping <user_query>', () => {
    const line = JSON.stringify({ type: 'user', content: { type: 'text', text: '<user_query>\n/code-review\n</user_query>' } });
    expect(extractGrokUserTurn(line)).toEqual({ timestampMs: null, text: '/code-review' });
  });

  it('rejects synthetic context records and non-user records', () => {
    expect(extractGrokUserTurn(JSON.stringify({ type: 'user', synthetic_reason: 'system_reminder', content: { type: 'text', text: 'x' } }))).toBeNull();
    expect(extractGrokUserTurn(JSON.stringify({ type: 'assistant', content: 'hello' }))).toBeNull();
    expect(extractGrokUserTurn('not json')).toBeNull();
  });

  it('rejects a JSON array line and a literal `null` line rather than treating them as records', () => {
    // JSON.parse succeeds for both, so the isRecord-style guard (typeof
    // === 'object' && !== null && !Array.isArray) is what must reject them.
    expect(extractGrokUserTurn(JSON.stringify(['user', 'hello']))).toBeNull();
    expect(extractGrokUserTurn('null')).toBeNull();
  });

  it('handles the wrapper edge cases via unwrapUserQuery', () => {
    expect(unwrapUserQuery('<user_query>\nplain\n</user_query>')).toBe('plain');
    expect(unwrapUserQuery('no wrapper at all')).toBe('no wrapper at all');
  });

  it('extracts text from a content array of plain strings, not just block objects', () => {
    // extractGrokUserTurn now delegates to the shared extractTextContent
    // (transcript-parser.ts), which accepts plain-string array items. The
    // pre-fix inline copy silently dropped them and returned null.
    const line = JSON.stringify({
      type: 'user',
      content: ['<user_query>\ntyped text\n</user_query>'],
    });
    expect(extractGrokUserTurn(line)).toEqual({ timestampMs: null, text: 'typed text' });
  });
});

describe('createGrokCommandInjectionVerifier (wiring)', () => {
  // Everything above exercises extractGrokUserTurn directly. This drives the
  // real chain the injection burst uses: build the verifier via the actual
  // production factory and confirm it reads a real chat_history.jsonl on
  // disk - the precedent is codex-command-injection-verifier.test.ts's
  // 'createSubmittedTextSubmissionVerifier (Codex wiring)' block.
  it('confirms a matching typed submission and rejects one that never landed', async () => {
    const home = useTempGrokHome();
    const cwd = '/home/dev/verifier-project';
    const sessionDir = path.join(home, 'sessions', cwdToSessionsDirName(cwd), SESSION_ID);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, 'chat_history.jsonl'),
      `${JSON.stringify({ type: 'user', content: { type: 'text', text: '<user_query>\nrun the tests\n</user_query>' } })}\n`,
    );

    const verifier = createGrokCommandInjectionVerifier();
    const sentAt = Date.now();

    expect(await verifier({
      type: 'command-injection',
      text: 'run the tests',
      agentSessionId: SESSION_ID,
      cwd,
      sentAt,
      mode: 'submitted',
    })).toBe(true);

    expect(await verifier({
      type: 'command-injection',
      text: 'a command that was never submitted',
      agentSessionId: SESSION_ID,
      cwd,
      sentAt,
      mode: 'submitted',
    })).toBe(false);
  });

  it('resolvePath swallows an fs.existsSync throw and returns false instead of throwing', async () => {
    useTempGrokHome();
    const cwd = '/home/dev/exists-throw-project';
    const realExistsSync = fs.existsSync;
    // Throw ONLY for the chat_history.jsonl probe resolvePath performs, so
    // this actually exercises resolvePath's own try/catch rather than
    // passing vacuously off some unrelated existsSync call elsewhere in the
    // verifier chain.
    const existsSyncSpy = vi.spyOn(fs, 'existsSync').mockImplementation((...args: Parameters<typeof fs.existsSync>) => {
      const [target] = args;
      if (String(target).includes('chat_history.jsonl')) {
        throw new Error('EPERM: simulated permission failure');
      }
      return realExistsSync(...args);
    });

    const verifier = createGrokCommandInjectionVerifier();
    const result = await verifier({
      type: 'command-injection',
      text: 'anything',
      agentSessionId: SESSION_ID,
      cwd,
      sentAt: Date.now(),
      mode: 'submitted',
    });

    expect(result).toBe(false);
    expect(existsSyncSpy.mock.calls.some((call) => String(call[0]).includes('chat_history.jsonl'))).toBe(true);
    existsSyncSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Transcript cleanup
// ---------------------------------------------------------------------------

describe('cleanGrokTranscript', () => {
  it("extracts the last turn from grok's exit dump and strips the resume trailer", () => {
    const raw = [
      'Grok Build  1.0.0',
      'Grok4.6ishere,tryitoutforfreeforalimitedtime!',
      '[Click here to Upgrade]',
      'Reply with exactly: PONG',
      '> Reply with exactly: PONG',
      '  PONG',
      'Resume this session with:',
      '  grok --resume 01a00b66-92e2-7812-a209-b80885090deb',
    ].join('\n');
    const cleaned = cleanGrokTranscript(raw);
    expect(cleaned).toContain('Reply with exactly: PONG');
    expect(cleaned).toContain('PONG');
    expect(cleaned).not.toContain('--resume');
    expect(cleaned).not.toContain('Upgrade');
    expect(cleaned).not.toContain('Grok Build  1.0.0');
  });

  it('returns finalized prose when no structural marker exists', () => {
    expect(cleanGrokTranscript('just some output\n\nwith prose')).toContain('just some output');
    expect(cleanGrokTranscript('   \n  ')).toBeNull();
  });

  it('strips the braille spinner/logo, telemetry opt-in prose, status/timer chrome, key-hint/status bar, and slash-palette noise patterns', () => {
    // One example line per untested GROK_NOISE_PATTERNS entry, derived
    // verbatim from the regexes in transcript-cleanup.ts. The welcome-banner
    // "Upgrade for more usage" / "New worktree ctrl+w" / "Resume session
    // ctrl+s" / "Changelog" / "Quit ctrl+q" variants are deliberately out of
    // scope here (already partially covered by the "extracts the last turn"
    // test above, and not named in this hole).
    const noiseLines = [
      '⠋⠙⠹⠸⠼⠴', // braille spinner/logo
      'Help improve Grok by sharing usage data', // telemetry opt-in prose
      '[Opt out] [Opt in]',
      'Opt-in to allow SpaceXAI to help train models',
      'Read Terms and Privacy Policy for details',
      '◆ Thinking…', // status/timer chrome
      'Thinking… 12.3s',
      'Thought for 4.2s',
      'Responding… 1.1s',
      'Worked for 30.5s',
      'Ctrl+x: shortcuts', // key hints and status bar
      'Enter: send',
      'Shift+Tab: mode',
      '[stable]',
      '/quit Quit the application', // slash-command palette entry
    ];
    const survivor = 'Fixed the failing test suite.';
    const raw = [survivor, ...noiseLines].join('\n');

    const cleaned = cleanGrokTranscript(raw);

    expect(cleaned).toContain(survivor);
    for (const noise of noiseLines) {
      expect(cleaned).not.toContain(noise);
    }
  });
});

// ---------------------------------------------------------------------------
// Capability discovery
// ---------------------------------------------------------------------------

describe('discoverGrokCapabilities', () => {
  it("reads models, display names, and effort levels from grok's models cache", async () => {
    const home = useTempGrokHome();
    fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({
      models: {
        'grok-4.6': {
          info: {
            id: 'grok-4.6', name: 'Grok 4.6', context_window: 500000, hidden: false,
            reasoning_efforts: [{ id: 'xhigh' }, { id: 'high' }, { id: 'medium' }, { id: 'low' }],
          },
        },
        'grok-secret': { info: { id: 'grok-secret', name: 'Hidden', hidden: true } },
      },
    }));

    const capabilities = await discoverGrokCapabilities('/usr/bin/grok');
    expect(capabilities.supportsModelOverride).toBe(true);
    expect(capabilities.models).toEqual(['grok-4.6']);
    expect(capabilities.modelDisplayNames).toEqual({ 'grok-4.6': 'Grok 4.6' });
    expect(capabilities.effortLevels).toEqual(['low', 'medium', 'high', 'xhigh']);
  });

  it('memoizes the result: a second call does not re-read models_cache.json', async () => {
    const home = useTempGrokHome();
    fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({
      models: { 'grok-4.6': { info: { id: 'grok-4.6', name: 'Grok 4.6', context_window: 500000 } } },
    }));

    const first = await discoverGrokCapabilities('/usr/bin/grok');
    expect(first.models).toEqual(['grok-4.6']);

    // Change the on-disk cache after the memoized call. If the memo were not
    // honored, the second call would pick this up and report grok-5 instead.
    fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({
      models: { 'grok-5': { info: { id: 'grok-5', name: 'Grok 5', context_window: 1000000 } } },
    }));

    const second = await discoverGrokCapabilities('/usr/bin/grok');
    expect(second.models).toEqual(['grok-4.6']);
  });

  it('forceRefresh bypasses the memo and re-reads the current models_cache.json', async () => {
    const home = useTempGrokHome();
    fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({
      models: { 'grok-4.6': { info: { id: 'grok-4.6', name: 'Grok 4.6', context_window: 500000 } } },
    }));

    await discoverGrokCapabilities('/usr/bin/grok');

    fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({
      models: { 'grok-5': { info: { id: 'grok-5', name: 'Grok 5', context_window: 1000000 } } },
    }));

    const refreshed = await discoverGrokCapabilities('/usr/bin/grok', true);
    expect(refreshed.models).toEqual(['grok-5']);
  });
});

// ---------------------------------------------------------------------------
// Trust manager
// ---------------------------------------------------------------------------

describe('trust manager', () => {
  function worktreePathUnder(projectRoot: string): string {
    return path.join(projectRoot, '.kangentic', 'worktrees', 'task-slug');
  }

  it('pre-approves a Kangentic worktree with no covering decision', async () => {
    const home = useTempGrokHome();
    const projectRoot = path.join(home, 'fake-project');
    const worktree = worktreePathUnder(projectRoot);

    await ensureWorktreeTrust(worktree);
    const store = fs.readFileSync(path.join(home, 'trusted_folders.toml'), 'utf-8');
    expect(store).toContain(`[folders.'${path.resolve(worktree)}']`);
    expect(store).toContain('trusted = true');
    expect(store).toMatch(/decided_at = \d+/);
  });

  it('is idempotent: calling it twice for the same worktree appends exactly one table', async () => {
    const home = useTempGrokHome();
    const projectRoot = path.join(home, 'fake-project');
    const worktree = worktreePathUnder(projectRoot);

    await ensureWorktreeTrust(worktree);
    await ensureWorktreeTrust(worktree);

    const store = fs.readFileSync(path.join(home, 'trusted_folders.toml'), 'utf-8');
    const occurrences = store.split(`[folders.'${path.resolve(worktree)}']`).length - 1;
    expect(occurrences).toBe(1);
  });

  it('does nothing when a trusted ancestor already cascades over the worktree', async () => {
    const home = useTempGrokHome();
    const projectRoot = path.join(home, 'fake-project');
    const storePath = path.join(home, 'trusted_folders.toml');
    fs.writeFileSync(storePath, `[folders.'${path.resolve(projectRoot)}']\ntrusted = true\ndecided_at = 1786162868\n`);

    await ensureWorktreeTrust(worktreePathUnder(projectRoot));
    const store = fs.readFileSync(storePath, 'utf-8');
    expect(store).not.toContain('worktrees');
  });

  it('respects an explicit ancestor deny', async () => {
    const home = useTempGrokHome();
    const projectRoot = path.join(home, 'fake-project');
    const storePath = path.join(home, 'trusted_folders.toml');
    fs.writeFileSync(storePath, `[folders.'${path.resolve(projectRoot)}']\ntrusted = false\ndecided_at = 1786162868\n`);

    await ensureWorktreeTrust(worktreePathUnder(projectRoot));
    const store = fs.readFileSync(storePath, 'utf-8');
    expect(store).not.toContain('worktrees');
    expect(store).toContain('trusted = false');
  });

  it('never auto-trusts a plain project root', async () => {
    const home = useTempGrokHome();
    await ensureWorktreeTrust(path.join(home, 'fake-project'));
    expect(fs.existsSync(path.join(home, 'trusted_folders.toml'))).toBe(false);
  });

  it('writes nothing for a worktree path containing a single quote (cannot be a TOML literal key)', async () => {
    const home = useTempGrokHome();
    const projectRoot = path.join(home, 'fake-project');
    const worktree = path.join(projectRoot, '.kangentic', 'worktrees', "task's-slug");

    await ensureWorktreeTrust(worktree);
    expect(fs.existsSync(path.join(home, 'trusted_folders.toml'))).toBe(false);
  });

  it('removeWorktreeTrust no-ops when the trust store file does not exist', async () => {
    const home = useTempGrokHome();
    const storePath = path.join(home, 'trusted_folders.toml');
    expect(fs.existsSync(storePath)).toBe(false);

    await expect(removeWorktreeTrust(worktreePathUnder(path.join(home, 'fake-project')))).resolves.toBeUndefined();
    expect(fs.existsSync(storePath)).toBe(false);
  });

  it('logs and does not throw when the trust store write fails', async () => {
    const home = useTempGrokHome();
    const worktree = worktreePathUnder(path.join(home, 'fake-project'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const appendFileSyncSpy = vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {
      throw new Error('EACCES: simulated permission failure');
    });

    await expect(ensureWorktreeTrust(worktree)).resolves.toBeUndefined();
    expect(consoleErrorSpy).toHaveBeenCalled();

    appendFileSyncSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('removes only tables Kangentic could have written, atomically', async () => {
    const home = useTempGrokHome();
    const projectRoot = path.join(home, 'fake-project');
    const worktree = worktreePathUnder(projectRoot);
    const storePath = path.join(home, 'trusted_folders.toml');
    const userTable = `[folders.'${path.resolve(projectRoot)}']\ntrusted = true\ndecided_at = 1786162868\ncustom_key = "user data"\n`;
    fs.writeFileSync(storePath, userTable);

    await ensureWorktreeTrust(worktree);
    await removeWorktreeTrust(worktree);
    const store = fs.readFileSync(storePath, 'utf-8');
    expect(store).not.toContain('worktrees');
    expect(store).toContain('custom_key = "user data"');

    // A table with foreign keys at the WORKTREE path itself survives too.
    fs.writeFileSync(storePath, `[folders.'${path.resolve(worktree)}']\ntrusted = true\nother = 1\n`);
    await removeWorktreeTrust(worktree);
    expect(fs.readFileSync(storePath, 'utf-8')).toContain('other = 1');
  });
});

describe('GrokAdapter.onWorktreeRemoved', () => {
  // Everything above exercises removeWorktreeTrust directly. This proves the
  // REAL adapter method is wired to it - nothing else in the suite calls
  // onWorktreeRemoved through the adapter itself (the codex-adapter.test.ts
  // 'onWorktreeRemoved' block is the precedent for this shape).
  it('delegates to trust-manager removal for a real worktree entry', async () => {
    const home = useTempGrokHome();
    const adapter = new GrokAdapter();
    const projectRoot = path.join(home, 'delegation-project');
    const worktree = path.join(projectRoot, '.kangentic', 'worktrees', 'task-slug');
    const storePath = path.join(home, 'trusted_folders.toml');

    await adapter.ensureTrust(worktree);
    expect(fs.readFileSync(storePath, 'utf-8')).toContain(`[folders.'${path.resolve(worktree)}']`);

    await adapter.onWorktreeRemoved(worktree);

    expect(fs.readFileSync(storePath, 'utf-8')).not.toContain(`[folders.'${path.resolve(worktree)}']`);
  });
});

// ---------------------------------------------------------------------------
// Project relocation
// ---------------------------------------------------------------------------

describe('migrateGrokProjectData', () => {
  it('renames the encoded session directory and rewrites trust paths', async () => {
    const home = useTempGrokHome();
    const oldProject = path.join(home, 'old-project');
    const newProject = path.join(home, 'new-project');
    const sessionsRoot = path.join(home, 'sessions');
    const oldSessionDir = path.join(sessionsRoot, cwdToSessionsDirName(path.resolve(oldProject)), SESSION_ID);
    fs.mkdirSync(oldSessionDir, { recursive: true });
    fs.writeFileSync(path.join(oldSessionDir, 'updates.jsonl'), '');
    fs.writeFileSync(
      path.join(home, 'trusted_folders.toml'),
      `[folders.'${path.resolve(oldProject)}']\ntrusted = true\ndecided_at = 1786162868\n`,
    );

    await migrateGrokProjectData(oldProject, newProject);

    expect(fs.existsSync(path.join(sessionsRoot, cwdToSessionsDirName(path.resolve(newProject)), SESSION_ID))).toBe(true);
    expect(fs.existsSync(oldSessionDir)).toBe(false);
    const store = fs.readFileSync(path.join(home, 'trusted_folders.toml'), 'utf-8');
    expect(store).toContain(`[folders.'${path.resolve(newProject)}']`);
    expect(store).not.toContain(`[folders.'${path.resolve(oldProject)}']`);
  });

  it('falls back to a scan-and-decode match when the on-disk key carries a stray trailing separator', async () => {
    // cwdToSessionsDirName is bare encodeURIComponent (no normalization), but
    // normalizeForCompare resolves and strips a trailing separator. A key
    // encoded with a trailing separator is therefore a genuine STRING
    // mismatch against the exact-encoded key (unlike a same-machine drive-
    // letter casing difference, which Windows' case-insensitive filesystem
    // already tolerates at the exact-match existsSync check, making that
    // scenario unable to exercise this fallback at all) - real fs calls only,
    // no mocking needed, and platform-neutral since normalizeForCompare's
    // trailing-separator strip is not win32-gated.
    const home = useTempGrokHome();
    const oldProject = path.join(home, 'old-project');
    const newProject = path.join(home, 'new-project');
    const sessionsRoot = path.join(home, 'sessions');

    const resolvedOld = path.resolve(oldProject);
    const keyWithTrailingSep = resolvedOld + path.sep;
    const mismatchedSessionDir = path.join(sessionsRoot, cwdToSessionsDirName(keyWithTrailingSep), SESSION_ID);
    fs.mkdirSync(mismatchedSessionDir, { recursive: true });
    fs.writeFileSync(path.join(mismatchedSessionDir, 'updates.jsonl'), '');

    await migrateGrokProjectData(oldProject, newProject);

    const newSessionDir = path.join(sessionsRoot, cwdToSessionsDirName(path.resolve(newProject)), SESSION_ID);
    expect(fs.existsSync(newSessionDir)).toBe(true);
    expect(fs.existsSync(mismatchedSessionDir)).toBe(false);
  });

  it('skips a sessions-root sibling whose name is malformed percent-encoding, without logging a rename failure', async () => {
    // findSessionsDirForCwd's scan-and-decode fallback calls
    // decodeURIComponent(cwdKey) on every sibling in the sessions root; a
    // THIRD-PARTY (grok-written) directory name that is not valid
    // percent-encoding (e.g. a lone "%" not followed by two hex digits) must
    // be skipped, not propagate an uncaught URIError out of the scan.
    //
    // Deliberately no decodable match exists in this sessions root (only the
    // malformed sibling), so this assertion cannot pass by accident of
    // readdirSync ordering: on correct behavior the scan exhausts safely,
    // falls back to the (non-existent) exact-encoded path, and
    // renameOrMergeDirectory silently no-ops (relocation-utils.ts returns
    // early when the source does not exist) - no warning is logged. On
    // broken behavior (the guarding try/catch removed) decodeURIComponent
    // throws INSIDE the scan; that throw propagates, uncaught, out of
    // findSessionsDirForCwd and into migrateGrokProjectData's per-pair
    // try/catch, which DOES log "[GROK_RELOCATE] Failed to migrate
    // sessions" - so the assertion below is genuinely red against the
    // unguarded scan, not vacuously true.
    const home = useTempGrokHome();
    const oldProject = path.join(home, 'old-project');
    const newProject = path.join(home, 'new-project');
    const sessionsRoot = path.join(home, 'sessions');

    fs.mkdirSync(path.join(sessionsRoot, '%zz-not-percent-encoded'), { recursive: true });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(migrateGrokProjectData(oldProject, newProject)).resolves.toBeUndefined();

    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('[GROK_RELOCATE] Failed to migrate sessions'),
      expect.anything(),
    );

    warnSpy.mockRestore();
  });

  it('rewrites a double-quoted trust header for the old path, leaving an unrelated header untouched', async () => {
    // grok itself always writes single-quoted literals, but a double-quoted
    // key is legal TOML and must not be silently left pointing at the old
    // path. POSIX-style paths (no backslashes) keep the naive quote
    // extraction exact - a Windows path would need backslash escaping to be
    // a valid double-quoted TOML basic string.
    const home = useTempGrokHome();
    const oldProjectPath = '/old/project/path';
    const newProjectPath = path.join(home, 'new-project');
    const unrelatedPath = '/some/other/project';
    const storePath = path.join(home, 'trusted_folders.toml');
    fs.writeFileSync(
      storePath,
      `[folders."${oldProjectPath}"]\ntrusted = true\ndecided_at = 1786162868\n\n`
      + `[folders."${unrelatedPath}"]\ntrusted = true\ndecided_at = 1786162868\n`,
    );

    await migrateGrokProjectData(oldProjectPath, newProjectPath);

    const store = fs.readFileSync(storePath, 'utf-8');
    expect(store).toContain(`[folders.'${path.resolve(newProjectPath)}']`);
    expect(store).not.toContain(`[folders."${oldProjectPath}"]`);
    expect(store).toContain(`[folders."${unrelatedPath}"]`);
  });

  it('logs a per-pair rename failure without aborting migration of the remaining pairs', async () => {
    const home = useTempGrokHome();
    const oldProject = path.join(home, 'blocked-old-project');
    const newProject = path.join(home, 'blocked-new-project');
    const sessionsRoot = path.join(home, 'sessions');

    // Project-root pair: seed the OLD session dir, then preempt the NEW
    // location with a plain FILE so the merge-rename inside
    // renameOrMergeDirectory throws instead of succeeding.
    const oldRootSessionDir = path.join(sessionsRoot, cwdToSessionsDirName(path.resolve(oldProject)));
    fs.mkdirSync(oldRootSessionDir, { recursive: true });
    fs.writeFileSync(path.join(oldRootSessionDir, 'updates.jsonl'), '');
    const newRootSessionDir = path.join(sessionsRoot, cwdToSessionsDirName(path.resolve(newProject)));
    fs.writeFileSync(newRootSessionDir, 'not a directory');

    // Worktree pair: a normal rename that MUST still succeed even though
    // the project-root pair above fails first.
    fs.mkdirSync(path.join(newProject, '.kangentic', 'worktrees', 'task-a'), { recursive: true });
    const oldWorktreeSessionDir = path.join(
      sessionsRoot,
      cwdToSessionsDirName(path.join(path.resolve(oldProject), '.kangentic', 'worktrees', 'task-a')),
    );
    fs.mkdirSync(oldWorktreeSessionDir, { recursive: true });
    fs.writeFileSync(path.join(oldWorktreeSessionDir, 'updates.jsonl'), '');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(migrateGrokProjectData(oldProject, newProject)).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[GROK_RELOCATE] Failed to migrate sessions'),
      expect.anything(),
    );

    const newWorktreeSessionDir = path.join(
      sessionsRoot,
      cwdToSessionsDirName(path.join(path.resolve(newProject), '.kangentic', 'worktrees', 'task-a')),
    );
    expect(fs.existsSync(newWorktreeSessionDir)).toBe(true);
    expect(fs.existsSync(oldWorktreeSessionDir)).toBe(false);

    warnSpy.mockRestore();
  });

  it('rewriteTrustedFolderPaths no-ops when the trust store file does not exist', async () => {
    const home = useTempGrokHome();
    const oldProject = path.join(home, 'no-store-old');
    const newProject = path.join(home, 'no-store-new');

    await expect(migrateGrokProjectData(oldProject, newProject)).resolves.toBeUndefined();
    expect(fs.existsSync(path.join(home, 'trusted_folders.toml'))).toBe(false);
  });

  it('skips rewriting a trust header when the new path contains a single quote', async () => {
    const home = useTempGrokHome();
    const oldProjectPath = path.join(home, 'quote-old-project');
    const newProjectPath = path.join(home, "task's-new-project");
    const storePath = path.join(home, 'trusted_folders.toml');
    fs.writeFileSync(
      storePath,
      `[folders.'${path.resolve(oldProjectPath)}']\ntrusted = true\ndecided_at = 1786162868\n`,
    );

    await migrateGrokProjectData(oldProjectPath, newProjectPath);

    const store = fs.readFileSync(storePath, 'utf-8');
    expect(store).toContain(`[folders.'${path.resolve(oldProjectPath)}']`);
    expect(store).not.toContain(path.resolve(newProjectPath));
  });
});

describe('GrokAdapter.onProjectRelocated', () => {
  // Everything above exercises migrateGrokProjectData directly. This proves
  // the REAL adapter method is wired to it.
  it('delegates to migrateGrokProjectData for the real session directory', async () => {
    const home = useTempGrokHome();
    const adapter = new GrokAdapter();
    const oldProject = path.join(home, 'delegation-old');
    const newProject = path.join(home, 'delegation-new');
    const sessionsRoot = path.join(home, 'sessions');
    const oldSessionDir = path.join(sessionsRoot, cwdToSessionsDirName(path.resolve(oldProject)), SESSION_ID);
    fs.mkdirSync(oldSessionDir, { recursive: true });
    fs.writeFileSync(path.join(oldSessionDir, 'updates.jsonl'), '');

    await adapter.onProjectRelocated(oldProject, newProject);

    expect(fs.existsSync(path.join(sessionsRoot, cwdToSessionsDirName(path.resolve(newProject)), SESSION_ID))).toBe(true);
    expect(fs.existsSync(oldSessionDir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// locate: caller-owned id, deterministic path
// ---------------------------------------------------------------------------

describe('session history locate', () => {
  it('finds the updates file at the deterministic encoded path', async () => {
    const home = useTempGrokHome();
    const cwd = '/home/dev/project';
    const updatesPath = grokUpdatesJsonlPath(cwd, SESSION_ID);
    fs.mkdirSync(path.dirname(updatesPath), { recursive: true });
    fs.writeFileSync(updatesPath, '');

    const located = await GrokSessionHistoryParser.locate({ agentSessionId: SESSION_ID, cwd });
    expect(located).toBe(updatesPath);
    expect(located).toContain(home);
  });

  it('gives up (null) when nothing appears within the budget', async () => {
    useTempGrokHome();
    const located = await (await import('../../src/main/agent/adapters/grok/session-paths')).locateGrokUpdatesFile({
      agentSessionId: SESSION_ID,
      cwd: '/nowhere',
      maxAttempts: 1,
    });
    expect(located).toBeNull();
  });

  it('recovers via a cross-cwd scan when the file lives under a differently-encoded cwd key', async () => {
    // The caller-owned session UUID is globally unique, so once the CLI has
    // written ANYTHING, a one-level scan of the sessions root finds it even
    // when the cwd key was encoded differently than expected (e.g. a
    // drive-letter casing difference). This is the attach-time locator's
    // fallback, deliberately absent from GrokAdapter.locateSessionHistoryFile
    // (see the "GrokAdapter.locateSessionHistoryFile" block below).
    const home = useTempGrokHome();
    const foreignCwdKey = encodeURIComponent('/some/other/machine-path');
    const sessionDir = path.join(home, 'sessions', foreignCwdKey, SESSION_ID);
    fs.mkdirSync(sessionDir, { recursive: true });
    const updatesPath = path.join(sessionDir, 'updates.jsonl');
    fs.writeFileSync(updatesPath, '');

    const located = await locateGrokUpdatesFile({
      agentSessionId: SESSION_ID,
      cwd: '/home/dev/project-not-matching',
      maxAttempts: 1,
    });
    expect(located).toBe(updatesPath);
  });
});

describe('GrokAdapter.locateSessionHistoryFile (strict cwd-scoped probe)', () => {
  // This MUST NOT reuse GrokSessionHistoryParser.locate's cross-cwd scan
  // (see the preceding "recovers via a cross-cwd scan" test): callers like
  // resume-cwd-migration's reachability gate depend on this probe answering
  // ONLY for the exact (cwd, sessionId) pair, never a scan hit under a
  // different cwd's encoded directory.
  it('returns the path when updates.jsonl exists at the cwd-scoped encoded path', async () => {
    const home = useTempGrokHome();
    const adapter = new GrokAdapter();
    const cwd = '/home/dev/probe-project';
    const updatesPath = grokUpdatesJsonlPath(cwd, SESSION_ID);
    fs.mkdirSync(path.dirname(updatesPath), { recursive: true });
    fs.writeFileSync(updatesPath, '');

    const located = await adapter.locateSessionHistoryFile(SESSION_ID, cwd);
    expect(located).toBe(updatesPath);
    expect(located).toContain(home);
  });

  it('returns null when the session id exists ONLY under a different cwd\'s encoded directory', async () => {
    // Red-green: the pre-fix implementation reused the cross-cwd scan and
    // would have found this session under the foreign cwd, falsely
    // reporting it reachable from the cwd under test - the exact bug that
    // broke resume-cwd-migration's "already reachable from the NEW cwd?"
    // gate.
    const home = useTempGrokHome();
    const adapter = new GrokAdapter();
    const foreignCwd = '/home/dev/other-project';
    const foreignUpdatesPath = grokUpdatesJsonlPath(foreignCwd, SESSION_ID);
    fs.mkdirSync(path.dirname(foreignUpdatesPath), { recursive: true });
    fs.writeFileSync(foreignUpdatesPath, '');

    const located = await adapter.locateSessionHistoryFile(SESSION_ID, '/home/dev/probe-project');
    expect(located).toBeNull();
  });
});
