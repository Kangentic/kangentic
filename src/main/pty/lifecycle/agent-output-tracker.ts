import { findSpawnHandoffClear, hasPrintableOutput, stripAnsiSequences } from '../buffer/pty-buffer-manager';

/**
 * How long an agent session's launch overlay waits for evidence its agent is
 * on screen (`SessionManager.markAgentReady`) before the terminal is shown
 * anyway. The evidence normally lands in seconds: a cold Claude Code reached
 * its alt screen 3.0 to 3.1 s after spawn under Windows PowerShell in a
 * /preview. So this is a backstop for a stream none of it fits: a shell whose
 * clear sends neither \x1b[2J nor \x1b[3J, or an agent that starts without
 * drawing text or a frame. Showing the terminal late is the cost of a miss;
 * waiting forever is not an option.
 *
 * Declared here because both processes use it: `SessionManager` arms its
 * backstop with it, and the tracker below stops scanning once it has passed,
 * since the overlay has lifted by then whatever the stream shows.
 */
export const AGENT_READY_CEILING_MS = 15_000;

/**
 * An escape sequence cut off at the end of a chunk: a lone ESC, an
 * unterminated CSI, or a string (OSC, DCS, APC, PM, SOS) still waiting for its
 * terminator. It is held for the next chunk, so neither half of a split
 * sequence is read as text: a window title's path split across two chunks
 * would otherwise count as the agent's first output.
 */
const TRAILING_PARTIAL_ESCAPE = /\x1b(?:\[[\x30-\x3f]*[\x20-\x2f]*|[\]P_^X][^\x07\x1b]*\x1b?|[\x20-\x2f]+)?$/;

/**
 * A carried partial longer than this keeps only its introducer and a trailing
 * ESC (see carryFor), so the carry never grows past it.
 */
const MAX_CARRY_LENGTH = 4096;

/** nF escapes such as the charset designation `\x1b(B` that `sgr0` emits. */
const DESIGNATION_ESCAPE = /\x1b[\x20-\x2f]+[\x30-\x7e]/g;

interface AgentOutputState {
  /** New printable text has arrived: the shell's prompt or its banner. */
  shellTextSeen: boolean;
  /** The shell ran the typed command line: its clear landed after its text. */
  handoffSeen: boolean;
  /** A partial escape sequence held over from the previous chunk. */
  carry: string;
  /** When the first chunk arrived, for the AGENT_READY_CEILING_MS bound. */
  startedAt: number;
}

function hasVisibleText(text: string): boolean {
  return /\S/.test(stripAnsiSequences(text.replace(DESIGNATION_ESCAPE, '')));
}

/**
 * What to hold over from a partial escape. A long one keeps its introducer
 * (`\x1b]`, `\x1b[`, ...) and a trailing ESC that may start its terminator.
 * The payload between them never decides whether text is visible, and keeping
 * the introducer is what makes the rest of the sequence, when it ends in a
 * later chunk, still read as a sequence. Dropping the whole partial read that
 * rest as text: a window title longer than the cap, such as cmd's title
 * carrying a long agent command line, lifted the overlay on the shell.
 */
function carryFor(partial: string): string {
  if (partial.length <= MAX_CARRY_LENGTH) return partial;
  return partial.slice(0, 2) + (partial.endsWith('\x1b') ? '\x1b' : '');
}

/**
 * Per-session latch that fires once when the AGENT, not its shell, has put
 * text on the screen. It drives the launch overlay, so the shell's prompt and
 * the typed command never show before the agent's first frame.
 *
 * Each adapter's `detectFirstOutput` cannot answer this: a shell's startup
 * frame carries the very escapes the detectors match (pwsh 7.6 and Windows
 * PowerShell both emit `\x1b[?25l`, and several adapters accept any byte), so
 * on Windows those latches trip on shell bytes seconds before the agent runs.
 * This one keys on what Kangentic itself typed. The shell's clear runs the
 * moment the shell executes the spawn command, so:
 *
 *   1. new printable text arrives (the prompt, a banner, the echoed command);
 *   2. then the shell's clear (`findSpawnHandoffClear`, the same test the
 *      pre-TUI strip uses): the shell ran the typed line;
 *   3. then the first visible text after it is the agent's, or the shell's
 *      error when the agent command could not start, which is worth showing.
 *
 * Step 1 is what skips ConPTY's escape-only startup clear and anything a
 * resumed session carried over: only bytes the new PTY produced are fed here.
 * A fullscreen TUI usually enters the alt screen before step 3, and the
 * session manager takes that as the same evidence, as it does the agent's
 * SessionStart hook. A shell profile that prints and then clears trips step 2
 * early, which degrades to showing the prompt, the behavior before this
 * tracker.
 *
 * Holds per-session state only until it fires or AGENT_READY_CEILING_MS has
 * passed since the session's first chunk. Call `removeSession()` when a
 * session is dropped and `clear()` on shutdown.
 */
export class AgentOutputTracker {
  private readonly states = new Map<string, AgentOutputState>();
  /** Sessions the tracker is done with: it fired, or the ceiling passed. */
  private readonly finished = new Set<string>();

  /**
   * Feed a fresh PTY chunk. Returns true at most once per session: on the
   * chunk where visible text first follows the handoff clear, inside the
   * ceiling.
   */
  consume(sessionId: string, data: string): boolean {
    if (this.finished.has(sessionId)) return false;
    let state = this.states.get(sessionId);
    if (!state) {
      state = { shellTextSeen: false, handoffSeen: false, carry: '', startedAt: Date.now() };
      this.states.set(sessionId, state);
    }
    // Past the ceiling the session manager has lifted the overlay whatever
    // this decides, so stop scanning every chunk for a session that will
    // never show the handoff.
    if (Date.now() - state.startedAt > AGENT_READY_CEILING_MS) {
      this.finish(sessionId);
      return false;
    }
    const combined = state.carry + data;
    const partial = combined.match(TRAILING_PARTIAL_ESCAPE);
    const complete = partial ? combined.slice(0, partial.index) : combined;
    state.carry = partial ? carryFor(partial[0]) : '';
    let afterHandoff = complete;
    if (!state.handoffSeen) {
      const handoff = findSpawnHandoffClear(complete, state.shellTextSeen);
      if (!handoff) {
        if (!state.shellTextSeen && hasPrintableOutput(complete)) state.shellTextSeen = true;
        return false;
      }
      state.handoffSeen = true;
      afterHandoff = complete.slice(handoff.index + handoff.length);
    }
    if (!hasVisibleText(afterHandoff)) return false;
    this.finish(sessionId);
    return true;
  }

  /** Drop per-session state. Called when the host drops a session. */
  removeSession(sessionId: string): void {
    this.states.delete(sessionId);
    this.finished.delete(sessionId);
  }

  /** Drop all state. */
  clear(): void {
    this.states.clear();
    this.finished.clear();
  }

  private finish(sessionId: string): void {
    this.states.delete(sessionId);
    this.finished.add(sessionId);
  }
}
