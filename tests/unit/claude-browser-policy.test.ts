/**
 * The Claude spawn's half of the browser policy (task #977): while the Agent
 * Browser is on it is the only browser an agent drives.
 *
 * An agent in a project whose `.mcp.json` shipped Playwright MCP drove that
 * server's Chrome for a whole task. What this pins, through the real builder
 * and real files:
 * - every spawn registers the PreToolUse deny hook, whatever the switch says,
 *   since the bridge reads the switch live; its matcher and spec name the
 *   browser servers the session will load, found by package in `.mcp.json`
 *   and in both `~/.claude.json` scopes, whatever the user named them;
 * - with the switch on, the spawn passes the policy as `--append-system-prompt`
 *   and turns Claude in Chrome off with `--no-chrome`; with it off, neither;
 * - the plan approval hook never answers for a browser server while the switch
 *   is on, even when the project allows the server's tools.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommandBuilder } from '../../src/main/agent/adapters/claude';
import { claudeBrowserPolicySpec } from '../../src/main/agent/adapters/claude/hook-manager';
import { BROWSER_POLICY_PROMPT, browserPolicyMatcher } from '../../src/main/agent/shared/browser-policy-hook';
import { encodeHookSpec } from '../../src/main/agent/shared/hook-utils';
import { wslHookPaths, wslHookReplyCommand } from '../../src/main/agent/shared/wsl-hook-transport';
import type { CliTarget } from '../../src/main/agent/shared/cli-target';
import { PATHS } from '../../src/main/config/paths';
import { quoteArg } from '../../src/shared/paths';
import type { CommandOptions } from '../../src/main/agent/agent-adapter';

interface HookEntry { matcher: string; hooks: Array<{ command: string }> }
interface MergedSettings { hooks: Record<string, HookEntry[]> }

let workspace: string;
let projectDir: string;
let homeDir: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-claude-browser-policy-'));
  projectDir = path.join(workspace, 'project');
  homeDir = path.join(workspace, 'home');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  vi.spyOn(os, 'homedir').mockReturnValue(homeDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(workspace, { recursive: true, force: true });
});

function sessionDirFor(sessionId: string): string {
  return path.join(projectDir, '.kangentic', 'sessions', sessionId);
}

function build(sessionId: string, overrides: Partial<CommandOptions> = {}): { command: string; settings: MergedSettings } {
  const sessionDir = sessionDirFor(sessionId);
  const command = new CommandBuilder().buildClaudeCommand({
    cliPath: '/usr/bin/claude',
    taskId: 'browser-policy-task',
    cwd: projectDir,
    projectRoot: projectDir,
    permissionMode: 'default',
    sessionId,
    statusOutputPath: path.join(sessionDir, 'status.json'),
    eventsOutputPath: path.join(sessionDir, 'events.jsonl'),
    shell: 'bash',
    prompt: 'compare the production page with the local build',
    ...overrides,
  });
  const settings = JSON.parse(fs.readFileSync(path.join(sessionDir, 'settings.json'), 'utf-8')) as MergedSettings;
  return { command, settings };
}

function policyEntry(settings: MergedSettings): HookEntry {
  const entries = settings.hooks.PreToolUse.filter((entry) => entry.hooks.some((hook) => hook.command.includes('browser-policy-bridge')));
  expect(entries).toHaveLength(1);
  return entries[0];
}

function specOf(entry: HookEntry): { servers: string[]; serverTokens: string[]; configPath: string } {
  const encoded = entry.hooks[0].command.trim().split(/\s+/).pop() as string;
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
}

describe('Claude browser policy: the deny hook', () => {
  it('registers on every spawn, whatever the switch says, since the bridge reads it live', () => {
    for (const [sessionId, enabled] of [['on-sess', true], ['off-sess', false], ['unset-sess', undefined]] as const) {
      const entry = policyEntry(build(sessionId, { browserAutomationEnabled: enabled }).settings);
      expect(entry.hooks[0].command).toMatch(/^node "[^"]*browser-policy-bridge\.js" [A-Za-z0-9+/=]+$/);
      expect(specOf(entry).configPath.length).toBeGreaterThan(0);
    }
  });

  it('names the browser servers the session loads, found by package whatever the user named them', () => {
    fs.writeFileSync(path.join(projectDir, '.mcp.json'), JSON.stringify({
      mcpServers: {
        'site-checker': { command: 'npx', args: ['@playwright/mcp@latest'] },
        context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
      },
    }));
    fs.writeFileSync(path.join(homeDir, '.claude.json'), JSON.stringify({
      mcpServers: { devtools: { command: 'npx', args: ['chrome-devtools-mcp@latest'] } },
      projects: {
        [projectDir]: { mcpServers: { 'old browser': { command: 'npx', args: ['-y', '@modelcontextprotocol/server-puppeteer'] } } },
        [projectDir.replace(/\\/g, '/')]: { mcpServers: {} },
      },
    }));

    const entry = policyEntry(build('discover-sess', { browserAutomationEnabled: true }).settings);
    const spec = specOf(entry);

    expect(spec.servers).toEqual(expect.arrayContaining(['claude-in-chrome', 'site-checker', 'devtools', 'old_browser']));
    expect(spec.servers).not.toContain('context7');
    expect(spec.serverTokens).toContain('playwright');
    const matcher = new RegExp(`^(?:${entry.matcher})$`);
    expect(matcher.test('mcp__site-checker__browser_navigate')).toBe(true);
    expect(matcher.test('mcp__old_browser__puppeteer_screenshot')).toBe(true);
    expect(matcher.test('mcp__context7__query-docs')).toBe(false);
    expect(matcher.test('mcp__kangentic__kangentic_browser_navigate')).toBe(false);
  });

  it('for a WSL place registers the transport\'s browser-policy reply command carrying the spec', () => {
    const distroHome = path.join(workspace, 'distro-home');
    fs.mkdirSync(distroHome, { recursive: true });
    const place: CliTarget = {
      kind: 'wsl',
      distro: 'Ubuntu',
      linuxCliPath: '/home/dev/.local/bin/claude',
      facts: {
        distro: 'Ubuntu', homeLinux: '/home/dev', homeUnc: distroHome,
        uncRoot: '\\\\wsl.localhost\\Ubuntu', interactivePath: '/usr/bin', env: {}, networkingMode: 'nat',
      },
    };
    const sessionId = 'wsl-policy-sess';

    const { settings } = build(sessionId, { cliTarget: place, browserAutomationEnabled: true });

    const entries = settings.hooks.PreToolUse.filter((entry) => entry.hooks.some((hook) => / reply browser-policy /.test(hook.command)));
    expect(entries).toHaveLength(1);
    const expectedSpec = claudeBrowserPolicySpec(['claude-in-chrome'], PATHS.configFile);
    expect(entries[0].hooks[0].command).toBe(
      wslHookReplyCommand(wslHookPaths(sessionDirFor(sessionId)), place, 'browser-policy', encodeHookSpec(expectedSpec)),
    );
    expect(entries[0].matcher).toBe(browserPolicyMatcher(expectedSpec));
    // The Windows-side bridge script is not what a distro runs.
    expect(entries[0].hooks[0].command).not.toContain('browser-policy-bridge');
  });

  it('keeps the user\'s own PreToolUse hooks beside it', () => {
    fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.claude', 'settings.json'), JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node guard.js' }] }] },
    }));

    const { settings } = build('user-hooks-sess', { browserAutomationEnabled: true });

    expect(settings.hooks.PreToolUse.some((entry) => entry.hooks.some((hook) => hook.command === 'node guard.js'))).toBe(true);
    policyEntry(settings);
  });
});

describe('Claude browser policy: the system prompt and Claude in Chrome', () => {
  it('passes the policy as --append-system-prompt and --no-chrome while the Agent Browser is on', () => {
    const { command } = build('prompt-on', { browserAutomationEnabled: true });

    expect(command).toContain(`--append-system-prompt ${quoteArg(BROWSER_POLICY_PROMPT, 'bash')}`);
    expect(command).toContain('--no-chrome');
    // Not the file form: it is missing from `claude --help`, and Claude exits
    // on an unknown option, so a CLI that predates it would fail every spawn.
    expect(command).not.toContain('--append-system-prompt-file');
    // Both go before the prompt separator, or Claude reads them as prompt text.
    const separator = command.indexOf(' -- ');
    expect(separator).toBeGreaterThan(0);
    expect(command.indexOf('--append-system-prompt')).toBeLessThan(separator);
    expect(command.indexOf('--no-chrome')).toBeLessThan(separator);
  });

  it('passes neither while the Agent Browser is off', () => {
    const { command } = build('prompt-off', { browserAutomationEnabled: false });

    expect(command).not.toContain('--append-system-prompt');
    expect(command).not.toContain('--no-chrome');
  });

  it('adds --no-chrome once for a read-only launch, which already carries it', () => {
    const { command } = build('prompt-read-only', { browserAutomationEnabled: true, readOnly: true });

    expect(command.match(/--no-chrome/g)).toHaveLength(1);
    expect(command).toContain('--append-system-prompt');
  });

  it('keeps the policy text one line with no character a host shell treats specially', () => {
    // cmd.exe keeps only the first line of an argument through an npm .cmd
    // shim (#353), and each of these is special to at least one host shell:
    // a single quote and a backslash to the quoting of sh, fish and nushell.
    expect(BROWSER_POLICY_PROMPT).not.toMatch(/[\r\n"`$%!'\\]/);
  });

  it('names the policy what the reported session needed: any page, any purpose, the tool families by prefix', () => {
    expect(BROWSER_POLICY_PROMPT).toContain('the only browser you drive');
    expect(BROWSER_POLICY_PROMPT).toContain('production');
    expect(BROWSER_POLICY_PROMPT).toContain('artifact');
    expect(BROWSER_POLICY_PROMPT).toContain('mcp__playwright__*');
    expect(BROWSER_POLICY_PROMPT).toContain('mcp__claude-in-chrome__*');
    expect(BROWSER_POLICY_PROMPT).toContain('Open a browser only when the work needs one');
    expect(BROWSER_POLICY_PROMPT).toContain('saveToFile');
  });
});

describe('Claude browser policy: plan approval', () => {
  function planToolApprovalSpec(settings: MergedSettings): { prefixes: string[]; excludedPrefixes: string[] } | null {
    const entry = settings.hooks.PermissionRequest.find((candidate) => candidate.matcher.startsWith('mcp__'));
    if (!entry) return null;
    const encoded = entry.hooks[0].command.trim().split(/\s+/).pop() as string;
    return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  }

  beforeEach(() => {
    fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.claude', 'settings.json'), JSON.stringify({
      permissions: { allow: ['mcp__playwright', 'mcp__context7'] },
    }));
    fs.writeFileSync(path.join(projectDir, '.mcp.json'), JSON.stringify({
      mcpServers: { playwright: { command: 'npx', args: ['@playwright/mcp@latest'] } },
    }));
  });

  it('never answers for a browser server while the Agent Browser is on, even one the project allows', () => {
    const spec = planToolApprovalSpec(build('plan-on', { browserAutomationEnabled: true }).settings);

    expect(spec?.prefixes).toEqual(['mcp__context7__']);
    expect(spec?.excludedPrefixes).toEqual(expect.arrayContaining(['mcp__playwright__', 'mcp__claude-in-chrome__']));
  });

  it('answers for it as before while the Agent Browser is off', () => {
    const spec = planToolApprovalSpec(build('plan-off', { browserAutomationEnabled: false }).settings);

    expect(spec?.prefixes).toEqual(expect.arrayContaining(['mcp__playwright__', 'mcp__context7__']));
  });
});
