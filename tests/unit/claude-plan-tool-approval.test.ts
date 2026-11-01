/**
 * Which MCP tools the plan approval hook answers for a Claude session while its
 * plan is approved automatically (task #870,
 * src/main/agent/adapters/claude/plan-tool-approval.ts), and the hook entry the
 * real CommandBuilder writes for them.
 *
 * Claude's plan mode prompts for an MCP tool with no read-only annotation even
 * when an allow rule names it, which stopped unattended Planning sessions. The
 * hook answers such a prompt for a tool the user's own allow rules name. What
 * these tests pin is the boundary: only Claude's three MCP rule forms count,
 * Kangentic's own server never does, and a deny or ask rule leaves the tool out
 * (a hook's allow outranks an ask rule, measured on 2.1.306, so Claude would
 * not keep that prompt itself).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeAdapter, CommandBuilder } from '../../src/main/agent/adapters/claude';
import type { CommandOptions } from '../../src/main/agent/agent-adapter';
import {
  CLAUDE_PLAN_TOOL_APPROVAL_MATCHER,
  claudePlanToolApprovalSpec,
  mayApproveClaudePlanTool,
  planToolApprovalRules,
} from '../../src/main/agent/adapters/claude/plan-tool-approval';

/** The MCP half of a session's rules: what its allow rules let the hook answer. */
function mcpLists(rules: ReturnType<typeof planToolApprovalRules>): { tools: string[]; prefixes: string[] } {
  return { tools: rules?.tools ?? [], prefixes: rules?.prefixes ?? [] };
}

const NO_MCP_TOOLS = { tools: [], prefixes: [] };

/** The input-judged built-ins every session's hook answers unless a rule names them (task #952). */
const ARTIFACT_READS_AND_PUBLISHES = [
  { tool: 'Artifact', inputField: 'tool_input', actionField: 'action', allow: ['read', 'list', 'publish'], whenMissing: 'publish' },
];

describe('planToolApprovalRules', () => {
  it('reads the three MCP rule forms: a server, a server wildcard, one tool', () => {
    const rules = planToolApprovalRules([{ allow: ['mcp__docs__search', 'mcp__context7', 'mcp__github__*'] }]);
    expect(rules?.tools).toEqual(['mcp__docs__search']);
    expect(rules?.prefixes).toEqual(['mcp__context7__', 'mcp__github__']);
  });

  it('reads a server name that carries single underscores', () => {
    const rules = planToolApprovalRules([{ allow: ['mcp__claude_ai_Claude_Docs', 'mcp__claude_ai_Claude_Docs__batch'] }]);
    expect(rules?.prefixes).toEqual(['mcp__claude_ai_Claude_Docs__']);
    expect(rules?.tools).toEqual(['mcp__claude_ai_Claude_Docs__batch']);
  });

  it('ignores every allow rule that is not an MCP form: a built-in reaches the hook only by its input', () => {
    const rules = planToolApprovalRules([{
      allow: ['Edit', 'Read', 'Bash(npm test)', 'WebFetch(domain:example.com)', 'mcp__srv__get_*', 'mcp__*', 'mcp__srv__tool(x)', 'mcp__', 42, null],
    }]);
    expect(mcpLists(rules)).toEqual(NO_MCP_TOOLS);
    // No tool that edits files or runs commands, whatever the allow rules say.
    expect(rules?.inputJudgedTools).toEqual(ARTIFACT_READS_AND_PUBLISHES);
  });

  it('answers the input-judged built-ins with no allow rule at all (task #952)', () => {
    const rules = planToolApprovalRules([undefined, {}]);
    expect(mcpLists(rules)).toEqual(NO_MCP_TOOLS);
    expect(rules?.inputJudgedTools).toEqual(ARTIFACT_READS_AND_PUBLISHES);
  });

  it.each(['Artifact', 'Artifact(read)'])('leaves a built-in out when a deny or ask rule names it: %s', (rule) => {
    expect(planToolApprovalRules([{ ask: [rule] }])).toBeNull();
    expect(planToolApprovalRules([{ deny: [rule] }])).toBeNull();
    // An MCP allow rule still registers the hook, without the built-in.
    const rules = planToolApprovalRules([{ allow: ['mcp__docs'], deny: [rule] }]);
    expect(rules?.inputJudgedTools).toEqual([]);
    expect(rules?.excludedTools).toContain('Artifact');
  });

  it('never approves Kangentic\'s own tools, even when allowed', () => {
    expect(mcpLists(planToolApprovalRules([{ allow: ['mcp__kangentic', 'mcp__kangentic__kangentic_move_task'] }]))).toEqual(NO_MCP_TOOLS);
    const rules = planToolApprovalRules([{ allow: ['mcp__kangentic', 'mcp__docs'] }]);
    expect(rules?.prefixes).toEqual(['mcp__docs__']);
    expect(rules?.excludedPrefixes).toContain('mcp__kangentic__');
  });

  it('leaves out a tool a deny or an ask rule names', () => {
    const rules = planToolApprovalRules([{
      allow: ['mcp__docs', 'mcp__docs__search', 'mcp__github__create_issue'],
      ask: ['mcp__docs__fetch'],
      deny: ['mcp__github'],
    }]);
    expect(rules?.tools).toEqual(['mcp__docs__search']);
    expect(rules?.prefixes).toEqual(['mcp__docs__']);
    expect(rules?.excludedTools).toEqual(['mcp__docs__fetch']);
    expect(rules?.excludedPrefixes).toEqual(expect.arrayContaining(['mcp__github__', 'mcp__kangentic__']));
  });

  it('drops a server allowed in one layer and denied in another', () => {
    expect(mcpLists(planToolApprovalRules([{ allow: ['mcp__docs'] }, { deny: ['mcp__docs__*'] }]))).toEqual(NO_MCP_TOOLS);
  });

  it('merges every layer it is given', () => {
    const rules = planToolApprovalRules([{ allow: ['mcp__docs__fetch'] }, undefined, { allow: ['mcp__context7'] }]);
    expect(rules?.tools).toEqual(['mcp__docs__fetch']);
    expect(rules?.prefixes).toEqual(['mcp__context7__']);
  });

  it('names no MCP tool when no layer has an allow list', () => {
    expect(mcpLists(planToolApprovalRules([undefined, {}, { allow: 'mcp__docs' }]))).toEqual(NO_MCP_TOOLS);
  });

  it('returns null when nothing is left to answer: no MCP allow rule, and the built-in denied', () => {
    expect(planToolApprovalRules([{ allow: ['mcp__kangentic'], deny: ['Artifact'] }])).toBeNull();
  });

  it('excludes the text before the wildcard of a partial wildcard ask rule, and keeps the server', () => {
    const rules = planToolApprovalRules([{ allow: ['mcp__docs'], ask: ['mcp__docs__fetch_*'] }]);
    expect(rules?.prefixes).toEqual(['mcp__docs__']);
    expect(rules?.excludedPrefixes).toContain('mcp__docs__fetch_');
  });

  it('leaves out an allowed tool that a partial wildcard ask rule begins', () => {
    const rules = planToolApprovalRules([{
      allow: ['mcp__docs__fetch_page', 'mcp__docs__search'],
      ask: ['mcp__docs__fetch_*'],
    }]);
    expect(rules?.tools).toEqual(['mcp__docs__search']);
  });

  it('drops every allowed server when an ask rule wildcards all of mcp__', () => {
    expect(mcpLists(planToolApprovalRules([{ allow: ['mcp__docs'], ask: ['mcp__*'] }]))).toEqual(NO_MCP_TOOLS);
  });

  it('excludes the text before the specifier of a deny rule that has one', () => {
    const rules = planToolApprovalRules([{ allow: ['mcp__docs'], deny: ['mcp__docs__tool(x)'] }]);
    expect(rules?.prefixes).toEqual(['mcp__docs__']);
    expect(rules?.excludedPrefixes).toContain('mcp__docs__tool');
  });

  it('excludes nothing extra for a deny rule that is not an MCP rule', () => {
    const rules = planToolApprovalRules([{ allow: ['mcp__docs'], deny: ['Bash(rm *)', 'Edit', 42, null] }]);
    expect(rules?.excludedTools).toEqual([]);
    expect(rules?.excludedPrefixes).toEqual(['mcp__kangentic__']);
  });

  // One case per rejecting branch of the rule parser. The positive control in
  // each case is the same list plus a valid tool rule: the valid rule comes out
  // alone, so the rejected one left nothing in any of the four output lists.
  it.each([
    { description: 'a server with an empty tool', rejected: 'mcp__srv__' },
    { description: 'a wildcard server', rejected: 'mcp__*__x' },
    { description: 'a wildcard in a bare server', rejected: 'mcp__srv*' },
    { description: 'a partial wildcard tool', rejected: 'mcp__srv__a*' },
    { description: 'a specifier', rejected: 'mcp__srv(x)' },
  ])('rejects an allow rule with $description: $rejected', ({ rejected }) => {
    expect(mcpLists(planToolApprovalRules([{ allow: [rejected] }]))).toEqual(NO_MCP_TOOLS);
    expect(planToolApprovalRules([{ allow: [rejected, 'mcp__ok__tool'] }])).toEqual({
      tools: ['mcp__ok__tool'],
      prefixes: [],
      excludedTools: [],
      excludedPrefixes: ['mcp__kangentic__'],
      inputJudgedTools: ARTIFACT_READS_AND_PUBLISHES,
    });
  });
});

describe('claudePlanToolApprovalSpec', () => {
  it('answers in plan mode alone with a bare allow and the session\'s lists', () => {
    const spec = claudePlanToolApprovalSpec({
      tools: ['mcp__a__b'],
      prefixes: ['mcp__c__'],
      excludedTools: ['mcp__c__d'],
      excludedPrefixes: ['mcp__kangentic__'],
      inputJudgedTools: ARTIFACT_READS_AND_PUBLISHES,
    });
    expect(spec).toEqual({
      toolField: 'tool_name',
      modeField: 'permission_mode',
      modes: ['plan'],
      tools: ['mcp__a__b'],
      prefixes: ['mcp__c__'],
      excludedTools: ['mcp__c__d'],
      excludedPrefixes: ['mcp__kangentic__'],
      inputJudgedTools: ARTIFACT_READS_AND_PUBLISHES,
      reply: { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } },
    });
  });
});

describe('mayApprovePlanTool', () => {
  it('names any MCP tool but Kangentic\'s and the input-judged built-ins, and never another built-in or a question', () => {
    const adapter = new ClaudeAdapter();
    for (const tool of ['mcp__docs__search', 'mcp__claude_ai_Claude_Docs__batch', 'Artifact']) {
      expect(mayApproveClaudePlanTool(tool)).toBe(true);
      expect(adapter.mayApprovePlanTool(tool)).toBe(true);
    }
    for (const tool of ['mcp__kangentic__kangentic_move_task', 'Bash', 'Edit', 'Write', 'AskUserQuestion', 'ExitPlanMode']) {
      expect(adapter.mayApprovePlanTool(tool)).toBe(false);
    }
  });

  it('matches the input-judged built-ins in the hook\'s matcher, beside every MCP tool', () => {
    expect(CLAUDE_PLAN_TOOL_APPROVAL_MATCHER).toBe('mcp__.*|Artifact');
  });
});

describe('the plan tool approval hook in the merged settings', () => {
  let projectDir: string;
  let homeDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-plan-tool-'));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-plan-tool-home-'));
    vi.spyOn(os, 'homedir').mockReturnValue(homeDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  /** Write a settings file's text as given, for a content `JSON.stringify` of an object cannot make. */
  function writeRawSettings(directory: string, fileName: string, text: string): void {
    fs.mkdirSync(path.join(directory, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(directory, '.claude', fileName), text);
  }

  function writeSettings(directory: string, fileName: string, value: unknown): void {
    writeRawSettings(directory, fileName, JSON.stringify(value));
  }

  type HookEntry = { matcher: string; hooks: Array<{ command: string }> };
  type MergedSettings = { hooks?: Record<string, HookEntry[]>; permissions?: { allow?: string[] } };

  /** Build a plan session, with any option overridden, and return its merged settings and session directory. */
  function buildSession(cwd: string, overrides: Partial<CommandOptions> = {}): { merged: MergedSettings; sessionDir: string } {
    const sessionDir = path.join(projectDir, '.kangentic', 'sessions', 'tool-sess');
    new CommandBuilder().buildClaudeCommand({
      cliPath: '/usr/bin/claude',
      taskId: 'tool-task',
      cwd,
      projectRoot: projectDir,
      permissionMode: 'plan',
      sessionId: 'agent-tool-sess',
      statusOutputPath: path.join(sessionDir, 'status.json'),
      eventsOutputPath: path.join(sessionDir, 'events.jsonl'),
      mcpServerUrl: 'http://127.0.0.1:54321/mcp/test-project/tool-sess',
      mcpServerToken: 'deadbeef-test-token',
      ...overrides,
    });
    const merged = JSON.parse(fs.readFileSync(path.join(sessionDir, 'settings.json'), 'utf-8')) as MergedSettings;
    return { merged, sessionDir };
  }

  /** Build a plan session and return its PermissionRequest entries and session directory. */
  function buildPlanSession(cwd = projectDir): { entries: HookEntry[]; sessionDir: string } {
    const { merged, sessionDir } = buildSession(cwd);
    return { entries: merged.hooks!.PermissionRequest, sessionDir };
  }

  function toolApprover(entries: HookEntry[]): HookEntry | undefined {
    return entries.find((entry) => entry.matcher === CLAUDE_PLAN_TOOL_APPROVAL_MATCHER);
  }

  function decodedSpec(command: string): unknown {
    const encoded = command.trim().split(/\s+/).pop() ?? '';
    return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  }

  it('registers the bridge on MCP tools when the project allows one, beside the plan approver', () => {
    writeSettings(projectDir, 'settings.json', { permissions: { allow: ['Edit', 'mcp__docs__search'] } });
    const { entries, sessionDir } = buildPlanSession();

    expect(entries.find((entry) => entry.matcher === 'ExitPlanMode')).toBeDefined();
    const approver = toolApprover(entries);
    expect(approver).toBeDefined();
    const command = approver!.hooks[0].command;
    expect(command).toContain('plan-approval-bridge');
    expect(command).toContain(path.join(sessionDir, 'plan-approval.json').replace(/\\/g, '/'));
    expect(command).toContain(path.join(sessionDir, 'events.jsonl').replace(/\\/g, '/'));
    // Kangentic's own allow rule is in the merged list, and stays excluded.
    expect(decodedSpec(command)).toMatchObject({
      tools: ['mcp__docs__search'],
      prefixes: [],
      excludedPrefixes: ['mcp__kangentic__'],
      modes: ['plan'],
    });
  });

  it('registers the built-in approver alone when no allow rule names another server\'s tool', () => {
    writeSettings(projectDir, 'settings.json', { permissions: { allow: ['Edit', 'Bash(npm test)', 'mcp__kangentic'] } });
    const approver = toolApprover(buildPlanSession().entries);
    expect(decodedSpec(approver!.hooks[0].command)).toMatchObject({ tools: [], prefixes: [], inputJudgedTools: ARTIFACT_READS_AND_PUBLISHES });
  });

  it('registers nothing when no allow rule names another server\'s tool and a project rule asks for Artifact', () => {
    writeSettings(projectDir, 'settings.json', { permissions: { allow: ['mcp__kangentic'], ask: ['Artifact'] } });
    expect(toolApprover(buildPlanSession().entries)).toBeUndefined();
  });

  it('reads the user\'s own allow rules too', () => {
    writeSettings(homeDir, 'settings.json', { permissions: { allow: ['mcp__context7'] } });
    const approver = toolApprover(buildPlanSession().entries);
    expect(decodedSpec(approver!.hooks[0].command)).toMatchObject({ prefixes: ['mcp__context7__'] });
  });

  it('reads the worktree\'s own local grants', () => {
    const worktreeDir = path.join(projectDir, '.kangentic', 'worktrees', 'tool-task');
    writeSettings(worktreeDir, 'settings.local.json', { permissions: { allow: ['mcp__docs__fetch'] } });
    const approver = toolApprover(buildPlanSession(worktreeDir).entries);
    expect(decodedSpec(approver!.hooks[0].command)).toMatchObject({ tools: ['mcp__docs__fetch'] });
  });

  it('carries a project ask rule into the exclusions', () => {
    writeSettings(projectDir, 'settings.json', { permissions: { allow: ['mcp__docs'], ask: ['mcp__docs__fetch'] } });
    const approver = toolApprover(buildPlanSession().entries);
    expect(decodedSpec(approver!.hooks[0].command)).toMatchObject({
      prefixes: ['mcp__docs__'],
      excludedTools: ['mcp__docs__fetch'],
    });
  });

  describe('a user settings file that is not a JSON object', () => {
    // Written as raw text: `writeSettings` stringifies an object, so it cannot
    // make a file whose whole content is `null`, an array, a string or a number.
    const NOT_AN_OBJECT = ['null', '["x"]', '"x"', '7'];

    it.each(NOT_AN_OBJECT)('reads %s as empty: the build runs and registers the built-in approver alone', (raw) => {
      writeRawSettings(homeDir, 'settings.json', raw);
      let entries: HookEntry[] = [];
      expect(() => { entries = buildPlanSession().entries; }).not.toThrow();
      // The build got as far as its hooks, and the approver names no MCP tool.
      expect(entries.find((entry) => entry.matcher === 'ExitPlanMode')).toBeDefined();
      const approver = toolApprover(entries);
      expect(decodedSpec(approver!.hooks[0].command)).toMatchObject({ tools: [], prefixes: [] });
    });

    it.each(NOT_AN_OBJECT)('beside %s, a project allow rule still registers the approver', (raw) => {
      writeRawSettings(homeDir, 'settings.json', raw);
      writeSettings(projectDir, 'settings.json', { permissions: { allow: ['mcp__docs'] } });
      const approver = toolApprover(buildPlanSession().entries);
      expect(approver).toBeDefined();
      expect(decodedSpec(approver!.hooks[0].command)).toMatchObject({ tools: [], prefixes: ['mcp__docs__'] });
    });

    it.each(NOT_AN_OBJECT)('beside %s, the fullscreen renderer is still the default', (raw) => {
      writeRawSettings(homeDir, 'settings.json', raw);
      const environment = new CommandBuilder().rendererEnvironment({ cwd: projectDir, projectRoot: projectDir }, {});
      expect(environment).toEqual({ CLAUDE_CODE_NO_FLICKER: '1' });
    });
  });

  describe('the registration gate', () => {
    it('registers no tool approver in a build with no events path', () => {
      writeSettings(projectDir, 'settings.json', { permissions: { allow: ['mcp__docs__search'] } });
      const { merged } = buildSession(projectDir, { eventsOutputPath: undefined });
      // The settings were still built from the project's rules, with no hooks of ours.
      expect(merged.permissions?.allow).toContain('mcp__docs__search');
      const entries = Object.values(merged.hooks ?? {}).flat();
      expect(entries.filter((entry) => entry.matcher === CLAUDE_PLAN_TOOL_APPROVAL_MATCHER)).toEqual([]);
      expect(JSON.stringify(merged)).not.toContain('plan-approval-bridge');
      // Control: the same project registers it once an events path is given.
      expect(toolApprover(buildPlanSession().entries)).toBeDefined();
    });

    it('registers the tool approver in a default permission mode build too', () => {
      // Pinned as current behavior: the bridge checks the mode at run time, because a session's mode can change to plan while it runs.
      writeSettings(projectDir, 'settings.json', { permissions: { allow: ['mcp__docs__search'] } });
      const { merged } = buildSession(projectDir, { permissionMode: 'default' });
      const approver = toolApprover(merged.hooks!.PermissionRequest);
      expect(approver).toBeDefined();
      expect(decodedSpec(approver!.hooks[0].command)).toMatchObject({ tools: ['mcp__docs__search'], modes: ['plan'] });
    });
  });
});
