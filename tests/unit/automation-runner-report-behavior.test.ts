/**
 * What `automationRunReporter` sends from a real `runAutomations` run: a row's
 * error is reported once, after its retries are spent, and only when it is a
 * defect. An adapter's classified outcome (Automation*Error, the user's endpoint
 * or script) is expected and stays quiet. Without this, a broken adapter fails
 * silently in the run log with no Sentry event, or a user's dead webhook floods
 * the project.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { reportHandledError } = vi.hoisted(() => ({ reportHandledError: vi.fn() }));
vi.mock('../../src/main/analytics/error-reporting', () => ({ reportHandledError }));

import { automationRunReporter, runAutomations } from '../../src/main/automations/automation-runner';
import { AutomationRegistry } from '../../src/main/automations/automation-registry';
import {
  AutomationPermanentError,
  AutomationRetryableError,
} from '../../src/main/automations/shared/automation-errors';
import { AUTOMATION_MANIFEST } from '../../src/shared/automation-manifest';
import type { AutomationAdapter, AutomationContext } from '../../src/main/automations/shared/automation-adapter';
import type { AutomationRunRepository } from '../../src/main/db/repositories/automation-run-repository';
import type { ColumnAutomation, Swimlane, Task } from '../../src/shared/types';

const COLUMN = { id: 'lane-executing', name: 'Executing', position: 1 } as Swimlane;

const ROW: ColumnAutomation = {
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
};

const runs = {
  start: vi.fn(),
  finish: vi.fn(),
  recordSkipped: vi.fn(),
  recordDeliveredByCaller: vi.fn(),
} as unknown as AutomationRunRepository;

function context(): Omit<AutomationContext, 'runId' | 'signal'> {
  return {
    task: { id: 'task-1', title: 'A task', session_id: 'session-1' } as Task,
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
  } as unknown as Omit<AutomationContext, 'runId' | 'signal'>;
}

/** Runs one webhook row (3 attempts per the manifest) whose adapter is `execute`. */
async function runRow(execute: AutomationAdapter['execute']): Promise<void> {
  const adapter: AutomationAdapter = {
    id: 'webhook',
    manifest: { ...AUTOMATION_MANIFEST.webhook, retry: { attempts: 3 } as never },
    describe: () => 'test',
    execute,
  };
  const registry = new AutomationRegistry();
  registry.register(adapter);
  const run = runAutomations({
    automations: [ROW],
    column: COLUMN,
    context: context(),
    runs,
    signal: new AbortController().signal,
    registry,
  });
  await vi.advanceTimersByTimeAsync(60_000);
  await run;
}

describe('automationRunReporter in a real run', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    reportHandledError.mockClear();
    automationRunReporter.reset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reports a defect once, tagged with the automation type and no user text', async () => {
    await runRow(async () => {
      throw new TypeError("Cannot read properties of undefined (reading 'Ping')");
    });

    expect(reportHandledError).toHaveBeenCalledTimes(1);
    const [copy, tags] = reportHandledError.mock.calls[0];
    expect(copy.message).toBe('Handled automation_runner failure: TypeError');
    expect(tags).toMatchObject({ source: 'automation_runner', automation_type: 'webhook', error_name: 'TypeError' });
    expect(JSON.stringify(tags)).not.toContain('Ping');
  });

  it('reports nothing for a row that fails once with a retryable error, then succeeds', async () => {
    let attempts = 0;
    await runRow(async () => {
      attempts += 1;
      if (attempts === 1) throw new AutomationRetryableError('HTTP 503');
      return { detail: 'HTTP 200' };
    });

    expect(attempts).toBe(2);
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('reports nothing for a permanent failure, which is the user endpoint answering', async () => {
    let attempts = 0;
    await runRow(async () => {
      attempts += 1;
      throw new AutomationPermanentError('HTTP 404');
    });

    expect(attempts).toBe(1);
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  // AutomationRetryableError is in EXPECTED_FAILURE_NAMES, so a row that is
  // retried to exhaustion is still the user's endpoint failing, not a defect.
  it('retries a retryable error to the limit and still reports nothing', async () => {
    let attempts = 0;
    await runRow(async () => {
      attempts += 1;
      throw new AutomationRetryableError('HTTP 503');
    });

    expect(attempts).toBe(3);
    expect(reportHandledError).not.toHaveBeenCalled();
  });
});
