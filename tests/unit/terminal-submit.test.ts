/**
 * Unit tests for src/main/pty/terminal-submit.ts.
 *
 * `TerminalSubmit` exposes two methods:
 *
 *  - `submitContent(sessionId, text, opts)` - bracketed-paste delivery for
 *    free-form content (browser-pane Send). Thin wrapper around the
 *    `PasteEngine.pasteAndSubmit` instance passed in the constructor; tests
 *    here just confirm the forwarding contract (paste-engine internals are
 *    covered by `paste-engine.test.ts`).
 *
 *  - `submitKeystrokes(sessionId, commands[], opts)` - the keystroke sequence
 *    for slash commands. Tests pin the byte-level contract, the prompt-state
 *    policy, and the per-command verification modes.
 *
 * These run on REAL timers against the `FakeTui` simulator rather than fake
 * timers. The delivery path is now a handshake chain (drain, then wait for the
 * TUI's render to settle) rather than a fixed-sleep sequence, so a fake-timer
 * harness would have to hand-simulate the very output it is meant to be
 * reacting to. Driving a TUI model that actually emits bytes tests the real
 * mechanism; the settle windows are small, so the suite stays fast.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TerminalSubmit,
  type CommandVerifier,
  type SubmitKeystrokesOptions,
  type SubmitKeystrokesResult,
} from '../../src/main/pty/terminal-submit';
import type { PasteEngine, PasteOptions } from '../../src/main/pty/paste-engine';
import type { SessionManager } from '../../src/main/pty/session-manager';
import { EventType, IdleReason, PromptReason } from '../../src/shared/types';
import {
  SimulatedSessionManager,
  DEFAULT_TUI_OPTIONS,
  createStubPasteEngine,
  createSubmissionVerifier,
  type FakeTuiOptions,
} from './injection-tui-simulator';

const SESSION_ID = 's1';

class MockPasteEngine implements PasteEngine {
  calls: Array<{ sessionId: string; text: string; options?: PasteOptions }> = [];

  pasteAndSubmit(sessionId: string, text: string, options?: PasteOptions): Promise<void> {
    this.calls.push({ sessionId, text, options });
    return Promise.resolve();
  }
}

function makeSubmit(tuiOptions: Partial<FakeTuiOptions> = {}): {
  submit: TerminalSubmit;
  sessionManager: SimulatedSessionManager;
} {
  const sessionManager = new SimulatedSessionManager(SESSION_ID, {
    ...DEFAULT_TUI_OPTIONS,
    ...tuiOptions,
  });
  const submit = new TerminalSubmit(
    sessionManager as unknown as SessionManager,
    createStubPasteEngine() as unknown as PasteEngine,
  );
  return { submit, sessionManager };
}

describe('TerminalSubmit', () => {
  describe('submitContent', () => {
    it('forwards to PasteEngine.pasteAndSubmit byte-for-byte', async () => {
      const pasteEngine = new MockPasteEngine();
      const sessionManager = new SimulatedSessionManager(SESSION_ID);
      const submit = new TerminalSubmit(sessionManager as unknown as SessionManager, pasteEngine);

      await submit.submitContent(SESSION_ID, 'hello world', { bracketed: true, source: 'test' });

      expect(pasteEngine.calls).toHaveLength(1);
      expect(pasteEngine.calls[0].sessionId).toBe(SESSION_ID);
      expect(pasteEngine.calls[0].text).toBe('hello world');
      expect(pasteEngine.calls[0].options).toEqual({ bracketed: true, source: 'test' });
      // Pasted content (a phone's message, dictation, Browser Send) is use of
      // the terminal, so an unused Command Terminal stops being replaceable.
      expect(sessionManager.userInputMarks).toEqual([SESSION_ID]);
      sessionManager.dispose();
    });
  });

  describe('submitKeystrokes byte contract', () => {
    it('writes clear then text then Esc then Enter for a slash command', async () => {
      const { submit, sessionManager } = makeSubmit();
      await submit.submitKeystrokes(SESSION_ID, [{ text: '/test', verify: 'none' }]);

      expect(sessionManager.writes).toEqual(['\x15', '/test', '\x1b', '\r']);
      sessionManager.dispose();
    });

    it('does not send Esc for a plain-prose command', async () => {
      // Esc exists to dismiss the slash-command picker, and no picker opens for
      // prose. On Claude Code's prompt Esc is not a no-op, so sending it here
      // risks clearing the very text we just typed.
      const { submit, sessionManager } = makeSubmit();
      await submit.submitKeystrokes(SESSION_ID, [{ text: 'review the diff', verify: 'none' }]);

      expect(sessionManager.writes).toEqual(['\x15', 'review the diff', '\r']);
      expect(sessionManager.tui.submissions.map((entry) => entry.text)).toEqual(['review the diff']);
      sessionManager.dispose();
    });

    it('writes each command in a chained sequence', async () => {
      const { submit, sessionManager } = makeSubmit();
      await submit.submitKeystrokes(SESSION_ID, [
        { text: '/model opus', verify: 'none' },
        { text: '/effort high', verify: 'none' },
      ]);

      expect(sessionManager.writes).toEqual([
        '\x15',
        '/model opus', '\x1b', '\r',
        '/effort high', '\x1b', '\r',
      ]);
      sessionManager.dispose();
    });

    it('sanitizes commands: collapses CR/LF/Tab to spaces', async () => {
      const { submit, sessionManager } = makeSubmit();
      await submit.submitKeystrokes(SESSION_ID, [{ text: 'line\none\rtwo\tthree', verify: 'none' }]);

      expect(sessionManager.writes).toContain('line one two three');
      sessionManager.dispose();
    });

    it('drops empty commands silently', async () => {
      const { submit, sessionManager } = makeSubmit();
      const result = await submit.submitKeystrokes(SESSION_ID, [
        { text: '', verify: 'none' },
        { text: '   ', verify: 'none' },
        { text: '\n\t', verify: 'none' },
      ]);

      expect(sessionManager.writes).toHaveLength(0);
      expect(result.outcome).toBe('unconfirmed');
      // The early return for an all-blank command list must carry an empty
      // deliveries array, not an omitted or populated one: a caller (the
      // scheduler's escalation gate) reads `deliveries` unconditionally to
      // build its late-confirmation watermarks.
      expect(result.deliveries).toEqual([]);
      sessionManager.dispose();
    });

    it('accepts bare strings and treats them as unverifiable', async () => {
      // `send_command` and the Command Terminal both pass plain strings. A bare
      // string carries no declared verification, so it must never be reported
      // as confirmed.
      const { submit, sessionManager } = makeSubmit();
      const result = await submit.submitKeystrokes(SESSION_ID, ['/test']);

      expect(sessionManager.writes).toEqual(['\x15', '/test', '\x1b', '\r']);
      expect(result.outcome).toBe('unconfirmed');
      sessionManager.dispose();
    });

    it('reports aborted when cancelled mid-burst', async () => {
      const { submit, sessionManager } = makeSubmit();
      const controller = new AbortController();
      const promise = submit.submitKeystrokes(
        SESSION_ID,
        [{ text: '/test', verify: 'none' }],
        { signal: controller.signal },
      );
      controller.abort();
      const result = await promise;

      expect(result.outcome).toBe('aborted');
      sessionManager.dispose();
    });

    it('logs an outcome line for an aborted burst, as it does for every other outcome', async () => {
      // A cancelled burst used to return silently, so the log showed the burst
      // starting and then nothing: no confirmed, no unconfirmed, no failed. The
      // abort lands on the first settle, before any Enter, so 0 of 2 pressed.
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const { submit, sessionManager } = makeSubmit();
        const controller = new AbortController();
        const promise = submit.submitKeystrokes(
          SESSION_ID,
          [{ text: '/effort high', verify: 'none' }, { text: 'carry on', verify: 'none' }],
          { signal: controller.signal, source: 'task:abcd1234' },
        );
        controller.abort();
        const result = await promise;

        expect(result.outcome).toBe('aborted');
        const abortedLines = logSpy.mock.calls
          .map((call) => String(call[0]))
          .filter((line) => line.includes('aborted'));
        expect(abortedLines).toEqual([
          `[terminal-submit] task:abcd1234: aborted - stopped after 0 of 2 command(s) to session ${SESSION_ID}: /effort high | carry on`,
        ]);
        sessionManager.dispose();
      } finally {
        logSpy.mockRestore();
      }
    });
  });

  describe('aborted burst log line', () => {
    it('counts a command whose Enter already fired as pressed', async () => {
      // The abort lands right after the first command's Enter and before the
      // second command is typed, so exactly one delivery has a first-Enter stamp.
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const { submit, sessionManager } = makeSubmit();
        const controller = new AbortController();
        const originalWrite = sessionManager.write.bind(sessionManager);
        sessionManager.write = (writeSessionId: string, data: string): void => {
          originalWrite(writeSessionId, data);
          if (data === '\r') controller.abort();
        };

        const result = await submit.submitKeystrokes(
          SESSION_ID,
          [{ text: '/effort high', verify: 'none' }, { text: 'carry on', verify: 'none' }],
          { signal: controller.signal, source: 'task:abcd1234' },
        );

        expect(result.outcome).toBe('aborted');
        expect(result.deliveries).toHaveLength(1);
        expect(result.deliveries[0].firstSentAt).not.toBeNull();
        expect(sessionManager.writes).not.toContain('carry on');
        const abortedLines = logSpy.mock.calls
          .map((call) => String(call[0]))
          .filter((line) => line.includes('aborted'));
        expect(abortedLines).toEqual([
          `[terminal-submit] task:abcd1234: aborted - stopped after 1 of 2 command(s) to session ${SESSION_ID}: /effort high | carry on`,
        ]);
        sessionManager.dispose();
      } finally {
        logSpy.mockRestore();
      }
    });
  });

  describe('prompt-state policy', () => {
    it('clears the prompt on a warm session so the command cannot concatenate', async () => {
      const { submit, sessionManager } = makeSubmit();
      sessionManager.tui.setDraft('instead can we');

      const result = await submit.submitKeystrokes(
        SESSION_ID,
        [{ text: '/pull-request', verify: 'none' }],
        { pendingDraft: 'instead can we' },
      );

      expect(sessionManager.tui.submissions.map((entry) => entry.text)).toEqual(['/pull-request']);
      expect(result.discardedDraft).toBe('instead can we');
      sessionManager.dispose();
    });

    it('skips the clear on a fresh spawn with an empty prompt', async () => {
      // The prompt is empty by construction at spawn, so the clear has nothing
      // to do and only adds a keystroke that historically landed mid-render.
      const { submit, sessionManager } = makeSubmit();
      const result = await submit.submitKeystrokes(
        SESSION_ID,
        [{ text: '/test', verify: 'none' }],
        { freshlySpawned: true },
      );

      expect(sessionManager.writes).toEqual(['/test', '\x1b', '\r']);
      expect(result.discardedDraft).toBeNull();
      sessionManager.dispose();
    });

    it('clears on a fresh spawn when the user typed during the deferred wait', async () => {
      // Fresh-spawn delivery is deferred, so "empty at spawn time" is not
      // "empty at delivery time". This is the reported bug's real path.
      const { submit, sessionManager } = makeSubmit();
      sessionManager.tui.setDraft('instead can we');

      const result = await submit.submitKeystrokes(
        SESSION_ID,
        [{ text: '/pull-request', verify: 'none' }],
        { freshlySpawned: true, pendingDraft: 'instead can we' },
      );

      expect(sessionManager.writes[0]).toBe('\x15');
      expect(sessionManager.tui.submissions.map((entry) => entry.text)).toEqual(['/pull-request']);
      expect(result.discardedDraft).toBe('instead can we');
      sessionManager.dispose();
    });

    it('never interrupts a live turn, and never sends Esc while one is running', async () => {
      // Immediate-mode delivery into a busy agent must be NON-destructive.
      // Claude Code queues a message submitted mid-turn ("When a command is
      // sent while Claude is responding, it typically queues and runs after the
      // current turn finishes"), so there is nothing to interrupt for.
      //
      // Two keys would break that and both are excluded here. Ctrl+C is a
      // cancel (and exits the CLI on a double press), so the clear is Ctrl+U.
      // Esc is documented as "stop Claude while it is generating output", so it
      // is suppressed entirely while a turn is live - dismissing a picker with
      // it would silently abort the agent, which is the reported "it looked
      // like it was editing a message already in flight" behaviour.
      const { submit, sessionManager } = makeSubmit();
      const result = await submit.submitKeystrokes(
        SESSION_ID,
        [{ text: '/test', verify: 'none' }],
        { interruptingTurn: true },
      );

      expect(result.interruptedTurn).toBe(false);
      expect(sessionManager.writes).not.toContain('\x03');
      expect(sessionManager.writes).not.toContain('\x1b');
      expect(sessionManager.writes).toContain('\x15');
      sessionManager.dispose();
    });
  });

  describe('verification', () => {
    it('reports confirmed when the verifier matches', async () => {
      const { submit, sessionManager } = makeSubmit();
      const seen: Array<{ command: string; mode: string }> = [];
      const verifier: CommandVerifier = async (command, _sentAt, mode) => {
        seen.push({ command, mode });
        return true;
      };

      const result = await submit.submitKeystrokes(
        SESSION_ID,
        [{ text: '/model opus', verify: 'command-match' }],
        { verifier },
      );

      expect(result.outcome).toBe('confirmed');
      expect(seen[0]).toEqual({ command: '/model opus', mode: 'command-match' });
      sessionManager.dispose();
    });

    it('forwards each command its own verify mode', async () => {
      const { submit, sessionManager } = makeSubmit();
      const modes: string[] = [];
      const verifier: CommandVerifier = async (_command, _sentAt, mode) => {
        modes.push(mode);
        return true;
      };

      await submit.submitKeystrokes(
        SESSION_ID,
        [
          { text: '/effort high', verify: 'command-match' },
          { text: '/code-review', verify: 'submitted' },
        ],
        { verifier },
      );

      // The user's auto_command is verified too, under the weaker mode. Under
      // the old single `verifiedPrefixLength` it was excluded entirely.
      expect(modes).toEqual(['command-match', 'submitted']);
      sessionManager.dispose();
    });

    it('confirms a plain-prose auto_command under the submitted mode, and never sends Esc', async () => {
      // injection-plan.ts tags every user auto_command `verify: 'submitted'`
      // regardless of whether it is a slash command or plain prose (see
      // `prepareInjectionPlan`). The byte-contract test above pins "no Esc for
      // prose" with `verify: 'none'`, which never reaches the verifier at all;
      // this pins the two facts together end-to-end - no `\x1b` byte AND a
      // real 'submitted' confirmation - which is the actual path a prose
      // auto_command takes in production.
      const { submit, sessionManager } = makeSubmit();
      const modes: string[] = [];
      const verifier: CommandVerifier = async (command, sentAt, mode) => {
        modes.push(mode);
        return sessionManager.tui.submissions.some(
          (entry) => entry.text === command && entry.at >= sentAt - 50,
        );
      };

      const result = await submit.submitKeystrokes(
        SESSION_ID,
        [{ text: 'implement the feature', verify: 'submitted' }],
        { verifier },
      );

      expect(sessionManager.writes).not.toContain('\x1b');
      expect(result.outcome).toBe('confirmed');
      // The verifier may poll more than once before the submission lands (real
      // timing, not a stub that always answers true on the first call), but
      // every poll must carry the 'submitted' mode - never 'command-match'.
      expect(modes.length).toBeGreaterThan(0);
      expect(modes.every((mode) => mode === 'submitted')).toBe(true);
      expect(sessionManager.tui.submissions.map((entry) => entry.text)).toEqual(['implement the feature']);
      sessionManager.dispose();
    });

    it('never calls the verifier for a command declared unverifiable', async () => {
      const { submit, sessionManager } = makeSubmit();
      let calls = 0;
      const verifier: CommandVerifier = async () => {
        calls += 1;
        return true;
      };

      const result = await submit.submitKeystrokes(
        SESSION_ID,
        [{ text: '/test', verify: 'none' }],
        { verifier },
      );

      expect(calls).toBe(0);
      expect(result.outcome).toBe('unconfirmed');
      sessionManager.dispose();
    });

    it('sends Esc at most once, and still recovers a picker-eaten submission', async () => {
      // Esc is NOT safe to repeat. On a non-empty prompt with no picker, the
      // first press prints "Esc again to clear" and the SECOND press clears the
      // line - so a retry loop that re-sent Esc would delete the very command
      // it is trying to submit. An earlier version of this test asserted the
      // opposite (`escapeCount > 1`), which is how that hazard went unnoticed.
      //
      // Recovery therefore comes from re-pressing Enter, with the single Esc on
      // the first attempt having already dismissed the picker.
      //
      // The swallow is forced rather than provoked via `pickerRenderMs`: a
      // timing-driven window lands differently under CI load, where the first
      // attempt may simply succeed and fail the assertion that a retry occurred.
      const { submit, sessionManager } = makeSubmit({ eatEnterCount: 1 });
      const verifier: CommandVerifier = async (command) =>
        sessionManager.tui.submissions.some((entry) => entry.text === command);

      const result = await submit.submitKeystrokes(
        SESSION_ID,
        [{ text: '/code-review', verify: 'submitted' }],
        { verifier },
      );

      expect(result.outcome).toBe('confirmed');
      expect(sessionManager.tui.submissions.map((entry) => entry.text)).toEqual(['/code-review']);
      const escapeCount = sessionManager.writes.filter((data) => data === '\x1b').length;
      expect(escapeCount).toBe(1);
      // The retry that actually recovered it: more Enters than Escs.
      const enterCount = sessionManager.writes.filter((data) => data === '\r').length;
      expect(enterCount).toBeGreaterThan(1);
      // And the double-Esc line-wipe never happened.
      expect(sessionManager.tui.escClearedBuffer).toBe(false);
      sessionManager.dispose();
    });

    it('reports failed, and never writes Ctrl+C, when retries are exhausted', async () => {
      // On exhaustion the old code fired Ctrl+C into the live session. If the
      // command HAD submitted and verification merely lagged, that killed the
      // turn it just started - and it was the only path that could produce two
      // consecutive Ctrl+C presses and exit the CLI.
      const { submit, sessionManager } = makeSubmit();
      const verifier: CommandVerifier = async () => false;

      const result = await submit.submitKeystrokes(
        SESSION_ID,
        [{ text: '/code-review', verify: 'submitted' }],
        { verifier },
      );

      expect(result.outcome).toBe('failed');
      expect(result.unconfirmedCommands).toEqual(['/code-review']);
      const clearWrites = sessionManager.writes.filter((data) => data === '\x15');
      expect(clearWrites).toHaveLength(1); // the deliberate leading clear only
      expect(sessionManager.tui.maxConsecutiveEmptyCtrlC).toBeLessThan(2);
      sessionManager.dispose();
    }, 20_000);
  });

  /**
   * The #682 shape: the command DID submit on the first Enter, but the
   * transcript only shows it later than the first attempt's window. Claude
   * stamps the turn at submit and flushes the JSONL ~780ms or ~1830ms after
   * (docs/architecture/automations/command-injection-measurements.md, "Measured flush latency"). Four of four
   * observed live skill injections were reported `failed` and then re-run by
   * the escalation restart.
   */
  describe('late transcript flush', () => {
    const enterCount = (sessionManager: SimulatedSessionManager): number =>
      sessionManager.writes.filter((data) => data === '\r').length;

    it('confirms on a later attempt when the entry flushes after the first window', async () => {
      // 900ms: past the first 400ms window, inside the third. The stamp is
      // the submit time, so a watermark advanced to the second Enter would
      // already be past it and every later attempt would return false at the
      // watermark - which is what shipped.
      const { submit, sessionManager } = makeSubmit();
      const verifier = createSubmissionVerifier(sessionManager.tui, { flushDelayMs: 900 });

      const result = await submit.submitKeystrokes(
        SESSION_ID,
        [{ text: '/merge-pull-request', verify: 'submitted' }],
        { verifier },
      );

      expect(result.outcome).toBe('confirmed');
      expect(result.unconfirmedCommands).toEqual([]);
      // Exactly one real submission: the retry Enters landed on an empty
      // prompt and submitted nothing.
      expect(sessionManager.tui.submissions.map((entry) => entry.text)).toEqual(['/merge-pull-request']);
      // The watermark the burst reports is the first Enter, the one that
      // produced the submission, not the retry that happened to see it.
      expect(result.deliveries).toHaveLength(1);
      const [delivery] = result.deliveries;
      expect(delivery.text).toBe('/merge-pull-request');
      expect(delivery.confirmed).toBe(true);
      const firstSentAt = delivery.firstSentAt ?? Number.NaN;
      expect(sessionManager.tui.submissions[0].at - firstSentAt).toBeGreaterThanOrEqual(0);
      expect(sessionManager.tui.submissions[0].at - firstSentAt).toBeLessThan(150);
      sessionManager.dispose();
    }, 20_000);

    it('confirms inside the trailing grace, without a sixth Enter, when the flush outlasts every retry', async () => {
      // 2300ms: past all five 400ms windows (the slow flush mode plus a skill
      // expansion). The grace polls without pressing.
      const { submit, sessionManager } = makeSubmit();
      const verifier = createSubmissionVerifier(sessionManager.tui, { flushDelayMs: 2300 });

      const result = await submit.submitKeystrokes(
        SESSION_ID,
        [{ text: '/merge-pull-request', verify: 'submitted' }],
        { verifier },
      );

      expect(result.outcome).toBe('confirmed');
      expect(enterCount(sessionManager)).toBe(5);
      expect(sessionManager.tui.submissions.map((entry) => entry.text)).toEqual(['/merge-pull-request']);
      sessionManager.dispose();
    }, 20_000);

    it('still reports failed, after the grace, when every Enter was genuinely swallowed', async () => {
      // The negative that keeps rung 3 reachable: nothing ever submitted, so
      // no watermark and no grace can conjure a confirmation, and the
      // scheduler must still be told to restart.
      const { submit, sessionManager } = makeSubmit({ eatEnterCount: 5 });
      const verifier = createSubmissionVerifier(sessionManager.tui);

      const result = await submit.submitKeystrokes(
        SESSION_ID,
        [{ text: '/merge-pull-request', verify: 'submitted' }],
        { verifier },
      );

      expect(result.outcome).toBe('failed');
      expect(result.unconfirmedCommands).toEqual(['/merge-pull-request']);
      expect(result.deliveries).toEqual([
        { text: '/merge-pull-request', firstSentAt: expect.any(Number), confirmed: false },
      ]);
      expect(enterCount(sessionManager)).toBe(5);
      expect(sessionManager.tui.submissions).toEqual([]);
      sessionManager.dispose();
    }, 20_000);

    it('keeps one delivery record per command, so two identical commands in a burst do not collide', async () => {
      // A record keyed by text would let the second command overwrite the
      // first's watermark. Positional records keep both, each with its own
      // first Enter, in delivery order.
      const { submit, sessionManager } = makeSubmit();
      const verifier = createSubmissionVerifier(sessionManager.tui);

      const result = await submit.submitKeystrokes(
        SESSION_ID,
        [{ text: '/hello', verify: 'submitted' }, { text: '/hello', verify: 'submitted' }],
        { verifier },
      );

      expect(result.outcome).toBe('confirmed');
      expect(result.deliveries.map((delivery) => delivery.text)).toEqual(['/hello', '/hello']);
      expect(result.deliveries.every((delivery) => delivery.confirmed)).toBe(true);
      const [first, second] = result.deliveries;
      expect(first.firstSentAt).not.toBeNull();
      expect(second.firstSentAt).not.toBeNull();
      expect((second.firstSentAt ?? 0) > (first.firstSentAt ?? 0)).toBe(true);
      sessionManager.dispose();
    }, 20_000);
  });

  /**
   * The automated-keys guard (`automated-keys-guard.ts`) and the prompt hook.
   * A permission prompt takes typed keys as its answer, so nothing goes in
   * while the session reports one, or a tool call with no end. And under load
   * the prompt hook can land before the transcript does.
   */
  describe('automated keys guard and the prompt hook', () => {
    it('types nothing while the session cannot take keys, then delivers once it clears', async () => {
      const { submit, sessionManager } = makeSubmit();
      sessionManager.keysBlocker = 'a permission prompt is open';
      const delivery = submit.submitKeystrokes(SESSION_ID, ['carry on']);

      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(sessionManager.writes).toEqual([]);

      sessionManager.setKeysBlocker(null);
      const result = await delivery;
      expect(result.outcome).toBe('unconfirmed');
      expect(sessionManager.writes).toContain('carry on');
      sessionManager.dispose();
    });

    it('never presses Enter while a prompt that opened mid-burst is on screen', async () => {
      // The text is typed, then the session reports a tool call with no end
      // before the Enter: the Enter waits, and the abort ends the burst with
      // no Enter at all.
      const { submit, sessionManager } = makeSubmit();
      const controller = new AbortController();
      const typed = new Promise<void>((resolve) => {
        sessionManager.on('data-tap', () => {
          if (sessionManager.writes.includes('carry on') && sessionManager.keysBlocker === null) {
            sessionManager.keysBlocker = 'the Artifact tool call has not ended';
            resolve();
          }
        });
      });
      const delivery = submit.submitKeystrokes(SESSION_ID, ['carry on'], { signal: controller.signal });
      await typed;
      await new Promise((resolve) => setTimeout(resolve, 300));
      controller.abort();

      const result = await delivery;
      expect(result.outcome).toBe('aborted');
      expect(sessionManager.writes).not.toContain('\r');
      sessionManager.dispose();
    });

    it('confirms a submitted message from the prompt hook when the transcript is slow', async () => {
      // One overnight nudge's prompt hook landed 3.1 s after its Enter, before
      // the transcript, and the delivery was logged as a failure.
      const { submit, sessionManager } = makeSubmit();
      const verifier: CommandVerifier = async () => false;
      sessionManager.on('data-tap', () => {
        if (sessionManager.writes.includes('\r')) {
          sessionManager.emit('event', SESSION_ID, { ts: Date.now(), type: EventType.Prompt });
        }
      });

      const result = await submit.submitKeystrokes(SESSION_ID, [{ text: 'carry on', verify: 'submitted' }], { verifier });

      expect(result.outcome).toBe('confirmed');
      expect(sessionManager.writes.filter((data) => data === '\r')).toHaveLength(1);
      sessionManager.dispose();
    }, 20_000);

    it('does not take the prompt hook for a command the adapter emits itself', async () => {
      // `command-match` must match exactly in the transcript: a hook says a
      // prompt landed, not that it was this command with these arguments.
      const { submit, sessionManager } = makeSubmit();
      const verifier: CommandVerifier = async () => false;
      sessionManager.on('data-tap', () => {
        if (sessionManager.writes.includes('\r')) {
          sessionManager.emit('event', SESSION_ID, { ts: Date.now(), type: EventType.Prompt });
        }
      });

      const result = await submit.submitKeystrokes(SESSION_ID, [{ text: '/effort high', verify: 'command-match' }], { verifier });

      expect(result.outcome).toBe('failed');
      sessionManager.dispose();
    }, 30_000);

    it('reports an Enter that landed on a prompt the app had not heard of yet, and presses no more', async () => {
      // The prompt's hook arrives after the Enter, dated before it, and no
      // prompt of ours follows: the Enter most likely answered the prompt.
      const { submit, sessionManager } = makeSubmit();
      const verifier: CommandVerifier = async () => false;
      let raised = false;
      sessionManager.on('data-tap', () => {
        if (!raised && sessionManager.writes.includes('\r')) {
          raised = true;
          sessionManager.emit('event', SESSION_ID, { ts: Date.now() - 50, type: EventType.Idle, detail: IdleReason.Permission });
        }
      });

      const result = await submit.submitKeystrokes(SESSION_ID, [{ text: 'carry on', verify: 'submitted' }], { verifier });

      expect(result.reachedPermissionPrompt).toBe(true);
      expect(result.outcome).toBe('failed');
      expect(sessionManager.writes.filter((data) => data === '\r')).toHaveLength(1);
      sessionManager.dispose();
    }, 20_000);
  });

  /**
   * Scenarios that sit through production's long poll-only windows (the 2 s
   * late-flush grace plus the 8 s passive-evidence window, about 12 s of real
   * time per burst) or that need a hold to stay held. They drive the same
   * simulated TUI on a fake clock: the simulator's timers and its `Date.now()`
   * stamps are faked together with the burst's own, so the handshake still
   * reacts to bytes the simulated TUI emits and no assertion waits on the wall
   * clock.
   */
  describe('on a fake clock', () => {
    const simulatedManagers: SimulatedSessionManager[] = [];

    /** Advance the fake clock in small steps until `promise` settles, so every timer fires in order. */
    async function runToCompletion<Value>(promise: Promise<Value>, budgetMs = 60_000): Promise<Value> {
      let settled = false;
      void promise.then(
        () => { settled = true; },
        () => { settled = true; },
      );
      for (let elapsedMs = 0; elapsedMs < budgetMs && !settled; elapsedMs += 25) {
        await vi.advanceTimersByTimeAsync(25);
      }
      if (!settled) throw new Error(`the burst was still pending after ${budgetMs} ms of fake time`);
      return promise;
    }

    /** Run `callback` synchronously right after the `enterNumber`th Enter is written. */
    function onEnterWrite(sessionManager: SimulatedSessionManager, enterNumber: number, callback: () => void): void {
      const originalWrite = sessionManager.write.bind(sessionManager);
      let enterCount = 0;
      sessionManager.write = (writeSessionId: string, data: string): void => {
        originalWrite(writeSessionId, data);
        if (data !== '\r') return;
        enterCount += 1;
        if (enterCount === enterNumber) callback();
      };
    }

    function countEnters(sessionManager: SimulatedSessionManager): number {
      return sessionManager.writes.filter((data) => data === '\r').length;
    }

    function makeClockedSubmit(): ReturnType<typeof makeSubmit> {
      const made = makeSubmit();
      simulatedManagers.push(made.sessionManager);
      return made;
    }

    beforeEach(() => {
      vi.useFakeTimers();
      vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      for (const manager of simulatedManagers.splice(0)) manager.dispose();
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    describe('the keys guard between the Esc and the Enter', () => {
      const PROMPT_OPEN = 'a permission prompt is open';
      const slashCommand = [{ text: '/test', verify: 'none' as const }];
      const keysTypedBeforeTheEnter = ['\x15', '/test', '\x1b'];

      /**
       * A prompt that opens while the Esc is in flight: after the clearance
       * check that precedes the Esc, before the one that precedes the Enter.
       * An Enter typed into it would answer it as yes.
       */
      function openPromptWhenEscIsWritten(sessionManager: SimulatedSessionManager): void {
        const originalWrite = sessionManager.write.bind(sessionManager);
        sessionManager.write = (writeSessionId: string, data: string): void => {
          originalWrite(writeSessionId, data);
          if (data === '\x1b') sessionManager.keysBlocker = PROMPT_OPEN;
        };
      }

      it('writes no Enter, and ends aborted when cancelled, if a prompt opens while the Esc settles', async () => {
        const { submit, sessionManager } = makeClockedSubmit();
        openPromptWhenEscIsWritten(sessionManager);
        const controller = new AbortController();
        const delivery = submit.submitKeystrokes(SESSION_ID, slashCommand, { signal: controller.signal, source: 'test' });

        // Well past the 400 ms Esc settle cap and the Enter's own drain: an
        // Enter that skipped the second clearance check would be written by now.
        await vi.advanceTimersByTimeAsync(5_000);
        expect(sessionManager.writes).toEqual(keysTypedBeforeTheEnter);

        controller.abort();
        const result = await runToCompletion(delivery);

        expect(result.outcome).toBe('aborted');
        expect(sessionManager.writes).toEqual(keysTypedBeforeTheEnter);
        // The Enter was never pressed, so the command carries no watermark.
        expect(result.deliveries).toEqual([{ text: '/test', firstSentAt: null, confirmed: false }]);
      });

      it('returns failed with heldBy naming the exit, and no Enter, if the session exits while the Enter waits on the prompt', async () => {
        const { submit, sessionManager } = makeClockedSubmit();
        openPromptWhenEscIsWritten(sessionManager);
        const delivery = submit.submitKeystrokes(SESSION_ID, slashCommand, { source: 'test' });

        await vi.advanceTimersByTimeAsync(5_000);
        expect(sessionManager.writes).toEqual(keysTypedBeforeTheEnter);

        sessionManager.emit('exit', SESSION_ID);
        const result = await runToCompletion(delivery);

        expect(result.outcome).toBe('failed');
        expect(result.heldBy).toBe('the session exited');
        expect(result.unconfirmedCommands).toEqual(['/test']);
        expect(result.deliveries).toEqual([{ text: '/test', firstSentAt: null, confirmed: false }]);
        expect(sessionManager.writes).toEqual(keysTypedBeforeTheEnter);
        // It was the check after the Esc that held the burst, not the one before it.
        const warnings = vi.mocked(console.warn).mock.calls.map((call) => String(call[0]));
        expect(warnings).toEqual([expect.stringContaining('held before Enter')]);
      });

      it('presses the Enter once the prompt has closed, so a hold delays the command and never drops it', async () => {
        const { submit, sessionManager } = makeClockedSubmit();
        openPromptWhenEscIsWritten(sessionManager);
        const delivery = submit.submitKeystrokes(SESSION_ID, slashCommand, { source: 'test' });

        await vi.advanceTimersByTimeAsync(5_000);
        expect(sessionManager.writes).toEqual(keysTypedBeforeTheEnter);

        sessionManager.setKeysBlocker(null);
        const result = await runToCompletion(delivery);

        expect(result.heldBy).toBeUndefined();
        expect(result.outcome).toBe('unconfirmed');
        expect(sessionManager.writes).toEqual([...keysTypedBeforeTheEnter, '\r']);
        expect(result.deliveries[0].firstSentAt).not.toBeNull();
      });
    });

    it('returns failed with heldBy naming the exit, having typed nothing, when the session exits while the burst is held', async () => {
      const { submit, sessionManager } = makeClockedSubmit();
      sessionManager.keysBlocker = 'a tool call has not ended';
      const verifier = vi.fn<CommandVerifier>(async () => true);
      const delivery = submit.submitKeystrokes(
        SESSION_ID,
        [{ text: 'carry on', verify: 'submitted' }],
        { verifier, source: 'test' },
      );

      await vi.advanceTimersByTimeAsync(1_000);
      expect(sessionManager.writes).toEqual([]);

      sessionManager.emit('exit', SESSION_ID);
      const result = await runToCompletion(delivery);

      expect(result).toMatchObject({
        outcome: 'failed',
        heldBy: 'the session exited',
        unconfirmedCommands: ['carry on'],
        deliveries: [],
        discardedDraft: null,
        interruptedTurn: false,
      });
      expect(sessionManager.writes).toEqual([]);
      expect(verifier).not.toHaveBeenCalled();
    });

    describe('the prompt hook as evidence of a submission', () => {
      /** The transcript never shows the command, so only a hook can confirm it. */
      const neverInTranscript: CommandVerifier = async () => false;
      const submittedMessage = [{ text: 'carry on', verify: 'submitted' as const }];

      it('still confirms from a prompt hook that lands after the late-flush grace but inside the passive window', async () => {
        const { submit, sessionManager } = makeClockedSubmit();
        // The fifth Enter ends the retries: one more 400 ms poll, then 2000 ms
        // of late-flush grace, then the 8000 ms passive window. Five seconds
        // after the fifth Enter is past the 2.4 s a late-flush grace alone
        // would have watched and well inside the window that follows it.
        onEnterWrite(sessionManager, 5, () => {
          setTimeout(() => {
            sessionManager.emit('event', SESSION_ID, { ts: Date.now(), type: EventType.Prompt });
          }, 5_000);
        });

        const result = await runToCompletion(
          submit.submitKeystrokes(SESSION_ID, submittedMessage, { verifier: neverInTranscript }),
        );

        expect(result.outcome).toBe('confirmed');
        expect(result.unconfirmedCommands).toEqual([]);
        expect(result.deliveries).toEqual([{ text: 'carry on', firstSentAt: expect.any(Number), confirmed: true }]);
        // The window only watches. It never presses a sixth Enter.
        expect(countEnters(sessionManager)).toBe(5);
      });

      it.each<{ label: string; hookSessionId: string; detail: string | undefined; expectedOutcome: SubmitKeystrokesResult['outcome'] }>([
        { label: 'a genuine prompt hook from the burst session', hookSessionId: SESSION_ID, detail: undefined, expectedOutcome: 'confirmed' },
        { label: 'a synthetic pty-activity prompt', hookSessionId: SESSION_ID, detail: PromptReason.PtyActivity, expectedOutcome: 'failed' },
        { label: 'a prompt hook from another session', hookSessionId: 'other-session', detail: undefined, expectedOutcome: 'failed' },
      ])('takes $label as $expectedOutcome', async ({ hookSessionId, detail, expectedOutcome }) => {
        // The first row is the control: the same harness, a hook the burst may
        // trust. The other two must not confirm. A pty-activity prompt is the
        // tracker inferring a prompt from output, and another session's hook
        // says nothing about this prompt.
        const { submit, sessionManager } = makeClockedSubmit();
        onEnterWrite(sessionManager, 1, () => {
          sessionManager.emit('event', hookSessionId, {
            ts: Date.now(),
            type: EventType.Prompt,
            ...(detail === undefined ? {} : { detail }),
          });
        });

        const result = await runToCompletion(
          submit.submitKeystrokes(SESSION_ID, submittedMessage, { verifier: neverInTranscript }),
        );

        expect(result.outcome).toBe(expectedOutcome);
        expect(result.unconfirmedCommands).toEqual(expectedOutcome === 'confirmed' ? [] : ['carry on']);
      });

      it.each<{
        label: string;
        options: SubmitKeystrokesOptions;
        expectedOutcome: SubmitKeystrokesResult['outcome'];
        expectedEnters: number;
      }>([
        { label: 'a warm session that clears a draft off the prompt', options: { pendingDraft: 'instead can we' }, expectedOutcome: 'confirmed', expectedEnters: 1 },
        { label: 'a fresh spawn with an empty prompt', options: { freshlySpawned: true }, expectedOutcome: 'confirmed', expectedEnters: 1 },
        { label: 'a user draft left in the prompt', options: { sendCtrlC: false, pendingDraft: 'instead can we' }, expectedOutcome: 'failed', expectedEnters: 5 },
      ])('lets a prompt hook alone confirm only when nothing else sat in the prompt: $label is $expectedOutcome', async ({ options, expectedOutcome, expectedEnters }) => {
        // A hook says a prompt was submitted, not whose text it was. After a
        // clear, or on a fresh spawn with no draft, the only text in the prompt
        // is ours. With a draft left in place the submitted prompt is the draft
        // glued to our text, so the hook proves nothing about our message and
        // the burst keeps retrying, then reports it unconfirmed.
        const { submit, sessionManager } = makeClockedSubmit();
        if (options.pendingDraft) sessionManager.tui.setDraft(options.pendingDraft);
        onEnterWrite(sessionManager, 1, () => {
          sessionManager.emit('event', SESSION_ID, { ts: Date.now(), type: EventType.Prompt });
        });

        const result = await runToCompletion(
          submit.submitKeystrokes(SESSION_ID, submittedMessage, { ...options, verifier: neverInTranscript }),
        );

        expect(result.outcome).toBe(expectedOutcome);
        expect(countEnters(sessionManager)).toBe(expectedEnters);
        expect(result.deliveries.map((delivery) => delivery.confirmed)).toEqual([expectedOutcome === 'confirmed']);
      });
    });
  });
});
