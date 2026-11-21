import type { WebContents } from 'electron';
import type { DictationStartOutcome, DictationStartResult } from '../../shared/types';

/** What the owner map needs from `TranscriptionService`. */
export interface DictationSessionSource {
  isActive(dictationSessionId: string): boolean;
  cancel(dictationSessionId: string): void;
}

/**
 * How long another window's session may hold a press refused. The worker ends
 * a session after ten minutes (`MAX_SESSION_MS` in `dictation-worker.ts`) and
 * a finalize may take 30 seconds more (`FINALIZE_TIMEOUT_MS`), but the expiry
 * never reaches main, so a session wedged in one window would otherwise refuse
 * every other window's press until that window ended it. Past this bound the
 * session still routes its text to its window; it just stops blocking others.
 */
export const OTHER_WINDOW_HOLD_BOUND_MS = 11 * 60 * 1000;

/** The part of a `WebContents` the owner map touches, so a test can hand in a fake. */
export type DictationOwnerContents = Pick<WebContents, 'isDestroyed' | 'send' | 'once' | 'on'>;

/**
 * Which window started each dictation session.
 *
 * Every window runs its own push-to-talk: the main window and each pop-out
 * mount `useDictation`. A session's partial and final text belongs to the
 * window that started it, so they are sent there and nowhere else. Sending to
 * the main window alone left a pop-out's hold with no text.
 *
 * One engine serves every window, so a start from one window is refused while
 * another window's session is still recording or finalizing. A window already
 * refuses its own press while it finalizes (`decidePress`), and this is the
 * same refusal across windows. The same window is never refused: its hook
 * overlaps starts when a release beats the start, and cancels the older one.
 *
 * A window that goes away mid-hold cannot cancel its own session, and a leaked
 * session pins the engine and holds every other window's press refused. So the
 * sessions of a window that is destroyed, crashes, or loads a new page are
 * cancelled here.
 */
export class DictationSessionOwners<Contents extends DictationOwnerContents = WebContents> {
  private readonly owners = new Map<string, Contents>();
  /** When each session started, for `OTHER_WINDOW_HOLD_BOUND_MS`. */
  private readonly startedAt = new Map<string, number>();
  /** Starts awaiting the engine, per window. A second window's start in that
   *  gap would otherwise pass the check below before the first has a session. */
  private readonly pendingStarts = new Map<Contents, number>();
  private readonly watched = new WeakSet<Contents>();

  constructor(
    private readonly source: DictationSessionSource,
    private readonly now: () => number = Date.now,
  ) {}

  /** Start a session for `sender`, or refuse it while another window holds one. */
  async start(sender: Contents, begin: () => Promise<DictationStartResult>): Promise<DictationStartOutcome> {
    if (this.heldByAnotherWindow(sender)) return { refused: 'other-window' };
    this.watch(sender);
    this.pendingStarts.set(sender, (this.pendingStarts.get(sender) ?? 0) + 1);
    let result: DictationStartResult;
    try {
      result = await begin();
    } finally {
      const remaining = (this.pendingStarts.get(sender) ?? 1) - 1;
      if (remaining > 0) this.pendingStarts.set(sender, remaining);
      else this.pendingStarts.delete(sender);
    }
    // The window went away while the engine started: nobody can stop this one.
    if (sender.isDestroyed()) {
      this.source.cancel(result.dictationSessionId);
      return result;
    }
    this.owners.set(result.dictationSessionId, sender);
    this.startedAt.set(result.dictationSessionId, this.now());
    return result;
  }

  /** Send one of a session's pushes to the window that started it. */
  sendToOwner(dictationSessionId: string, channel: string, ...args: unknown[]): void {
    const owner = this.owners.get(dictationSessionId);
    if (!owner || owner.isDestroyed()) return;
    owner.send(channel, ...args);
  }

  /** Forget a session that has ended (stopped or cancelled). */
  release(dictationSessionId: string): void {
    this.owners.delete(dictationSessionId);
    this.startedAt.delete(dictationSessionId);
  }

  /** Whether a window other than `sender` has a session recording or finalizing,
   *  or a start in flight. Drops entries whose window or session is gone,
   *  `sender`'s own included: a session the service ended itself (a finalize
   *  timeout, a worker recycle) never reaches stop or cancel here. */
  heldByAnotherWindow(sender: Contents): boolean {
    for (const [dictationSessionId, owner] of this.owners) {
      if (owner.isDestroyed() || !this.source.isActive(dictationSessionId)) {
        this.release(dictationSessionId);
        continue;
      }
      if (owner === sender) continue;
      const startedAt = this.startedAt.get(dictationSessionId) ?? 0;
      if (this.now() - startedAt > OTHER_WINDOW_HOLD_BOUND_MS) continue;
      return true;
    }
    for (const [pendingSender, count] of this.pendingStarts) {
      if (pendingSender !== sender && count > 0 && !pendingSender.isDestroyed()) return true;
    }
    return false;
  }

  /** Cancel every session `sender` started. */
  private releaseWindow(sender: Contents): void {
    for (const [dictationSessionId, owner] of [...this.owners]) {
      if (owner !== sender) continue;
      this.release(dictationSessionId);
      this.source.cancel(dictationSessionId);
    }
  }

  private watch(sender: Contents): void {
    if (this.watched.has(sender)) return;
    this.watched.add(sender);
    const release = (): void => this.releaseWindow(sender);
    sender.once('destroyed', release);
    sender.on('render-process-gone', release);
    // A reload or a new page unmounts the hook without running its cleanup.
    // Fires for the main frame only; an in-page (hash) change does not.
    sender.on('did-navigate', release);
  }
}
