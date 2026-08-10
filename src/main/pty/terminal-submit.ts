import type { SessionManager } from './session-manager';
import type { PasteEngine, PasteOptions } from './paste-engine';
import { sanitizeForPty } from '../../shared/paths';
import { waitForOutputSettle } from './output-settle';

/**
 * Re-export the PasteEngine error class so callers (`browser.ts`) can catch
 * specific submission failures without reaching into `pty/paste-engine.ts`
 * directly. PasteEngine is an implementation detail of TerminalSubmit; this
 * is the only public symbol it exposes.
 */
export { PasteSubmitError } from './paste-engine';

/**
 * How strongly a single command's delivery can be confirmed.
 *
 * - `command-match` the adapter emitted this itself (`/effort xhigh`), so the
 *   transcript must contain a discrete invocation with exactly these args.
 *   Rejecting a combined-args entry is the point: that is how a swallowed
 *   Enter is detected.
 * - `submitted` a user-supplied auto_command. We cannot require it to parse
 *   as a registered slash command (it may be plain prose, or an unregistered
 *   `/foo`), only that EXACTLY this text became a user turn. Strictly weaker
 *   than `command-match`, so it is always available.
 * - `none` this adapter exposes no transcript verifier. Delivery ends
 *   `unconfirmed`; it is never reported as confirmed.
 *
 * This replaces the old `verifiedPrefixLength`, which could only express one
 * semantic for a whole burst and therefore had to leave the user's
 * auto_command unverified entirely.
 */
export type InjectionVerifyMode = 'command-match' | 'submitted' | 'none';

/** One command plus how its delivery may be confirmed. */
export interface InjectionCommand {
  text: string;
  verify: InjectionVerifyMode;
  /**
   * Whether a verification FAILURE on this command may escalate to a restart.
   * Omitted or true means yes.
   *
   * This exists to separate the two things a verifier does, because they carry
   * very different risk. A verifier that returns false drives retry-on-Enter
   * (rung 2), which is pure upside: it recovers a submission a picker swallowed
   * and is what closes the measured 92.9% -> 100% delivery gap. Exhausting the
   * retries then escalates to a session restart (rung 3), which DESTROYS live
   * work if the verifier was wrong.
   *
   * An adapter that has not proven its verifier end to end can therefore be
   * given a CONFIRM-ONLY verifier: it confirms and it retries, but it is never
   * allowed to authorize the restart. Set from
   * `AgentAdapter.canEscalateOnVerificationFailure`.
   */
  escalatable?: boolean;
}

/**
 * Per-command verifier polled by `submitKeystrokes` after each Enter.
 * Returns true when the agent's transcript confirms the command was
 * processed. Adapters supply this via `getSubmissionVerifier('command-injection')`.
 *
 * Defined here so `terminal-submit-scheduler` (the lifecycle wrapper),
 * `injection-plan` (the builder), and `slash-command-verifier` (the impl)
 * can all import from one place.
 */
export type CommandVerifier = (
  command: string,
  sentAt: number,
  mode: InjectionVerifyMode,
) => Promise<boolean>;

/**
 * Free-form-content delivery options. Forwarded verbatim to PasteEngine.
 * Re-exported here as the public shape for `submitContent` callers.
 */
export type SubmitContentOptions = PasteOptions;

/** Terminal state of one `submitKeystrokes` call. */
export type InjectionOutcome = 'confirmed' | 'unconfirmed' | 'failed' | 'aborted';

export interface SubmitKeystrokesResult {
  /**
   * `confirmed`   every verifiable command was seen in the transcript.
   * `unconfirmed` nothing could be checked (adapter has no verifier). NOT a
   *               failure, and deliberately distinguished: 11 of 12 adapters
   *               are in this bucket, so conflating it with `failed` would
   *               make the outcome meaningless off Claude.
   * `failed`      a verifiable command exhausted its retries.
   * `aborted`     cancelled mid-burst.
   */
  outcome: InjectionOutcome;
  /** Commands that were verifiable but never confirmed. */
  unconfirmedCommands: string[];
  /** User draft cleared off the prompt, if the caller told us about one. */
  discardedDraft: string | null;
  /**
   * True when delivery interrupted a live turn. Always false since the clear
   * became Ctrl+U: injection is now non-destructive by construction, and a
   * command sent mid-turn is queued by the CLI rather than cutting it off.
   */
  interruptedTurn: boolean;
}

/** Manual-keystroke delivery options. */
export interface SubmitKeystrokesOptions {
  /**
   * Explicit override for the leading clear. When unset the policy is
   * derived (see `shouldClearPrompt`): clear unless this is a fresh spawn
   * with no known draft.
   */
  sendCtrlC?: boolean;
  /**
   * True when the CLI was just spawned. At SPAWN time its prompt is empty by
   * construction, so the clear has nothing to do and sending it only adds a
   * keystroke that historically landed mid-render on Windows ConPTY (the
   * `</task>/test` glue bug). Note this is not the same as "empty at DELIVERY
   * time": fresh-spawn delivery is deferred, and a user can type during the
   * wait, which is what `pendingDraft` exists to catch.
   */
  freshlySpawned?: boolean;
  /**
   * Text the session's draft ledger believes is sitting unsubmitted in the
   * prompt. Used for two things: forcing a clear on a fresh-spawn delivery
   * where the user typed during the wait, and reporting what was discarded.
   */
  pendingDraft?: string | null;
  /** True when the agent is mid-turn, so the clear is a deliberate interrupt. */
  interruptingTurn?: boolean;
  /** Per-command verifier; commands with `verify: 'none'` skip it. */
  verifier?: CommandVerifier | null;
  /**
   * Caller cancellation. The current write/wait stops; previous writes have
   * already been queued through `sessionManager.write` and cannot be
   * un-pushed. Aborting between commands is the typical cancellation point.
   */
  signal?: AbortSignal;
  /** Diagnostic label for `[terminal-submit]` log lines. */
  source?: string;
}

/** Settle tuning. These are CAPS on a handshake, not the mechanism.
 *
 *  The old code slept a flat 100ms between keypresses, sized against the
 *  worst observed Ink picker render. That is correct on an idle machine and
 *  wrong on a busy one, which is precisely why delivery degraded under load:
 *  when the picker took longer than 100ms, the Esc landed before it mounted
 *  (a no-op), the picker then rendered, and it ate the Enter. Waiting for the
 *  render itself is fast when the machine is fast and patient when it is not.
 */
const SETTLE_IDLE_MS = 150;
/**
 * Idle window after typing a SLASH command, before the Esc that dismisses the
 * picker. Longer than the general one because the picker mounts a beat after
 * the text echoes, and Esc is only sent once now - so it has to land on a
 * picker that already exists.
 */
const SLASH_PICKER_IDLE_MS = 400;
const SETTLE_CAP_MS = 1200;
/** Bound on the post-Enter wait when nothing can be verified. */
const UNVERIFIED_SETTLE_CAP_MS = 800;
const VERIFY_POLL_MS = 25;
const VERIFY_WINDOW_MS = 400;
const MAX_SUBMIT_ATTEMPTS = 5;
/**
 * Cap on the wait between Esc and the Enter that follows it.
 *
 * This is a HANDSHAKE, not a gap, and the distinction is the whole point.
 * `\x1b` and `\r` arriving in one read is the terminal's Meta encoding, so the
 * TUI receives Alt+Enter (insert a newline) instead of Esc-then-Enter. What
 * decides whether they coalesce is when the CHILD reads stdin, not when we
 * write: a busy Ink app mid-render can leave both bytes sitting in the pipe and
 * read them together no matter how long we waited between writes.
 *
 * A fixed delay was tried first and observed to fail live for exactly that
 * reason - it works when the TUI is idle and stops working when it is busy,
 * which is the same defect as the original flat 100ms sleep. Waiting for the
 * Esc's own repaint proves the child has read it, and adapts: fast when the
 * TUI is fast, patient when it is not. The cap only bounds a silent TUI.
 */
const ESC_SETTLE_CAP_MS = 400;
/**
 * Ctrl+U: clear the input line.
 *
 * Claude Code's own docs name this as the way to clear input ("Up arrow to edit
 * queued messages or Ctrl+U to clear the input line"). It replaced Ctrl+C,
 * which means CANCEL there and EXITS the CLI when pressed twice, and which did
 * not reliably clear a draft - the failure that produced
 * `Tell me about 10 planets with details/merge-pull-request`.
 *
 * Being a line-editing key rather than a signal, it also leaves a running turn
 * alone, which is what makes immediate-mode injection non-destructive.
 */
const CLEAR_LINE = '\x15';

/**
 * `TerminalSubmit` is the byte-pushing engine for getting user-facing text
 * into a PTY session. Two methods, two strategies:
 *
 * - **submitContent**: bracketed-paste delivery for free-form content (URLs,
 *   prompts, attachments). The TUI receives the text as a single paste event
 *   so special characters do not trigger key handlers. Browser-pane Send and
 *   future content-delivery paths use this.
 *
 * - **submitKeystrokes**: manual `clear? -> text -> Esc? -> Enter` keystroke
 *   sequence for slash commands and anything the TUI must interpret.
 *   `auto_command`, `/effort`, and `send_command` actions all use this.
 *
 * The two strategies are NOT interchangeable - bracket-pasting `/test` makes
 * the TUI treat it as literal text (slash-command parser never fires), and
 * sending a 2KB URL as keystrokes takes ~80 seconds and trips key handlers.
 * Callers must pick the right method for their content type.
 *
 * PROMPT-STATE POLICY LIVES HERE, not in the scheduler, because
 * `send_command` (transition-engine) and the Command Terminal call this
 * method directly and bypass the scheduler entirely. Policy at the byte layer
 * is policy everywhere.
 */
export class TerminalSubmit {
  constructor(
    private sessionManager: SessionManager,
    private pasteEngine: PasteEngine,
  ) {}

  /**
   * Bracketed-paste delivery for free-form content. Delegates to PasteEngine
   * which handles drain -> chunked write -> output settle -> \r -> submission
   * evidence with retry. See `paste-engine.ts` for the underlying algorithm
   * and timing tunables.
   */
  async submitContent(
    sessionId: string,
    text: string,
    opts: SubmitContentOptions = {},
  ): Promise<void> {
    return this.pasteEngine.pasteAndSubmit(sessionId, text, opts);
  }

  /**
   * Deliver one or more commands as keystrokes.
   *
   * Each command is sanitized, then delivered as a handshake chain rather
   * than a timed sequence: every write is followed by a queue drain (so the
   * wait is measured from the PTY, not from the enqueue) and an output settle
   * (so the next keystroke lands after the TUI has actually rendered).
   *
   * Escape is sent ONLY for `/`-prefixed commands. Its job is dismissing the
   * slash-command picker, which only opens for a slash; on a plain-prose
   * command no picker exists and Esc is not a no-op on Claude Code's prompt,
   * so sending it there risks clearing the very text we just typed.
   *
   * When a command is verifiable and confirmation does not arrive, the retry
   * re-presses Enter ALONE. Esc is not repeated: Claude Code documents it as
   * "stop Claude while it is generating output", and on a non-empty prompt with
   * no picker the first press prints "Esc again to clear", so a second one would
   * delete the very command being submitted. See the attempt loop below.
   *
   * On exhaustion we do NOT write Ctrl+C. If the command actually did submit
   * and verification merely lagged, that Ctrl+C would kill the turn it just
   * started; it is also the only path that could produce two consecutive
   * Ctrl+C presses and exit the CLI. Exhaustion is reported instead, and the
   * scheduler escalates.
   */
  async submitKeystrokes(
    sessionId: string,
    commands: ReadonlyArray<string | InjectionCommand>,
    opts: SubmitKeystrokesOptions = {},
  ): Promise<SubmitKeystrokesResult> {
    const sanitized = normalizeCommands(commands);
    const source = opts.source ?? 'unknown';
    const pendingDraft = opts.pendingDraft && opts.pendingDraft.length > 0 ? opts.pendingDraft : null;

    if (sanitized.length === 0) {
      return { outcome: 'unconfirmed', unconfirmedCommands: [], discardedDraft: null, interruptedTurn: false };
    }

    const verifier = opts.verifier ?? null;
    const signal = opts.signal ?? new AbortController().signal;
    const shouldClear = shouldClearPrompt(opts, pendingDraft);
    const unconfirmedCommands: string[] = [];
    let sawVerifiable = false;
    let sawFailure = false;

    try {
      if (shouldClear) {
        // Ctrl+U, the documented "clear the input line" key, NOT Ctrl+C.
        //
        // Claude Code's docs are explicit: "Users can now use the Up arrow to
        // edit queued messages or Ctrl+U to clear the input line." Ctrl+C means
        // CANCEL there, and two of them exit the CLI outright - so the old
        // `\x03` was both unreliable at the job we wanted (a draft survived it,
        // and the auto_command glued onto it: `Tell me about 10 planets with
        // details/merge-pull-request`) and dangerous when it did land twice.
        //
        // Ctrl+U is also a line-editing key rather than a control signal, so it
        // does NOT interrupt a running turn. That is what lets immediate mode
        // clear a stale draft without disturbing the agent mid-response.
        this.sessionManager.write(sessionId, CLEAR_LINE);
        await this.settleAfterWrite(sessionId, signal, SETTLE_CAP_MS);
      }

      for (const command of sanitized) {
        const isSlashCommand = command.text.startsWith('/');
        const canVerify = verifier !== null && command.verify !== 'none';
        if (canVerify) sawVerifiable = true;

        this.sessionManager.write(sessionId, command.text);
        // A slash command gets a longer idle window, because the thing we are
        // waiting for is the PICKER, and it mounts a beat after the keystrokes
        // echo. At the ordinary 150ms idle the settle returns on the text's own
        // repaint, the single Esc then lands before the picker exists (a no-op),
        // and the picker eats the Enter - with Esc now sent at most once there
        // is no second chance to clear it. Waiting for a longer quiet period
        // catches the picker's own mount repaint and extends again if more
        // arrives, so it stays a handshake rather than a fixed sleep.
        await this.settleAfterWrite(
          sessionId,
          signal,
          SETTLE_CAP_MS,
          isSlashCommand ? SLASH_PICKER_IDLE_MS : SETTLE_IDLE_MS,
        );

        let confirmed = false;
        for (let attempt = 0; attempt < MAX_SUBMIT_ATTEMPTS; attempt++) {
          // Esc dismisses the slash picker, but it is NOT a picker-scoped key -
          // Claude Code documents it as "stop Claude while it is generating
          // output". Two consequences, and both were live bugs:
          //
          //   1. Never send it while a turn is running. Dismissing a picker
          //      would silently interrupt the agent, which is precisely the
          //      "editing a message already in flight" behaviour immediate mode
          //      must avoid. Immediate mode does not need it anyway: a message
          //      submitted mid-turn is QUEUED by the CLI and runs after.
          //   2. Never send it twice. On a non-empty prompt with no picker, the
          //      first Esc prints "Esc again to clear" - so a second one CLEARS
          //      the command we just typed. Retrying with Esc would delete the
          //      very text it is trying to submit.
          //
          // Hence: at most once, on the first attempt, and only when we are not
          // sitting on a live turn. Retries send Enter alone.
          const sendEsc = isSlashCommand && attempt === 0 && !opts.interruptingTurn;
          if (sendEsc) {
            // Wait for the Esc's own repaint before Enter. `\x1b` followed by
            // `\r` in ONE read is the Meta prefix, so the TUI would receive
            // Alt+Enter (insert a newline) instead of Esc-then-Enter. What
            // decides that is when the CHILD reads stdin, not when we write, so
            // neither `drain()` nor a fixed delay is sufficient - both were
            // tried and both failed on a busy TUI. Settling proves the child
            // consumed the Esc, which is the actual precondition.
            this.sessionManager.write(sessionId, '\x1b');
            await this.settleAfterWrite(sessionId, signal, ESC_SETTLE_CAP_MS);
          }

          const sentAt = Date.now();
          this.sessionManager.write(sessionId, '\r');
          await this.sessionManager.drain(sessionId);

          if (!canVerify || !verifier) break;

          confirmed = await this.pollForConfirmation(verifier, command, sentAt, signal);
          if (confirmed) break;
        }

        if (canVerify) {
          if (!confirmed) {
            unconfirmedCommands.push(command.text);
            sawFailure = true;
            console.warn(
              `[terminal-submit] ${source}: "${command.text}" unconfirmed after ${MAX_SUBMIT_ATTEMPTS} attempts`,
            );
          }
        } else {
          // Nothing to check against; give the TUI a bounded moment so a
          // following command does not race this one's render.
          await this.settleAfterWrite(sessionId, signal, UNVERIFIED_SETTLE_CAP_MS);
        }
      }

      const outcome: InjectionOutcome = sawFailure ? 'failed' : sawVerifiable ? 'confirmed' : 'unconfirmed';
      console.log(
        `[terminal-submit] ${source}: ${outcome} - delivered ${sanitized.length} command(s) to ` +
          `session ${sessionId.slice(0, 8)}: ${sanitized.map((entry) => entry.text).join(' | ')}`,
      );
      return {
        outcome,
        unconfirmedCommands,
        discardedDraft: shouldClear ? pendingDraft : null,
        // Always false now: the clear is Ctrl+U (line editing), which leaves a
        // running turn alone, and Esc is suppressed while a turn is live. The
        // field stays so the outcome notice keeps a slot for a genuine
        // interruption if one is ever reintroduced deliberately.
        interruptedTurn: false,
      };
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : String(caughtError);
      if (message.includes('abort')) {
        return {
          outcome: 'aborted',
          unconfirmedCommands,
          discardedDraft: shouldClear ? pendingDraft : null,
          // See `SubmitKeystrokesResult.interruptedTurn`: always false while the
          // clear is Ctrl+U and Esc is suppressed during a live turn.
          interruptedTurn: false,
        };
      }
      console.error(`[terminal-submit] ${source}: keystroke delivery failed: ${message}`);
      throw caughtError;
    }
  }

  /**
   * Drain the write queue, then wait for the TUI's render to settle.
   *
   * The drain is what makes the wait meaningful: `sessionManager.write`
   * enqueues, and the queue drains over later ticks, so a delay measured
   * without it is a delay from the enqueue rather than from the PTY.
   *
   * Observes `'data-tap'`, not `'data'`. The `'data'` event is gated on
   * renderer focus and is default-closed, and auto_command injection normally
   * targets a session whose terminal is NOT the one on screen - observing
   * `'data'` would silently degrade every such delivery to the wall-clock cap.
   */
  private async settleAfterWrite(
    sessionId: string,
    signal: AbortSignal,
    capMs: number,
    idleMs: number = SETTLE_IDLE_MS,
  ): Promise<void> {
    await this.sessionManager.drain(sessionId);
    await waitForOutputSettle(this.sessionManager, sessionId, {
      event: 'data-tap',
      idleMs,
      capMs,
      floorMs: 0,
      signal,
      abortError: () => new Error('aborted'),
    });
  }

  /**
   * Poll the verifier for one retry window. This does NOT re-fire Enter
   * itself; the caller's attempt loop re-presses Enter ALONE.
   *
   * Esc is sent at most once, on the first attempt only (`attempt === 0`, and
   * never while interrupting a live turn): a second Esc would clear the command
   * that is already typed, and an Esc mid-turn interrupts the agent.
   */
  private async pollForConfirmation(
    verifier: CommandVerifier,
    command: InjectionCommand,
    sentAt: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    const deadline = Date.now() + VERIFY_WINDOW_MS;
    while (Date.now() < deadline) {
      if (signal.aborted) throw new Error('aborted');
      if (await verifier(command.text, sentAt, command.verify)) return true;
      await waitMs(VERIFY_POLL_MS, signal);
    }
    return false;
  }
}

/**
 * Whether to clear the prompt before typing.
 *
 * Warm sessions always clear: it is the only way to guarantee the command
 * cannot concatenate onto a draft, and the user initiated the move that is
 * injecting it. A fresh spawn skips the clear because its prompt is empty by
 * construction - UNLESS the draft ledger saw the user type during the
 * deferred wait, which is the realistic path to the reported
 * `instead can we/pull-request` bug.
 */
function shouldClearPrompt(opts: SubmitKeystrokesOptions, pendingDraft: string | null): boolean {
  if (opts.sendCtrlC !== undefined) return opts.sendCtrlC;
  if (!opts.freshlySpawned) return true;
  return pendingDraft !== null;
}

/** Sanitize, drop empties, and default a bare string to unverifiable. */
function normalizeCommands(commands: ReadonlyArray<string | InjectionCommand>): InjectionCommand[] {
  const normalized: InjectionCommand[] = [];
  for (const entry of commands) {
    const raw = typeof entry === 'string' ? { text: entry, verify: 'none' as const } : entry;
    const text = sanitizeForPty(raw.text);
    if (text.length === 0) continue;
    normalized.push({ text, verify: raw.verify });
  }
  return normalized;
}

function waitMs(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
