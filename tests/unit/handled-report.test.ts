/**
 * The shared parts of every handled-error report (`handled-report.ts`): the copy
 * that carries no user content, the dedupe mark, the predicate that keeps refusals,
 * aborts and the network out of Sentry, and the latched chokepoint reporter. A
 * regression here either ships a task title in an event or floods the project.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const reportHandledError = vi.fn();
vi.mock('../../src/main/analytics/error-reporting', () => ({ reportHandledError }));

const {
  createChokepointReporter,
  isAllowlistedDefect,
  isExpectedFailure,
  isReported,
  markReported,
  pathFreeCopy,
  sendHandledFailure,
  EXPECTED_FAILURE_NAMES,
} = await import('../../src/main/analytics/handled-report');
const { setShuttingDown } = await import('../../src/main/shutdown-state');
const { RefusalError } = await import('../../src/shared/refusal');

function errnoError(code: string, message = `${code}: failed, open 'C:\\Users\\dev\\project\\file'`): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  error.syscall = 'open';
  return error;
}

describe('pathFreeCopy', () => {
  it('keeps the name and frames and drops a multi-line message', () => {
    const original = new TypeError("Cannot read properties of undefined\nat C:\\Users\\dev\\fix-the-login-redirect-1a2b");
    const copy = pathFreeCopy('ipc', original);
    expect(copy.name).toBe('TypeError');
    expect(copy.message).toBe('Handled ipc failure: TypeError');
    expect(copy.stack?.startsWith('TypeError: Handled ipc failure: TypeError\n')).toBe(true);
    expect(copy.stack).not.toContain('fix-the-login-redirect');
    const originalFrames = original.stack?.slice(original.stack.search(/\n\s+at /)) ?? '';
    expect(originalFrames.length).toBeGreaterThan(0);
    expect(copy.stack?.endsWith(originalFrames)).toBe(true);
  });

  it('names a thrown non-Error NonError', () => {
    expect(pathFreeCopy('mcp_tool', 'a string with a title').message).toBe('Handled mcp_tool failure: NonError');
  });
});

describe('isExpectedFailure', () => {
  it('skips every class thrown by design, matched by the name each class sets', async () => {
    const constructed: Error[] = [
      new (await import('../../src/main/workflows/workflow-requests')).WorkflowRequestError('Remove x from y first.'),
      new (await import('../../src/main/automations/shared/automation-errors')).AutomationTimeoutError('slow'),
      new (await import('../../src/main/pr/shared/pr-errors')).PRResolverTransientError('503'),
      new (await import('../../src/main/utility-process/off-main-pty')).HostUnavailableError(),
      new (await import('../../src/main/pty/host/pty-host-request-errors')).PtyHostExitedError(),
      new (await import('../../src/main/pty/spawn/agent-start-refused')).AgentCommandTooLongError(),
      new (await import('../../src/main/retrieval/retrieval-client')).RetrievalUnavailableError('down'),
      new (await import('../../src/main/transcription/engines/transcription-engine')).ModelLoadError('model', new Error('x')),
    ];
    for (const error of constructed) {
      expect(EXPECTED_FAILURE_NAMES.has(error.name), error.name).toBe(true);
      expect(isExpectedFailure(error), error.name).toBe(true);
    }
  });

  it('skips a refusal, an abort and the network', () => {
    expect(isExpectedFailure(new RefusalError('No project is currently open'))).toBe(true);
    expect(isExpectedFailure(new DOMException('aborted', 'AbortError'))).toBe(true);
    expect(isExpectedFailure(errnoError('ECONNRESET'))).toBe(true);
    expect(isExpectedFailure(errnoError('ERR_STREAM_PREMATURE_CLOSE'))).toBe(true);
    expect(isExpectedFailure(new TypeError('fetch failed', { cause: errnoError('ENOTFOUND') }))).toBe(true);
  });

  it('keeps a defect', () => {
    expect(isExpectedFailure(new TypeError("Cannot read properties of undefined (reading 'id')"))).toBe(false);
    expect(isExpectedFailure(errnoError('EACCES'))).toBe(false);
    expect(isExpectedFailure(new TypeError('fetch failed', { cause: new RangeError('bad') }))).toBe(false);
  });
});

describe('isAllowlistedDefect', () => {
  it('passes runtime errors, SQLite codes and non-network errnos, and nothing else', () => {
    expect(isAllowlistedDefect(new RangeError('Invalid array length'))).toBe(true);
    expect(isAllowlistedDefect(errnoError('ENOSPC'))).toBe(true);
    const sqlite = Object.assign(new Error('database is locked'), { name: 'SqliteError', code: 'SQLITE_BUSY' });
    expect(isAllowlistedDefect(sqlite)).toBe(true);
    expect(isAllowlistedDefect(errnoError('ETIMEDOUT'))).toBe(false);
    expect(isAllowlistedDefect(new Error('Task is not in this column'))).toBe(false);
    expect(isAllowlistedDefect(new SyntaxError('Unexpected token'))).toBe(false);
  });
});

describe('sendHandledFailure', () => {
  beforeEach(() => reportHandledError.mockReset());

  it('sends the copy with fixed tags, an env fingerprint for an errno, and marks the original', () => {
    const original = errnoError('ENOSPC');
    sendHandledFailure('task_move', original, { stage: 'worktree' });
    const [sent, tags, contexts, fingerprint] = reportHandledError.mock.calls[0] as [Error, Record<string, string>, Record<string, unknown>, string[] | undefined];
    expect(sent.message).toBe('Handled task_move failure: Error');
    expect(tags).toEqual({ stage: 'worktree', source: 'task_move', error_name: 'Error', errno: 'ENOSPC', syscall: 'open' });
    expect(contexts).toEqual({});
    expect(fingerprint).toEqual(['handled-env', 'Error', 'ENOSPC']);
    expect(isReported(original)).toBe(true);
  });

  it('puts a TypeError message in contexts, paths removed, and leaves grouping to the stack', () => {
    sendHandledFailure('ipc', new TypeError('x is not a function at C:\\Users\\dev\\a\\b.ts'));
    const [, , contexts, fingerprint] = reportHandledError.mock.calls[0] as [Error, unknown, { error_detail: { message: string } }, string[] | undefined];
    expect(contexts.error_detail.message).toBe('x is not a function at <path>');
    expect(fingerprint).toBeUndefined();
  });

  it('never puts a SyntaxError message anywhere', () => {
    sendHandledFailure('ipc', new SyntaxError('Unexpected token "my secret title" in JSON'));
    const [sent, , contexts] = reportHandledError.mock.calls[0] as [Error, unknown, Record<string, unknown>];
    expect(JSON.stringify([sent.message, sent.stack, contexts])).not.toContain('secret');
  });
});

describe('createChokepointReporter', () => {
  beforeEach(() => reportHandledError.mockReset());

  it('reports a key once, skips a marked error, and stops at its cap', () => {
    const reporter = createChokepointReporter('ipc', { cap: 2 });
    const first = new TypeError('a');
    expect(reporter.report(first, { tags: { channel: 'task:move' } })).toBe(true);
    expect(reporter.report(first, { tags: { channel: 'task:move' } })).toBe(false);

    const marked = new TypeError('b');
    markReported(marked);
    expect(reporter.report(marked, { tags: { channel: 'other' } })).toBe(false);

    expect(reporter.report(new RangeError('c'), { tags: { channel: 'second' } })).toBe(true);
    expect(reporter.report(new ReferenceError('d'), { tags: { channel: 'third' } })).toBe(false);
    expect(reportHandledError).toHaveBeenCalledTimes(2);
  });

  it('applies its own filter after the expected-failure skip', () => {
    const reporter = createChokepointReporter('ipc', { shouldReport: isAllowlistedDefect });
    expect(reporter.report(new Error('Task is not in this column'))).toBe(false);
    expect(reporter.report(new RefusalError('No project is currently open'))).toBe(false);
    expect(reporter.report(new TypeError('defect'))).toBe(true);
  });

  it('reports nothing while the app quits', () => {
    const reporter = createChokepointReporter('ipc');
    setShuttingDown();
    expect(reporter.report(new TypeError('during quit'))).toBe(false);
    expect(reportHandledError).not.toHaveBeenCalled();
  });
});
