/**
 * The shared parts of every handled-error report (`handled-report.ts`): the copy
 * that carries no user content, the dedupe mark, the predicate that keeps refusals,
 * aborts and the network out of Sentry, and the latched chokepoint reporter. A
 * regression here either ships a task title in an event or floods the project.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const reportHandledError = vi.fn();
vi.mock('../../src/main/analytics/error-reporting', () => ({ reportHandledError }));

const {
  createChokepointReporter,
  isExpectedFailure,
  isReported,
  markReported,
  pathFreeCopy,
  sendHandledFailure,
  EXPECTED_FAILURE_NAMES,
  NETWORK_ERRNOS,
} = await import('../../src/main/analytics/handled-report');
const { setShuttingDown } = await import('../../src/main/shutdown-state');
const { RefusalError } = await import('../../src/shared/refusal');
const { isRuntimeDefect } = await import('../../src/shared/handled-error-copy');

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
      new (await import('../../src/main/boards/adapters/trello/client')).TrelloError('invalid token', 401),
      new (await import('../../src/main/boards/adapters/jira/oauth-tokens')).JiraRefreshUnavailableError(502),
      new (await import('../../src/main/mobile-bridge/transport/relay-client')).RelayDialError({ kind: 'closed', errorFirst: true, closeCode: 1006, stack: 'node' }),
    ];
    for (const error of constructed) {
      expect(EXPECTED_FAILURE_NAMES.has(error.name), error.name).toBe(true);
      expect(isExpectedFailure(error), error.name).toBe(true);
    }
  });

  it('names every expected class in source: each name is set by a class under src/ (AbortError is Node\'s, exempt)', () => {
    const sources: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (/\.tsx?$/.test(entry.name)) sources.push(fs.readFileSync(full, 'utf8'));
      }
    };
    walk(path.join(__dirname, '../../src'));
    const missing = [...EXPECTED_FAILURE_NAMES]
      // Node's own `AbortError` (fs, fetch) is not declared in this repo.
      .filter((name) => name !== 'AbortError')
      .filter((name) => {
        const declaration = new RegExp(`\\bname\\s*(?::\\s*[\\w'"]+\\s*)?=\\s*['"]${name}['"]`);
        return !sources.some((text) => declaration.test(text));
      });
    expect(missing).toEqual([]);
  });

  it.each([...NETWORK_ERRNOS])('skips the network errno %s', (code) => {
    expect(isExpectedFailure(errnoError(code))).toBe(true);
  });

  // Literal list, so dropping an entry from NETWORK_ERRNOS fails rather than shrinking the table above.
  it.each(['EADDRNOTAVAIL', 'ENETRESET', 'ESHUTDOWN', 'EPROTO'])('keeps %s in NETWORK_ERRNOS', (code) => {
    expect(NETWORK_ERRNOS.has(code)).toBe(true);
  });

  it('skips a bare fetch failure with no cause and a destroyed stream', () => {
    expect(isExpectedFailure(new TypeError('fetch failed'))).toBe(true);
    expect(isExpectedFailure(errnoError('ERR_STREAM_DESTROYED'))).toBe(true);
  });

  it('skips a refusal, an abort and the network', () => {
    expect(isExpectedFailure(new RefusalError('No project is currently open'))).toBe(true);
    expect(isExpectedFailure(new DOMException('aborted', 'AbortError'))).toBe(true);
    expect(isExpectedFailure(errnoError('ECONNRESET'))).toBe(true);
    expect(isExpectedFailure(errnoError('ERR_STREAM_PREMATURE_CLOSE'))).toBe(true);
    expect(isExpectedFailure(new TypeError('fetch failed', { cause: errnoError('ENOTFOUND') }))).toBe(true);
  });

  it('judges a wrapper by what it wraps, as wrapWorktreeSetupError wraps a dirty tree', async () => {
    const { GitUserStateError } = await import('../../src/main/git/worktree-errors');
    const { wrapWorktreeSetupError } = await import('../../src/main/ipc/helpers/worktree-setup-error');
    const wrapped = wrapWorktreeSetupError(new GitUserStateError("Cannot switch to branch 'x': you have uncommitted changes."));
    expect(wrapped).not.toBeInstanceOf(GitUserStateError);
    expect(isExpectedFailure(wrapped)).toBe(true);
    expect(isExpectedFailure(wrapWorktreeSetupError(new TypeError('defect')))).toBe(false);
  });

  it('keeps a defect', () => {
    expect(isExpectedFailure(new TypeError("Cannot read properties of undefined (reading 'id')"))).toBe(false);
    expect(isExpectedFailure(errnoError('EACCES'))).toBe(false);
    expect(isExpectedFailure(new TypeError('fetch failed', { cause: new RangeError('bad') }))).toBe(false);
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

  // A failed git command carries what git refused on as one fixed word
  // (`GitCommandError.gitCause`). It is read by shape, off the error or the one
  // it wraps, and anything that is not a short word is left out.
  it('adds the git cause an error or its cause carries, and never text in its place', () => {
    const gitFailure = Object.assign(new Error("fatal: bad object in 'fix-acme-billing'"), { gitCause: 'missing_object' });
    sendHandledFailure('task_move', gitFailure);
    sendHandledFailure('task_move', new Error('Worktree setup failed: fix-acme-billing', { cause: gitFailure }));
    sendHandledFailure('task_move', Object.assign(new Error('x'), { gitCause: "fatal: bad object 'fix-acme-billing'" }));
    sendHandledFailure('task_move', new TypeError('no git here'));

    const tagsOf = (call: number): Record<string, string> => reportHandledError.mock.calls[call][1] as Record<string, string>;
    expect(tagsOf(0).git_cause).toBe('missing_object');
    expect(tagsOf(1).git_cause).toBe('missing_object');
    expect(tagsOf(2)).not.toHaveProperty('git_cause');
    expect(tagsOf(3)).not.toHaveProperty('git_cause');
    expect(JSON.stringify(reportHandledError.mock.calls.map((call) => [(call[0] as Error).message, call[1]]))).not.toContain('acme');
  });

  // An az import call the server refused carries the Microsoft code (or `none`)
  // as `azServerCode`. Only a code of that shape rides the tag.
  it('adds the Azure DevOps server code an error or its cause carries, and never text in its place', () => {
    const refused = Object.assign(new Error("ERROR: TF51005: field 'Acme.Billing' does not exist"), { azServerCode: 'TF51005' });
    sendHandledFailure('ipc_handler', refused);
    sendHandledFailure('ipc_handler', new Error('wrapped', { cause: refused }));
    sendHandledFailure('ipc_handler', Object.assign(new Error('x'), { azServerCode: 'none' }));
    sendHandledFailure('ipc_handler', Object.assign(new Error('x'), { azServerCode: 'TF51005: Acme.Billing' }));
    sendHandledFailure('ipc_handler', new TypeError('no az here'));

    const tagsOf = (call: number): Record<string, string> => reportHandledError.mock.calls[call][1] as Record<string, string>;
    expect(tagsOf(0).az_server_code).toBe('TF51005');
    expect(tagsOf(1).az_server_code).toBe('TF51005');
    expect(tagsOf(2).az_server_code).toBe('none');
    expect(tagsOf(3)).not.toHaveProperty('az_server_code');
    expect(tagsOf(4)).not.toHaveProperty('az_server_code');
    expect(JSON.stringify(reportHandledError.mock.calls.map((call) => [(call[0] as Error).message, call[1]]))).not.toContain('Acme');
  });

  it.each([
    ['a V8 TypeError naming the property it read', new TypeError("Cannot read properties of undefined (reading 'Fix Acme billing')")],
    ['a Node ERR_INVALID_ARG_TYPE quoting its value', Object.assign(
      new TypeError("The \"path\" argument must be of type string. Received type string ('Fix Acme billing')"),
      { code: 'ERR_INVALID_ARG_TYPE' },
    )],
    ['a SyntaxError quoting its JSON', new SyntaxError('Unexpected token "Fix Acme billing" in JSON')],
  ])('never sends the message of %s, and leaves a code defect to stack grouping', (_label, error) => {
    sendHandledFailure('ipc', error);
    const [sent, tags, contexts, fingerprint] = reportHandledError.mock.calls[0] as [Error, unknown, Record<string, unknown>, string[] | undefined];
    expect(contexts).toEqual({});
    expect(JSON.stringify([sent.message, sent.stack, tags, contexts])).not.toContain('Acme');
    expect(fingerprint).toBeUndefined();
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

  it('latches two Azure DevOps server codes thrown from one line as two keys', () => {
    const reporter = createChokepointReporter('ipc_handler');
    const refusal = (azServerCode: string): Error => Object.assign(new Error('refused'), { azServerCode });
    const reportAt = (azServerCode: string): boolean => reporter.report(refusal(azServerCode), { tags: { channel: 'backlog:importReconcile' } });
    expect(reportAt('TF51005')).toBe(true);
    expect(reportAt('none')).toBe(true);
    expect(reportAt('TF51005')).toBe(false);
  });

  it('applies its own filter after the expected-failure skip', () => {
    const reporter = createChokepointReporter('ipc', { shouldReport: isRuntimeDefect });
    expect(reporter.report(new Error('Task is not in this column'))).toBe(false);
    expect(reporter.report(new RefusalError('No project is currently open'))).toBe(false);
    expect(reporter.report(new TypeError('defect'))).toBe(true);
  });

  it.each(['UNKNOWN', 'SQLITE_BUSY'])('groups the %s code as an environment failure with an errno tag', (code) => {
    const reporter = createChokepointReporter('ipc');
    expect(reporter.report(errnoError(code))).toBe(true);
    const [, tags, , fingerprint] = reportHandledError.mock.calls[0] as [Error, Record<string, string>, unknown, string[] | undefined];
    expect(fingerprint).toEqual(['handled-env', 'Error', code]);
    expect(tags.errno).toBe(code);
  });

  it.each(['spawn C:\\Users\\dev\\git.exe', 'a_syscall_name_that_is_longer_than_32_chars'])('drops the syscall %s from the tags', (syscall) => {
    const error = errnoError('ENOSPC');
    error.syscall = syscall;
    createChokepointReporter('ipc').report(error);
    const [, tags] = reportHandledError.mock.calls[0] as [Error, Record<string, string>];
    expect(tags).not.toHaveProperty('syscall');
    expect(tags.errno).toBe('ENOSPC');
  });

  it('lets reportOptions.fingerprint override the default', () => {
    createChokepointReporter('preload').report(errnoError('ENOSPC'), { fingerprint: ['preload-callback', 'method'] });
    const [, , , fingerprint] = reportHandledError.mock.calls[0] as [Error, unknown, unknown, string[] | undefined];
    expect(fingerprint).toEqual(['preload-callback', 'method']);
  });

  it('does not mark an error the cap turned away, and marks a repeat of a reported key', () => {
    const reporter = createChokepointReporter('ipc', { cap: 1 });
    const make = (): TypeError => new TypeError('same line');
    const first = make();
    const repeat = make();
    expect(reporter.report(first)).toBe(true);
    expect(reporter.report(repeat)).toBe(false);
    expect(isReported(repeat)).toBe(true);

    const turnedAway = new RangeError('another key');
    expect(reporter.report(turnedAway)).toBe(false);
    expect(isReported(turnedAway)).toBe(false);
  });

  it('reports nothing while the app quits', () => {
    const reporter = createChokepointReporter('ipc');
    setShuttingDown();
    expect(reporter.report(new TypeError('during quit'))).toBe(false);
    expect(reportHandledError).not.toHaveBeenCalled();
  });
});
