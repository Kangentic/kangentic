import { beforeEach, describe, expect, it, vi } from 'vitest';

const reportHandledError = vi.fn();
vi.mock('../../src/main/analytics/error-reporting', () => ({
  reportHandledError: (...reportArguments: unknown[]) => reportHandledError(...reportArguments),
}));

import { reportAccountProblem, resetAccountProblemReports, scrubFailureDetail } from '../../src/main/accounts/account-report';

beforeEach(() => {
  reportHandledError.mockClear();
  resetAccountProblemReports();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('reportAccountProblem', () => {
  it('sends an error whose message holds neither a home path nor an email', () => {
    const cause = new Error('Could not read C:\\Users\\dev\\.claude\\state.json for dev@example.com and /home/dev/.claude/x');
    reportAccountProblem('folder-link-failed', 'test-agent', { entry: 'projects' }, cause);

    expect(reportHandledError).toHaveBeenCalledTimes(1);
    const sent = reportHandledError.mock.calls[0][0] as Error;
    expect(sent).toBeInstanceOf(Error);
    expect(sent.message).toContain('folder-link-failed');
    expect(sent.message).not.toContain('dev@example.com');
    expect(sent.message).not.toContain('C:\\Users');
    expect(sent.message).not.toContain('/home/dev');
  });

  it('drops the second identical report in one run and sends it again after a reset', () => {
    reportAccountProblem('usage-read-unreadable', 'test-agent', { keys: 'a,b' });
    reportAccountProblem('usage-read-unreadable', 'test-agent', { keys: 'a,b' });
    expect(reportHandledError).toHaveBeenCalledTimes(1);

    reportAccountProblem('usage-read-unreadable', 'test-agent', { keys: 'c' });
    expect(reportHandledError).toHaveBeenCalledTimes(2);

    resetAccountProblemReports();
    reportAccountProblem('usage-read-unreadable', 'test-agent', { keys: 'a,b' });
    expect(reportHandledError).toHaveBeenCalledTimes(3);
  });
});

describe('scrubFailureDetail', () => {
  it('replaces an absolute path that is not under a home folder', () => {
    const windowsPath = scrubFailureDetail('failed at D:\\Work\\x\\y now');
    expect(windowsPath).not.toContain('Work');
    expect(windowsPath).toContain('<path>');
    const posixPath = scrubFailureDetail('failed at /var/lib/x now');
    expect(posixPath).not.toContain('/var/lib');
    expect(posixPath).toContain('<path>');
  });

  it('keeps the path of a web address', () => {
    expect(scrubFailureDetail('POST https://api.example.com/v1/billing returned 402')).toBe(
      'POST https://api.example.com/v1/billing returned 402',
    );
  });

  it('replaces an email and a home folder', () => {
    const scrubbed = scrubFailureDetail('dev@example.com at C:\\Users\\dev\\x and /Users/dev/y');
    expect(scrubbed).not.toContain('dev@example.com');
    expect(scrubbed).not.toContain('C:\\Users');
    expect(scrubbed).not.toContain('/Users/dev');
  });
});
