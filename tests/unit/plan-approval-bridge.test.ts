/**
 * plan-approval-bridge.js, the hook that answers an agent CLI's plan approval
 * prompt, run as the CLI runs it: a separate Node process fed the hook payload
 * on stdin. The command is built by the same `buildPlanApprovalCommand` and
 * `CLAUDE_PLAN_APPROVAL_SPEC` the Claude adapter registers, so the spec under
 * test is the shipped one.
 *
 * Payload shapes are Claude Code 2.1.302's PermissionRequest, captured in the
 * task 840 probe (paths replaced): ExitPlanMode carries `{plan, planFilePath}`,
 * AskUserQuestion `{questions}`.
 *
 * What it pins: the hook answers ExitPlanMode and nothing else, only when the
 * decision says to, with the tool input echoed exactly and the decision's mode,
 * and it fails closed (prints nothing) on every error, so the CLI's own dialog
 * shows and the user decides.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLAUDE_PLAN_APPROVAL_SPEC } from '../../src/main/agent/adapters/claude/hook-manager';
import { PLAN_APPROVAL_FILE_NAME } from '../../src/main/agent/shared/plan-approval-hook';

const BRIDGE = path.resolve(__dirname, '../../src/main/agent/plan-approval-bridge.js');

const PLAN_INPUT = {
  plan: '1. Create probe.txt containing the word "hi".\n2. Stop once the file is written.',
  planFilePath: 'C:\\Users\\dev\\.claude\\plans\\plan-this-create-a-jaunty-church.md',
};

function permissionRequest(toolName: string, toolInput: unknown): string {
  return JSON.stringify({
    session_id: '3f0b6c1e-0000-4000-8000-000000000000',
    transcript_path: 'C:\\Users\\dev\\.claude\\projects\\probe\\3f0b6c1e.jsonl',
    cwd: 'C:\\Users\\dev\\probe',
    permission_mode: 'plan',
    hook_event_name: 'PermissionRequest',
    tool_name: toolName,
    tool_input: toolInput,
  });
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
});
