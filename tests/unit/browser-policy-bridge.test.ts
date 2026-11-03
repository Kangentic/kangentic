/**
 * browser-policy-bridge.js, the PreToolUse hook that denies a third-party
 * browser-automation MCP tool while the Kangentic Agent Browser is on (task
 * #977). An agent in a project whose `.mcp.json` shipped Playwright MCP drove
 * that server's Chrome for a whole task instead of the Agent Browser.
 *
 * The spec is the shipped `claudeBrowserPolicySpec`, so the reply shape is the
 * one Claude reads. Probed on Claude Code 2.1.317
 * (`scripts/probe-claude-browser-deny.js`): the deny held in every permission
 * mode and for a subagent, and the reason reached the model as the tool result.
 *
 * What it pins: a browser server's tool is denied by its discovered name, by a
 * name fragment, and in a plugin's form; Kangentic's own tools, other MCP tools
 * and built-ins pass; the Agent Browser switch is read live from the config
 * file (off frees the call, a missing key or file means on, an unreadable file
 * answers nothing); and malformed input prints nothing. The matcher Claude
 * filters with covers every tool the bridge denies.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeBrowserPolicySpec } from '../../src/main/agent/adapters/claude/hook-manager';
import {
  BROWSER_POLICY_REPLACEMENT_TOOL,
  browserPolicyMatcher,
  buildBrowserPolicyCommand,
  isBrowserAutomationServer,
} from '../../src/main/agent/shared/browser-policy-hook';
import { browserPolicyReply } from '../../src/main/agent/browser-policy-bridge';

const BRIDGE = path.resolve(__dirname, '../../src/main/agent/browser-policy-bridge.js');
const CONFIG_PATH = 'config.json';

function encode(spec: unknown): string {
  return Buffer.from(JSON.stringify(spec), 'utf8').toString('base64');
}

const SPEC = encode(claudeBrowserPolicySpec(['claude-in-chrome', 'web-tester'], CONFIG_PATH));

function preToolUse(toolName: string): string {
  return JSON.stringify({
    session_id: 'probe-session',
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: { url: 'https://example.com' },
    tool_use_id: 'toolu_probe',
  });
}

const configSaying = (config: unknown) => () => JSON.stringify(config);
const AGENT_BROWSER_ON = configSaying({ browserAutomation: { enabled: true } });

function reasonOf(printed: string | null): string {
  expect(printed).not.toBeNull();
  const reply = JSON.parse(printed as string) as {
    hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string };
  };
  expect(reply.hookSpecificOutput.hookEventName).toBe('PreToolUse');
  expect(reply.hookSpecificOutput.permissionDecision).toBe('deny');
  return reply.hookSpecificOutput.permissionDecisionReason;
}

describe('browser-policy-bridge', () => {
  it.each([
    ['a name fragment', 'mcp__playwright__browser_navigate'],
    ['a discovered server name', 'mcp__web-tester__browser_take_screenshot'],
    ['Claude in Chrome', 'mcp__claude-in-chrome__navigate'],
    ['a plugin server', 'mcp__plugin_playwright_playwright__browser_evaluate'],
    ['a name fragment in another case', 'mcp__Chrome-DevTools__take_screenshot'],
  ])('denies %s with a reason that names the tool and the replacement', (_case, toolName) => {
    const reason = reasonOf(browserPolicyReply(SPEC, preToolUse(toolName), AGENT_BROWSER_ON));
    expect(reason).toContain(`blocked ${toolName}`);
    expect(reason).toContain(BROWSER_POLICY_REPLACEMENT_TOOL);
    expect(reason).toContain('saveToFile');
    expect(reason).not.toContain('{{tool}}');
  });

  it.each([
    ['Kangentic\'s own browser tool', 'mcp__kangentic__kangentic_browser_navigate'],
    ['another MCP server', 'mcp__context7__query-docs'],
    ['a tool whose own name holds a fragment', 'mcp__github__search_playwright_issues'],
    ['a built-in tool', 'Bash'],
    ['WebFetch', 'WebFetch'],
  ])('lets %s through', (_case, toolName) => {
    expect(browserPolicyReply(SPEC, preToolUse(toolName), AGENT_BROWSER_ON)).toBeNull();
  });

  it('never denies a server named kangentic, even when a spec lists it', () => {
    const spec = encode(claudeBrowserPolicySpec(['kangentic'], CONFIG_PATH));
    expect(browserPolicyReply(spec, preToolUse('mcp__kangentic__kangentic_browser_eval'), AGENT_BROWSER_ON)).toBeNull();
  });

  it('denies a listed server whose own name holds the separator', () => {
    const spec = encode(claudeBrowserPolicySpec(['web__tester'], CONFIG_PATH));
    const toolName = 'mcp__web__tester__browser_navigate';
    expect(reasonOf(browserPolicyReply(spec, preToolUse(toolName), AGENT_BROWSER_ON))).toContain(`blocked ${toolName}`);
    // A server that merely starts the same way is not the listed one.
    expect(browserPolicyReply(spec, preToolUse('mcp__web__other__browser_navigate'), AGENT_BROWSER_ON)).toBeNull();
  });

  it('reads the Agent Browser switch on every call: off lets the call through', () => {
    const off = configSaying({ browserAutomation: { enabled: false } });
    expect(browserPolicyReply(SPEC, preToolUse('mcp__playwright__browser_navigate'), off)).toBeNull();
  });

  it('treats a missing key or a missing config file as on, the default', () => {
    const tool = preToolUse('mcp__playwright__browser_navigate');
    expect(browserPolicyReply(SPEC, tool, configSaying({ theme: 'dark' }))).not.toBeNull();
    const missing = () => {
      throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
    };
    expect(browserPolicyReply(SPEC, tool, missing)).not.toBeNull();
  });

  it('answers nothing when the config file cannot be read or parsed, rather than strand an agent', () => {
    const tool = preToolUse('mcp__playwright__browser_navigate');
    const locked = () => {
      throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    };
    expect(browserPolicyReply(SPEC, tool, locked)).toBeNull();
    expect(browserPolicyReply(SPEC, tool, () => '{ not json')).toBeNull();
  });

  it('prints nothing for malformed or oversized input, or a missing spec', () => {
    expect(browserPolicyReply(SPEC, 'not json', AGENT_BROWSER_ON)).toBeNull();
    expect(browserPolicyReply(SPEC, JSON.stringify({ tool_input: {} }), AGENT_BROWSER_ON)).toBeNull();
    expect(browserPolicyReply(undefined, preToolUse('mcp__playwright__browser_navigate'), AGENT_BROWSER_ON)).toBeNull();
    expect(browserPolicyReply('%%%', preToolUse('mcp__playwright__browser_navigate'), AGENT_BROWSER_ON)).toBeNull();
    const oversized = JSON.stringify({ tool_name: 'mcp__playwright__browser_navigate', padding: 'x'.repeat(1024 * 1024) });
    expect(browserPolicyReply(SPEC, oversized, AGENT_BROWSER_ON)).toBeNull();
  });

  it('as a real process, prints nothing and exits 0 when stdin passes 1 MiB, though a smaller one is denied', () => {
    const encodedSpec = encode(claudeBrowserPolicySpec(['claude-in-chrome'], path.join(os.tmpdir(), 'kangentic-no-such-config.json')));
    const run = (paddingCharacters: number): string => execFileSync(process.execPath, [BRIDGE, encodedSpec], {
      input: JSON.stringify({ tool_name: 'mcp__playwright__browser_navigate', padding: 'x'.repeat(paddingCharacters) }),
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
    }).toString('utf8');
    // The control: the same tool is denied while the input fits the limit.
    expect(run(512 * 1024)).not.toBe('');
    // execFileSync throws on a nonzero exit, so returning at all is exit 0.
    expect(run(1024 * 1024 + 1024)).toBe('');
  });

  it('runs as the CLI runs it: the shipped command, a real process, the real config file', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-browser-policy-'));
    const configPath = path.join(folder, 'config.json');
    const spec = claudeBrowserPolicySpec(['claude-in-chrome'], configPath);
    const command = buildBrowserPolicyCommand('sh-or-powershell', BRIDGE.replace(/\\/g, '/'), spec);
    const encodedSpec = command.split(' ').pop() as string;
    const run = (toolName: string): string =>
      execFileSync(process.execPath, [BRIDGE, encodedSpec], { input: preToolUse(toolName), timeout: 5000 }).toString('utf8');
    try {
      // No config file yet: the default holds.
      expect(reasonOf(run('mcp__playwright__browser_navigate'))).toContain(BROWSER_POLICY_REPLACEMENT_TOOL);
      // The user turns the Agent Browser off: the same running hook lets the call through.
      fs.writeFileSync(configPath, JSON.stringify({ browserAutomation: { enabled: false } }));
      expect(run('mcp__playwright__browser_navigate')).toBe('');
      fs.writeFileSync(configPath, JSON.stringify({ browserAutomation: { enabled: true } }));
      expect(run('mcp__playwright__browser_navigate')).not.toBe('');
      expect(run('mcp__kangentic__kangentic_browser_open_pane')).toBe('');
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe('browserPolicyMatcher', () => {
  const spec = claudeBrowserPolicySpec(['claude-in-chrome', 'web.tester'], CONFIG_PATH);
  const matcher = new RegExp(`^(?:${browserPolicyMatcher(spec)})$`);

  it('matches every tool the bridge denies', () => {
    for (const toolName of [
      'mcp__playwright__browser_navigate',
      'mcp__claude-in-chrome__navigate',
      'mcp__plugin_playwright_playwright__browser_click',
      'mcp__puppeteer__puppeteer_navigate',
      'mcp__web_tester__browser_snapshot',
    ]) {
      expect(matcher.test(toolName)).toBe(true);
    }
  });

  it('matches a server whose name has the separator in it', () => {
    const separatorSpec = claudeBrowserPolicySpec(['web__tester'], CONFIG_PATH);
    const separatorMatcher = new RegExp(`^(?:${browserPolicyMatcher(separatorSpec)})$`);
    expect(separatorMatcher.test('mcp__web__tester__browser_navigate')).toBe(true);
    expect(separatorMatcher.test('mcp__context7__query-docs')).toBe(false);
  });

  it('matches a token in any case, since Claude filters hooks with a case-sensitive pattern', () => {
    expect(matcher.test('mcp__Chrome-DevTools__take_screenshot')).toBe(true);
    expect(matcher.test('mcp__Playwright__browser_navigate')).toBe(true);
    expect(matcher.test('mcp__PUPPETEER__puppeteer_navigate')).toBe(true);
  });

  it('never matches Kangentic\'s own tools even when a listed name is a substring of them', () => {
    const overlappingSpec = claudeBrowserPolicySpec(['browser', 'kangentic'], CONFIG_PATH);
    const overlappingMatcher = new RegExp(`^(?:${browserPolicyMatcher(overlappingSpec)})$`);
    expect(overlappingMatcher.test('mcp__kangentic__kangentic_browser_eval')).toBe(false);
    expect(overlappingMatcher.test('mcp__kangentic__kangentic_browser_navigate')).toBe(false);
    // The listed name still matches another server's tool.
    expect(overlappingMatcher.test('mcp__browser__navigate')).toBe(true);
  });

  it('never matches Kangentic\'s own tools or a built-in, so the hook does not run for them', () => {
    for (const toolName of ['mcp__kangentic__kangentic_browser_navigate', 'mcp__kangentic__kangentic_browser_eval', 'Bash', 'Read']) {
      expect(matcher.test(toolName)).toBe(false);
    }
  });
});

describe('isBrowserAutomationServer', () => {
  it.each([
    [{ name: 'web', command: 'npx', args: ['@playwright/mcp@latest'] }],
    [{ name: 'devtools', command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'] }],
    [{ name: 'browser', command: 'npx', args: ['-y', '@modelcontextprotocol/server-puppeteer'] }],
    [{ name: 'bb', command: 'npx', args: ['@browserbasehq/mcp'] }],
    [{ name: 'playwright', url: 'http://localhost:8931/mcp' }],
  ])('classifies %o as a browser server', (server) => {
    expect(isBrowserAutomationServer(server)).toBe(true);
  });

  it.each([
    [{ name: 'context7', command: 'npx', args: ['-y', '@upstash/context7-mcp'] }],
    [{ name: 'github', url: 'https://api.githubcopilot.com/mcp/' }],
    [{ name: 'kangentic', command: 'npx', args: ['@playwright/mcp'] }],
  ])('leaves %o alone', (server) => {
    expect(isBrowserAutomationServer(server)).toBe(false);
  });
});
