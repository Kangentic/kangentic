/**
 * What `automationRunReporter` sends from a real `runAutomations` run: a row's
 * error is reported once, after its retries are spent, and only when it is a
 * defect. An adapter's classified outcome (Automation*Error, the user's endpoint
 * or script) is expected and stays quiet. Without this, a broken adapter fails
 * silently in the run log with no Sentry event, or a user's dead webhook floods
 * the project.
 */
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { reportHandledError } = vi.hoisted(() => ({ reportHandledError: vi.fn() }));
vi.mock('../../src/main/analytics/error-reporting', () => ({ reportHandledError }));

import { createChokepointReporter, isExpectedFailure } from '../../src/main/analytics/handled-report';
import { automationRunReporter, runAutomations } from '../../src/main/automations/automation-runner';
import { AutomationRegistry } from '../../src/main/automations/automation-registry';
import { runScriptAdapter } from '../../src/main/automations/adapters/run-script';
import {
  AutomationPermanentError,
  AutomationRetryableError,
} from '../../src/main/automations/shared/automation-errors';
import { AUTOMATION_MANIFEST } from '../../src/shared/automation-manifest';
import { PasteSubmitError } from '../../src/main/pty/paste-engine';
import type { AutomationAdapter, AutomationContext } from '../../src/main/automations/shared/automation-adapter';
import type { AutomationRunRepository } from '../../src/main/db/repositories/automation-run-repository';
import type { ColumnAutomation, Swimlane, Task } from '../../src/shared/types';

const COLUMN = { id: 'lane-executing', name: 'Executing', position: 1 } as Swimlane;

// A shell every runner has, in its non-interactive form (run-script-adapter.test.ts).
const SHELL = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';

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
    manifest: { ...AUTOMATION_MANIFEST.webhook, retry: { attempts: 3, on: 'network-or-retryable-status' } },
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
    // Which trigger ran the row and how many attempts it took ride along: one
    // defect on enter and at a turn end is two paths, and a first-attempt throw
    // is not a row that failed after its retries.
    expect(tags).toMatchObject({
      source: 'automation_runner',
      automation_type: 'webhook',
      automation_trigger: 'enter',
      attempts: '1',
      error_name: 'TypeError',
    });
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

  // A move that lands in the backoff aborts with whatever reason its caller
  // gave, and a follow-up's controller gives a string. The rejection must
  // still read as the abort it is to the caller's reporter.
  it('rejects a move aborted during the backoff with an abort, whatever the abort reason', async () => {
    const adapter: AutomationAdapter = {
      id: 'webhook',
      manifest: { ...AUTOMATION_MANIFEST.webhook, retry: { attempts: 3, on: 'network-or-retryable-status' } },
      describe: () => 'test',
      execute: async () => {
        throw new AutomationRetryableError('HTTP 503');
      },
    };
    const registry = new AutomationRegistry();
    registry.register(adapter);
    const move = new AbortController();
    const run = runAutomations({
      automations: [ROW],
      column: COLUMN,
      context: context(),
      runs,
      signal: move.signal,
      registry,
    });
    const settled = run.then(() => null, (rejection: unknown) => rejection);
    await vi.advanceTimersByTimeAsync(100);
    move.abort('superseded by a newer move');
    const rejection = await settled;

    expect(rejection).toMatchObject({ name: 'AbortError', cause: 'superseded by a newer move' });
    expect(isExpectedFailure(rejection)).toBe(true);
  });
});

// Sentry DESKTOP-52: an awaited Send message paste showed no sign of a submit.
// The run log and the toast carried the engine's own diagnostic (an internal
// name, an escaped carriage return, a millisecond count), and the report
// carried only the automation type, so nobody could tell which case it was.
describe('a send_message row whose paste shows no sign of a submit', () => {
  const ENGINE_TEXT = 'paste-engine: automation sent paste + \\r (1 retry) but agent emitted no signal in 5012ms';
  const MESSAGE_ROW: ColumnAutomation = { ...ROW, name: 'Hand off', type: 'send_message', trigger: 'turn_end' };

  beforeEach(() => {
    reportHandledError.mockClear();
    automationRunReporter.reset();
    vi.mocked(runs.finish).mockClear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function runPasteRow(error: PasteSubmitError): Promise<void> {
    const adapter: AutomationAdapter = {
      id: 'send_message',
      manifest: AUTOMATION_MANIFEST.send_message,
      describe: () => 'test',
      execute: async () => {
        throw error;
      },
    };
    const registry = new AutomationRegistry();
    registry.register(adapter);
    await runAutomations({
      automations: [MESSAGE_ROW],
      // A column that runs an agent, so a row that needs one can run.
      column: { ...COLUMN, auto_spawn: true, role: null } as Swimlane,
      context: { ...context(), trigger: 'turn_end' } as unknown as Omit<AutomationContext, 'runId' | 'signal'>,
      runs,
      signal: new AbortController().signal,
      registry,
    });
  }

  it('records a plain sentence and reports the original error with the paste facts as tags', async () => {
    await runPasteRow(new PasteSubmitError('no-submission-evidence', ENGINE_TEXT, {
      facts: {
        reason: 'no-signal',
        firstWindowTakesData: false,
        retried: true,
        pasteModeOff: false,
        settleOutput: true,
        firstWindowBytes: '1-9',
        retryWindowBytes: '0',
      },
    }));

    const detail = vi.mocked(runs.finish).mock.calls[0][2];
    expect(detail).toBe('The message was pasted, but the agent showed no sign of taking it.');
    expect(detail).not.toContain('paste-engine');
    expect(detail).not.toContain('\\r');
    expect(detail).not.toMatch(/\d+ms/);
    // The main log keeps the engine's diagnostic.
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain(ENGINE_TEXT);

    expect(reportHandledError).toHaveBeenCalledTimes(1);
    const [copy, tags] = reportHandledError.mock.calls[0];
    expect(copy.message).toBe('Handled automation_runner failure: PasteSubmitError');
    expect(tags).toMatchObject({
      source: 'automation_runner',
      automation_type: 'send_message',
      automation_trigger: 'turn_end',
      error_name: 'PasteSubmitError',
      paste_code: 'no-submission-evidence',
      paste_reason: 'no-signal',
      paste_first_window_data: 'false',
      paste_retried: 'true',
      paste_mode_off: 'false',
      paste_settle_output: 'true',
      paste_first_bytes: '1-9',
      paste_retry_bytes: '0',
    });
    const sent = JSON.stringify(tags);
    expect(sent).not.toContain('paste-engine');
    expect(sent).not.toContain('Hand off');
  });

  it('says Enter was not pressed again when the agent had a prompt open', async () => {
    await runPasteRow(new PasteSubmitError(
      'no-submission-evidence',
      'paste-engine: automation sent paste but agent disabled bracketed-paste mode (modal/prompt focused). Skipped retry to avoid confirming a destructive action.',
      {
        facts: {
          reason: 'paste-mode-off',
          firstWindowTakesData: false,
          retried: false,
          pasteModeOff: true,
          settleOutput: true,
          firstWindowBytes: '0',
        },
      },
    ));

    expect(vi.mocked(runs.finish).mock.calls[0][2]).toBe(
      'The message was pasted while the agent had a prompt or dialog open, so Enter was not pressed again.',
    );
    expect(reportHandledError.mock.calls[0][1]).toMatchObject({ paste_reason: 'paste-mode-off', paste_retried: 'false' });
    expect(reportHandledError.mock.calls[0][1]).not.toHaveProperty('paste_retry_bytes');
  });
});

// Sentry DESKTOP-49: the adapter threw a plain Error for a non-zero exit, so
// every script a user wrote that failed reached Sentry as a defect of ours.
// The real adapter and a real shell, on real timers: the child's exit is I/O.
describe('a run_script row whose script exits non-zero', () => {
  beforeEach(() => {
    reportHandledError.mockClear();
    automationRunReporter.reset();
    vi.mocked(runs.finish).mockClear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records the run as failed with the exit code and reports nothing', async () => {
    const registry = new AutomationRegistry();
    registry.register(runScriptAdapter);
    const scriptRow: ColumnAutomation = { ...ROW, name: 'Build', type: 'run_script', config: { script: 'exit 1' } };

    await runAutomations({
      automations: [scriptRow],
      column: COLUMN,
      context: {
        ...context(),
        cwd: os.tmpdir(),
        sessionHost: { getShell: async () => SHELL },
      } as unknown as Omit<AutomationContext, 'runId' | 'signal'>,
      runs,
      signal: new AbortController().signal,
      registry,
    });

    expect(runs.finish).toHaveBeenCalledWith(expect.any(String), 'failed', 'Script exited with code 1.', 1);
    expect(reportHandledError).not.toHaveBeenCalled();
  });
});

// Sentry DESKTOP-4X: a turn-end pass was running a Run script row when the
// user moved the task. The move aborted the pass, the script's tree was killed,
// and the adapter rejected a plain Error, which the runner rethrows and the
// turn-end pass reported as a defect. The runner's own reporter never sees an
// abort, so the report under test is the caller's: the turn-end pass's
// chokepoint, built the way `turnEndReporter` is.
describe('a row whose move is superseded mid-run', () => {
  const SLEEP = process.platform === 'win32' ? 'ping -n 30 127.0.0.1 > nul' : 'sleep 30';
  const turnEndPassReporter = createChokepointReporter('turn_end');

  beforeEach(() => {
    reportHandledError.mockClear();
    turnEndPassReporter.reset();
    vi.mocked(runs.start).mockClear();
    vi.mocked(runs.finish).mockClear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Runs `row` under a move the test aborts once `abortWhen` resolves, and returns what the run rejected with. */
  async function supersededRun(registry: AutomationRegistry, row: ColumnAutomation, abortWhen: Promise<void>): Promise<unknown> {
    const move = new AbortController();
    const run = runAutomations({
      automations: [row],
      column: COLUMN,
      context: {
        ...context(),
        cwd: os.tmpdir(),
        sessionHost: { getShell: async () => SHELL },
      } as unknown as Omit<AutomationContext, 'runId' | 'signal'>,
      runs,
      signal: move.signal,
      registry,
    });
    const settled = run.then(() => null, (rejection: unknown) => rejection);
    await abortWhen;
    move.abort();
    return settled;
  }

  it('closes a real sleeping script interrupted, and the turn-end pass reports nothing', async () => {
    const registry = new AutomationRegistry();
    registry.register(runScriptAdapter);
    const scriptRow: ColumnAutomation = { ...ROW, name: 'Build', type: 'run_script', config: { script: SLEEP } };
    // Past the shell lookup and the spawn: the script is running when the move lands.
    const scriptStarted = vi.waitFor(() => expect(runs.start).toHaveBeenCalled()).then(
      () => new Promise<void>((resolve) => setTimeout(resolve, 300)),
    );

    const rejection = await supersededRun(registry, scriptRow, scriptStarted);

    expect(runs.finish).toHaveBeenCalledWith(expect.any(String), 'interrupted', 'The move was superseded.', 1);
    expect(rejection).toMatchObject({ name: 'AbortError', message: 'The move was superseded before the script finished.' });
    expect(isExpectedFailure(rejection)).toBe(true);
    turnEndPassReporter.report(rejection, { tags: { stage: 'pass' } });
    expect(reportHandledError).not.toHaveBeenCalled();
  }, 20_000);

  it('still reports a defect an adapter throws while the move aborts', async () => {
    const adapter: AutomationAdapter = {
      id: 'webhook',
      manifest: AUTOMATION_MANIFEST.webhook,
      describe: () => 'test',
      execute: (_config, adapterContext) => new Promise((_resolve, reject) => {
        adapterContext.signal.addEventListener('abort', () => {
          reject(new TypeError("Cannot read properties of undefined (reading 'Ping')"));
        }, { once: true });
      }),
    };
    const registry = new AutomationRegistry();
    registry.register(adapter);

    const rejection = await supersededRun(registry, ROW, vi.waitFor(() => expect(runs.start).toHaveBeenCalled()).then(() => undefined));

    expect(runs.finish).toHaveBeenCalledWith(expect.any(String), 'interrupted', 'The move was superseded.', 1);
    expect(rejection).toBeInstanceOf(TypeError);
    expect(isExpectedFailure(rejection)).toBe(false);
    turnEndPassReporter.report(rejection, { tags: { stage: 'pass' } });
    expect(reportHandledError).toHaveBeenCalledTimes(1);
    expect(reportHandledError.mock.calls[0][1]).toMatchObject({ source: 'turn_end', stage: 'pass', error_name: 'TypeError' });
  });
});
