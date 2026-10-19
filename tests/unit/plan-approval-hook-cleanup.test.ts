/**
 * The plan approval hook is a Kangentic-injected hook, so Kangentic's own hook
 * cleanup has to recognize it and a user's hooks have to survive it.
 *
 * `isKangenticHookCommand` (src/main/agent/shared/hook-utils.ts) fingerprints a
 * command as ours by a bridge script name AND a `.kangentic` path. The plan
 * approval hook's script is `plan-approval-bridge`, and its command carries no
 * `event-bridge` or `activity-bridge` in it, so without its own clause every
 * sweep would leave a plan approval hook behind in a settings file.
 *
 * Claude's `removeHooks` (the sweep of a project's `.claude/settings.local.json`)
 * drops our entries through that fingerprint and keeps the user's own.
 *
 * Fixtures build the command with the real `buildPlanApprovalCommand` and the
 * real Claude spec, so the shape under test is the shape that ships.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isKangenticHookCommand, filterKangenticHooks } from '../../src/main/agent/shared/hook-utils';
import { buildPlanApprovalCommand } from '../../src/main/agent/shared/plan-approval-hook';
import { CLAUDE_BRIDGE_SHELL, CLAUDE_PLAN_APPROVAL_SPEC, buildHooks, removeHooks } from '../../src/main/agent/adapters/claude/hook-manager';

/** The command as Kangentic registers it: a session directory under `<project>/.kangentic/`. */
const KANGENTIC_APPROVER = buildPlanApprovalCommand(
  CLAUDE_BRIDGE_SHELL,
  '/opt/app/plan-approval-bridge.js',
  '/work/project/.kangentic/sessions/session-1/plan-approval.json',
  '/work/project/.kangentic/sessions/session-1/events.jsonl',
  CLAUDE_PLAN_APPROVAL_SPEC,
);

/** The same command with every `.kangentic` taken out of its paths, as a user's own script would be. */
const FOREIGN_APPROVER = buildPlanApprovalCommand(
  CLAUDE_BRIDGE_SHELL,
  '/opt/app/plan-approval-bridge.js',
  '/work/project/sessions/session-1/plan-approval.json',
  '/work/project/sessions/session-1/events.jsonl',
  CLAUDE_PLAN_APPROVAL_SPEC,
);

const USER_PERMISSION_COMMAND = 'node "/home/dev/hooks/audit-permissions.js"';

describe('isKangenticHookCommand and the plan approval hook', () => {
  it('has only the plan approval bridge to go on, so the third clause is what is under test', () => {
    // If either older bridge name appeared in the command, deleting the
    // plan-approval-bridge clause would leave these tests green.
    expect(KANGENTIC_APPROVER).toContain('plan-approval-bridge');
    expect(KANGENTIC_APPROVER).not.toContain('event-bridge');
    expect(KANGENTIC_APPROVER).not.toContain('activity-bridge');
  });

  it('recognizes a plan approval command whose paths hold .kangentic', () => {
    expect(isKangenticHookCommand(KANGENTIC_APPROVER)).toBe(true);
  });

  it('does not claim the same command once .kangentic is out of its paths', () => {
    expect(FOREIGN_APPROVER).not.toContain('.kangentic');
    expect(FOREIGN_APPROVER).not.toContain('/kangentic/');
    expect(isKangenticHookCommand(FOREIGN_APPROVER)).toBe(false);
  });

  it('does not claim a user\'s own permission hook', () => {
    expect(isKangenticHookCommand(USER_PERMISSION_COMMAND)).toBe(false);
    expect(isKangenticHookCommand(undefined)).toBe(false);
  });

  it('filterKangenticHooks drops the approver\'s entry and keeps the others', () => {
    const entries = [
      { matcher: 'ExitPlanMode', hooks: [{ type: 'command', command: KANGENTIC_APPROVER }] },
      { matcher: '', hooks: [{ type: 'command', command: USER_PERMISSION_COMMAND }] },
      { matcher: 'ExitPlanMode', hooks: [{ type: 'command', command: FOREIGN_APPROVER }] },
    ];

    const kept = filterKangenticHooks(entries, (entry) => entry.hooks.map((hook) => hook.command));

    expect(kept.map((entry) => entry.hooks[0].command)).toEqual([USER_PERMISSION_COMMAND, FOREIGN_APPROVER]);
  });
});

describe('Claude removeHooks and the plan approval hook', () => {
  let projectDirectory: string;
  const settingsPath = () => path.join(projectDirectory, '.claude', 'settings.local.json');

  beforeEach(() => {
    projectDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-plan-approval-hook-'));
    fs.mkdirSync(path.join(projectDirectory, '.claude'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(projectDirectory, { recursive: true, force: true });
  });

  function writeSettings(settings: unknown): void {
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  }

  function readSettings(): { hooks?: Record<string, Array<{ matcher: string; hooks: Array<{ command: string }> }>>; permissions?: unknown } {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'));
  }

  it('drops a stale ExitPlanMode approver from PermissionRequest and keeps the user\'s own entry', () => {
    writeSettings({
      hooks: {
        PermissionRequest: [
          { matcher: '', hooks: [{ type: 'command', command: USER_PERMISSION_COMMAND }] },
          { matcher: 'ExitPlanMode', hooks: [{ type: 'command', command: KANGENTIC_APPROVER }] },
        ],
      },
    });

    removeHooks(projectDirectory);

    const settings = readSettings();
    expect(settings.hooks?.PermissionRequest).toEqual([
      { matcher: '', hooks: [{ type: 'command', command: USER_PERMISSION_COMMAND }] },
    ]);
  });

  it('removes the event key and leaves the rest of the settings when the approver was its only entry', () => {
    writeSettings({
      permissions: { allow: ['Read'] },
      hooks: {
        PermissionRequest: [
          { matcher: 'ExitPlanMode', hooks: [{ type: 'command', command: KANGENTIC_APPROVER }] },
        ],
        Stop: [
          { matcher: '', hooks: [{ type: 'command', command: 'node "/home/dev/hooks/on-stop.js"' }] },
        ],
      },
    });

    removeHooks(projectDirectory);

    const settings = readSettings();
    expect(settings.hooks).not.toHaveProperty('PermissionRequest');
    expect(settings.hooks?.Stop).toHaveLength(1);
    expect(settings.permissions).toEqual({ allow: ['Read'] });
  });

  it('keeps a user hook that merely names the plan approval bridge outside any .kangentic path', () => {
    writeSettings({
      hooks: {
        PermissionRequest: [
          { matcher: 'ExitPlanMode', hooks: [{ type: 'command', command: FOREIGN_APPROVER }] },
          { matcher: 'ExitPlanMode', hooks: [{ type: 'command', command: KANGENTIC_APPROVER }] },
        ],
      },
    });

    removeHooks(projectDirectory);

    expect(readSettings().hooks?.PermissionRequest).toEqual([
      { matcher: 'ExitPlanMode', hooks: [{ type: 'command', command: FOREIGN_APPROVER }] },
    ]);
  });
});

describe('Claude buildHooks and a user\'s own PermissionRequest entry', () => {
  it('keeps the user\'s entry ahead of ours, with the approver matched exactly to ExitPlanMode', () => {
    const userEntry = { matcher: 'Bash', hooks: [{ type: 'command', command: USER_PERMISSION_COMMAND }] };

    const hooks = buildHooks(
      '/opt/app/event-bridge.js',
      '/work/project/.kangentic/sessions/session-1/events.jsonl',
      { PermissionRequest: [userEntry] },
      { planApprovalCommand: KANGENTIC_APPROVER },
    );

    expect(hooks.PermissionRequest[0]).toEqual(userEntry);
    expect(hooks.PermissionRequest.map((entry) => entry.matcher)).toEqual(['Bash', '', 'ExitPlanMode']);
    expect(hooks.PermissionRequest[2].hooks[0].command).toBe(KANGENTIC_APPROVER);
  });
});
