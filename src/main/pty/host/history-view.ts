/**
 * Opens and closes an agent's history view for the find bar (`AgentHistoryView`):
 * the agent writes its whole conversation into the terminal's normal buffer, where
 * a search covers all of it, and goes back to its own screen when the bar closes.
 *
 * Every key it sends is typed into a live agent, so each one waits on what the
 * screen shows. A key sent to the wrong view lands in the prompt:
 * - It opens only from the alternate screen, which is where the agent draws itself.
 * - It sends the toggle only when the history view is not already showing (the user
 *   may have opened it), and the write-out only once the history view shows.
 * - When the agent does not answer in time, it toggles back if its toggle moved the
 *   screen, and reports that nothing opened. A toggle that moved the screen into a
 *   view `isShowing` never recognized is `unrecognized-view`, which main reports
 *   (`history-view-report.ts`), since it means the agent's view has changed.
 * - It closes only a view it opened, and only while the terminal is still on the
 *   normal buffer. A user who left it already put the agent back.
 * - A write-out that outlasts its wait still lands, so the mark stays through a
 *   bounded close: the late conversation is kept out like any other, and the host
 *   sends the toggle once the agent has left the alternate screen.
 *
 * While a view is opening, open or closing, `isActive` is true, and the host keeps
 * the written-out conversation away from what reads a session's output as new: the
 * stored transcript, the agent's output parsers, and the activity signals. So a
 * close the agent never answers expires after `writeOutWaitMs`, and the host
 * removes a session's mark when its PTY exits or a new PTY takes the session, and
 * closes the view when the window that showed it closes or crashes.
 */

import type { AgentHistoryView, HistoryViewOpenResult } from '../../../shared/types';

export interface HistoryViewDependencies {
  /** The session's agent's history view, or undefined when it declares none. */
  viewFor(sessionId: string): AgentHistoryView | undefined;
  /** The session's visible rows, top first. */
  screenRows(sessionId: string): readonly string[];
  inAltScreen(sessionId: string): boolean;
  /** Type keys into the session's live PTY. False when there is none. */
  write(sessionId: string, keys: string): boolean;
}

export interface HistoryViewTiming {
  /** How long the agent gets to show its history view after the toggle. */
  showWaitMs: number;
  /** How long the agent gets to leave the alternate screen after the write-out. */
  writeOutWaitMs: number;
  pollMs: number;
}

/** Claude answered each key within a frame or two; these bound a busy machine. */
export const HISTORY_VIEW_TIMING: HistoryViewTiming = { showWaitMs: 2000, writeOutWaitMs: 5000, pollMs: 50 };

/** `closing`: the toggle went out (or waits for a late write-out) and the stream has
 *  not entered the alternate screen yet. */
type Phase = 'opening' | 'open' | 'closing';

function sameRows(first: readonly string[], second: readonly string[]): boolean {
  return first.length === second.length && first.every((row, index) => row === second[index]);
}

interface Mark {
  phase: Phase;
  /** The bar closed while this was opening: close it once it is open. */
  closeRequested: boolean;
  /** Closing a write-out that outlasted its wait: send the toggle when it lands. */
  toggleOnWriteOut: boolean;
}

export class HistoryViews {
  private readonly marks = new Map<string, Mark>();

  constructor(
    private readonly dependencies: HistoryViewDependencies,
    private readonly timing: HistoryViewTiming = HISTORY_VIEW_TIMING,
  ) {}

  /** A view is opening, open or closing: the session's output is the written-out conversation. */
  isActive(sessionId: string): boolean {
    return this.marks.has(sessionId);
  }

  async open(sessionId: string): Promise<HistoryViewOpenResult> {
    const view = this.dependencies.viewFor(sessionId);
    if (!view) return 'unsupported';
    const closing = this.marks.get(sessionId);
    if (closing?.phase === 'closing') {
      // A bar reopened before the agent went back: wait for it, then open afresh.
      // The close's own bound always ends it first; twice that is only a backstop.
      const closed = await this.waitFor(() => this.marks.get(sessionId) !== closing, this.timing.writeOutWaitMs * 2);
      if (!closed) return 'did-not-open';
    }
    const existing = this.marks.get(sessionId);
    if (existing) {
      // A second open while the first is under way (one bar closed and reopened,
      // or a remount): it cancels a close the bar asked for while opening. A close
      // once open still ends the view for every caller.
      existing.closeRequested = false;
      if (existing.phase === 'open') return 'opened';
      return this.waitForPhase(sessionId);
    }
    if (!this.dependencies.inAltScreen(sessionId)) return 'not-fullscreen';

    const mark: Mark = { phase: 'opening', closeRequested: false, toggleOnWriteOut: false };
    this.marks.set(sessionId, mark);
    let toggled = false;
    const screenBeforeToggle = this.dependencies.screenRows(sessionId);
    if (!view.isShowing(screenBeforeToggle)) {
      if (!this.dependencies.write(sessionId, view.toggleKeys)) return this.abandon(sessionId, 'not-running');
      toggled = true;
      const shown = await this.waitFor(() => view.isShowing(this.dependencies.screenRows(sessionId)), this.timing.showWaitMs);
      if (this.marks.get(sessionId) !== mark) return 'not-running';
      if (!shown) {
        // The screen moved, so the toggle opened something `isShowing` does not
        // know: put the agent back rather than leave it in that view. A screen that
        // did not move took no toggle (a dialog that ignores the key), and gets none.
        if (!sameRows(this.dependencies.screenRows(sessionId), screenBeforeToggle)) {
          this.dependencies.write(sessionId, view.toggleKeys);
          return this.abandon(sessionId, 'unrecognized-view');
        }
        return this.abandon(sessionId, 'did-not-open');
      }
    }
    if (!this.dependencies.write(sessionId, view.writeOutKeys)) return this.abandon(sessionId, 'not-running');
    const wroteOut = await this.waitFor(() => !this.dependencies.inAltScreen(sessionId), this.timing.writeOutWaitMs);
    // The session ended while it waited.
    if (this.marks.get(sessionId) !== mark) return 'not-running';
    if (!wroteOut) {
      // The `[` went out, so a slow agent can still write out after this. Back
      // out of the history view we opened, so the agent is where it was, and keep
      // the mark through a bounded close so a late write-out stays out of the
      // transcript and is toggled back once it lands.
      const backedOut = toggled && view.isShowing(this.dependencies.screenRows(sessionId)) && this.dependencies.write(sessionId, view.toggleKeys);
      mark.toggleOnWriteOut = !backedOut;
      this.startClosing(sessionId, mark);
      if (backedOut) {
        // Keys reach the agent in order, so once the back-out shows the agent's own
        // screen on the alternate screen, the `[` before it wrote nothing out.
        const backOnItsScreen = await this.waitFor(
          () => this.marks.get(sessionId) !== mark
            || (this.dependencies.inAltScreen(sessionId) && !view.isShowing(this.dependencies.screenRows(sessionId))),
          this.timing.showWaitMs,
        );
        if (backOnItsScreen && this.marks.get(sessionId) === mark) this.marks.delete(sessionId);
      }
      return 'did-not-open';
    }
    mark.phase = 'open';
    if (mark.closeRequested) this.close(sessionId);
    return 'opened';
  }

  /** Put the agent back on its own screen. Safe to call when nothing is open. */
  close(sessionId: string): void {
    const mark = this.marks.get(sessionId);
    if (!mark || mark.phase === 'closing') return;
    if (mark.phase === 'opening') {
      mark.closeRequested = true;
      return;
    }
    const view = this.dependencies.viewFor(sessionId);
    // Already back on the alternate screen, or nothing to type with: the view is over.
    if (!view || this.dependencies.inAltScreen(sessionId) || !this.dependencies.write(sessionId, view.toggleKeys)) {
      this.marks.delete(sessionId);
      return;
    }
    this.startClosing(sessionId, mark);
  }

  /** The stream entered the alternate screen: an open view has closed, by our keys or the user's. */
  noteAltScreenEnter(sessionId: string): void {
    const phase = this.marks.get(sessionId)?.phase;
    if (phase === 'open' || phase === 'closing') this.marks.delete(sessionId);
  }

  /** The stream left the alternate screen: a write-out that outlasted its wait has landed. */
  noteAltScreenExit(sessionId: string): void {
    const mark = this.marks.get(sessionId);
    if (mark?.phase !== 'closing' || !mark.toggleOnWriteOut) return;
    mark.toggleOnWriteOut = false;
    const view = this.dependencies.viewFor(sessionId);
    if (view) this.dependencies.write(sessionId, view.toggleKeys);
  }

  /** Close every view no renderer shows any longer: a closed or crashed window
   *  takes its find bar with it and never sends the close. */
  closeUnwatched(isWatched: (sessionId: string) => boolean): void {
    for (const sessionId of [...this.marks.keys()]) {
      if (!isWatched(sessionId)) this.close(sessionId);
    }
  }

  remove(sessionId: string): void {
    this.marks.delete(sessionId);
  }

  /** Wait for the agent to go back, at most `writeOutWaitMs`: a toggle the agent
   *  ignored must not keep its output from the transcript for good. */
  private startClosing(sessionId: string, mark: Mark): void {
    mark.phase = 'closing';
    setTimeout(() => {
      if (this.marks.get(sessionId) === mark) this.marks.delete(sessionId);
    }, this.timing.writeOutWaitMs);
  }

  private abandon(sessionId: string, result: HistoryViewOpenResult): HistoryViewOpenResult {
    this.marks.delete(sessionId);
    return result;
  }

  private async waitForPhase(sessionId: string): Promise<HistoryViewOpenResult> {
    const budget = this.timing.showWaitMs + this.timing.writeOutWaitMs + this.timing.pollMs;
    const opened = await this.waitFor(() => this.marks.get(sessionId)?.phase !== 'opening', budget);
    return opened && this.marks.get(sessionId)?.phase === 'open' ? 'opened' : 'did-not-open';
  }

  private async waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, this.timing.pollMs));
    }
    return true;
  }
}
