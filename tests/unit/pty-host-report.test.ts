/**
 * The pty host's handled-failure relay. The host cannot import Sentry, so it
 * sends a fixed code once per run (`HostHandledErrors`) and main reports it
 * (`pty-host-report.ts`). Also pins that a typed host error keeps its name across
 * the wire, and that the first host crash of a run reports apart from the latch.
 * A regression here leaves a host failure that ends every terminal unreported.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const reportHandledError = vi.fn();
vi.mock('../../src/main/analytics/error-reporting', () => ({ reportHandledError }));
vi.mock('../../src/main/analytics/analytics', () => ({ trackEvent: vi.fn() }));

const { HostHandledErrors } = await import('../../src/main/pty/host/host-handled-error');
const { fromPtyHostError, toPtyHostError } = await import('../../src/main/pty/host/protocol');
const { reportPtyHostHandledError, reportPtyHostHeartbeatStall, resetPtyHostReports } = await import('../../src/main/pty/host/pty-host-report');
const { PtyHostTimeoutError } = await import('../../src/main/pty/host/pty-host-request-errors');
const { UtilityRestartPolicy, resetUtilityCrashTelemetryForTests } = await import('../../src/main/utility-process/restart-policy');

describe('HostHandledErrors (in the host)', () => {
  it('relays each code once per run, with the error shape and no more', () => {
    const emitted: unknown[] = [];
    const errors = new HostHandledErrors((event) => emitted.push(event));
    const failure = Object.assign(new Error('SQLITE_BUSY: database is locked'), { code: 'SQLITE_BUSY', name: 'SqliteError' });
    errors.report('transcript_flush', failure);
    errors.report('transcript_flush', failure);
    errors.report('root_pin', new TypeError('x'));
    expect(emitted).toHaveLength(2);
    expect(emitted[0]).toMatchObject({ type: 'handledError', code: 'transcript_flush', error: { name: 'SqliteError', code: 'SQLITE_BUSY' } });
  });

  it('never throws into the path it reports on', () => {
    const errors = new HostHandledErrors(() => { throw new Error('port gone'); });
    expect(() => errors.report('pty_kill', new Error('x'))).not.toThrow();
  });
});

describe('the wire keeps a typed error typed', () => {
  it('restores the name, so an expected class stays expected in main', () => {
    const restored = fromPtyHostError(toPtyHostError(new PtyHostTimeoutError('reapTaggedProcesses')));
    expect(restored.name).toBe('PtyHostTimeoutError');
  });

  it('ignores a name that is not a class name, and an older host that sends none', () => {
    expect(fromPtyHostError({ message: 'x', name: 'fix: the Acme billing export' }).name).toBe('Error');
    expect(fromPtyHostError({ message: 'x' }).name).toBe('Error');
  });
});

describe('main reports what the host relayed', () => {
  beforeEach(() => {
    reportHandledError.mockReset();
    resetPtyHostReports();
  });

  it('sends a fixed message tagged with the code, never the host text', () => {
    reportPtyHostHandledError({
      type: 'handledError',
      code: 'orphan_cleanup',
      error: { message: 'could not open C:\\Users\\dev\\fix-acme-billing', name: 'TypeError' },
    });
    const [sent, tags] = reportHandledError.mock.calls[0] as [Error, Record<string, string>];
    expect(sent.message).toBe('Handled pty_host failure: TypeError');
    expect(tags).toMatchObject({ source: 'pty_host', code: 'orphan_cleanup' });
    expect(JSON.stringify(reportHandledError.mock.calls[0])).not.toContain('acme');
  });

  it('reports a heartbeat stall once per run', () => {
    reportPtyHostHeartbeatStall(30_000);
    reportPtyHostHeartbeatStall(30_000);
    expect(reportHandledError).toHaveBeenCalledTimes(1);
    expect(reportHandledError.mock.calls[0][3]).toEqual(['pty-host', 'heartbeat-stall']);
  });
});

describe('the first crash of a run (reportFirstCrash)', () => {
  beforeEach(() => {
    reportHandledError.mockReset();
    resetUtilityCrashTelemetryForTests();
  });

  it('reports the first crash once, apart from the latch, only for a policy that asked', () => {
    const optedIn = new UtilityRestartPolicy({ service: 'kangentic-pty-host', maxCrashes: 5, reportFirstCrash: true });
    optedIn.recordCrash(1);
    optedIn.recordCrash(1);
    expect(reportHandledError).toHaveBeenCalledTimes(1);
    expect(reportHandledError.mock.calls[0][3]).toEqual(['utility-process-first-crash', 'kangentic-pty-host', 'exit']);

    const other = new UtilityRestartPolicy({ service: 'kangentic-embeddings', maxCrashes: 5 });
    other.recordCrash(1);
    expect(reportHandledError).toHaveBeenCalledTimes(1);
  });
});
