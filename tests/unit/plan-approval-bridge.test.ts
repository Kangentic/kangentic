/**
 * plan-approval-bridge.js, the hook that answers an agent CLI's plan approval
 * prompt, run as the CLI runs it: a separate Node process fed the hook payload
 * on stdin. The command is built by the same `buildPlanApprovalCommand` and
 * `CLAUDE_PLAN_APPROVAL_SPEC` the Claude adapter registers, so the spec under
 * test is the shipped one.
 *
 * The ExitPlanMode payload is Claude Code 2.1.302's PermissionRequest, captured
 * in a probe (paths replaced) and kept in
 * tests/fixtures/plan-exit/claude-2.1.302-permission-request-exit-plan-mode.json:
 * ExitPlanMode carries `{plan, planFilePath}`. In the plan spec block every
 * other tool's request is that capture with its tool swapped (AskUserQuestion
 * takes `{questions}`).
 *
 * The tool spec block replays Claude Code 2.1.306's PermissionRequest for an MCP
 * tool in plan mode, as captured: claude-2.1.306-permission-request-mcp-tool.json
 * from the main agent and claude-2.1.306-permission-request-mcp-tool-subagent.json
 * from a subagent, both in tests/fixtures/plan-exit/. Other tools and modes are
 * the main agent capture with `tool_name` or `permission_mode` swapped.
 *
 * What it pins: with the plan spec the hook answers ExitPlanMode and nothing
 * else, only when the decision says to, with the tool input echoed exactly and
 * the decision's mode; with a tool spec, only a tool the spec names, in plan
 * mode, while the decision approves the plan. Either way it fails closed
 * (prints nothing) on every error, so the CLI's own dialog shows and the user
 * decides.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLAUDE_PLAN_APPROVAL_SPEC } from '../../src/main/agent/adapters/claude/hook-manager';
import { claudePlanToolApprovalSpec, type PlanToolApprovalRules } from '../../src/main/agent/adapters/claude/plan-tool-approval';
import { PLAN_APPROVAL_FILE_NAME } from '../../src/main/agent/shared/plan-approval-hook';
import { EventType } from '../../src/shared/types';

const BRIDGE = path.resolve(__dirname, '../../src/main/agent/plan-approval-bridge.js');

const CAPTURED_REQUEST_TEXT = fs.readFileSync(
  path.resolve(__dirname, '../fixtures/plan-exit/claude-2.1.302-permission-request-exit-plan-mode.json'),
  'utf8',
);
const CAPTURED_REQUEST = JSON.parse(CAPTURED_REQUEST_TEXT) as Record<string, unknown>;
const PLAN_INPUT = CAPTURED_REQUEST.tool_input;

const MCP_CAPTURED_TEXT = fs.readFileSync(
  path.resolve(__dirname, '../fixtures/plan-exit/claude-2.1.306-permission-request-mcp-tool.json'),
  'utf8',
);
const MCP_CAPTURED_REQUEST = JSON.parse(MCP_CAPTURED_TEXT) as Record<string, unknown>;

const SUBAGENT_CAPTURED_TEXT = fs.readFileSync(
  path.resolve(__dirname, '../fixtures/plan-exit/claude-2.1.306-permission-request-mcp-tool-subagent.json'),
  'utf8',
);
const SUBAGENT_CAPTURED_REQUEST = JSON.parse(SUBAGENT_CAPTURED_TEXT) as Record<string, unknown>;

/** The tool both MCP captures are a prompt for. */
const CAPTURED_MCP_TOOL = 'mcp__probe__lookup';

/** The captured request as Claude sent it, or with another tool in its place. */
function permissionRequest(toolName: string, toolInput: unknown): string {
  if (toolName === CAPTURED_REQUEST.tool_name && toolInput === PLAN_INPUT) return CAPTURED_REQUEST_TEXT;
  return JSON.stringify({ ...CAPTURED_REQUEST, tool_name: toolName, tool_input: toolInput });
}

let sessionDir: string;
let decisionPath: string;
let eventsPath: string;

beforeEach(() => {
  sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-approval-bridge-'));
  decisionPath = path.join(sessionDir, PLAN_APPROVAL_FILE_NAME);
  eventsPath = path.join(sessionDir, 'events.jsonl');
});

afterEach(() => {
  fs.rmSync(sessionDir, { recursive: true, force: true });
});

function writeDecision(decision: unknown): void {
  fs.writeFileSync(decisionPath, typeof decision === 'string' ? decision : JSON.stringify(decision));
}

function encodedSpec(): string {
  return Buffer.from(JSON.stringify(CLAUDE_PLAN_APPROVAL_SPEC), 'utf8').toString('base64');
}

/** Run the bridge, returning what it printed. */
function runBridge(stdin: string, spec = encodedSpec()): string {
  return execFileSync(process.execPath, [BRIDGE, decisionPath, eventsPath, spec], {
    input: stdin,
    timeout: 5000,
  }).toString('utf8');
}

function readEvents(): Array<Record<string, unknown>> {
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

describe('plan-approval-bridge.js', () => {
  it('approves ExitPlanMode with the input echoed exactly and the decided mode', () => {
    writeDecision({ approve: true, mode: 'acceptEdits', detail: 'Moved to Executing' });
    const printed = JSON.parse(runBridge(permissionRequest('ExitPlanMode', PLAN_INPUT)));
    expect(printed).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: 'allow',
          updatedInput: PLAN_INPUT,
          updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
        },
      },
    });
  });

  it('appends one plan_approval_sent marker carrying the decision detail', () => {
    writeDecision({ approve: true, mode: 'default', detail: 'Stayed in Planning' });
    runBridge(permissionRequest('ExitPlanMode', PLAN_INPUT));
    const events = readEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'plan_approval_sent', detail: 'Stayed in Planning' });
    expect(typeof events[0].ts).toBe('number');
  });

  it('never answers AskUserQuestion, whatever the decision says', () => {
    writeDecision({ approve: true, mode: 'acceptEdits', detail: 'Moved to Executing' });
    const printed = runBridge(permissionRequest('AskUserQuestion', { questions: [{ question: 'Red or blue?' }] }));
    expect(printed).toBe('');
    expect(readEvents()).toEqual([]);
  });

  it('never answers another tool', () => {
    writeDecision({ approve: true, mode: 'acceptEdits', detail: null });
    expect(runBridge(permissionRequest('Write', { file_path: 'probe.txt', content: 'hi' }))).toBe('');
  });

  it('leaves the plan to the user when the decision does not approve', () => {
    writeDecision({ approve: false, mode: 'acceptEdits', detail: 'Moved to Executing' });
    expect(runBridge(permissionRequest('ExitPlanMode', PLAN_INPUT))).toBe('');
    expect(readEvents()).toEqual([]);
  });

  it('leaves the plan to the user when there is no decision file', () => {
    expect(runBridge(permissionRequest('ExitPlanMode', PLAN_INPUT))).toBe('');
    expect(readEvents()).toEqual([]);
  });

  it('fails closed on a broken decision file', () => {
    writeDecision('{"approve": tru');
    expect(runBridge(permissionRequest('ExitPlanMode', PLAN_INPUT))).toBe('');
  });

  it('fails closed on a decision with no mode', () => {
    writeDecision({ approve: true, detail: null });
    expect(runBridge(permissionRequest('ExitPlanMode', PLAN_INPUT))).toBe('');
  });

  it('fails closed on stdin that is not JSON', () => {
    writeDecision({ approve: true, mode: 'acceptEdits', detail: null });
    expect(runBridge('not json')).toBe('');
  });

  it('fails closed on a malformed spec and logs it', () => {
    writeDecision({ approve: true, mode: 'acceptEdits', detail: null });
    expect(runBridge(permissionRequest('ExitPlanMode', PLAN_INPUT), 'not-base64-json')).toBe('');
    expect(fs.existsSync(path.join(sessionDir, 'plan-approval-bridge.error.log'))).toBe(true);
  });

  it('approves nothing when the marker cannot be written', () => {
    // An events path inside a directory that does not exist: the append throws.
    eventsPath = path.join(sessionDir, 'missing', 'events.jsonl');
    writeDecision({ approve: true, mode: 'acceptEdits', detail: null });
    expect(runBridge(permissionRequest('ExitPlanMode', PLAN_INPUT))).toBe('');
  });

  it('maps the mode through the spec when the CLI names it differently', () => {
    writeDecision({ approve: true, mode: 'acceptEdits', detail: null });
    const spec = Buffer.from(JSON.stringify({
      ...CLAUDE_PLAN_APPROVAL_SPEC,
      reply: { mode: '{{mode}}' },
      modes: { acceptEdits: 'auto_edit' },
    }), 'utf8').toString('base64');
    expect(JSON.parse(runBridge(permissionRequest('ExitPlanMode', PLAN_INPUT), spec))).toEqual({ mode: 'auto_edit' });
  });

  it('never answers an MCP tool with the plan spec', () => {
    writeDecision({ approve: true, mode: 'acceptEdits', detail: null });
    expect(runBridge(permissionRequest('mcp__docs__search', { query: 'probe word' }))).toBe('');
  });
});

/**
 * The same bridge with the Claude tool spec (task #870): a tool the project
 * allows, which plan mode asks about anyway. The requests are Claude 2.1.306's
 * captured PermissionRequests for an MCP tool in plan mode, from the main agent
 * and from a subagent (scripts/probe-claude-plan-tool-approval.js), replayed
 * exactly as captured. A case that needs another tool or mode takes the main
 * agent capture and swaps `tool_name` or `permission_mode` into it.
 */
describe('plan-approval-bridge.js with a tool spec', () => {
  const RULES: PlanToolApprovalRules = {
    tools: ['mcp__docs__search', CAPTURED_MCP_TOOL],
    prefixes: ['mcp__context7__'],
    excludedTools: ['mcp__context7__resolve-library-id'],
    excludedPrefixes: ['mcp__kangentic__'],
    inputJudgedTools: [
      { tool: 'Artifact', inputField: 'tool_input', actionField: 'action', allow: ['read', 'list', 'publish'], whenMissing: 'publish' },
    ],
  };
  const BARE_ALLOW = {
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
  };

  function encodeSpec(spec: unknown): string {
    return Buffer.from(JSON.stringify(spec), 'utf8').toString('base64');
  }

  function toolSpec(): string {
    return encodeSpec(claudePlanToolApprovalSpec(RULES));
  }

  /** A shipped spec for these rules with one key left off, as a hand-written spec might omit it. */
  function toolSpecWithout(rules: PlanToolApprovalRules, omittedKey: 'tools' | 'prefixes'): string {
    const spec: Record<string, unknown> = { ...claudePlanToolApprovalSpec(rules) };
    delete spec[omittedKey];
    return encodeSpec(spec);
  }

  /** The main agent capture with its tool or mode swapped. */
  function toolRequest(toolName: string, permissionMode = 'plan'): string {
    return JSON.stringify({ ...MCP_CAPTURED_REQUEST, tool_name: toolName, permission_mode: permissionMode });
  }

  /** The bridge answered with a bare allow, after exactly one marker that names the tool. */
  function expectBareAllow(printed: string, tool: string): void {
    expect(printed).not.toBe('');
    expect(JSON.parse(printed)).toEqual(BARE_ALLOW);
    const events = readEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: EventType.ToolApprovalSent, tool });
    expect(typeof events[0].ts).toBe('number');
  }

  function expectNoAnswer(printed: string): void {
    expect(printed).toBe('');
    expect(readEvents()).toEqual([]);
  }

  it('approves the main agent request exactly as Claude 2.1.306 captured it, with a bare allow after its marker', () => {
    writeDecision({ approve: true, mode: 'auto', detail: 'Moved to Executing' });
    expectBareAllow(runBridge(MCP_CAPTURED_TEXT, toolSpec()), CAPTURED_MCP_TOOL);
  });

  it('approves the subagent request exactly as Claude 2.1.306 captured it', () => {
    // The capture is a subagent's: it carries the ids the main agent's lacks.
    expect(SUBAGENT_CAPTURED_REQUEST.agent_id).toEqual(expect.any(String));
    expect(SUBAGENT_CAPTURED_REQUEST.agent_type).toEqual(expect.any(String));
    expect(MCP_CAPTURED_REQUEST.agent_id).toBeUndefined();
    writeDecision({ approve: true, mode: 'auto', detail: null });
    expectBareAllow(runBridge(SUBAGENT_CAPTURED_TEXT, toolSpec()), CAPTURED_MCP_TOOL);
  });

  it('approves another allowed tool in plan mode with a bare allow, after its marker', () => {
    writeDecision({ approve: true, mode: 'auto', detail: null });
    expectBareAllow(runBridge(toolRequest('mcp__docs__search'), toolSpec()), 'mcp__docs__search');
  });

  it('approves a tool its server is allowed by', () => {
    writeDecision({ approve: true, mode: 'auto', detail: null });
    expectBareAllow(runBridge(toolRequest('mcp__context7__query-docs'), toolSpec()), 'mcp__context7__query-docs');
  });

  it('leaves the prompt to the user when the decision does not approve the plan', () => {
    writeDecision({ approve: false, mode: 'auto', detail: null });
    expect(runBridge(toolRequest('mcp__docs__search'), toolSpec())).toBe('');
    expect(readEvents()).toEqual([]);
  });

  it('answers nothing outside plan mode, even where the decision approves (a workflow task past its plan column)', () => {
    writeDecision({ approve: true, mode: 'auto', detail: null });
    expect(runBridge(toolRequest('mcp__docs__search', 'default'), toolSpec())).toBe('');
    expect(readEvents()).toEqual([]);
  });

  it('never answers a tool no rule names, an excluded tool, or Kangentic\'s own', () => {
    writeDecision({ approve: true, mode: 'auto', detail: null });
    for (const tool of ['mcp__docs__fetch', 'mcp__context7__resolve-library-id', 'mcp__kangentic__kangentic_move_task', 'Bash', 'AskUserQuestion']) {
      expect(runBridge(toolRequest(tool), toolSpec())).toBe('');
    }
    expect(readEvents()).toEqual([]);
  });

  it('never answers the plan exit with a tool spec', () => {
    writeDecision({ approve: true, mode: 'auto', detail: null });
    expect(runBridge(permissionRequest('ExitPlanMode', PLAN_INPUT), toolSpec())).toBe('');
  });

  // Task #952: Planning agents waited minutes on the approval of an Artifact
  // read. A built-in call that only reads or publishes is answered by what its
  // input asks, with no allow rule; a delete keeps its prompt.
  describe('a built-in call judged by its input', () => {
    function artifactRequest(toolInput: unknown): string {
      return JSON.stringify({ ...MCP_CAPTURED_REQUEST, tool_name: 'Artifact', tool_input: toolInput });
    }

    it.each(['read', 'list', 'publish'])('approves an Artifact %s with a bare allow, after its marker', (action) => {
      writeDecision({ approve: true, mode: 'auto', detail: null });
      expectBareAllow(runBridge(artifactRequest({ action, url: 'https://claude.ai/artifact/x' }), toolSpec()), 'Artifact');
    });

    it('approves an Artifact call that leaves its action out, which the tool documents as a publish', () => {
      writeDecision({ approve: true, mode: 'auto', detail: null });
      expectBareAllow(runBridge(artifactRequest({ file_path: '/tmp/page.html' }), toolSpec()), 'Artifact');
    });

    it.each(['delete', 'open', 'pin', 42])('never answers an Artifact call whose action is %s', (action) => {
      writeDecision({ approve: true, mode: 'auto', detail: null });
      expectNoAnswer(runBridge(artifactRequest({ action }), toolSpec()));
    });

    it('never answers an Artifact call with no input object, or outside plan mode', () => {
      writeDecision({ approve: true, mode: 'auto', detail: null });
      expectNoAnswer(runBridge(artifactRequest('read'), toolSpec()));
      expectNoAnswer(runBridge(JSON.stringify({ ...JSON.parse(artifactRequest({ action: 'read' })), permission_mode: 'default' }), toolSpec()));
    });

    it('never answers it when a deny or ask rule names the tool', () => {
      writeDecision({ approve: true, mode: 'auto', detail: null });
      const excluded = encodeSpec(claudePlanToolApprovalSpec({ ...RULES, excludedTools: ['Artifact'] }));
      expectNoAnswer(runBridge(artifactRequest({ action: 'read' }), excluded));
    });
  });

  it('leaves the prompt to the user when there is no decision file', () => {
    expect(runBridge(toolRequest('mcp__docs__search'), toolSpec())).toBe('');
  });

  it('approves nothing when the marker cannot be written', () => {
    eventsPath = path.join(sessionDir, 'missing', 'events.jsonl');
    writeDecision({ approve: true, mode: 'auto', detail: null });
    expect(runBridge(MCP_CAPTURED_TEXT, toolSpec())).toBe('');
  });

  /**
   * Each case changes one thing about the captured request that would otherwise
   * be answered, so the outcome rests on that one thing. The bridge also has an
   * outer catch that turns any throw into silence, which would hide a guard
   * that was removed; the cases that reach a guard first assert the error log
   * stayed empty, so the guard itself is what is pinned.
   */
  describe('fails closed', () => {
    const errorLogPath = (): string => path.join(sessionDir, 'plan-approval-bridge.error.log');

    it('on a decision file that is not JSON', () => {
      writeDecision('{not json');
      expectNoAnswer(runBridge(MCP_CAPTURED_TEXT, toolSpec()));
      expect(fs.existsSync(errorLogPath())).toBe(false);
    });

    it('on a request with no permission_mode', () => {
      const request: Record<string, unknown> = { ...MCP_CAPTURED_REQUEST };
      delete request.permission_mode;
      writeDecision({ approve: true, mode: 'auto', detail: null });
      expectNoAnswer(runBridge(JSON.stringify(request), toolSpec()));
    });

    it('on a decision whose approve is truthy but not true', () => {
      writeDecision({ approve: 'yes', mode: 'auto', detail: null });
      expectNoAnswer(runBridge(MCP_CAPTURED_TEXT, toolSpec()));
    });

    it.each([
      ['null', 'null'],
      ['an array', '[]'],
    ])('on stdin that is JSON but not a request (%s), without raising an error', (_label, stdin) => {
      writeDecision({ approve: true, mode: 'auto', detail: null });
      expectNoAnswer(runBridge(stdin, toolSpec()));
      expect(fs.existsSync(errorLogPath())).toBe(false);
    });
  });

  /**
   * A tool spec is told apart from the plan spec by carrying `tools` or
   * `prefixes`. A spec that names its tools one way only still has to be read
   * as a tool spec, or the plan path would take it and answer nothing.
   */
  describe('routes a spec that carries only one of tools and prefixes', () => {
    const PROBE_ONLY_RULES: PlanToolApprovalRules = {
      tools: [],
      prefixes: [],
      excludedTools: [],
      excludedPrefixes: ['mcp__kangentic__'],
    };

    it('answers a prefixed tool when the spec has prefixes and no tools', () => {
      const spec = toolSpecWithout({ ...PROBE_ONLY_RULES, prefixes: ['mcp__probe__'] }, 'tools');
      writeDecision({ approve: true, mode: 'auto', detail: null });
      expectBareAllow(runBridge(MCP_CAPTURED_TEXT, spec), CAPTURED_MCP_TOOL);
    });

    it('answers nothing outside its prefixes when the spec has prefixes and no tools', () => {
      const spec = toolSpecWithout({ ...PROBE_ONLY_RULES, prefixes: ['mcp__probe__'] }, 'tools');
      writeDecision({ approve: true, mode: 'auto', detail: null });
      expectNoAnswer(runBridge(toolRequest('mcp__docs__search'), spec));
    });

    it('answers its tool when the spec has tools and no prefixes', () => {
      const spec = toolSpecWithout({ ...PROBE_ONLY_RULES, tools: [CAPTURED_MCP_TOOL] }, 'prefixes');
      writeDecision({ approve: true, mode: 'auto', detail: null });
      expectBareAllow(runBridge(MCP_CAPTURED_TEXT, spec), CAPTURED_MCP_TOOL);
    });

    it('answers only the exact tool when the spec has tools and no prefixes', () => {
      const spec = toolSpecWithout({ ...PROBE_ONLY_RULES, tools: [CAPTURED_MCP_TOOL] }, 'prefixes');
      writeDecision({ approve: true, mode: 'auto', detail: null });
      // A sibling on the same server, and a name that merely begins with the tool's.
      for (const tool of ['mcp__probe__other', `${CAPTURED_MCP_TOOL}_all`]) {
        expectNoAnswer(runBridge(toolRequest(tool), spec));
      }
    });
  });
});
