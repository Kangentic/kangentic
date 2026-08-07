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
  /** True when the leading clear interrupted a live turn. */
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
const SETTLE_CAP_MS = 1200;
/** Bound on the post-Enter wait when nothing can be verified. */
const UNVERIFIED_SETTLE_CAP_MS = 800;
const VERIFY_POLL_MS = 25;
const VERIFY_WINDOW_MS = 400;
const MAX_SUBMIT_ATTEMPTS = 5;

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
   * re-sends Esc AND Enter, not Enter alone. Re-firing Enter into a picker
   * that is still open just gets eaten again; the Esc is what clears the
   * condition. This is the single most load-bearing detail in the retry loop.
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
        // Clears any half-typed draft AND interrupts a live turn. Both are
        // deliberate; the caller reports them.
        this.sessionManager.write(sessionId, '\x03');
        await this.settleAfterWrite(sessionId, signal, SETTLE_CAP_MS);
      }

      for (const command of sanitized) {
        const isSlashCommand = command.text.startsWith('/');
        const canVerify = verifier !== null && command.verify !== 'none';
        if (canVerify) sawVerifiable = true;

        this.sessionManager.write(sessionId, command.text);
        await this.settleAfterWrite(sessionId, signal, SETTLE_CAP_MS);

        let confirmed = false;
        for (let attempt = 0; attempt < MAX_SUBMIT_ATTEMPTS; attempt++) {
          if (isSlashCommand) {
            // Dismiss the autocomplete picker so Enter resolves to "submit
            // typed text" rather than "select highlighted entry".
            //
            // Drain but do NOT settle between Esc and Enter. The remaining
            // failure mode is a picker that mounts in the gap between them:
            // the Esc finds nothing to dismiss, then the picker appears and
            // eats the Enter. Settling here would widen that gap by a full
            // idle window and make the race MORE likely, not less. The
            // preceding settle already waited for the render; keeping these
            // two keystrokes adjacent is what closes the window.
            this.sessionManager.write(sessionId, '\x1b');
            await this.sessionManager.drain(sessionId);
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
        interruptedTurn: shouldClear && (opts.interruptingTurn ?? false),
      };
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : String(caughtError);
      if (message.includes('abort')) {
        return {
          outcome: 'aborted',
          unconfirmedCommands,
          discardedDraft: shouldClear ? pendingDraft : null,
          interruptedTurn: shouldClear && (opts.interruptingTurn ?? false),
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
  private async settleAfterWrite(sessionId: string, signal: AbortSignal, capMs: number): Promise<void> {
    await this.sessionManager.drain(sessionId);
    await waitForOutputSettle(this.sessionManager, sessionId, {
      event: 'data-tap',
      idleMs: SETTLE_IDLE_MS,
      capMs,
      floorMs: 0,
      signal,
      abortError: () => new Error('aborted'),
    });
  }

  /**
   * Poll the verifier for one retry window. Unlike the previous
   * implementation this does NOT re-fire Enter itself; the caller's attempt
   * loop re-sends Esc AND Enter together, which is what actually recovers a
   * submission the picker swallowed.
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
