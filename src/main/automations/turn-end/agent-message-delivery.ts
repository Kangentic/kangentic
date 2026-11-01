import type { AutoCommandMode } from '../../../shared/types';
import type { IpcContext } from '../../ipc/ipc-context';
import type { CommandVerifier } from '../../pty/terminal-submit';
import type { InjectionReport } from '../../transition-engine/terminal-submit-scheduler';
import { deliverExitMessage, EXIT_BUDGET_ABORT_REASON } from '../../ipc/helpers/exit-message-delivery';
import { waitForTurnCompletion, type TurnCompletionResult } from '../../transition-engine/turn-completion';
import { trackMessageDelivery } from './turn-end-passes';
import { AGENT_READY_CEILING_MS } from '../../pty/lifecycle/agent-output-tracker';

/**
 * How a column's message reaches a live agent: typed as keystrokes, or pasted.
 *
 * Keystrokes sanitize newlines and tabs to spaces (`sanitizeForPty`), so a
 * message with line breaks typed that way arrives as one line. A Move to column
 * row hands the next column a reviewer's `{{agentReply}}`, thousands of
 * characters across many lines, and a column's own message can carry
 * `{{description}}`. So every path that hands a message to an agent asks
 * `shouldPaste` here, once:
 *
 * - **One line, or a slash command,** the keystroke burst, which is the only
 *   way a slash command runs (a pasted `/code-review` is literal text to the
 *   TUI). A slash command with line breaks in it, such as
 *   `/code-review {{attachments}}`, stays keystrokes on purpose: it arrives on
 *   one line and runs, where a paste would deliver text that never runs.
 * - **More than one line, or long,** bracketed paste (`submitContent`), the
 *   path the MCP send tool and the phone use, which keeps the text whole.
 *
 * The keystroke side is the scheduler's, unchanged: its verifier, its
 * escalation, its outcome report. The paste side has no transcript verifier,
 * so a paste that went in is reported `unconfirmed`, as keystrokes on an agent
 * with no verifier are.
 */
const PASTE_THRESHOLD_CHARS = 1_000;
/** How long an awaited paste (exit, turn end) waits for the agent's turn to end. */
const PASTE_TURN_WAIT_MS = 10 * 60_000;
/**
 * How long a background paste waits for the agent's turn to end. Long, because
 * on a fresh spawn that turn is the agent's whole first pass at the task, and a
 * later move cancels the wait anyway (`supersedeMessageDeliveries`).
 */
const BACKGROUND_TURN_WAIT_MS = 60 * 60_000;

const SESSION_GONE_REASON = 'The session was no longer running.';
const SUPERSEDED_REASON = 'The task left the column before the message was sent.';

export function needsPaste(message: string): boolean {
  return message.includes('\n') || message.length > PASTE_THRESHOLD_CHARS;
}

/**
 * A slash command's first word: `/name` or `/plugin:name`. Never a path, which
 * has a second slash, so a message that is an agent's reply and happens to
 * open with `/src/main/...` is pasted whole rather than typed flat.
 */
const SLASH_COMMAND_HEAD = /^\/[A-Za-z][\w:.-]*(?:\s|$)/;

/**
 * Whether a message runs as a slash command. Text added after one becomes its
 * arguments in some CLIs, and text put before one stops it being a command at
 * all, so a message that rides with one goes on its own instead.
 */
export function isSlashCommand(message: string): boolean {
  return SLASH_COMMAND_HEAD.test(message.trimStart());
}

/** The one decision every delivery path asks. See the module comment. */
export function shouldPaste(message: string): boolean {
  return needsPaste(message) && !isSlashCommand(message);
}

interface AgentMessage {
  taskId: string;
  sessionId: string;
  message: string;
  mode: AutoCommandMode;
  verifier: CommandVerifier | null;
}

/**
 * Deliver a message and WAIT for it to land. On task exit and On agent turn
 * end, whose groups await every row.
 *
 * `turnWait` says when a paste waits for the agent's turn to end first:
 * `'always'` at a turn end, where the agent has just gone idle and a paste must
 * land after the turn's last paint; `'when-deferred'` on exit, where the row's
 * own mode decides, as it does for keystrokes. Bounded by `signal`, the
 * automation run's own, which the paste itself is also handed.
 */
export async function deliverAgentMessageAndWait(
  context: IpcContext,
  input: AgentMessage & {
    signal: AbortSignal;
    turnWait: 'always' | 'when-deferred';
    /** What the run log says when `signal` fires first. Defaults to the exit budget's wording. */
    abortReason?: string;
  },
): Promise<void> {
  const abortReason = input.abortReason ?? EXIT_BUDGET_ABORT_REASON;
  if (!shouldPaste(input.message)) {
    await deliverExitMessage(
      context,
      input.taskId,
      input.sessionId,
      input.message,
      input.mode,
      input.verifier,
      input.signal,
      abortReason,
    );
    return;
  }

  await runInPasteOrder(input.taskId, input.signal, async () => {
    if (input.signal.aborted) throw new Error(abortReason);
    if (!isSessionLive(context, input.sessionId)) throw new Error(SESSION_GONE_REASON);
    if (input.turnWait === 'always' || input.mode === 'deferred') {
      const settled = await waitForTurnCompletion(context.sessionManager, input.sessionId, {
        signal: input.signal,
        timeoutMs: PASTE_TURN_WAIT_MS,
      });
      if (settled !== 'completed') throw new Error(turnWaitFailure(settled, abortReason));
    }
    if (input.signal.aborted) throw new Error(abortReason);
    try {
      await context.terminalSubmit.submitContent(input.sessionId, input.message, {
        source: 'automation',
        signal: input.signal,
        automated: true,
      });
    } catch (error) {
      if (input.signal.aborted) throw new Error(abortReason, { cause: error });
      throw error;
    }
  });
}

/**
 * The paste each task has running or waiting, as one chain.
 *
 * Every paste waits for the agent's turn to end, and every such wait listens
 * to the same activity and output events, so two pastes for one task (two
 * multi-line enter rows, or an enter row and a Move to column follow-up) would
 * see the same turn end within milliseconds and write their bytes into the PTY
 * at once. Chained, the next one starts only once the one ahead of it has
 * settled, so its turn wait is for the turn that paste started.
 */
const pasteChains = new Map<string, Promise<void>>();

/**
 * Run `paste` after every paste already chained for the task. `signal` bounds
 * the wait for those (an exit row's budget must not run out behind someone
 * else's turn), never the chain itself: a later paste still waits for the
 * earlier ones, including one this paste stopped waiting for.
 */
function runInPasteOrder(taskId: string, signal: AbortSignal | null, paste: () => Promise<void>): Promise<void> {
  const previous = pasteChains.get(taskId) ?? Promise.resolve();
  const current = untilSettledOrAborted(previous, signal).then(paste);
  const tail = Promise.allSettled([previous, current]).then(() => undefined);
  pasteChains.set(taskId, tail);
  void tail.then(() => {
    if (pasteChains.get(taskId) === tail) pasteChains.delete(taskId);
  });
  return current;
}

function untilSettledOrAborted(promise: Promise<void>, signal: AbortSignal | null): Promise<void> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onAbort = (): void => resolve();
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    });
  });
}

/**
 * Hand a message to the agent and return at once. On task enter (warm and
 * cold), the injection that carries a column's message on a warm move, and
 * Run again.
 *
 * A one-line message is scheduled as keystrokes exactly as before.
 * `freshlySpawned` goes to the scheduler, which waits for the CLI to come alive.
 */
export function deliverAgentMessageInBackground(
  context: IpcContext,
  input: AgentMessage & {
    freshlySpawned?: boolean;
    onOutcome: (report: InjectionReport) => void;
  },
): void {
  if (!shouldPaste(input.message)) {
    context.terminalSubmitScheduler.scheduleKeystrokes(
      input.taskId,
      input.sessionId,
      [{ text: input.message, verify: 'submitted' }],
      {
        ...(input.freshlySpawned ? { freshlySpawned: true } : {}),
        verifier: input.verifier,
        mode: input.mode,
        onOutcome: input.onOutcome,
      },
    );
    return;
  }
  pasteAgentMessageInBackground(context, input);
}

/**
 * Paste a message in the background, once the agent's turn has ended, whatever
 * the row's mode.
 *
 * Always after the turn, for two reasons. A freshly spawned agent's TUI is not
 * ready at once, and its first turn is the earliest a paste can land whole.
 * And on a live session a keystroke burst may still be typing (the warm move's
 * `/effort`, an earlier row): a paste written over it would interleave, and
 * the burst's leading Ctrl+U could clear the pasted text before its Enter. So
 * it also waits until the scheduler holds nothing for the task
 * (`hasPending`). The user sees what `immediate` gives keystrokes anyway,
 * since a CLI queues a message typed mid-turn until the turn ends.
 *
 * A move that takes the task to another column cancels it
 * (`supersedeMessageDeliveries`), and the outcome goes to `onOutcome` the way a
 * keystroke burst's does: `cancelled` for a superseded paste (silent),
 * `failed` with a reason otherwise (a notice).
 */
export function pasteAgentMessageInBackground(
  context: IpcContext,
  input: {
    taskId: string;
    sessionId: string;
    message: string;
    onOutcome: (report: InjectionReport) => void;
  },
): void {
  // Tracked from now, so a move cancels it even while it waits its turn in
  // the task's paste chain.
  const controller = new AbortController();
  const release = trackMessageDelivery(input.taskId, controller);
  void runInPasteOrder(input.taskId, null, () => runBackgroundPaste(context, input, controller.signal))
    .finally(release);
}

async function runBackgroundPaste(
  context: IpcContext,
  input: {
    taskId: string;
    sessionId: string;
    message: string;
    onOutcome: (report: InjectionReport) => void;
  },
  signal: AbortSignal,
): Promise<void> {
  // Until `submitContent` starts, nothing of the message has reached the agent.
  let pasteStarted = false;
  const report = (outcome: 'unconfirmed' | 'failed' | 'cancelled', reason?: string): void => {
    try {
      input.onOutcome({
        taskId: input.taskId,
        sessionId: input.sessionId,
        commands: [input.message],
        outcome,
        unconfirmedCommands: outcome === 'unconfirmed' ? [] : [input.message],
        discardedDraft: null,
        interruptedTurn: false,
        escalated: false,
        ...(reason ? { reason } : {}),
        ...(pasteStarted ? {} : { textReachedAgent: false as const }),
      });
    } catch (error) {
      console.error(`[agent-message] Outcome handler threw for task ${input.taskId.slice(0, 8)}:`, error);
    }
  };

  try {
    if (signal.aborted) {
      report('cancelled', SUPERSEDED_REASON);
      return;
    }
    if (!isSessionLive(context, input.sessionId)) {
      report('failed', SESSION_GONE_REASON);
      return;
    }
    const deadline = Date.now() + BACKGROUND_TURN_WAIT_MS;
    // A screen the agent shows before its input box (Claude's approval of a
    // new project MCP server) would take the paste and its Enter as an answer.
    // The stale-thinking reclaim reads such an agent idle after 3 minutes, so
    // the turn wait alone does not keep the paste out of it.
    const atInput = await context.sessionManager.awaitInputReady(input.sessionId, BACKGROUND_TURN_WAIT_MS, signal);
    if (!atInput) {
      if (signal.aborted) report('cancelled', SUPERSEDED_REASON);
      else if (!isSessionLive(context, input.sessionId)) report('failed', SESSION_GONE_REASON);
      else report('failed', 'The agent did not reach its input box in time to deliver the message.');
      return;
    }
    // The turn has to end AND the scheduler has to be done with this task. A
    // keystroke burst scheduled ahead of the paste (the warm move's `/effort`,
    // an earlier row) may be waiting on this same turn end; it starts then,
    // and its typing breaks the quiet the next wait needs, so the loop lands
    // the paste after it. Each wait takes at least the 1.5 s quiet window, so
    // the loop never spins.
    for (;;) {
      const settled = await waitForTurnCompletion(context.sessionManager, input.sessionId, {
        signal,
        timeoutMs: Math.max(0, deadline - Date.now()),
      });
      if (settled === 'aborted') {
        report('cancelled', SUPERSEDED_REASON);
        return;
      }
      if (settled !== 'completed') {
        report('failed', turnWaitFailure(settled, SUPERSEDED_REASON));
        return;
      }
      if (!context.terminalSubmitScheduler.hasPending(input.taskId)) break;
    }
    pasteStarted = true;
    await context.terminalSubmit.submitContent(input.sessionId, input.message, {
      source: `automation:${input.taskId.slice(0, 8)}`,
      signal,
      automated: true,
    });
    report('unconfirmed');
  } catch (error) {
    if (signal.aborted) {
      report('cancelled', SUPERSEDED_REASON);
      return;
    }
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[agent-message] Paste failed for task ${input.taskId.slice(0, 8)}: ${detail}`);
    report('failed', `The message could not be pasted: ${detail}`);
  }
}

/**
 * A wait on a session that already ended would sit out its whole timeout,
 * because the `exit` event it listens for has been and gone. `queued` counts:
 * that session is about to start.
 */
function isSessionLive(context: IpcContext, sessionId: string): boolean {
  const status = context.sessionManager.getSession(sessionId)?.status;
  return status === 'running' || status === 'queued';
}

function turnWaitFailure(result: Exclude<TurnCompletionResult, 'completed'>, abortReason: string): string {
  if (result === 'exited') return 'The agent exited before the message could be delivered.';
  if (result === 'timeout') return "The agent's turn did not end in time to deliver the message.";
  return abortReason;
}

/**
 * How long the opening prompt waits for an adopted agent's screen to settle
 * after it is ready. The agent has been at its input box for the whole setup
 * script by then, so this is the short tail of a script shorter than the boot.
 */
const OPENING_SETTLE_WAIT_MS = 15_000;
/**
 * How long the adopted agent's screen must be quiet before its opening goes
 * in. It is idle at its input box, not ending a turn, so this only lets the
 * repaint after its terminal mounts (and resizes it) finish: measured, that
 * mount is the one burst of output after adoption. The paste engine keeps its
 * own settle on top.
 */
const OPENING_QUIET_MS = 500;
const OPENING_ABORT_REASON = 'The task moved on before its opening prompt was sent.';

/**
 * Type a task's opening prompt into an agent its spawn adopted
 * (`SpawnOutcome.typedOpening`: launched while the task's worktree ran its
 * setup script, before the prompt was ready), and wait for it to land. The
 * prompt is what the command line would have carried, so it goes as the
 * command line would deliver it: whole, and first.
 *
 * Waits for the agent to be on screen (`awaitAgentReady`, bounded by the same
 * ceiling the launch overlay uses) and for its screen to be quiet, then
 * delivers through the decision every path uses (`shouldPaste`): a bracketed
 * paste for text with line breaks (the task template's XML), keystrokes for one
 * line or a slash command, which a paste would never run (a column whose message
 * is the opening prompt, such as `/code-review`). Awaited either way, so the
 * column's later messages, held messages and pastes are all scheduled after it.
 *
 * Returns null once the prompt reached the agent, or why it did not. Never
 * throws: a failure is logged and returned, and the agent stays up for the
 * user. A cancel (the task moved on) is reported as `cancelled`, which the
 * caller does not announce.
 */
export async function deliverOpeningPromptAndWait(
  context: IpcContext,
  input: {
    taskId: string;
    sessionId: string;
    prompt: string;
    verifier: CommandVerifier | null;
    signal?: AbortSignal;
  },
): Promise<{ outcome: 'failed' | 'cancelled'; reason: string } | null> {
  const taskLabel = input.taskId.slice(0, 8);
  const signal = input.signal ?? new AbortController().signal;
  try {
    const ready = await context.sessionManager.awaitAgentReady(input.sessionId, AGENT_READY_CEILING_MS);
    if (!ready && !isSessionLive(context, input.sessionId)) {
      console.warn(`[agent-message] Task ${taskLabel}: the agent exited before its opening prompt was sent`);
      return { outcome: 'failed', reason: 'The agent exited before its first prompt was sent.' };
    }
    const settled = await waitForTurnCompletion(context.sessionManager, input.sessionId, {
      signal,
      quietMs: OPENING_QUIET_MS,
      timeoutMs: OPENING_SETTLE_WAIT_MS,
    });
    if (settled === 'aborted') return { outcome: 'cancelled', reason: OPENING_ABORT_REASON };
    if (settled === 'exited') {
      console.log(`[agent-message] Task ${taskLabel}: opening prompt not sent (the agent exited)`);
      return { outcome: 'failed', reason: 'The agent exited before its first prompt was sent.' };
    }
    // A timeout still sends: the agent has been ready a while and only its
    // screen is busy, which typed input waits out in the CLI's own buffer.
    if (shouldPaste(input.prompt)) {
      await context.terminalSubmit.submitContent(input.sessionId, input.prompt, {
        source: `automation:${taskLabel}`,
        signal,
      });
    } else {
      await deliverExitMessage(
        context, input.taskId, input.sessionId, input.prompt, 'immediate', input.verifier, signal, OPENING_ABORT_REASON,
      );
    }
    console.log(`[agent-message] Task ${taskLabel}: opening prompt sent to the adopted agent`);
    return null;
  } catch (error) {
    if (signal.aborted) return { outcome: 'cancelled', reason: OPENING_ABORT_REASON };
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[agent-message] Task ${taskLabel}: the opening prompt could not be sent: ${detail}`);
    return { outcome: 'failed', reason: `Its first prompt could not be sent: ${detail}` };
  }
}
