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
import { describe, it, expect } from 'vitest';
import { TerminalSubmit, type CommandVerifier } from '../../src/main/pty/terminal-submit';
import type { PasteEngine, PasteOptions } from '../../src/main/pty/paste-engine';
import type { SessionManager } from '../../src/main/pty/session-manager';
import {
  SimulatedSessionManager,
  DEFAULT_TUI_OPTIONS,
  createStubPasteEngine,
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
});
