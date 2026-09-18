/**
 * The escalation gate's late confirmation, end to end on real parts: the real
 * `TerminalSubmitScheduler`, the real `TerminalSubmit` over the FakeTui, and
 * the real Claude verifier reading a temp transcript on disk.
 *
 * The scheduler suite covers this path with a mocked verifier; this file
 * exists because the path could not be reached in a live preview. A deny-read
 * ACL on the transcript (the rig that forces a restart) also stops Claude
 * Code persisting its own turn, so "evidence arrives after the burst" cannot
 * be staged against the real CLI without corrupting the evidence. Here the
 * transcript stays writable and the evidence (a `queue-operation` enqueue,
 * the mid-turn shape of #682) lands only once the burst has reported
 * `failed` (five 400ms windows and the 2000ms grace, all against an empty
 * transcript), inside the gate's wait, which never completes here because
 * the session reads as thinking. The gate's 1s poll must see it and cancel
 * the restart. The burst's own result gates the append, not a clock, so a
 * slow runner cannot confirm inside the burst and pass by the wrong path.
 *
 * Real timers, about five seconds. Kept to one case on purpose.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PasteEngine } from '../../src/main/pty/paste-engine';
import type { SessionManager } from '../../src/main/pty/session-manager';
import { TerminalSubmit, type CommandVerifier, type SubmitKeystrokesResult } from '../../src/main/pty/terminal-submit';
import { TerminalSubmitScheduler, type InjectionReport } from '../../src/main/transition-engine/terminal-submit-scheduler';
import {
  createSlashCommandVerifier,
  clearTranscriptTailCache,
} from '../../src/main/agent/adapters/claude/slash-command-verifier';
import { SimulatedSessionManager, DEFAULT_TUI_OPTIONS, createStubPasteEngine } from './injection-tui-simulator';

const SESSION_ID = 's-late';
const TASK_ID = 'task-late';

/** The simulator plus the three reads the scheduler and the gate make. */
class SchedulerSessionManager extends SimulatedSessionManager {
  activity: 'thinking' | 'idle' = 'idle';

  getSession(id: string): { status: string } | undefined {
    return id === this.sessionId ? { status: 'running' } : undefined;
  }

  getActivityCache(): Record<string, 'thinking' | 'idle'> {
    return { [this.sessionId]: this.activity };
  }

  getPendingDraft(): string | null {
    return null;
  }
}

describe('late confirmation at the escalation gate (real scheduler, submit engine, and Claude verifier)', () => {
  it('confirms from evidence that lands after the burst gave up, and never restarts', async () => {
    clearTranscriptTailCache();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-late-confirm-'));
    const jsonlPath = path.join(tmpDir, 'session.jsonl');
    // A transcript with an earlier turn in it, so the walk has something older
    // than the watermark to stop on once the evidence is there.
    fs.writeFileSync(jsonlPath, JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'earlier prompt' },
      timestamp: new Date(Date.now() - 60_000).toISOString(),
    }) + '\n');

    const sessionManager = new SchedulerSessionManager(SESSION_ID, DEFAULT_TUI_OPTIONS);
    const submit = new TerminalSubmit(
      sessionManager as unknown as SessionManager,
      createStubPasteEngine() as unknown as PasteEngine,
    );
    // The burst's own verdict, captured as the scheduler receives it. The
    // evidence is appended only after the burst has reported `failed`, so the
    // confirmation below can only have come from the gate's poll: a fixed
    // delay would let a slow runner confirm inside the burst instead and pass
    // without ever reaching the path this file exists to cover.
    const burstResults: Promise<SubmitKeystrokesResult>[] = [];
    const realSubmitKeystrokes = submit.submitKeystrokes.bind(submit);
    vi.spyOn(submit, 'submitKeystrokes').mockImplementation((...callArguments) => {
      const pending = realSubmitKeystrokes(...callArguments);
      burstResults.push(pending);
      return pending;
    });
    const scheduler = new TerminalSubmitScheduler(sessionManager as unknown as SessionManager, submit);
    const claudeVerifier = createSlashCommandVerifier(jsonlPath);
    if (!claudeVerifier) throw new Error('verifier not created');
    const verifier: CommandVerifier = (command, sentAt, mode) => claudeVerifier(command, sentAt, mode);
    const escalate = vi.fn(async () => true);

    const reports: InjectionReport[] = [];
    const reported = new Promise<InjectionReport>((resolve) => {
      scheduler.scheduleKeystrokes(TASK_ID, SESSION_ID, [{ text: '/hello', verify: 'submitted' }], {
        verifier,
        escalate,
        onOutcome: (report) => {
          reports.push(report);
          resolve(report);
        },
      });
    });

    // The burst reads the activity once at its start: idle, so the slash gets
    // its Esc and the FakeTui's picker does not eat the Enter (the simulator
    // models the picker; the real CLI queues a mid-turn slash without one).
    // The gate reads it again when the burst fails: thinking by then, so the
    // gate waits and only its poll can end it. The flip keys off the FakeTui
    // recording the submission, which is after the burst's read by
    // construction; a fixed delay could land before it on a starved runner.
    await vi.waitFor(() => {
      expect(sessionManager.tui.submissions.map((entry) => entry.text)).toEqual(['/hello']);
    }, { timeout: 5_000, interval: 25 });
    sessionManager.activity = 'thinking';

    // The CLI took the text at once, but its transcript says nothing until the
    // burst has given up: five 400ms windows and the 2000ms grace, about four
    // seconds, all of it spent on a transcript with no evidence. Only then does
    // the entry land, with the gate waiting on a session that reads as thinking.
    // The wait is real time on a shared CI worker, so the budget carries more
    // than double the burst; the test's own 30s timeout still bounds a hang.
    await vi.waitFor(() => expect(burstResults).toHaveLength(1), { timeout: 10_000, interval: 25 });
    const burstResult = await burstResults[0];
    expect(burstResult.outcome).toBe('failed');
    expect(burstResult.unconfirmedCommands).toEqual(['/hello']);
    expect(burstResult.deliveries.map((delivery) => delivery.confirmed)).toEqual([false]);
    expect(sessionManager.tui.submissions.map((entry) => entry.text)).toEqual(['/hello']);
    expect(reports).toHaveLength(0);
    fs.appendFileSync(jsonlPath, JSON.stringify({
      type: 'queue-operation',
      operation: 'enqueue',
      timestamp: new Date().toISOString(),
      sessionId: 'claude-session',
      content: '/hello',
    }) + '\n');

    const report = await reported;

    expect(report.outcome).toBe('confirmed');
    expect(report.escalated).toBe(false);
    expect(report.unconfirmedCommands).toEqual([]);
    expect(escalate).not.toHaveBeenCalled();

    sessionManager.dispose();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  }, 30_000);
});
