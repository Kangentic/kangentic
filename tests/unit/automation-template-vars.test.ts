/**
 * Template variables inside an automation's config, end to end.
 *
 * This covers a seam nothing else reaches. `task-template-vars-parity.test.ts`
 * pins each RESOLVER against a hand-built context, and the spawn specs pin
 * `agent-spawn`'s own `resolveAutoCommandVars`. Between them sits the engine's
 * automations call site, which is the only place that:
 *
 *  - passes a real `move` object, so `{{column}}`, `{{fromColumn}}`,
 *    `{{toColumn}}` and `{{trigger}}` resolve to anything at all. Both other
 *    call sites pass `move: null` by design, which means a regression here is
 *    invisible to every other test in the suite, and those four are the
 *    variables this whole feature added.
 *  - reads `attachmentPaths` off its own `attachmentRepo` and `projectPath` off
 *    `getConfig()`, rather than taking them as arguments.
 *  - hands the result to `interpolateAutomationConfig`, which applies each
 *    FIELD's declared escape. A message is `escape: 'none'` because it is prose
 *    going to an agent; a script is `escape: 'shell'` and strips the characters
 *    that could break out of a quoted value.
 *
 * The adapters are exercised through the real registry, so a message that
 * arrives at `deliverToAgent` is the one a live agent would receive.
 */

import { describe, it, expect, vi } from 'vitest';
import { TransitionEngine } from '../../src/main/transition-engine/transition-engine';
import { interpolateAutomationConfig } from '../../src/main/automations/interpolate-config';
import { AUTOMATION_MANIFEST } from '../../src/shared/automation-manifest';
import type { ColumnAutomation, Swimlane, Task } from '../../src/shared/types';

const COLUMN_ID = 'lane-code-review';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-tpl-1',
    display_id: 42,
    title: 'Fix the login flow',
    description: 'Check OAuth.',
    swimlane_id: COLUMN_ID,
    position: 0,
    agent: 'claude',
    agent_override: null,
    model_override: null,
    effort_override: null,
    session_id: 'pty-1',
    worktree_path: '/mock/worktrees/fix-login',
    branch_name: 'fix-login',
    pr_number: null,
    pr_url: null,
    base_branch: 'develop',
    use_worktree: null,
    labels: [],
    priority: 0,
    attachment_count: 0,
    archived_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Task;
}

function makeColumn(id: string, name: string): Swimlane {
  return {
    id,
    name,
    role: null,
    position: 0,
    color: '#888',
    icon: null,
    is_archived: false,
    is_ghost: false,
    permission_mode: null,
    auto_spawn: true,
    auto_command: null,
    plan_exit_target_id: null,
    agent_override: null,
    model_override: null,
    effort_override: null,
    handoff_context: false,
    session_target: 'main',
    session_spawn_strategy: 'create_or_resume',
    created_at: '2026-01-01T00:00:00.000Z',
  } as Swimlane;
}

function makeAutomation(overrides: Partial<ColumnAutomation> = {}): ColumnAutomation {
  return {
    id: 'automation-1',
    swimlane_id: COLUMN_ID,
    name: 'Review',
    type: 'send_message',
    trigger: 'enter',
    position: 0,
    enabled: true,
    config: { message: 'hello', mode: 'immediate' },
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as ColumnAutomation;
}

/**
 * The engine with only the collaborators the automations path touches. Run
 * records go to an in-memory list; everything a spawn would need is absent on
 * purpose, because a `send_message` row against a task that already has a
 * session never spawns.
 */
function makeEngine(options: {
  automations: ColumnAutomation[];
  attachmentPaths?: string[];
}) {
  const runs: Array<{ id: string; status: string; detail: string | null }> = [];
  const automationRunRepo = {
    start: (input: { id: string }) => { runs.push({ id: input.id, status: 'running', detail: null }); },
    finish: (id: string, status: string, detail: string | null) => {
      const row = runs.find((candidate) => candidate.id === id);
      if (row) { row.status = status; row.detail = detail; }
    },
    recordSkipped: (input: { id: string }, reason: string) => {
      runs.push({ id: input.id, status: 'skipped', detail: reason });
    },
    recordDeliveredByCaller: (input: { id: string }, detail: string) => {
      runs.push({ id: input.id, status: 'succeeded', detail });
    },
  };

  const engine = new TransitionEngine(
    {} as never,
    {} as never,
    { getById: vi.fn(() => makeTask()) } as never,
    () => ({
      projectId: 'project-1',
      projectPath: '/mock/main-project',
      projectName: 'Mock Project',
      gitConfig: { defaultBaseBranch: 'main' },
    }) as never,
    undefined,
    { getPathsForTask: vi.fn(() => options.attachmentPaths ?? []) } as never,
    { getForTrigger: vi.fn(() => options.automations) } as never,
    automationRunRepo as never,
  );

  return { engine, runs };
}

describe('template variables reach an automation config through the engine', () => {
  it('resolves the four move keywords, which no other call site can produce', async () => {
    // Both `agent-spawn`'s resolveAutoCommandVars and the engine's own
    // spawn-prompt call pass `move: null`, so this assertion is the only thing
    // in the suite standing between these four and silently resolving empty.
    const delivered: string[] = [];
    const { engine } = makeEngine({
      automations: [makeAutomation({
        config: {
          message: 'column={{column}} from={{fromColumn}} to={{toColumn}} trigger={{trigger}}',
          mode: 'immediate',
        },
      })],
    });

    const summary = await engine.executeTransition(
      makeTask(),
      makeColumn(COLUMN_ID, 'Code Review'),
      'enter',
      {
        signal: new AbortController().signal,
        fromColumn: makeColumn('lane-executing', 'Executing'),
        toColumn: makeColumn(COLUMN_ID, 'Code Review'),
        deliverToAgent: async (message: string) => { delivered.push(message); },
        showNotification: vi.fn(),
      } as never,
    );

    expect(summary.failures).toEqual([]);
    expect(delivered).toEqual([
      'column=Code Review from=Executing to=Code Review trigger=enter',
    ]);
  });

  it('names the automation own column even on exit, when the task is leaving it', async () => {
    // `{{column}}` is the column the ROW belongs to, not whichever end of the
    // move it happens to be. An exit row should be able to say where it lives
    // without knowing which side it sits on.
    const delivered: string[] = [];
    const { engine } = makeEngine({
      automations: [makeAutomation({
        trigger: 'exit',
        config: { message: '{{column}} -> {{toColumn}} ({{trigger}})', mode: 'immediate' },
      })],
    });

    await engine.executeTransition(
      makeTask(),
      makeColumn(COLUMN_ID, 'Code Review'),
      'exit',
      {
        signal: new AbortController().signal,
        fromColumn: makeColumn(COLUMN_ID, 'Code Review'),
        toColumn: makeColumn('lane-testing', 'Testing'),
        deliverToAgent: async (message: string) => { delivered.push(message); },
        showNotification: vi.fn(),
      } as never,
    );

    expect(delivered).toEqual(['Code Review -> Testing (exit)']);
  });

  it('leaves fromColumn empty for a task born into a column rather than moved into one', async () => {
    const delivered: string[] = [];
    const { engine } = makeEngine({
      automations: [makeAutomation({
        config: { message: 'from=[{{fromColumn}}]', mode: 'immediate' },
      })],
    });

    await engine.executeTransition(
      makeTask(),
      makeColumn(COLUMN_ID, 'Code Review'),
      'enter',
      {
        signal: new AbortController().signal,
        fromColumn: null,
        toColumn: makeColumn(COLUMN_ID, 'Code Review'),
        deliverToAgent: async (message: string) => { delivered.push(message); },
        showNotification: vi.fn(),
      } as never,
    );

    expect(delivered).toEqual(['from=[]']);
  });

  it('reads attachments and projectPath off the engine own collaborators', async () => {
    // These come from `this.attachmentRepo` and `getConfig()`, not from an
    // argument, so a regression that dropped either would be invisible to a
    // resolver-level test. projectPath is deliberately distinct from the task's
    // worktree_path so a swap cannot pass vacuously.
    const delivered: string[] = [];
    const { engine } = makeEngine({
      automations: [makeAutomation({
        config: { message: 'at {{projectPath}} with {{attachments}}', mode: 'immediate' },
      })],
      attachmentPaths: ['/mock/a.png'],
    });

    await engine.executeTransition(
      makeTask({ worktree_path: '/mock/worktrees/fix-login' }),
      makeColumn(COLUMN_ID, 'Code Review'),
      'enter',
      {
        signal: new AbortController().signal,
        fromColumn: null,
        toColumn: makeColumn(COLUMN_ID, 'Code Review'),
        deliverToAgent: async (message: string) => { delivered.push(message); },
        showNotification: vi.fn(),
      } as never,
    );

    expect(delivered).toEqual(['at /mock/main-project with \n/mock/a.png']);
  });

  it('resolves taskNumber and baseBranch, which a webhook payload ties back on', async () => {
    const delivered: string[] = [];
    const { engine } = makeEngine({
      automations: [makeAutomation({
        config: { message: '#{{taskNumber}} off {{baseBranch}}', mode: 'immediate' },
      })],
    });

    await engine.executeTransition(
      makeTask({ display_id: 42, base_branch: 'develop' }),
      makeColumn(COLUMN_ID, 'Code Review'),
      'enter',
      {
        signal: new AbortController().signal,
        fromColumn: null,
        toColumn: makeColumn(COLUMN_ID, 'Code Review'),
        deliverToAgent: async (message: string) => { delivered.push(message); },
        showNotification: vi.fn(),
      } as never,
    );

    expect(delivered).toEqual(['#42 off develop']);
  });
});

describe('interpolateAutomationConfig applies each field own escape', () => {
  const messageFields = AUTOMATION_MANIFEST.send_message.fields;
  const scriptFields = AUTOMATION_MANIFEST.run_script.fields;

  it('sends a message raw, because it is prose going to an agent', () => {
    const result = interpolateAutomationConfig(
      { message: 'Review {{title}}', mode: 'immediate' },
      messageFields,
      { title: "Fix the user's login; it broke" },
    );

    expect(result.message).toBe("Review Fix the user's login; it broke");
  });

  it('strips shell metacharacters out of a script, so an imported title cannot run', () => {
    // A title arriving from a GitHub issue is not text this user wrote. The
    // field declares `escape: 'shell'`, and the runner strips rather than
    // quoting because correct quoting differs per shell.
    const result = interpolateAutomationConfig(
      { script: 'echo {{title}}' },
      scriptFields,
      { title: 'oops; rm -rf /' },
    );

    expect(result.script).not.toContain(';');
    expect(result.script).toContain('echo ');
  });

  it('escapes the VALUE and not the template, so the author own punctuation survives', () => {
    const result = interpolateAutomationConfig(
      { script: 'echo "{{title}}" && done' },
      scriptFields,
      { title: 'plain' },
    );

    expect(result.script).toContain('"plain"');
    expect(result.script).toContain('&&');
  });

  it('leaves a field the manifest does not mark templateVariables exactly as written', () => {
    // `mode` is a select. A value that happens to look like a variable is data.
    const result = interpolateAutomationConfig(
      { message: '{{title}}', mode: '{{title}}' },
      messageFields,
      { title: 'substituted' },
    );

    expect(result.message).toBe('substituted');
    expect(result.mode).toBe('{{title}}');
  });

  it('passes an unknown variable through literally, as the field editor promises', () => {
    const result = interpolateAutomationConfig(
      { message: 'hello {{nope}}', mode: 'immediate' },
      messageFields,
      { title: 'x' },
    );

    expect(result.message).toBe('hello {{nope}}');
  });
});
