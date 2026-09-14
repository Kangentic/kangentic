/**
 * The runner's reliability guarantees.
 *
 * Every assertion here corresponds to a live defect in the action system this
 * replaces, so these are regression tests for behaviour that shipped broken:
 * one throw aborted the rest of the list and was then swallowed while the move
 * reported success; nothing timed out, so a hung webhook held the task lock
 * until a restart; and no run was recorded anywhere, so "did it run" had no
 * answer.
 *
 * Driven through a test registry rather than the real adapters, so the
 * guarantees are exercised without a PTY, a network, or a database.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runAutomations } from '../../src/main/automations/automation-runner';
import { AutomationRegistry } from '../../src/main/automations/automation-registry';
import {
  AutomationPermanentError,
  AutomationRetryableError,
} from '../../src/main/automations/shared/automation-errors';
import { AUTOMATION_MANIFEST } from '../../src/shared/automation-manifest';
import type { AutomationAdapter, AutomationContext } from '../../src/main/automations/shared/automation-adapter';
import type { AutomationRunRepository } from '../../src/main/db/repositories/automation-run-repository';
import type { AutomationRunStatus, ColumnAutomation, Swimlane, Task } from '../../src/shared/types';

// --- fixtures -------------------------------------------------------------

const COLUMN: Swimlane = {
  id: 'lane-executing',
  name: 'Executing',
  description: null,
  role: null,
  position: 1,
  color: '#3b82f6',
  icon: null,
  is_archived: false,
  is_ghost: false,
  permission_mode: null,
  auto_spawn: true,
  auto_command: null,
  auto_command_mode: 'immediate',
  plan_exit_target_id: null,
  agent_override: null,
  model_override: null,
  effort_override: null,
  handoff_context: false,
  session_target: 'main',
  session_spawn_strategy: 'create_or_resume',
  created_at: '2026-01-01T00:00:00.000Z',
};

function task(overrides: Partial<Task> = {}): Task {
  return { id: 'task-1', title: 'A task', session_id: 'session-1', ...overrides } as Task;
}

function automation(overrides: Partial<ColumnAutomation> = {}): ColumnAutomation {
  return {
    id: 'a1',
    swimlane_id: COLUMN.id,
    name: 'Ping',
    type: 'webhook',
    trigger: 'enter',
    position: 0,
    enabled: true,
    config: {},
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Records what the runner wrote, so the assertions read like the run log. */
function fakeRuns() {
  const rows: Array<{ id: string; status: AutomationRunStatus; detail: string | null; attempts: number }> = [];
  const repository = {
    start: (input: { id: string }) => {
      rows.push({ id: input.id, status: 'running', detail: null, attempts: 0 });
    },
    finish: (id: string, status: AutomationRunStatus, detail: string | null, attempts = 1) => {
      const row = rows.find((candidate) => candidate.id === id);
      if (row) Object.assign(row, { status, detail, attempts });
    },
    recordSkipped: (input: { id: string }, reason: string) => {
      rows.push({ id: input.id, status: 'skipped', detail: reason, attempts: 0 });
    },
  };
  return { rows, repository: repository as unknown as AutomationRunRepository };
}

function context(overrides: Partial<AutomationContext> = {}): Omit<AutomationContext, 'runId' | 'signal'> {
  return {
    task: task(),
    column: COLUMN,
    fromColumn: null,
    toColumn: COLUMN,
    trigger: 'enter',
    cwd: '/mock/worktree',
    projectId: 'project-1',
    projectPath: '/mock/project',
    projectName: 'Mock',
    templateVars: { title: 'A task', toColumn: 'Executing' },
    sessionHost: { spawn: vi.fn(), kill: vi.fn(), on: vi.fn(), off: vi.fn() },
    deliverToAgent: vi.fn(async () => {}),
    showNotification: vi.fn(),
    ...overrides,
  } as Omit<AutomationContext, 'runId' | 'signal'>;
}

/** A stand-in adapter whose behaviour each test picks. */
function testAdapter(
  id: 'webhook' | 'run_script' | 'send_message' | 'notify',
  execute: AutomationAdapter['execute'],
  manifestOverrides: Partial<(typeof AUTOMATION_MANIFEST)['webhook']> = {},
): AutomationAdapter {
  return {
    id,
    manifest: { ...AUTOMATION_MANIFEST[id], ...manifestOverrides },
    describe: () => 'test',
    execute,
  };
}

function registryOf(...adapters: AutomationAdapter[]): AutomationRegistry {
  const registry = new AutomationRegistry();
  for (const adapter of adapters) registry.register(adapter);
  return registry;
}

// --- tests ----------------------------------------------------------------

describe('one row failing', () => {
  it('does not stop the rest of the list', async () => {
    const order: string[] = [];
    const { rows, repository } = fakeRuns();
    const registry = registryOf(
      testAdapter('webhook', async () => {
        order.push('webhook');
        throw new AutomationPermanentError('example.com answered HTTP 404.');
      }),
      testAdapter('notify', async () => {
        order.push('notify');
        return { detail: 'Shown' };
      }),
    );

    const summary = await runAutomations({
      automations: [automation({ id: 'a1', type: 'webhook' }), automation({ id: 'a2', type: 'notify', name: 'Tell me' })],
      column: COLUMN,
      context: context(),
      runs: repository,
      signal: new AbortController().signal,
      registry,
    });

    expect(order).toEqual(['webhook', 'notify']);
    expect(summary.outcomes.map((outcome) => outcome.status)).toEqual(['failed', 'succeeded']);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0].name).toBe('Ping');
    expect(rows.map((row) => row.status)).toEqual(['failed', 'succeeded']);
    expect(rows[0].detail).toBe('example.com answered HTTP 404.');
  });

  it('never throws out of the runner for the automation sake', async () => {
    const { repository } = fakeRuns();
    const registry = registryOf(testAdapter('webhook', async () => {
      throw new Error('boom');
    }));

    await expect(runAutomations({
      automations: [automation()],
      column: COLUMN,
      context: context(),
      runs: repository,
      signal: new AbortController().signal,
      registry,
    })).resolves.toBeDefined();
  });
});

describe('budgets', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('stops a row that outlives its adapter budget, and records it', async () => {
    const { rows, repository } = fakeRuns();
    const registry = registryOf(testAdapter(
      'webhook',
      (_config, runContext) => new Promise((_resolve, reject) => {
        runContext.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
      { timeoutMs: 1000, retry: null },
    ));

    const run = runAutomations({
      automations: [automation()],
      column: COLUMN,
      context: context(),
      runs: repository,
      signal: new AbortController().signal,
      registry,
    });

    await vi.advanceTimersByTimeAsync(1500);
    const summary = await run;

    expect(summary.outcomes[0].status).toBe('failed');
    expect(rows[0].detail).toMatch(/Gave up after 1s/);
  });

  it('caps an exit group so a slow row cannot hold the short lock', async () => {
    const { rows, repository } = fakeRuns();
    // The first row eats the whole group budget; the second must not run.
    const slow = registryOf(
      testAdapter('webhook', (_config, runContext) => new Promise((_resolve, reject) => {
        runContext.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }), { timeoutMs: 30_000, retry: null }),
      testAdapter('notify', async () => ({ detail: 'Shown' })),
    );

    const run = runAutomations({
      automations: [
        automation({ id: 'a1', type: 'webhook', trigger: 'exit' }),
        automation({ id: 'a2', type: 'notify', name: 'Tell me', trigger: 'exit' }),
      ],
      column: COLUMN,
      context: context({ trigger: 'exit' }),
      runs: repository,
      signal: new AbortController().signal,
      registry: slow,
      groupBudgetMs: 500,
    });

    await vi.advanceTimersByTimeAsync(1000);
    const summary = await run;

    expect(summary.outcomes[0].status).toBe('failed');
    expect(summary.outcomes[1].status).toBe('skipped');
    expect(rows[1].detail).toBe('Exit automations are capped so the board stays responsive.');
  });
});

describe('retry', () => {
  it('retries a retryable failure up to the manifest attempts', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const { rows, repository } = fakeRuns();
    const registry = registryOf(testAdapter('webhook', async () => {
      attempts += 1;
      if (attempts < 3) throw new AutomationRetryableError('example.com answered HTTP 503.');
      return { detail: 'HTTP 200' };
    }));

    const run = runAutomations({
      automations: [automation()],
      column: COLUMN,
      context: context(),
      runs: repository,
      signal: new AbortController().signal,
      registry,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    const summary = await run;
    vi.useRealTimers();

    expect(attempts).toBe(3);
    expect(summary.outcomes[0].status).toBe('succeeded');
    expect(rows[0].attempts).toBe(3);
  });

  it('does not retry a permanent failure, however many attempts are allowed', async () => {
    let attempts = 0;
    const { rows, repository } = fakeRuns();
    const registry = registryOf(testAdapter('webhook', async () => {
      attempts += 1;
      throw new AutomationPermanentError('example.com answered HTTP 404.');
    }));

    await runAutomations({
      automations: [automation()],
      column: COLUMN,
      context: context(),
      runs: repository,
      signal: new AbortController().signal,
      registry,
    });

    // Retrying a 404 three times just fails three times more slowly.
    expect(attempts).toBe(1);
    expect(rows[0].attempts).toBe(1);
  });

  it('never retries an adapter whose manifest declares no policy', async () => {
    let attempts = 0;
    const { repository } = fakeRuns();
    const registry = registryOf(testAdapter('run_script', async () => {
      attempts += 1;
      throw new AutomationRetryableError('transient');
    }));

    await runAutomations({
      automations: [automation({ type: 'run_script' })],
      column: COLUMN,
      context: context(),
      runs: repository,
      signal: new AbortController().signal,
      registry,
    });

    // A half-run script is not safe to repeat, whatever the error claims.
    expect(attempts).toBe(1);
  });
});

describe('the agent', () => {
  it('starts before the first row that needs it, exactly once', async () => {
    const startAgent = vi.fn(async () => {});
    const { repository } = fakeRuns();
    const registry = registryOf(
      testAdapter('run_script', async () => ({ detail: 'exit 0' })),
      testAdapter('send_message', async () => ({ detail: 'Delivered' })),
    );

    const summary = await runAutomations({
      automations: [
        automation({ id: 'a1', type: 'run_script', name: 'Setup' }),
        automation({ id: 'a2', type: 'send_message', name: 'Review' }),
        automation({ id: 'a3', type: 'send_message', name: 'And again', position: 2 }),
      ],
      column: COLUMN,
      context: context({ task: task({ session_id: null }) }),
      runs: repository,
      signal: new AbortController().signal,
      registry,
      startAgent,
    });

    expect(startAgent).toHaveBeenCalledTimes(1);
    expect(summary.startedAgent).toBe(true);
    expect(summary.outcomes.map((outcome) => outcome.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
  });

  it('does not start one when a session is already attached', async () => {
    const startAgent = vi.fn(async () => {});
    const { repository } = fakeRuns();
    const registry = registryOf(testAdapter('send_message', async () => ({ detail: 'Delivered' })));

    const summary = await runAutomations({
      automations: [automation({ type: 'send_message' })],
      column: COLUMN,
      context: context(),
      runs: repository,
      signal: new AbortController().signal,
      registry,
      startAgent,
    });

    expect(startAgent).not.toHaveBeenCalled();
    expect(summary.startedAgent).toBe(false);
  });

  it('skips an agent-needing exit row, because an exit cannot start an agent', async () => {
    const { rows, repository } = fakeRuns();
    const registry = registryOf(testAdapter('send_message', async () => ({ detail: 'Delivered' })));

    const summary = await runAutomations({
      automations: [automation({ type: 'send_message', trigger: 'exit' })],
      column: COLUMN,
      context: context({ trigger: 'exit', task: task({ session_id: null }) }),
      runs: repository,
      signal: new AbortController().signal,
      registry,
      // No startAgent on the exit path.
    });

    expect(summary.outcomes[0].status).toBe('skipped');
    // Worded for the fact rather than for this caller: a re-run reaches the
    // same branch with an ENTER row, where "an exit automation cannot start
    // one" read as plainly wrong to the user who asked for the re-run.
    expect(rows[0].detail).toMatch(/only a move into this column can start one/);
  });

  it('skips the rows that needed an agent that failed to start, and runs the rest', async () => {
    const { repository } = fakeRuns();
    const registry = registryOf(
      testAdapter('send_message', async () => ({ detail: 'Delivered' })),
      testAdapter('notify', async () => ({ detail: 'Shown' })),
    );

    const summary = await runAutomations({
      automations: [
        automation({ id: 'a1', type: 'send_message', name: 'Review' }),
        automation({ id: 'a2', type: 'notify', name: 'Tell me' }),
      ],
      column: COLUMN,
      context: context({ task: task({ session_id: null }) }),
      runs: repository,
      signal: new AbortController().signal,
      registry,
      startAgent: async () => {
        throw new Error('claude CLI not found');
      },
    });

    expect(summary.outcomes[0].status).toBe('skipped');
    expect(summary.outcomes[0].detail).toMatch(/claude CLI not found/);
    expect(summary.outcomes[1].status).toBe('succeeded');
  });
});

describe('rows the column cannot run', () => {
  it('records the reason canColumnRun gave, rather than failing', async () => {
    const { rows, repository } = fakeRuns();
    const registry = registryOf(testAdapter('send_message', async () => ({ detail: 'Delivered' })));

    const summary = await runAutomations({
      automations: [automation({ type: 'send_message' })],
      column: { ...COLUMN, auto_spawn: false },
      context: context(),
      runs: repository,
      signal: new AbortController().signal,
      registry,
    });

    expect(summary.outcomes[0].status).toBe('skipped');
    expect(rows[0].detail).toBe('Start an agent here is off.');
  });

  it('skips a type this build does not know instead of throwing', async () => {
    const { rows, repository } = fakeRuns();
    const registry = registryOf(testAdapter('notify', async () => ({ detail: 'Shown' })));

    const summary = await runAutomations({
      automations: [automation({ type: 'webhook' })],
      column: COLUMN,
      context: context(),
      runs: repository,
      signal: new AbortController().signal,
      registry,
    });

    expect(summary.outcomes[0].status).toBe('skipped');
    expect(rows[0].detail).toMatch(/does not know the automation type/);
  });
});

// A recovery move out of Done delivers nothing to the agent. The guard has to
// live in the runner: `deliverToAgent` is a silent no-op on that path, so
// letting the adapter run would record "Delivered" for a message nobody got.
describe('a recovery move out of Done', () => {
  it('records the message row as skipped rather than letting it report Delivered', async () => {
    const { rows, repository } = fakeRuns();
    const executed: string[] = [];
    const registry = registryOf(testAdapter('send_message', async () => {
      executed.push('send_message');
      return { detail: 'Delivered' };
    }));

    const summary = await runAutomations({
      automations: [automation({ type: 'send_message' })],
      column: COLUMN,
      context: context(),
      runs: repository,
      signal: new AbortController().signal,
      suppressAgentMessages: true,
      registry,
    });

    expect(executed).toEqual([]);
    expect(summary.outcomes[0].status).toBe('skipped');
    expect(rows[0].detail).toBe('Restoring a task from Done does not message the agent. The next move does.');
  });

  it('still runs every row that does not need the agent', async () => {
    const { repository } = fakeRuns();
    const executed: string[] = [];
    const registry = registryOf(
      testAdapter('send_message', async () => { executed.push('send_message'); return { detail: 'Delivered' }; }),
      testAdapter('notify', async () => { executed.push('notify'); return { detail: 'Shown' }; }),
    );

    const summary = await runAutomations({
      automations: [automation({ id: 'a', type: 'send_message' }), automation({ id: 'b', type: 'notify' })],
      column: COLUMN,
      context: context(),
      runs: repository,
      signal: new AbortController().signal,
      suppressAgentMessages: true,
      registry,
    });

    expect(executed).toEqual(['notify']);
    expect(summary.outcomes.map((outcome) => outcome.status)).toEqual(['skipped', 'succeeded']);
  });

  it('never starts the agent for a message it is going to skip', async () => {
    const { repository } = fakeRuns();
    let started = 0;
    const registry = registryOf(testAdapter('send_message', async () => ({ detail: 'Delivered' })));

    const summary = await runAutomations({
      automations: [automation({ type: 'send_message' })],
      column: COLUMN,
      context: context({ task: task({ session_id: null }) }),
      runs: repository,
      signal: new AbortController().signal,
      suppressAgentMessages: true,
      startAgent: async () => { started += 1; },
      registry,
    });

    expect(started).toBe(0);
    expect(summary.startedAgent).toBe(false);
    expect(summary.outcomes[0].status).toBe('skipped');
  });
});

// The warm live-injection path delivers a column's FIRST message itself,
// bundled into the same keystroke burst as a `/model` or `/effort` change,
// because a live session should get one burst rather than two. It then runs the
// rest of the group through the runner, and this is what keeps the message from
// going out twice.
describe('rows the caller already delivered', () => {
  it('does not execute them, and writes no second run record', async () => {
    const { rows, repository } = fakeRuns();
    const executed: string[] = [];
    const registry = registryOf(
      testAdapter('send_message', async () => { executed.push('send_message'); return { detail: 'Delivered' }; }),
      testAdapter('notify', async () => { executed.push('notify'); return { detail: 'Shown' }; }),
    );

    const summary = await runAutomations({
      automations: [
        automation({ id: 'already-sent', type: 'send_message', name: 'Greet', position: 0 }),
        automation({ id: 'still-mine', type: 'notify', name: 'Tell me', position: 1 }),
      ],
      column: COLUMN,
      context: context(),
      runs: repository,
      signal: new AbortController().signal,
      alreadyDelivered: new Set(['already-sent']),
      registry,
    });

    expect(executed).toEqual(['notify']);
    // No record at all for the pre-delivered row: exactly one run row, and one
    // outcome, both for the OTHER automation. It DID run, and the caller that
    // ran it reports its real outcome on the auto-command channel, so a row
    // here would double-count it in the log the user reads.
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('succeeded');
    expect(summary.outcomes).toHaveLength(1);
    expect(summary.outcomes[0].name).toBe('Tell me');
  });

  it('runs the whole group when the set is empty', async () => {
    const { repository } = fakeRuns();
    const executed: string[] = [];
    const registry = registryOf(
      testAdapter('send_message', async () => { executed.push('send_message'); return { detail: 'Delivered' }; }),
      testAdapter('notify', async () => { executed.push('notify'); return { detail: 'Shown' }; }),
    );

    await runAutomations({
      automations: [
        automation({ id: 'one', type: 'send_message', position: 0 }),
        automation({ id: 'two', type: 'notify', position: 1 }),
      ],
      column: COLUMN,
      context: context(),
      runs: repository,
      signal: new AbortController().signal,
      registry,
    });

    expect(executed).toEqual(['send_message', 'notify']);
  });
});

describe('the move being superseded', () => {
  it('rethrows, because that is the caller business and not a row failure', async () => {
    const controller = new AbortController();
    const { rows, repository } = fakeRuns();
    const registry = registryOf(testAdapter('webhook', async () => {
      controller.abort(new Error('superseded'));
      throw new Error('aborted');
    }));

    await expect(runAutomations({
      automations: [automation()],
      column: COLUMN,
      context: context(),
      runs: repository,
      signal: controller.signal,
      registry,
    })).rejects.toThrow();

    expect(rows[0].status).toBe('interrupted');
  });
});

describe('template substitution', () => {
  it('escapes each value for the field it lands in', async () => {
    const seen: string[] = [];
    const { repository } = fakeRuns();
    const registry = registryOf(testAdapter('run_script', async (config) => {
      seen.push(config.script ?? '');
      return { detail: 'exit 0' };
    }));

    await runAutomations({
      automations: [automation({ type: 'run_script', config: { script: 'echo {{title}}' } })],
      column: COLUMN,
      context: context({ templateVars: { title: 'fix; rm -rf ~' } }),
      runs: repository,
      signal: new AbortController().signal,
      registry,
    });

    // The shell metacharacters are stripped, so the value cannot chain a command.
    expect(seen[0]).toBe('echo fix rm -rf ~');
  });

  it('hands every adapter the SAME resolved variables', async () => {
    // Replaces the old "executeAction builds ONE shared templateVars for every
    // action type" test. That used to be incidental (one object built in a
    // switch); it is now structural, because executeTransition resolves the
    // variables once and the runner passes that object to every adapter. The
    // regression it guards is a base ref meaning one thing in a script and
    // another in a webhook.
    const seen: string[] = [];
    const { repository } = fakeRuns();
    const record = async (config: { script?: string; url?: string; title?: string }) => {
      seen.push(config.script ?? config.url ?? config.title ?? '');
      return { detail: 'ok' };
    };
    const registry = registryOf(
      testAdapter('run_script', async (config) => record(config)),
      testAdapter('webhook', async (config) => record(config)),
      testAdapter('notify', async (config) => record(config)),
    );

    await runAutomations({
      automations: [
        automation({ id: 'a1', type: 'run_script', name: 'Script', config: { script: '{{baseBranch}}' } }),
        automation({ id: 'a2', type: 'webhook', name: 'Hook', config: { url: 'https://x.test/{{baseBranch}}' } }),
        automation({ id: 'a3', type: 'notify', name: 'Tell me', config: { title: '{{baseBranch}}' } }),
      ],
      column: COLUMN,
      context: context({ templateVars: { baseBranch: 'develop' } }),
      runs: repository,
      signal: new AbortController().signal,
      registry,
    });

    expect(seen).toEqual(['develop', 'https://x.test/develop', 'develop']);
  });

  it('leaves a value raw where the field says it may be', async () => {
    const seen: string[] = [];
    const { repository } = fakeRuns();
    const registry = registryOf(testAdapter('send_message', async (config) => {
      seen.push(config.message ?? '');
      return { detail: 'Delivered' };
    }));

    await runAutomations({
      automations: [automation({ type: 'send_message', config: { message: 'Fix {{title}}' } })],
      column: COLUMN,
      context: context({ templateVars: { title: 'the "quoted" bug & more' } }),
      runs: repository,
      signal: new AbortController().signal,
      registry,
    });

    // Prose the agent reads as text: mangling it would be the bug.
    expect(seen[0]).toBe('Fix the "quoted" bug & more');
  });
});
