import { TRAILING_PARTIAL_ESCAPE, carryForPartialEscape } from '../../../shared/ansi-strip';
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
 * backstop with it, and the launch report reads it as the point past which a
 * person stopping a silent launch has given up (`LAUNCH_ABANDON_MS`). The
 * tracker below scans past it, to `AGENT_START_CEILING_MS`: the overlay has
 * lifted by then, but whether the shell ran the typed line still matters.
 */
export const AGENT_READY_CEILING_MS = 15_000;

/**
 * How long a launch may go without showing its agent ran before it is judged
 * the way any launch is. Until then the agent-absence sweep judges it only
 * when its output already names a cause (`SessionManager.isAgentAbsenceCandidate`),
 * and this tracker keeps watching for the typed line to run.
 *
 * A slow shell takes the typed line late, never loses it. Measured through a
 * real ConPTY on Windows PowerShell 5.1 (`scripts/probe-powershell-slow-shell-typed-line.js`):
 * with the shell held 20 s and 40 s before its prompt, a 7,649-byte line ran
 * whole at 23.4 s and 43.5 s. A launch judged at the 30 s grace was paused and
 * retried while its line was still waiting (Sentry DESKTOP-2E). Two minutes
 * leaves a profile that slow room, and a launch that really failed with no
 * words for it waits that long before its retry.
 *
 * Declared here because both processes read it: the session manager bounds
 * the sweep's wait with it, and the tracker its scan.
 */
export const AGENT_START_CEILING_MS = 120_000;

/** nF escapes such as the charset designation `\x1b(B` that `sgr0` emits. */
const DESIGNATION_ESCAPE = /\x1b[\x20-\x2f]+[\x30-\x7e]/g;

interface AgentOutputState {
  /** New printable text has arrived: the shell's prompt or its banner. */
  shellTextSeen: boolean;
  /** The shell ran the typed command line: its clear landed after its text. */
  handoffSeen: boolean;
  /** A partial escape sequence held over from the previous chunk. */
  carry: string;
  /** When the first chunk arrived, for the AGENT_START_CEILING_MS bound. */
  startedAt: number;
}

function hasVisibleText(text: string): boolean {
  return /\S/.test(stripAnsiSequences(text.replace(DESIGNATION_ESCAPE, '')));
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
 * It fires the session manager's `agentOutputAt` too, which the launch report
 * reads as the shell having run the typed line (`typed_line_ran`,
 * `shell_printed=after_launch`). So it keeps scanning past the overlay's
 * AGENT_READY_CEILING_MS, to AGENT_START_CEILING_MS: a Windows PowerShell 5.1
 * held 20 s by its profile ran a launch's line at 23.4 s, and a scan that
 * stopped at 15 s reported every such launch as never having run its line, a
 * retry that worked included (Sentry DESKTOP-2E). The overlay is unaffected: it
 * lifted at its own ceiling, and `markAgentReady` lifts it once.
 *
 * Holds per-session state only until it fires or AGENT_START_CEILING_MS has
 * passed since the session's first chunk. Call `removeSession()` when a
 * session is dropped and `clear()` on shutdown.
 */
export class AgentOutputTracker {
  private readonly states = new Map<string, AgentOutputState>();
  /** Sessions the tracker is done with: it fired, or the ceiling passed. */
  private readonly finished = new Set<string>();

  /**
   * Feed a fresh PTY chunk. Returns true at most once per session: on the
   * chunk where visible text first follows the handoff clear, inside
   * AGENT_START_CEILING_MS.
   */
  consume(sessionId: string, data: string): boolean {
    if (this.finished.has(sessionId)) return false;
    let state = this.states.get(sessionId);
    if (!state) {
      state = { shellTextSeen: false, handoffSeen: false, carry: '', startedAt: Date.now() };
      this.states.set(sessionId, state);
    }
    // Past the start ceiling the launch is judged whatever this decides, so
    // stop scanning every chunk for a session that will never show the handoff.
    if (Date.now() - state.startedAt > AGENT_START_CEILING_MS) {
      this.finish(sessionId);
      return false;
    }
    const combined = state.carry + data;
    const partial = combined.match(TRAILING_PARTIAL_ESCAPE);
    const complete = partial ? combined.slice(0, partial.index) : combined;
    state.carry = partial ? carryForPartialEscape(partial[0]) : '';
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
