/**
 * Failed PR checks, sent to the task's agent (#1032): the shared log cut, each
 * connector's normalization of its platform's checks, the message the agent
 * reads, and the live-or-held delivery.
 *
 * The log fixtures are synthetic but shaped like real output, measured on a
 * real failed Actions job (gh prints `<job>\t<step>\t<timestamp> <text>`, often
 * with `UNKNOWN STEP` as the step) and a real failed Pipelines step (`az rest`
 * prints `<timestamp> <text>`). Both end with runner cleanup after the last
 * `##[error]` line, which is what the cut drops.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PRCheck } from '../../src/shared/types';
import type { GhStatusCheckRollupItem } from '../../src/main/boards/adapters/github-common/gh-client';
import type { AzurePolicyEvaluation } from '../../src/main/boards/adapters/azure-devops/client';

const hoisted = vi.hoisted(() => ({
  listPRChecks: vi.fn<(...callArguments: unknown[]) => Promise<unknown>>(),
  fetchPRCheckLog: vi.fn<(...callArguments: unknown[]) => Promise<string | null>>(),
  holdTaskMessage: vi.fn<(...callArguments: unknown[]) => unknown>(() => ({ status: 'held', displayId: 7, rowId: 'held-1' })),
  task: {} as Record<string, unknown>,
}));

vi.mock('../../src/main/pr/pr-registry', () => ({
  listPRChecks: hoisted.listPRChecks,
  fetchPRCheckLog: hoisted.fetchPRCheckLog,
}));
vi.mock('../../src/main/held-messages/held-messages', () => ({ holdTaskMessage: hoisted.holdTaskMessage }));
vi.mock('../../src/main/agent/agent-registry', () => ({ agentRegistry: { get: () => undefined } }));
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({
  getProjectRepos: () => ({ tasks: { getById: () => hoisted.task } }),
  resolveProjectContext: (_context: unknown, projectId: string | null) => ({ projectId: projectId ?? 'proj-1', projectPath: '/repo' }),
}));

const { tailToLastError, tailRawLog, stripLogTimestamp, EARLIER_LINES_CUT } = await import('../../src/main/pr/shared/ci-log-tail');
const { PasteSubmitError } = await import('../../src/main/pty/terminal-submit');
const { normalizeRollupChecks, actionsJobId, stripActionsLogPrefix } = await import('../../src/main/pr/adapters/github/github-connector');
const { policyChecks } = await import('../../src/main/pr/adapters/azure-devops/azure-devops-connector');
const { buildFailedChecksMessage, perCheckLogBudget, sendFailedPrChecks, PER_CHECK_LOG_MAX_CHARS } =
  await import('../../src/main/pr/failed-checks-delivery');
const { MOVE_MESSAGE_MAX_CHARS } = await import('../../src/main/agent/commands/move-message-limit');

const ACTIONS_LOG = [
  'UI Test (10/11)\tUNKNOWN STEP\t\uFEFF2026-11-08T02:31:00.0000000Z ##[group]Run npx playwright test',
  'UI Test (10/11)\tUNKNOWN STEP\t2026-11-08T02:31:01.0000000Z npx playwright test --shard 10/11',
  'UI Test (10/11)\tUNKNOWN STEP\t2026-11-08T02:31:01.1000000Z ##[endgroup]',
  'UI Test (10/11)\tUNKNOWN STEP\t2026-11-08T02:33:10.0000000Z   1) [ui] tests/ui/checkout.spec.ts:361:1 applies the discount',
  'UI Test (10/11)\tUNKNOWN STEP\t2026-11-08T02:33:10.1000000Z     Error: expect(locator).toHaveText(expected) failed',
  'UI Test (10/11)\tUNKNOWN STEP\t2026-11-08T02:33:12.0000000Z \u001b[31m  1 failed\u001b[39m',
  'UI Test (10/11)\tUNKNOWN STEP\t2026-11-08T02:33:12.1000000Z ##[error]Process completed with exit code 1.',
  'UI Test (10/11)\tUNKNOWN STEP\t2026-11-08T02:33:13.0000000Z Post job cleanup.',
  'UI Test (10/11)\tUNKNOWN STEP\t2026-11-08T02:33:14.0000000Z Cleaning up orphan processes',
];

const PIPELINES_LOG = [
  '2026-10-22T16:43:31.2522979Z ##[section]Starting: Build',
  '2026-10-22T16:44:13.6402176Z tests/App.Tests/ServiceTests.cs(884,31): error CS1501: No overload for method takes 3 arguments',
  '2026-10-22T16:44:13.6469175Z ##[error]tests/App.Tests/ServiceTests.cs(884,31): Error CS1501: No overload for method takes 3 arguments',
  '2026-10-22T16:44:25.4653079Z Build FAILED.',
  '2026-10-22T16:44:25.5456379Z ##[error]Dotnet command failed with non-zero exit code on the following projects',
  '2026-10-22T16:44:25.5553624Z ##[section]Finishing: Build',
];

describe('tailToLastError', () => {
  it('keeps the output up to the last error line and drops the cleanup and group markers after a GitHub prefix strip', () => {
    const tail = tailToLastError(ACTIONS_LOG.map(stripActionsLogPrefix), 6_000);
    expect(tail).toContain('applies the discount');
    expect(tail.endsWith('##[error]Process completed with exit code 1.')).toBe(true);
    expect(tail).not.toContain('Post job cleanup');
    expect(tail).not.toContain('##[group]');
    expect(tail).not.toContain('\u001b');
    expect(tail).not.toContain('UNKNOWN STEP');
    expect(tail).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('keeps the compiler errors above a Pipelines step\'s last, generic error line', () => {
    const tail = tailToLastError(PIPELINES_LOG.map(stripLogTimestamp), 6_000);
    expect(tail).toContain('error CS1501');
    expect(tail.endsWith('on the following projects')).toBe(true);
    expect(tail).not.toContain('Finishing: Build');
  });

  it('cuts to the cap on a line boundary and says so', () => {
    const lines = Array.from({ length: 200 }, (_unused, index) => `line ${index} of compiler output`);
    lines.push('##[error]boom');
    const tail = tailToLastError(lines, 300);
    expect(tail.length).toBeLessThanOrEqual(300);
    expect(tail.startsWith(`${EARLIER_LINES_CUT}\n`)).toBe(true);
    expect(tail.endsWith('##[error]boom')).toBe(true);
    for (const line of tail.split('\n').slice(1)) expect(lines).toContain(line);
  });

  it('keeps a log with no error marker whole up to the cap', () => {
    expect(tailToLastError(['one', 'two'], 100)).toBe('one\ntwo');
    expect(tailToLastError([], 100)).toBe('');
  });
});

describe('GitHub check normalization', () => {
  const run = (name: string, overrides: Partial<Extract<GhStatusCheckRollupItem, { __typename: 'CheckRun' }>> = {}): GhStatusCheckRollupItem => ({
    __typename: 'CheckRun',
    name,
    status: 'COMPLETED',
    conclusion: 'SUCCESS',
    workflowName: 'CI',
    detailsUrl: `https://github.com/o/r/actions/runs/1/job/${name.length}00`,
    startedAt: '2026-11-08T02:00:00Z',
    ...overrides,
  });

  it('reads the job id out of an Actions details URL, and nothing out of any other page', () => {
    expect(actionsJobId('https://github.com/o/r/actions/runs/42436059750/job/128595029334')).toBe('128595029334');
    expect(actionsJobId('https://github.com/o/r/actions/runs/42436059750/job/128595029334?pr=38')).toBe('128595029334');
    expect(actionsJobId('https://app.codecov.io/gh/o/r/pull/38')).toBeNull();
  });

  it('keeps one row per check, the later re-run replacing the superseded one', () => {
    const checks = normalizeRollupChecks([
      run('cla', { workflowName: 'CLA Assistant', startedAt: '2026-11-08T02:28:53Z', conclusion: 'FAILURE' }),
      run('cla', { workflowName: 'CLA Assistant', startedAt: '2026-11-08T02:43:00Z', conclusion: 'SUCCESS' }),
    ]);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ name: 'cla', group: 'CLA Assistant', status: 'passed' });
  });

  it('folds conclusions and statuses into the four statuses, with a log only for an Actions job', () => {
    const checks = normalizeRollupChecks([
      run('Lint'),
      run('Unit', { conclusion: 'FAILURE' }),
      run('Docs', { conclusion: 'SKIPPED' }),
      run('E2E', { status: 'IN_PROGRESS', conclusion: null }),
      run('Neutral', { conclusion: 'NEUTRAL' }),
      { __typename: 'StatusContext', context: 'codecov/patch', state: 'FAILURE', targetUrl: 'https://app.codecov.io/x' },
      { __typename: 'StatusContext', context: 'deploy', state: 'PENDING' },
    ]);
    const byName = Object.fromEntries(checks.map((check) => [check.name, check]));
    expect(byName.Lint.status).toBe('passed');
    expect(byName.Unit.status).toBe('failed');
    expect(byName.Docs.status).toBe('skipped');
    expect(byName.E2E.status).toBe('pending');
    expect(byName.Neutral.status).toBe('passed');
    expect(byName['codecov/patch']).toMatchObject({ status: 'failed', hasLog: false, url: 'https://app.codecov.io/x', group: null });
    expect(byName.deploy.status).toBe('pending');
    expect(byName.Unit.hasLog).toBe(true);
  });
});

describe('Azure DevOps check normalization', () => {
  const remote = { org: 'my-org', project: 'My Project', repo: 'app' };
  const prUrl = 'https://dev.azure.com/my-org/My%20Project/_git/app/pullrequest/12';
  const evaluation = (overrides: Partial<AzurePolicyEvaluation>): AzurePolicyEvaluation => ({
    status: 'approved',
    typeId: '0609b952-1397-4640-95ec-e00a01b2c241',
    isBlocking: true,
    isEnabled: true,
    isDeleted: false,
    ...overrides,
  });

  it('lists build and status policies only, a build linking to its results and readable once it ran', () => {
    const checks = policyChecks([
      evaluation({ evaluationId: 'e1', displayName: 'PR build', buildId: 711, status: 'rejected' }),
      evaluation({ evaluationId: 'e2', typeId: 'cbdc66da-9728-4af8-aada-9a5a32e4a226', statusGenre: 'sonar', statusName: 'quality-gate', status: 'running' }),
      evaluation({ evaluationId: 'e3', typeId: 'fa4e907d-c16b-4a4c-9dfa-4906e5d171dd', status: 'queued' }),
      evaluation({ evaluationId: 'e4', typeId: 'c6a1889d-b943-4856-b76f-9e46bb6b0df2', status: 'rejected' }),
      evaluation({ evaluationId: 'e5', buildDefinitionName: 'Nightly', isEnabled: false }),
    ], remote, prUrl);
    expect(checks).toEqual([
      { id: 'e1', name: 'PR build', group: null, url: 'https://dev.azure.com/my-org/My%20Project/_build/results?buildId=711', status: 'failed', hasLog: true },
      { id: 'e2', name: 'sonar/quality-gate', group: null, url: prUrl, status: 'pending', hasLog: false },
    ]);
  });

  it('names a build policy by its pipeline when it has no display name', () => {
    const [check] = policyChecks([evaluation({ buildDefinitionName: 'Web - CI', buildId: null, status: 'queued' })], remote, prUrl);
    expect(check).toMatchObject({ name: 'Web - CI', status: 'pending', hasLog: false, url: prUrl });
  });
});

describe('the message the agent gets', () => {
  const check = (name: string, group: string | null = 'CI'): PRCheck => ({ id: name, name, group, url: `https://ci/${name}`, status: 'failed', hasLog: true });

  it('leads with the failures, then one block per check with its link and log, escaping attributes', () => {
    const message = buildFailedChecksMessage({
      prNumber: 38,
      baseBranch: 'main',
      conflicting: false,
      failed: [
        { check: check('UI Test (10/11)'), log: '##[error]boom', noLogReason: null },
        { check: check('codecov/"patch"', null), log: null, noLogReason: 'this check has no log' },
      ],
    });
    expect(message.startsWith('PR #38 has 2 failed checks.')).toBe(true);
    expect(message).toContain('<failed_check name="UI Test (10/11)" workflow="CI" url="https://ci/UI Test (10/11)">\n##[error]boom\n</failed_check>');
    expect(message).toContain('name="codecov/&quot;patch&quot;"');
    expect(message).toContain('No log: this check has no log.');
    expect(message).not.toMatch(/push|merge the pull request/i);
  });

  it('names the conflict and the base it is against', () => {
    expect(buildFailedChecksMessage({ prNumber: 38, baseBranch: 'develop', conflicting: true, failed: [] }))
      .toBe('PR #38 conflicts with develop. Merge develop into this branch and resolve the conflicts.');
    const both = buildFailedChecksMessage({ prNumber: 38, baseBranch: null, conflicting: true, failed: [{ check: check('Lint'), log: 'x', noLogReason: null }] });
    expect(both.startsWith('PR #38 conflicts with its base branch and has 1 failed check.')).toBe(true);
  });

  it('keeps every full log under the hold limit, sized from the skeleton the real tags and links make', () => {
    // Real Actions job URLs and a workflow name: about 170 characters of tag
    // per check, which a fixed overhead allowance stopped covering near 9 checks.
    const actionsCheck = (index: number, total: number): PRCheck => ({
      id: String(128595029334 + index),
      name: `UI Test (${index + 1}/${total})`,
      group: 'Continuous Integration',
      url: `https://github.com/example-org/example-repository/actions/runs/42436059750/job/${128595029334 + index}`,
      status: 'failed',
      hasLog: true,
    });
    for (const total of [1, 11, 24]) {
      const checks = Array.from({ length: total }, (_unused, index) => actionsCheck(index, total));
      const input = { prNumber: 38, baseBranch: 'main', conflicting: true };
      const skeleton = buildFailedChecksMessage({ ...input, failed: checks.map((item) => ({ check: item, log: '', noLogReason: null })) });
      const budget = perCheckLogBudget(total, skeleton.length);
      expect(budget).toBeLessThanOrEqual(PER_CHECK_LOG_MAX_CHARS);
      const message = buildFailedChecksMessage({ ...input, failed: checks.map((item) => ({ check: item, log: 'x'.repeat(budget), noLogReason: null })) });
      expect(message.length).toBeLessThan(MOVE_MESSAGE_MAX_CHARS);
    }
    expect(perCheckLogBudget(1, 300)).toBe(PER_CHECK_LOG_MAX_CHARS);
  });
});

describe('sendFailedPrChecks', () => {
  const failedCheck: PRCheck = { id: '1', name: 'Unit', group: 'CI', url: 'https://ci/1', status: 'failed', hasLog: true };

  function makeContext(live: { id: string; writable: boolean } | null) {
    const submitContent = vi.fn(async () => undefined);
    const context = {
      sessionManager: {
        findLiveSessionByTaskId: vi.fn(() => (live ? { id: live.id } : undefined)),
        isWritable: vi.fn((sessionId: string) => live?.id === sessionId && live.writable),
        getSessionAgentName: vi.fn(() => 'claude'),
      },
      terminalSubmit: { submitContent },
    };
    return { context: context as never, submitContent };
  }

  beforeEach(() => {
    hoisted.task = { id: 'task-1', pr_number: 38, pr_merge_readiness: 'failing', base_branch: 'main', worktree_path: '/repo/.kangentic/worktrees/t1' };
    hoisted.listPRChecks.mockReset();
    hoisted.fetchPRCheckLog.mockReset();
    hoisted.holdTaskMessage.mockReset();
    hoisted.holdTaskMessage.mockReturnValue({ status: 'held', displayId: 7, rowId: 'held-1' });
    hoisted.listPRChecks.mockResolvedValue({ checks: [failedCheck, { ...failedCheck, id: '2', name: 'Lint', status: 'passed' }], checksPageUrl: '' });
    hoisted.fetchPRCheckLog.mockResolvedValue('##[error]boom');
  });

  it('pastes into a running agent, reading the checks from the task worktree', async () => {
    const { context, submitContent } = makeContext({ id: 'session-1', writable: true });
    await expect(sendFailedPrChecks(context, 'task-1', 'proj-1')).resolves.toEqual({ outcome: 'sent', count: 1 });
    expect(hoisted.listPRChecks).toHaveBeenCalledWith('/repo/.kangentic/worktrees/t1', 38);
    expect(submitContent).toHaveBeenCalledWith('session-1', expect.stringContaining('##[error]boom'), expect.objectContaining({ bracketed: true, source: 'pr-checks' }));
    expect(hoisted.holdTaskMessage).not.toHaveBeenCalled();
  });

  it('holds the message for the next agent when none is running', async () => {
    const { context, submitContent } = makeContext(null);
    await expect(sendFailedPrChecks(context, 'task-1', 'proj-1')).resolves.toEqual({ outcome: 'held', count: 1 });
    expect(submitContent).not.toHaveBeenCalled();
    expect(hoisted.holdTaskMessage).toHaveBeenCalledWith(context, expect.objectContaining({ taskId: 'task-1', message: expect.stringContaining('Unit') }));
  });

  it('sends a check whose log will not download as its link and the reason, never failing the send', async () => {
    hoisted.fetchPRCheckLog.mockRejectedValue(new Error('gh: HTTP 502'));
    const { context, submitContent } = makeContext({ id: 'session-1', writable: true });
    await sendFailedPrChecks(context, 'task-1', 'proj-1');
    expect(submitContent).toHaveBeenCalledWith('session-1', expect.stringContaining('No log: gh: HTTP 502.'), expect.anything());
  });

  it('counts a conflict, and refuses when nothing needs fixing', async () => {
    hoisted.task = { ...hoisted.task, pr_merge_readiness: 'conflicting' };
    const { context } = makeContext(null);
    await expect(sendFailedPrChecks(context, 'task-1', 'proj-1')).resolves.toEqual({ outcome: 'held', count: 2 });
    hoisted.task = { ...hoisted.task, pr_merge_readiness: 'ready' };
    hoisted.listPRChecks.mockResolvedValue({ checks: [{ ...failedCheck, status: 'passed' }], checksPageUrl: '' });
    await expect(sendFailedPrChecks(context, 'task-1', 'proj-1')).rejects.toThrow('Nothing on this pull request needs fixing');
  });

  it('surfaces a refused hold as the error', async () => {
    hoisted.holdTaskMessage.mockReturnValue({ status: 'refused', error: 'The task is in Done' });
    const { context } = makeContext(null);
    await expect(sendFailedPrChecks(context, 'task-1', 'proj-1')).rejects.toThrow('The task is in Done');
  });

  it('refuses a task that is gone, and a task with no pull request, before reading any check', async () => {
    const { context } = makeContext(null);
    hoisted.task = null as unknown as Record<string, unknown>;
    await expect(sendFailedPrChecks(context, 'task-1', 'proj-1')).rejects.toThrow('Task not found');
    hoisted.task = { id: 'task-1', pr_number: null, worktree_path: null };
    await expect(sendFailedPrChecks(context, 'task-1', 'proj-1')).rejects.toThrow('This task has no pull request');
    expect(hoisted.listPRChecks).not.toHaveBeenCalled();
  });

  it('reads the checks from the project folder when the task has no worktree', async () => {
    hoisted.task = { ...hoisted.task, worktree_path: null };
    const { context } = makeContext(null);
    await sendFailedPrChecks(context, 'task-1', 'proj-1');
    expect(hoisted.listPRChecks).toHaveBeenCalledWith('/repo', 38);
  });

  it('sends a check whose log fetch resolves empty as "the log could not be read"', async () => {
    hoisted.fetchPRCheckLog.mockResolvedValue(null);
    const { context, submitContent } = makeContext({ id: 'session-1', writable: true });
    await sendFailedPrChecks(context, 'task-1', 'proj-1');
    expect(submitContent).toHaveBeenCalledWith('session-1', expect.stringContaining('No log: the log could not be read.'), expect.anything());
  });

  it('never fetches the log of a check that has none, and says so', async () => {
    hoisted.listPRChecks.mockResolvedValue({ checks: [{ ...failedCheck, hasLog: false }], checksPageUrl: '' });
    const { context, submitContent } = makeContext({ id: 'session-1', writable: true });
    await sendFailedPrChecks(context, 'task-1', 'proj-1');
    expect(hoisted.fetchPRCheckLog).not.toHaveBeenCalled();
    expect(submitContent).toHaveBeenCalledWith('session-1', expect.stringContaining('No log: this check has no log.'), expect.anything());
  });

  it('holds the message for a session that is live but cannot take a paste right now', async () => {
    const { context, submitContent } = makeContext({ id: 'session-1', writable: false });
    await expect(sendFailedPrChecks(context, 'task-1', 'proj-1')).resolves.toEqual({ outcome: 'held', count: 1 });
    expect(submitContent).not.toHaveBeenCalled();
    expect(hoisted.holdTaskMessage).toHaveBeenCalledTimes(1);
  });

  /** Many failed Actions checks with real-length names, workflow and links. */
  const manyFailedChecks = (total: number): PRCheck[] => Array.from({ length: total }, (_unused, index) => ({
    id: String(128595029334 + index),
    name: `UI Test (${index + 1}/${total})`,
    group: 'Continuous Integration',
    url: `https://github.com/example-org/example-repository/actions/runs/42436059750/job/${128595029334 + index}`,
    status: 'failed',
    hasLog: true,
  }));
  const heldMessage = (): string => (hoisted.holdTaskMessage.mock.calls[0][1] as { message: string }).message;

  it('hands every log fetch the budget the skeleton leaves, which is below the cap for many checks', async () => {
    const checks = manyFailedChecks(20);
    hoisted.listPRChecks.mockResolvedValue({ checks, checksPageUrl: '' });
    const skeleton = buildFailedChecksMessage({
      prNumber: 38,
      baseBranch: 'main',
      conflicting: false,
      failed: checks.map((check) => ({ check, log: '', noLogReason: null })),
    });
    const expectedBudget = perCheckLogBudget(checks.length, skeleton.length);
    expect(expectedBudget).toBeGreaterThan(0);
    expect(expectedBudget).toBeLessThan(PER_CHECK_LOG_MAX_CHARS);
    hoisted.fetchPRCheckLog.mockImplementation(async (...callArguments: unknown[]) => 'x'.repeat(callArguments[3] as number));

    const { context } = makeContext(null);
    await sendFailedPrChecks(context, 'task-1', 'proj-1');

    expect(hoisted.fetchPRCheckLog).toHaveBeenCalledTimes(20);
    for (const call of hoisted.fetchPRCheckLog.mock.calls) expect(call[3]).toBe(expectedBudget);
    expect(heldMessage().length).toBeLessThan(MOVE_MESSAGE_MAX_CHARS);
  });

  it('cuts a very long error so the whole held message stays under the hold limit', async () => {
    hoisted.listPRChecks.mockResolvedValue({ checks: manyFailedChecks(20), checksPageUrl: '' });
    hoisted.fetchPRCheckLog.mockRejectedValue(new Error('e'.repeat(100_000)));
    const { context } = makeContext(null);
    await sendFailedPrChecks(context, 'task-1', 'proj-1');
    expect(heldMessage()).toContain('No log: eeee');
    expect(heldMessage().length).toBeLessThan(MOVE_MESSAGE_MAX_CHARS);
  });

  it('turns a refused paste into a plain Error carrying the paste error as its cause, and rethrows any other failure as is', async () => {
    const { context, submitContent } = makeContext({ id: 'session-1', writable: true });
    const pasteError = new PasteSubmitError('timeout', 'paste-engine: timed out');
    submitContent.mockRejectedValueOnce(pasteError);
    const thrown = await sendFailedPrChecks(context, 'task-1', 'proj-1').catch((caught: unknown) => caught);
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(PasteSubmitError);
    expect((thrown as Error).message).toBe('Paste timed out - the agent may be busy. Try again.');
    expect((thrown as Error & { cause?: unknown }).cause).toBe(pasteError);

    const other = new Error('pty gone');
    submitContent.mockRejectedValueOnce(other);
    await expect(sendFailedPrChecks(context, 'task-1', 'proj-1')).rejects.toBe(other);
  });
});

describe('perCheckLogBudget', () => {
  it('is zero for no failed checks and for a negative count', () => {
    expect(perCheckLogBudget(0, 500)).toBe(0);
    expect(perCheckLogBudget(-3, 500)).toBe(0);
  });

  it('splits what the skeleton leaves evenly, never below zero and never above the cap', () => {
    expect(perCheckLogBudget(4, 1_800)).toBe(Math.floor((MOVE_MESSAGE_MAX_CHARS - 200 - 1_800) / 4));
    expect(perCheckLogBudget(1, MOVE_MESSAGE_MAX_CHARS)).toBe(0);
    expect(perCheckLogBudget(2, MOVE_MESSAGE_MAX_CHARS * 2)).toBe(0);
    expect(perCheckLogBudget(1, 0)).toBe(PER_CHECK_LOG_MAX_CHARS);
  });
});

describe('tailToLastError boundaries', () => {
  const LINES = ['line-one-1', 'line-two-2', 'line-thr-3', 'line-fou-4'];

  it('drops one more line than fit by themselves to make room for the marker', () => {
    // Three 10-char lines fit in 40, but not beside the 20-char marker line.
    const tail = tailToLastError(LINES, 40);
    expect(tail).toBe(`${EARLIER_LINES_CUT}\nline-fou-4`);
    expect(tail.length).toBeLessThanOrEqual(40);
    // One character more room keeps a second line beside the marker.
    expect(tailToLastError(LINES, 41)).toBe(`${EARLIER_LINES_CUT}\nline-thr-3\nline-fou-4`);
  });

  it('returns the marker and the start of the last line when that line alone is longer than the cap', () => {
    const lastLine = `##[error]${'x'.repeat(100)}`;
    const tail = tailToLastError(['earlier output', lastLine], 60);
    expect(tail.length).toBe(60);
    expect(tail).toBe(`${EARLIER_LINES_CUT}\n${lastLine.slice(0, 40)}`);
    // A single line longer than the cap takes the same path.
    expect(tailToLastError([lastLine], 60)).toBe(`${EARLIER_LINES_CUT}\n${lastLine.slice(0, 40)}`);
  });

  it('returns nothing when the cap is no bigger than the marker and its newline', () => {
    const lines = ['earlier output', '##[error]boom and then some more words'];
    expect(tailToLastError(lines, EARLIER_LINES_CUT.length + 1)).toBe('');
    expect(tailToLastError(lines, 5)).toBe('');
    expect(tailToLastError(lines, 0)).toBe('');
    expect(tailToLastError(lines, EARLIER_LINES_CUT.length + 2)).toBe(`${EARLIER_LINES_CUT}\n#`);
  });
});

describe('tailRawLog', () => {
  it('still ends at the last error line, with the marker and inside the cap, for a raw log over a million characters', () => {
    const filler = Array.from({ length: 30_000 }, (_unused, index) => `2026-11-08T00:00:00.0000000Z compiler output line ${index} padded to a realistic width`);
    const raw = [
      ...filler,
      '2026-11-08T00:00:01.0000000Z src/app.ts(1,1): error TS2322: Type mismatch',
      '2026-11-08T00:00:02.0000000Z ##[error]Process completed with exit code 1.',
      '2026-11-08T00:00:03.0000000Z Post job cleanup.',
      ...Array.from({ length: 5_000 }, (_unused, index) => `2026-11-08T00:00:04.0000000Z runner cleanup line ${index} also padded to a realistic width`),
    ].join('\n');
    expect(raw.length).toBeGreaterThan(1_000_000);
    const tail = tailRawLog(raw, stripLogTimestamp, 500);
    expect(tail.length).toBeLessThanOrEqual(500);
    expect(tail.startsWith(`${EARLIER_LINES_CUT}\n`)).toBe(true);
    expect(tail.endsWith('##[error]Process completed with exit code 1.')).toBe(true);
    expect(tail).toContain('error TS2322');
    expect(tail).not.toContain('cleanup');
  });

  it('reads a raw log with carriage returns and no error marker whole up to the cap', () => {
    expect(tailRawLog('one\r\ntwo\r\n', (line) => line, 100)).toBe('one\ntwo');
  });
});

describe('GitHub check status folding', () => {
  const run = (name: string, overrides: Record<string, unknown> = {}): GhStatusCheckRollupItem => ({
    __typename: 'CheckRun',
    name,
    status: 'COMPLETED',
    conclusion: 'SUCCESS',
    workflowName: 'CI',
    detailsUrl: 'https://github.com/o/r/actions/runs/1/job/100',
    startedAt: '2026-11-08T02:00:00Z',
    ...overrides,
  }) as GhStatusCheckRollupItem;
  const statusOf = (item: GhStatusCheckRollupItem) => normalizeRollupChecks([item])[0].status;

  it.each([
    ['STALE', 'skipped'],
    [null, 'pending'],
    ['TIMED_OUT', 'failed'],
    ['CANCELLED', 'failed'],
    ['ACTION_REQUIRED', 'failed'],
    ['STARTUP_FAILURE', 'failed'],
    ['FAILURE', 'failed'],
    ['SKIPPED', 'skipped'],
    ['NEUTRAL', 'passed'],
    ['SUCCESS', 'passed'],
  ])('folds a completed check run with conclusion %s into %s', (conclusion, expected) => {
    expect(statusOf(run('check', { conclusion }))).toBe(expected);
  });

  it.each([
    ['ERROR', 'failed'],
    ['FAILURE', 'failed'],
    ['EXPECTED', 'pending'],
    ['PENDING', 'pending'],
    ['SUCCESS', 'passed'],
  ])('folds a status context in state %s into %s', (state, expected) => {
    expect(statusOf({ __typename: 'StatusContext', context: 'ci/legacy', state } as GhStatusCheckRollupItem)).toBe(expected);
  });

  it('keeps the later startedAt of two runs of one status context, whatever order the rollup lists them', () => {
    const earlier = { __typename: 'StatusContext', context: 'codecov/patch', state: 'FAILURE', startedAt: '2026-11-08T02:00:00Z' } as GhStatusCheckRollupItem;
    const later = { __typename: 'StatusContext', context: 'codecov/patch', state: 'SUCCESS', startedAt: '2026-11-08T02:30:00Z' } as GhStatusCheckRollupItem;
    for (const rollup of [[earlier, later], [later, earlier]]) {
      const checks = normalizeRollupChecks(rollup);
      expect(checks).toHaveLength(1);
      expect(checks[0]).toMatchObject({ name: 'codecov/patch', status: 'passed' });
    }
  });

  it('tells two apps apart by the host of their page when neither names a workflow, and merges the re-runs of one app', () => {
    const fromOneHost = [
      run('build', { workflowName: '', detailsUrl: 'https://ci-one.example/builds/1', conclusion: 'FAILURE', startedAt: '2026-11-08T01:00:00Z' }),
      run('build', { workflowName: '', detailsUrl: 'https://ci-one.example/builds/2', conclusion: 'SUCCESS', startedAt: '2026-11-08T02:00:00Z' }),
    ];
    const merged = normalizeRollupChecks(fromOneHost);
    expect(merged).toHaveLength(1);
    expect(merged[0].status).toBe('passed');

    const fromTwoHosts = [
      run('build', { workflowName: '', detailsUrl: 'https://ci-one.example/builds/1', conclusion: 'FAILURE', startedAt: '2026-11-08T01:00:00Z' }),
      run('build', { workflowName: '', detailsUrl: 'https://ci-two.example/builds/1', conclusion: 'SUCCESS', startedAt: '2026-11-08T02:00:00Z' }),
    ];
    const separate = normalizeRollupChecks(fromTwoHosts);
    expect(separate).toHaveLength(2);
    expect(separate.map((check) => check.status).sort()).toEqual(['failed', 'passed']);
  });

  it('keeps a failed check run when only a differently named workflow passed one of the same name', () => {
    const checks = normalizeRollupChecks([
      run('build', { workflowName: 'CI', conclusion: 'FAILURE' }),
      run('build', { workflowName: 'Release', conclusion: 'SUCCESS' }),
    ]);
    expect(checks).toHaveLength(2);
  });
});

describe('Azure DevOps policy checks, edge cases', () => {
  const remote = { org: 'my-org', project: 'My Project', repo: 'app' };
  const prUrl = 'https://dev.azure.com/my-org/My%20Project/_git/app/pullrequest/12';
  const BUILD_TYPE = '0609b952-1397-4640-95ec-e00a01b2c241';
  const policy = (overrides: Partial<AzurePolicyEvaluation>): AzurePolicyEvaluation => ({
    status: 'approved',
    typeId: BUILD_TYPE,
    isBlocking: true,
    isEnabled: true,
    isDeleted: false,
    ...overrides,
  });

  it('names a check by its type when nothing else names it, and "Policy" when not even that', () => {
    const checks = policyChecks([
      policy({ evaluationId: 'a', typeName: 'Build' }),
      policy({ evaluationId: 'b' }),
    ], remote, prUrl);
    expect(checks.map((check) => check.name)).toEqual(['Build', 'Policy']);
  });

  it('prefers the display name, then the pipeline, then the status genre and name, then the type', () => {
    const names = policyChecks([
      policy({ evaluationId: 'a', displayName: 'Shown', buildDefinitionName: 'Pipeline', typeName: 'Build' }),
      policy({ evaluationId: 'b', buildDefinitionName: 'Pipeline', typeName: 'Build' }),
      policy({ evaluationId: 'c', typeId: 'cbdc66da-9728-4af8-aada-9a5a32e4a226', statusName: 'gate', typeName: 'Status' }),
      policy({ evaluationId: 'd', typeId: 'cbdc66da-9728-4af8-aada-9a5a32e4a226', statusGenre: 'sonar', statusName: 'gate' }),
    ], remote, prUrl).map((check) => check.name);
    expect(names).toEqual(['Shown', 'Pipeline', 'gate', 'sonar/gate']);
  });

  it('gives a check with no evaluation id the id policy-<index>, counted among the listed checks', () => {
    const checks = policyChecks([
      policy({ evaluationId: 'gone', isDeleted: true }),
      policy({ evaluationId: null }),
      policy({ evaluationId: undefined }),
      policy({ evaluationId: 'kept' }),
    ], remote, prUrl);
    expect(checks.map((check) => check.id)).toEqual(['policy-0', 'policy-1', 'kept']);
  });

  it('drops a soft-deleted or disabled policy', () => {
    const checks = policyChecks([
      policy({ evaluationId: 'deleted', isDeleted: true }),
      policy({ evaluationId: 'disabled', isEnabled: false }),
      policy({ evaluationId: 'live' }),
    ], remote, prUrl);
    expect(checks.map((check) => check.id)).toEqual(['live']);
  });

  it.each([
    ['approved', 'passed'],
    ['rejected', 'failed'],
    ['broken', 'failed'],
    ['notApplicable', 'skipped'],
    ['queued', 'pending'],
    ['running', 'pending'],
  ])('folds an evaluation in status %s into %s', (status, expected) => {
    const [check] = policyChecks([policy({ evaluationId: 'x', status: status as AzurePolicyEvaluation['status'] })], remote, prUrl);
    expect(check.status).toBe(expected);
  });
});
