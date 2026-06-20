/**
 * Fake-child protocol tests for the Windows `WindowsProbe` sentinel-based
 * stdin/stdout protocol.
 *
 * These tests run on ALL platforms (no platform gate) by intercepting
 * `node:child_process.spawn` via `vi.mock` before importing the module
 * under test. The real PowerShell binary is never invoked; instead we
 * drive fake EventEmitter-based child processes from test code to exercise
 * precise chunk-boundary and timing scenarios that the real-OS smoke tests
 * cannot control:
 *
 *   - Sentinel split across stdout chunks: `processStdoutBuffer` must
 *     accumulate the buffer and only resolve after the full sentinel appears.
 *
 *   - dispose() called while a query is in-flight: the pending promise must
 *     resolve with [] immediately, the per-query timer must be cleared, and
 *     the child must be killed.
 *
 *   - ENOENT fallback chain: pwsh.exe → powershell.exe. A dev machine with
 *     pwsh installed never hits this branch in the real-OS smoke.
 *
 * `vi.mock` is hoisted, so the mock is active for the entire file. The
 * real-OS smoke tests live in `process-tree.test.ts` (un-mocked) and are
 * not affected.
 *
 * `process.platform` is spoofed to 'win32' within each test so that
 * `createProcessTreeProbe()` instantiates `WindowsProbe` regardless of the
 * host OS. The spy is restored after every test via `vi.restoreAllMocks`.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// vi.mock must be called before any dynamic import of the module being mocked.
// Vitest hoists these calls to the top of the file.
vi.mock('node:child_process');

// Import the mock-controlled module after vi.mock so we can shape the mock.
import * as childProcessMock from 'node:child_process';
// Import after vi.mock so the module sees the mocked spawn.
import { createProcessTreeProbe } from '../../src/main/activity-engine/background-shell/process-tree';

// ---------------------------------------------------------------------------
// Fake child process infrastructure
// ---------------------------------------------------------------------------

/**
 * Minimal stdin stub: tracks writes, supports `end()`, emits 'error'.
 */
interface FakeStdin extends EventEmitter {
  writtenChunks: string[];
  writable: boolean;
  write(chunk: string): boolean;
  end(): void;
}

/**
 * Minimal stdout stub: lets test code push data chunks as if they arrived
 * from the PowerShell process.
 */
interface FakeStdout extends EventEmitter {
  pushData(chunk: string): void;
}

/**
 * Minimal child process stub. Extends EventEmitter so listeners attached
 * with `.on('exit', ...)` and `.on('error', ...)` work correctly.
 */
interface FakeChild extends EventEmitter {
  stdin: FakeStdin;
  stdout: FakeStdout;
  kill(): void;
  killCalled: boolean;
  removeAllListeners(event?: string): this;
}

function makeFakeChild(): FakeChild {
  const stdin: FakeStdin = Object.assign(new EventEmitter(), {
    writtenChunks: [] as string[],
    writable: true,
    write(chunk: string): boolean {
      stdin.writtenChunks.push(chunk);
      return true;
    },
    end(): void {
      stdin.writable = false;
    },
  });

  const stdout: FakeStdout = Object.assign(new EventEmitter(), {
    pushData(chunk: string): void {
      stdout.emit('data', Buffer.from(chunk, 'utf-8'));
    },
  });

  const fakeChild: FakeChild = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    killCalled: false,
    kill(): void {
      fakeChild.killCalled = true;
      // Simulate OS delivering SIGTERM exit notification. WindowsProbe
      // attaches to 'exit' in commitChild() to drive handleChildExit().
      fakeChild.emit('exit', null, 'SIGTERM');
    },
  }) as FakeChild;

  return fakeChild;
}

/**
 * Extract the sentinel UUID string embedded in the PowerShell `-Command`
 * script argument. The script contains: `Write-Output '<sentinel>'`
 */
function extractSentinelFromScript(script: string): string {
  const match = script.match(/Write-Output '([^']+)'/);
  if (!match) throw new Error(`Could not extract sentinel from script: ${script.slice(0, 200)}`);
  return match[1];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WindowsProbe fake-child protocol (all-platform)', () => {
  let platformSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Spoof platform so createProcessTreeProbe() returns WindowsProbe
    // regardless of the host OS. Restored in afterEach via restoreAllMocks.
    platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32' as NodeJS.Platform);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(childProcessMock.spawn).mockReset();
    platformSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Gap 2: sentinel split across stdout chunks
  // -------------------------------------------------------------------------

  it('sentinel split across two stdout chunks: accumulates buffer and resolves only after full sentinel arrives', async () => {
    // Real-world streaming from pwsh.exe can deliver CSV and the sentinel
    // in separate `data` events. `processStdoutBuffer` must NOT resolve the
    // pending query on the first chunk (no sentinel yet), and MUST resolve on
    // the second chunk once the sentinel is present.
    //
    // This is impossible to prove with real PowerShell because the OS
    // controls how stdout is flushed.
    const fakeChild = makeFakeChild();

    vi.mocked(childProcessMock.spawn).mockReturnValue(
      fakeChild as unknown as ReturnType<typeof childProcessMock.spawn>,
    );

    const probeUnderTest = createProcessTreeProbe();
    const queryPromise = probeUnderTest.listAllProcesses();

    // Drain microtasks: WindowsProbe sets up the stdout listener and writes
    // 'Q\n' to stdin inside `attemptSpawn`, which runs synchronously from
    // listAllProcesses -> spawnAndFirstQuery -> attemptSpawn -> Promise ctor.
    await Promise.resolve();
    await Promise.resolve();

    // Verify spawn was attempted with pwsh.exe.
    expect(vi.mocked(childProcessMock.spawn)).toHaveBeenCalledWith(
      'pwsh.exe',
      expect.arrayContaining(['-NonInteractive']),
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'ignore'] }),
    );

    // Extract sentinel from the '-Command' argument.
    const spawnArgs = vi.mocked(childProcessMock.spawn).mock.calls[0];
    const scriptArg = (spawnArgs[1] as string[])[3];
    const sentinel = extractSentinelFromScript(scriptArg);

    // Chunk 1: CSV header + first data row. NO sentinel yet. The probe must
    // not resolve the query.
    const chunk1 = '"ProcessId","ParentProcessId","Name"\r\n"100","200","node.exe"\r\n';
    fakeChild.stdout.pushData(chunk1);

    // Yield: if there were a premature resolve, the promise would settle now.
    await Promise.resolve();

    // Push chunk 2: a second CSV row followed by the sentinel.
    const chunk2 = '"300","100","bash.exe"\r\n' + sentinel + '\n';
    fakeChild.stdout.pushData(chunk2);

    // Yield again so processStdoutBuffer can detect the sentinel and resolve.
    await Promise.resolve();
    await Promise.resolve();

    const result = await queryPromise;

    // Both CSV rows must be present - content before chunk boundary preserved.
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ pid: 100, ppid: 200, comm: 'node' });
    expect(result[1]).toEqual({ pid: 300, ppid: 100, comm: 'bash' });

    probeUnderTest.dispose();
  });

  // -------------------------------------------------------------------------
  // Gap 3: dispose() called while a query is in-flight
  // -------------------------------------------------------------------------

  it('dispose() while query is in-flight: resolves pending promise with [] and does not allow timer to fire after child is killed', async () => {
    // Shutdown safety contract: `before-quit` calls `probe.dispose()` during
    // an active query. The pending promise must resolve with [] immediately.
    // The per-query timeout timer must be cleared (it must not fire after the
    // child is killed and cause a second `resolve` call or a use-after-free).
    //
    // WindowsProbe.dispose() code path:
    //   1. Set disposed=true.
    //   2. Drain pendingQuery: clearTimeout(pending.timer); pending.resolve([]).
    //   3. Call shutdownChild() which writes EXIT\n, ends stdin, kills child.
    vi.useFakeTimers();

    const bootstrapChild = makeFakeChild();
    const queryChild = makeFakeChild();
    let spawnIndex = 0;

    vi.mocked(childProcessMock.spawn).mockImplementation(() => {
      spawnIndex += 1;
      // First spawn: used to bootstrap (commit) the long-lived child.
      // Second spawn would happen only if the probe tried to respawn after
      // dispose, which it must NOT do.
      return (spawnIndex === 1 ? bootstrapChild : queryChild) as unknown as ReturnType<typeof childProcessMock.spawn>;
    });

    const probeUnderTest = createProcessTreeProbe();

    // Bootstrap step: run one complete query to transition the probe from
    // spawnAndFirstQuery into the "committed long-lived child" state. This
    // means subsequent queries go through queryExistingChild().
    const bootstrapPromise = probeUnderTest.listAllProcesses();
    await Promise.resolve();
    await Promise.resolve();

    const bootstrapSpawnArgs = vi.mocked(childProcessMock.spawn).mock.calls[0];
    const bootstrapScript = (bootstrapSpawnArgs[1] as string[])[3];
    const sentinel = extractSentinelFromScript(bootstrapScript);

    // Answer the bootstrap query with one valid CSV row + sentinel.
    bootstrapChild.stdout.pushData(
      '"ProcessId","ParentProcessId","Name"\r\n"999","1","node.exe"\r\n' + sentinel,
    );
    await Promise.resolve();
    await Promise.resolve();

    const bootstrapResult = await bootstrapPromise;
    // Probe committed the bootstrapChild as its long-lived child.
    expect(bootstrapResult).toHaveLength(1);

    // In-flight query: uses queryExistingChild() which sets pendingQuery and
    // writes 'Q\n'. We do NOT emit any stdout data, so the query hangs.
    const inflightPromise = probeUnderTest.listAllProcesses();
    await Promise.resolve();
    await Promise.resolve();

    // Confirm the second 'Q\n' was written (the first was the bootstrap query).
    const qWrites = bootstrapChild.stdin.writtenChunks.filter((chunk) => chunk === 'Q\n');
    expect(qWrites.length).toBeGreaterThanOrEqual(2);

    // Call dispose() while the in-flight query is awaiting its sentinel.
    probeUnderTest.dispose();

    // Advance fake timers well past PROBE_TIMEOUT_MS (1500ms). The per-query
    // timer must have been cleared by dispose() so advancing time must NOT
    // cause a second resolve or throw.
    vi.advanceTimersByTime(5000);
    await Promise.resolve();
    await Promise.resolve();

    // The in-flight promise must have resolved with [].
    const inflightResult = await inflightPromise;
    expect(inflightResult).toEqual([]);

    // kill() must have been called to tear down the committed child.
    expect(bootstrapChild.killCalled).toBe(true);

    // A second dispose must be a no-op and not throw.
    expect(() => probeUnderTest.dispose()).not.toThrow();

    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Gap 4: ENOENT fallback chain (pwsh.exe → powershell.exe)
  // -------------------------------------------------------------------------

  it('ENOENT on pwsh.exe triggers fallback to powershell.exe and succeeds', async () => {
    // On machines where only Windows PowerShell 5.x is installed (pwsh.exe
    // not present), `spawn('pwsh.exe', ...)` emits an ENOENT 'error' event.
    // WindowsProbe.attemptSpawn() resolves with `null` on ENOENT, and
    // spawnAndFirstQuery() loops to powershell.exe. Dev machines with pwsh
    // installed never exercise this branch in the real-OS smoke.
    const pwshChild = makeFakeChild();
    const powershellChild = makeFakeChild();
    let spawnIndex = 0;

    vi.mocked(childProcessMock.spawn).mockImplementation(() => {
      spawnIndex += 1;
      return (spawnIndex === 1 ? pwshChild : powershellChild) as unknown as ReturnType<typeof childProcessMock.spawn>;
    });

    const probeUnderTest = createProcessTreeProbe();
    const queryPromise = probeUnderTest.listAllProcesses();

    await Promise.resolve();
    await Promise.resolve();

    // First spawn was for pwsh.exe. Emit ENOENT via the 'error' event.
    // WindowsProbe.attemptSpawn listens for 'error'; ENOENT code resolves null.
    const enoentError = Object.assign(new Error('spawn pwsh.exe ENOENT'), {
      code: 'ENOENT',
    });
    pwshChild.emit('error', enoentError);

    await Promise.resolve();
    await Promise.resolve();

    // The probe must have spawned powershell.exe as the fallback.
    expect(spawnIndex).toBe(2);
    const fallbackSpawnArgs = vi.mocked(childProcessMock.spawn).mock.calls[1];
    expect(fallbackSpawnArgs[0]).toBe('powershell.exe');

    // Extract sentinel from the powershell.exe spawn's script argument.
    const fallbackScript = (fallbackSpawnArgs[1] as string[])[3];
    const fallbackSentinel = extractSentinelFromScript(fallbackScript);

    // Answer the powershell.exe query with a valid response.
    powershellChild.stdout.pushData(
      '"ProcessId","ParentProcessId","Name"\r\n"42","1","cmd.exe"\r\n' + fallbackSentinel,
    );
    await Promise.resolve();
    await Promise.resolve();

    const result = await queryPromise;

    // Result must come from the powershell.exe response (not [] from ENOENT).
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ pid: 42, ppid: 1, comm: 'cmd' });

    probeUnderTest.dispose();
  });

  it('all executables ENOENT: returns [] without throwing', async () => {
    // If both pwsh.exe and powershell.exe emit ENOENT, the probe must
    // return [] gracefully (not throw, not hang). The watcher treats []
    // as a probe failure and skips the cycle.
    const pwshChild = makeFakeChild();
    const powershellChild = makeFakeChild();
    let spawnIndex = 0;

    vi.mocked(childProcessMock.spawn).mockImplementation(() => {
      spawnIndex += 1;
      return (spawnIndex === 1 ? pwshChild : powershellChild) as unknown as ReturnType<typeof childProcessMock.spawn>;
    });

    const probeUnderTest = createProcessTreeProbe();
    const queryPromise = probeUnderTest.listAllProcesses();

    await Promise.resolve();
    await Promise.resolve();

    // Both executables report ENOENT.
    const enoentError = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    pwshChild.emit('error', enoentError);

    await Promise.resolve();
    await Promise.resolve();

    powershellChild.emit('error', enoentError);

    await Promise.resolve();
    await Promise.resolve();

    const result = await queryPromise;
    expect(result).toEqual([]);

    probeUnderTest.dispose();
  });
});
