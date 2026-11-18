/**
 * The pty host's handled-failure relay. The host cannot import Sentry, so it
 * sends a fixed code once per run (`HostHandledErrors`) and main reports it
 * (`pty-host-report.ts`). Also pins that a typed host error keeps its name across
 * the wire, and that the first host crash of a run reports apart from the latch.
 * A regression here leaves a host failure that ends every terminal unreported.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const reportHandledError = vi.fn();
vi.mock('../../src/main/analytics/error-reporting', () => ({ reportHandledError }));
vi.mock('../../src/main/analytics/analytics', () => ({ trackEvent: vi.fn() }));

const { HostHandledErrors } = await import('../../src/main/pty/host/host-handled-error');
const { fromPtyHostError, toPtyHostError } = await import('../../src/main/pty/host/protocol');
const {
  recordPtyHostStallAtQuit,
  reportPtyHostHandledError,
  reportPtyHostHeartbeatStall,
  reportPtyHostStallFromLastRun,
  resetPtyHostReports,
} = await import('../../src/main/pty/host/pty-host-report');
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
    const stall = {
      unansweredMs: 11_000,
      outcome: 'answered' as const,
      answeredAfterMs: 12_000,
      timerLateMs: 0,
      inFlight: [],
      stderrTail: '',
      watchdogLinesBefore: 0,
    };
    reportPtyHostHeartbeatStall(stall);
    reportPtyHostHeartbeatStall(stall);
    expect(reportHandledError).toHaveBeenCalledTimes(1);
    expect(reportHandledError.mock.calls[0][3]).toEqual(['pty-host', 'heartbeat-stall']);
  });

  it('redacts the host stderr it carries, as a crash report does', () => {
    reportPtyHostHeartbeatStall({
      unansweredMs: 11_000,
      outcome: 'no_answer',
      answeredAfterMs: null,
      timerLateMs: 0,
      inFlight: [],
      stderrTail: `[pty-host] event loop held 5 s in pty:spawn\nopened ${path.join(os.homedir(), 'fix-acme-billing')}`,
      watchdogLinesBefore: 0,
    });
    const contexts = reportHandledError.mock.calls[0][2] as Record<string, Record<string, unknown>>;
    expect(contexts.pty_host).toMatchObject({ outcome: 'no_answer', neverAnswered: true, heldStep: '[pty-host] event loop held 5 s in pty:spawn' });
    const sentTail = String(contexts.utility_process.stderrTail);
    expect(sentTail).toContain('fix-acme-billing');
    expect(sentTail).not.toContain(os.homedir());
  });
});

describe('a heartbeat stall the last run quit on', () => {
  let directory = '';
  let filePath = '';
  const STALL_AT_QUIT = {
    unansweredMs: 11_000,
    outcome: 'shutdown' as const,
    answeredAfterMs: null,
    timerLateMs: 0,
    inFlight: ['spawn'],
    stderrTail: '[pty-host] event loop held 5 s in pty:data',
    watchdogLinesBefore: 0,
  };

  beforeEach(() => {
    reportHandledError.mockReset();
    resetPtyHostReports();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-host-stall-at-quit-'));
    filePath = path.join(directory, 'pty-host-stall-at-quit.json');
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('is reported once by the next launch, and does not use up that run\'s own stall report', () => {
    recordPtyHostStallAtQuit(filePath, STALL_AT_QUIT);
    reportPtyHostStallFromLastRun(filePath);
    reportPtyHostStallFromLastRun(filePath);
    expect(reportHandledError).toHaveBeenCalledTimes(1);
    expect(reportHandledError.mock.calls[0][1]).toMatchObject({ code: 'heartbeat_stall', outcome: 'shutdown' });
    expect(reportHandledError.mock.calls[0][3]).toEqual(['pty-host', 'heartbeat-stall']);

    // A stall in the new run still reports.
    reportPtyHostHeartbeatStall({ ...STALL_AT_QUIT, outcome: 'answered', answeredAfterMs: 12_000 });
    expect(reportHandledError).toHaveBeenCalledTimes(2);
  });

  it('sends nothing for no file, a broken file, or one this app could not have written, and deletes what it read', () => {
    expect(() => reportPtyHostStallFromLastRun(filePath)).not.toThrow();
    fs.writeFileSync(filePath, '{ not json');
    reportPtyHostStallFromLastRun(filePath);
    expect(fs.existsSync(filePath)).toBe(false);
    fs.writeFileSync(filePath, JSON.stringify({ ...STALL_AT_QUIT, outcome: 'answered' }));
    reportPtyHostStallFromLastRun(filePath);
    fs.writeFileSync(filePath, JSON.stringify({ ...STALL_AT_QUIT, unansweredMs: 'eleven' }));
    reportPtyHostStallFromLastRun(filePath);
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('keeps only method names from the in-flight list it reads back', () => {
    fs.writeFileSync(filePath, JSON.stringify({ ...STALL_AT_QUIT, inFlight: ['spawn', 'C:\\Users\\dev\\fix-acme', 7] }));
    reportPtyHostStallFromLastRun(filePath);
    const contexts = reportHandledError.mock.calls[0][2] as Record<string, Record<string, unknown>>;
    expect(contexts.pty_host.inFlight).toEqual(['spawn']);
  });

  it('caps the stderr tail and the in-flight list it reads back, keeping the newest text', () => {
    const methods = Array.from({ length: 30 }, (_unused, index) => `m${'a'.repeat(index + 1)}`);
    const longTail = `START_MARKER${'x'.repeat(39_978)}END_MARKER`;
    expect(longTail.length).toBe(40_000);
    fs.writeFileSync(filePath, JSON.stringify({ ...STALL_AT_QUIT, inFlight: methods, stderrTail: longTail }));
    reportPtyHostStallFromLastRun(filePath);
    const contexts = reportHandledError.mock.calls[0][2] as Record<string, Record<string, unknown>>;
    expect(contexts.pty_host.inFlight).toEqual(methods.slice(0, 16));
    const sentTail = String(contexts.utility_process.stderrTail);
    expect(sentTail.length).toBeLessThanOrEqual(16_384);
    expect(sentTail.endsWith('END_MARKER')).toBe(true);
    expect(sentTail).not.toContain('START_MARKER');
  });

  it.each([
    ['a negative timerLateMs', { ...STALL_AT_QUIT, timerLateMs: -1 }],
    ['an inFlight that is not an array', { ...STALL_AT_QUIT, inFlight: 'spawn' }],
    ['a JSON array at the top level', [STALL_AT_QUIT]],
    ['a JSON null at the top level', null],
  ])('sends nothing for %s', (_name, recorded) => {
    fs.writeFileSync(filePath, JSON.stringify(recorded));
    reportPtyHostStallFromLastRun(filePath);
    expect(reportHandledError).not.toHaveBeenCalled();
    expect(fs.existsSync(filePath)).toBe(false);
  });
});

describe('the heldStep a heartbeat stall names', () => {
  const HELD_LINE = '[pty-host] event loop held 5 s in pty:data';
  const baseStall = {
    unansweredMs: 11_000,
    outcome: 'no_answer' as const,
    answeredAfterMs: null,
    timerLateMs: 0,
    inFlight: [],
    stderrTail: HELD_LINE,
    watchdogLinesBefore: 0,
  };

  function contextsOfLastReport(): Record<string, Record<string, unknown>> {
    return reportHandledError.mock.calls[reportHandledError.mock.calls.length - 1][2] as Record<string, Record<string, unknown>>;
  }

  beforeEach(() => {
    reportHandledError.mockReset();
    resetPtyHostReports();
  });

  it('says so when the host captured no stderr', () => {
    reportPtyHostHeartbeatStall({ ...baseStall, stderrTail: '' });
    const contexts = contextsOfLastReport();
    expect(contexts.utility_process.stderrTail).toBe('(no stderr captured)');
    expect(contexts.pty_host.heldStep).toBeNull();
  });

  it('names the line only when the watchdog line count grew since the beat was sent', () => {
    reportPtyHostHeartbeatStall({ ...baseStall, watchdogLinesBefore: 1 });
    expect(contextsOfLastReport().pty_host.heldStep).toBeNull();

    resetPtyHostReports();
    reportPtyHostHeartbeatStall({ ...baseStall, watchdogLinesBefore: 0 });
    expect(contextsOfLastReport().pty_host.heldStep).toBe(HELD_LINE);
  });
});

// src/main/index.ts and register-all.ts cannot be imported in a test, so this reads their text.
describe('the stall-at-quit file wiring', () => {
  const mainRoot = path.join(__dirname, '..', '..', 'src', 'main');

  it('is read at launch from the config directory by index.ts', () => {
    const source = fs.readFileSync(path.join(mainRoot, 'index.ts'), 'utf8');
    expect(
      /reportPtyHostStallFromLastRun\(\s*path\.join\(PATHS\.configDir,\s*PTY_HOST_STALL_AT_QUIT_FILE_NAME\)/.test(source),
      'index.ts must call reportPtyHostStallFromLastRun(path.join(PATHS.configDir, PTY_HOST_STALL_AT_QUIT_FILE_NAME)) at startup, or a stall the last run quit on is never reported.',
    ).toBe(true);
  });

  it('is handed to the transport by register-all.ts under the same name', () => {
    const source = fs.readFileSync(path.join(mainRoot, 'ipc', 'register-all.ts'), 'utf8');
    expect(
      /stallAtQuitFilePath:\s*path\.join\(PATHS\.configDir,\s*PTY_HOST_STALL_AT_QUIT_FILE_NAME\)/.test(source),
      'register-all.ts must pass stallAtQuitFilePath: path.join(PATHS.configDir, PTY_HOST_STALL_AT_QUIT_FILE_NAME) to UtilityPtyHostTransport, or a quit on a stall records nothing.',
    ).toBe(true);
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
