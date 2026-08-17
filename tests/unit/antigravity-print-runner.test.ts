/**
 * Unit tests for the real `runAntigravityPrint` (print-runner.ts).
 *
 * `tests/unit/antigravity-adapter.test.ts` globally mocks this module out
 * (its summarize()-wiring tests only need to assert the WRAPPING, not the
 * PTY-driving internals), so the onData capping behavior added in this
 * branch has no other coverage. This file does NOT mock print-runner
 * itself: node-pty is mocked so the PTY output stream is fully
 * controllable with no native binding involved, and trust-manager's
 * `ensureWorkspaceTrust` is mocked to a no-op so nothing here touches a
 * real home directory (`scratchDirectory()` uses the real `os.tmpdir()`,
 * which is the sandboxed-write rule's own carve-out).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

vi.mock('../../src/main/agent/adapters/antigravity/trust-manager', () => ({
  ensureWorkspaceTrust: vi.fn(async () => undefined),
}));

import * as pty from 'node-pty';
import { runAntigravityPrint } from '../../src/main/agent/adapters/antigravity/print-runner';

const spawnMock = pty.spawn as unknown as ReturnType<typeof vi.fn>;

interface FakePtyProcess {
  emitData: (data: string) => void;
  emitExit: () => void;
  killMock: ReturnType<typeof vi.fn>;
}

/**
 * Install a scripted fake PTY, following the claude-model-picker-probe.test.ts
 * precedent: `onSpawn` fires from a `queueMicrotask` scheduled at the moment
 * `spawn()` is called, so it always runs AFTER the synchronous `onData`/
 * `onExit` registration inside print-runner's `new Promise(executor)` -
 * causally ordered, no fixed-delay guess needed.
 */
function installFakePty(onSpawn: (fake: FakePtyProcess) => void): void {
  let dataCallback: ((data: string) => void) | null = null;
  let exitCallback: (() => void) | null = null;
  const fake: FakePtyProcess = {
    emitData: (data: string) => {
      if (!dataCallback) throw new Error('test setup: onData handler not registered yet');
      dataCallback(data);
    },
    emitExit: () => {
      if (!exitCallback) throw new Error('test setup: onExit handler not registered yet');
      exitCallback();
    },
    killMock: vi.fn(),
  };
  spawnMock.mockImplementation(() => {
    queueMicrotask(() => onSpawn(fake));
    return {
      onData: (callback: (data: string) => void) => {
        dataCallback = callback;
      },
      onExit: (callback: () => void) => {
        exitCallback = callback;
      },
      kill: fake.killMock,
    };
  });
}

beforeEach(() => {
  spawnMock.mockReset();
});

describe('runAntigravityPrint output capping', () => {
  it('retains the TAIL of PTY output under the 64KB cap so a closing result JSON survives a chatty run', async () => {
    // Before this branch, the cap guard was drop-forward
    // (`if (output.length < OUTPUT_CAP_BYTES) output += data`): once 64KB of
    // output had accumulated, every subsequent chunk - including the closing
    // result JSON extractPrintResponse reads from the END of the stream -
    // was silently discarded. The fix retains the tail instead
    // (`output = (output + data).slice(-OUTPUT_CAP_BYTES)`), so a run that
    // is chatty BEFORE printing its result must still resolve correctly.
    const resultJson = JSON.stringify({
      conversation_id: 'a1b2c3',
      status: 'done',
      response: 'Fix the login timeout bug',
      usage: {},
    });

    const resultPromise = runAntigravityPrint('/usr/bin/agy', 'summarize this task');

    installFakePty((fake) => {
      // 80KB of noise BEFORE the result JSON: on its own this already
      // exceeds the 64KB cap, so a drop-forward guard would have frozen
      // `output` at this noise's head and never seen the JSON chunk below.
      // Kept free of `{`/`}` and control bytes so it cannot itself parse as
      // (or corrupt) a JSON candidate.
      fake.emitData('n'.repeat(80 * 1024));
      fake.emitData(resultJson);
      fake.emitExit();
    });

    await expect(resultPromise).resolves.toBe('Fix the login timeout bug');
  });
});
