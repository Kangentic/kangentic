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
import { TransitionEngine, type TransitionEngineServices } from '../../src/main/transition-engine/transition-engine';
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
  /** The Automation agent stand-in an enter or exit Condition is checked on. */
  checkConditions?: TransitionEngineServices['checkConditions'];
}) {
  const runs: Array<{ id: string; status: string; detail: string | null; backgroundCallId: string | null }> = [];
  const automationRunRepo = {
    start: (input: { id: string; backgroundCallId?: string | null }) => {
      runs.push({ id: input.id, status: 'running', detail: null, backgroundCallId: input.backgroundCallId ?? null });
    },
    finish: (id: string, status: string, detail: string | null) => {
      const row = runs.find((candidate) => candidate.id === id);
      if (row) { row.status = status; row.detail = detail; }
    },
    recordSkipped: (input: { id: string; backgroundCallId?: string | null }, reason: string) => {
      runs.push({ id: input.id, status: 'skipped', detail: reason, backgroundCallId: input.backgroundCallId ?? null });
    },
    recordDeliveredByCaller: (input: { id: string; backgroundCallId?: string | null }, detail: string) => {
      runs.push({ id: input.id, status: 'succeeded', detail, backgroundCallId: input.backgroundCallId ?? null });
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
    { checkConditions: options.checkConditions },
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

describe('an enter Condition is checked with the task facts the engine hands the Automation agent', () => {
  const CONDITION_ROW_ID = 'automation-conditioned';

  // The engine's `conditionCheckInput` is one of two places that build the
  // check's task facts (the other is the workflow step), and the PR's merge
  // readiness is one of them. A Condition such as "the PR is ready to merge"
  // reads the platform's verdict from here, so dropping the field would ask the
  // question with the answer missing from the input.
  it.each(['ready', 'running', null] as const)('passes the PR merge readiness (%s) with the rest of the task', async (readiness) => {
    const checkConditions = vi.fn<NonNullable<TransitionEngineServices['checkConditions']>>(async () => ({
      ok: true,
      answers: new Map([[CONDITION_ROW_ID, { met: true, reason: 'The PR can merge.' }]]),
      agentName: 'Mock agent',
    }));
    const delivered: string[] = [];
    const { engine } = makeEngine({
      automations: [makeAutomation({
        id: CONDITION_ROW_ID,
        condition: 'The PR is ready to merge.',
        config: { message: 'merge it', mode: 'immediate' },
      })],
      checkConditions,
    });

    const summary = await engine.executeTransition(
      makeTask({
        pr_url: 'https://example.test/owner/repo/pull/7',
        pr_state: 'open',
        pr_merge_readiness: readiness,
      }),
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

    expect(summary.failures).toEqual([]);
    expect(checkConditions).toHaveBeenCalledTimes(1);
    const checkedInput = checkConditions.mock.calls[0][0];
    expect(checkedInput.task).toMatchObject({
      title: 'Fix the login flow',
      prUrl: 'https://example.test/owner/repo/pull/7',
      prState: 'open',
      prMergeReadiness: readiness,
    });
    expect(checkedInput.trigger).toBe('enter');
    expect(checkedInput.rows.map((row) => row.automationId)).toEqual([CONDITION_ROW_ID]);
    // The answer was yes, so the row ran: the check really gated this delivery.
    expect(delivered).toEqual(['merge it']);
  });
});

// Each Condition check is one recorded background call, filed against the
// project, task and column it judged, and the run rows it caused link back to
// it. These are the hops between the engine and the run log: the call context
// the engine hands the check, and the id a check that ran without answering
// hands the runner.
describe('a Condition check is recorded against the task and column it judges', () => {
  const CONDITION_ROW_ID = 'automation-conditioned';
  const TIMED_OUT = 'The Automation agent did not answer in time.';
  const CODE_REVIEW = makeColumn(COLUMN_ID, 'Code Review');
  const EXPECTED_CALL = { projectId: 'project-1', taskId: 'task-tpl-1', swimlaneId: COLUMN_ID, job: 'condition_check' };

  function conditionedRow(trigger: 'enter' | 'exit' | 'turn_end'): ColumnAutomation {
    return makeAutomation({
      id: CONDITION_ROW_ID,
      trigger,
      condition: 'The PR is ready to merge.',
      config: { message: 'merge it', mode: 'immediate' },
    });
  }

  /** Run the group the way a move does, and say what it delivered. */
  async function runGroup(
    engine: TransitionEngine,
    trigger: 'enter' | 'exit' | 'turn_end',
    extra: Record<string, unknown> = {},
  ): Promise<string[]> {
    const delivered: string[] = [];
    await engine.executeTransition(makeTask(), CODE_REVIEW, trigger, {
      signal: new AbortController().signal,
      fromColumn: trigger === 'enter' ? null : CODE_REVIEW,
      toColumn: trigger === 'enter' ? CODE_REVIEW : makeColumn('lane-testing', 'Testing'),
      deliverToAgent: async (message: string) => { delivered.push(message); },
      showNotification: vi.fn(),
      ...extra,
    } as never);
    return delivered;
  }

  it.each(['enter', 'exit'] as const)('hands an %s group\'s check the project, task and column as its call', async (trigger) => {
    const checkConditions = vi.fn<NonNullable<TransitionEngineServices['checkConditions']>>(async () => ({
      ok: true,
      answers: new Map([[CONDITION_ROW_ID, { met: true, reason: 'The PR can merge.' }]]),
      agentName: 'Mock agent',
      callId: 'c1',
    }));
    const { engine } = makeEngine({ automations: [conditionedRow(trigger)], checkConditions });

    await runGroup(engine, trigger);

    expect(checkConditions).toHaveBeenCalledTimes(1);
    expect(checkConditions.mock.calls[0][2]).toEqual(EXPECTED_CALL);
  });

  it.each(['enter', 'exit'] as const)('links an %s row skipped by a check that ran without answering to that call', async (trigger) => {
    const checkConditions = vi.fn<NonNullable<TransitionEngineServices['checkConditions']>>(async () => ({
      ok: false,
      reason: TIMED_OUT,
      cause: 'failed',
      callId: 'c1',
    }));
    const { engine, runs } = makeEngine({ automations: [conditionedRow(trigger)], checkConditions });

    const delivered = await runGroup(engine, trigger);

    expect(delivered).toEqual([]);
    expect(runs).toEqual([expect.objectContaining({ status: 'skipped', detail: TIMED_OUT, backgroundCallId: 'c1' })]);
  });

  it('links the skip to no call when the check never started, since none was paid for (the control)', async () => {
    const checkConditions = vi.fn<NonNullable<TransitionEngineServices['checkConditions']>>(async () => ({
      ok: false,
      reason: 'Set up an Automation agent in Settings > Workflows to check this condition.',
      cause: 'unavailable',
    }));
    const { engine, runs } = makeEngine({ automations: [conditionedRow('enter')], checkConditions });

    await runGroup(engine, 'enter');

    expect(runs).toEqual([expect.objectContaining({ status: 'skipped', backgroundCallId: null })]);
  });

  // A turn end checks before it runs anything, so the group never calls the
  // service: its caller passes the answers, or why there are none and the call
  // that ran without answering.
  it('links a turn-end row the caller could not get an answer for to the call the caller names', async () => {
    const checkConditions = vi.fn<NonNullable<TransitionEngineServices['checkConditions']>>();
    const { engine, runs } = makeEngine({ automations: [conditionedRow('turn_end')], checkConditions });

    const delivered = await runGroup(engine, 'turn_end', {
      conditionAnswers: new Map(),
      conditionUnavailableReason: TIMED_OUT,
      conditionUnavailableCallId: 'c1',
    });

    expect(checkConditions).not.toHaveBeenCalled();
    expect(delivered).toEqual([]);
    expect(runs).toEqual([expect.objectContaining({ status: 'skipped', detail: TIMED_OUT, backgroundCallId: 'c1' })]);
  });

  it('links a turn-end skip to no call when the caller names none (the control)', async () => {
    const { engine, runs } = makeEngine({ automations: [conditionedRow('turn_end')] });

    await runGroup(engine, 'turn_end', {
      conditionAnswers: new Map(),
      conditionUnavailableReason: 'Set up an Automation agent in Settings > Workflows to check this condition.',
    });

    expect(runs).toEqual([expect.objectContaining({ status: 'skipped', backgroundCallId: null })]);
  });

  // The turn-end runner builds its own check from these two methods, so each is
  // a hop on its own: the description of whose call it is, and the pass-through.
  it('describes a call as the open project, the task and the column', () => {
    const { engine } = makeEngine({ automations: [] });

    expect(engine.conditionCheckCall(makeTask(), CODE_REVIEW)).toEqual(EXPECTED_CALL);
  });

  it('hands the service the limits and the call it was given', async () => {
    const checkConditions = vi.fn<NonNullable<TransitionEngineServices['checkConditions']>>(async () => ({
      ok: false,
      reason: TIMED_OUT,
      cause: 'failed',
      callId: 'c1',
    }));
    const { engine } = makeEngine({ automations: [], checkConditions });
    const input = engine.conditionCheckInput(makeTask(), CODE_REVIEW, 'turn_end', [], {}, {});
    const limits = { signal: new AbortController().signal };
    const call = engine.conditionCheckCall(makeTask(), CODE_REVIEW);

    const outcome = await engine.checkConditions(input, limits, call);

    expect(checkConditions).toHaveBeenCalledTimes(1);
    expect(checkConditions.mock.calls[0][0]).toBe(input);
    expect(checkConditions.mock.calls[0][1]).toBe(limits);
    expect(checkConditions.mock.calls[0][2]).toBe(call);
    // And the outcome comes back whole, with the call the turn-end pass reads.
    expect(outcome).toEqual({ ok: false, reason: TIMED_OUT, cause: 'failed', callId: 'c1' });
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
