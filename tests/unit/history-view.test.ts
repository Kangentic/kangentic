/**
 * The find bar's history view in the pty host (`HistoryViews`), driven against a stand-in
 * for Claude Code that answers Ctrl+O and `[` the way the probes measured on 2.1.319:
 * Ctrl+O opens transcript mode from the prompt and returns to the prompt from transcript
 * mode or from a written-out conversation, and `[` in transcript mode leaves the alternate
 * screen. Every other key lands in the prompt, which is the failure this guards: a key sent
 * to the wrong view types into the agent.
 *
 * The view under test is the real `CLAUDE_HISTORY_VIEW`, and its footer check runs on rows
 * captured from Claude Code at 160 and 60 columns.
 */
import { describe, expect, it } from 'vitest';
import { HistoryViews, type HistoryViewTiming } from '../../src/main/pty/host/history-view';
import { CLAUDE_HISTORY_VIEW } from '../../src/main/agent/adapters/claude/history-view';
import type { AgentHistoryView } from '../../src/shared/types';

const FAST: HistoryViewTiming = { showWaitMs: 60, writeOutWaitMs: 60, pollMs: 2 };

const PROMPT_SCREEN = [
  '● Done.',
  '─'.repeat(40),
  '❯ ',
  '─'.repeat(40),
  '  ⏵⏵ auto mode on (shift+tab to cycle)',
];
const TRANSCRIPT_SCREEN = [
  '✻ Crunched for 32m 38s · done 2:45 PM',
  '',
  '─'.repeat(40),
  '  Showing detailed transcript · ctrl+o to toggle · ↑↓ scroll · v to open in editor · ? for shortcuts      verbose ',
  '',
];

type AgentView = 'prompt' | 'transcript' | 'written-out';

/** A Claude Code stand-in. `answers: false` ignores the keys, as a dialog that takes typed text would. */
function standInAgent(options: { answers?: boolean; writesOut?: boolean; start?: AgentView; transcriptScreen?: string[] } = {}) {
  const answers = options.answers ?? true;
  const writesOut = options.writesOut ?? true;
  const transcriptScreen = options.transcriptScreen ?? TRANSCRIPT_SCREEN;
  const state = { view: options.start ?? 'prompt' as AgentView, typedIntoPrompt: '', writes: [] as string[], live: true, writesOut };
  const press = (keys: string) => {
    state.writes.push(keys);
    for (const key of keys) {
      if (!answers) { state.typedIntoPrompt += key; continue; }
      if (key === '\x0f') state.view = state.view === 'prompt' ? 'transcript' : 'prompt';
      else if (key === '[' && state.view === 'transcript') { if (state.writesOut) state.view = 'written-out'; }
      else if (state.view === 'prompt') state.typedIntoPrompt += key;
    }
  };
  /** `null` stands for an agent that declares no history view. */
  const dependencies = (view: AgentHistoryView | null = CLAUDE_HISTORY_VIEW) => ({
    viewFor: () => view ?? undefined,
    screenRows: () => (state.view === 'transcript' ? transcriptScreen : PROMPT_SCREEN),
    inAltScreen: () => state.view !== 'written-out',
    write: (_sessionId: string, keys: string) => {
      if (!state.live) return false;
      press(keys);
      return true;
    },
  });
  return { state, dependencies };
}

describe('HistoryViews.open', () => {
  it('opens transcript mode, waits for it, then writes the conversation out', async () => {
    const agent = standInAgent();
    const views = new HistoryViews(agent.dependencies(), FAST);

    await expect(views.open('session-1')).resolves.toBe('opened');
    expect(agent.state.writes).toEqual(['\x0f', '[']);
    expect(agent.state.view).toBe('written-out');
    expect(agent.state.typedIntoPrompt).toBe('');
    expect(views.isActive('session-1')).toBe(true);
  });

  it('sends only the write-out when the user already has transcript mode open, so Ctrl+O does not close it', async () => {
    const agent = standInAgent({ start: 'transcript' });
    const views = new HistoryViews(agent.dependencies(), FAST);

    await expect(views.open('session-1')).resolves.toBe('opened');
    expect(agent.state.writes).toEqual(['[']);
    expect(agent.state.typedIntoPrompt).toBe('');
  });

  it('types nothing more when the agent never shows transcript mode, and leaves nothing open', async () => {
    const agent = standInAgent({ answers: false });
    const views = new HistoryViews(agent.dependencies(), FAST);

    await expect(views.open('session-1')).resolves.toBe('did-not-open');
    // The toggle is the one key a non-answering view received: no `[` followed it.
    expect(agent.state.writes).toEqual(['\x0f']);
    expect(views.isActive('session-1')).toBe(false);
  });

  it('puts the agent back when its toggle opened a view the footer check does not recognize, and says so', async () => {
    // An update that rewords the footer: transcript mode opens, but nothing reads it as open.
    const reworded = ['✻ Crunched for 32m 38s', '─'.repeat(40), '  Viewing transcript · ctrl+o to toggle', ''];
    const agent = standInAgent({ transcriptScreen: reworded });
    const views = new HistoryViews(agent.dependencies(), FAST);

    await expect(views.open('session-1')).resolves.toBe('unrecognized-view');
    expect(agent.state.writes).toEqual(['\x0f', '\x0f']);
    expect(agent.state.view).toBe('prompt');
    expect(agent.state.typedIntoPrompt).toBe('');
    expect(views.isActive('session-1')).toBe(false);
  });

  it('backs out of the transcript mode it opened when the write-out never leaves the alternate screen', async () => {
    const agent = standInAgent({ writesOut: false });
    const views = new HistoryViews(agent.dependencies(), FAST);

    await expect(views.open('session-1')).resolves.toBe('did-not-open');
    expect(agent.state.writes).toEqual(['\x0f', '[', '\x0f']);
    expect(agent.state.view).toBe('prompt');
    // The back-out showed the agent's own screen, so the `[` wrote nothing out and
    // the mark goes at once, not after the late write-out's bound.
    expect(views.isActive('session-1')).toBe(false);
  });

  it('refuses an agent with no history view, and a terminal already off the alternate screen', async () => {
    const unsupported = standInAgent();
    await expect(new HistoryViews(unsupported.dependencies(null), FAST).open('session-1')).resolves.toBe('unsupported');

    const classic = standInAgent({ start: 'written-out' });
    await expect(new HistoryViews(classic.dependencies(), FAST).open('session-1')).resolves.toBe('not-fullscreen');
    expect(unsupported.state.writes).toEqual([]);
    expect(classic.state.writes).toEqual([]);
  });

  it('answers not-running when the session goes while it waits', async () => {
    const agent = standInAgent({ answers: false });
    const views = new HistoryViews(agent.dependencies(), FAST);
    const opening = views.open('session-1');
    views.remove('session-1');
    await expect(opening).resolves.toBe('not-running');
  });

  it('serves a second open from the view the first one opened', async () => {
    const agent = standInAgent();
    const views = new HistoryViews(agent.dependencies(), FAST);
    const [first, second] = await Promise.all([views.open('session-1'), views.open('session-1')]);
    expect([first, second]).toEqual(['opened', 'opened']);
    expect(agent.state.writes).toEqual(['\x0f', '[']);
  });
});

describe('HistoryViews.close', () => {
  it('returns the agent to its prompt with Ctrl+O, and the return ends the view', async () => {
    const agent = standInAgent();
    const views = new HistoryViews(agent.dependencies(), FAST);
    await views.open('session-1');

    views.close('session-1');
    expect(agent.state.writes).toEqual(['\x0f', '[', '\x0f']);
    expect(agent.state.view).toBe('prompt');
    views.noteAltScreenEnter('session-1');
    expect(views.isActive('session-1')).toBe(false);
  });

  it('types nothing when the user already left the view from the pane', async () => {
    const agent = standInAgent();
    const views = new HistoryViews(agent.dependencies(), FAST);
    await views.open('session-1');
    // The user's own Ctrl+O in the pane.
    agent.state.view = 'prompt';
    views.noteAltScreenEnter('session-1');

    views.close('session-1');
    expect(agent.state.writes).toEqual(['\x0f', '[']);
  });

  it('types nothing while the terminal is still on the alternate screen', async () => {
    const agent = standInAgent();
    const views = new HistoryViews(agent.dependencies(), FAST);
    await views.open('session-1');
    agent.state.view = 'prompt';

    views.close('session-1');
    expect(agent.state.writes).toEqual(['\x0f', '[']);
  });

  it('closes a view the bar gave up on while it was still opening, once it opens', async () => {
    const agent = standInAgent();
    const views = new HistoryViews(agent.dependencies(), FAST);
    const opening = views.open('session-1');
    views.close('session-1');

    await expect(opening).resolves.toBe('opened');
    expect(agent.state.writes).toEqual(['\x0f', '[', '\x0f']);
    expect(agent.state.view).toBe('prompt');
  });

  it('does nothing for a session with no view', () => {
    const agent = standInAgent();
    new HistoryViews(agent.dependencies(), FAST).close('session-1');
    expect(agent.state.writes).toEqual([]);
  });
});

describe('HistoryViews.close, when the close does not land', () => {
  it('clears the mark at once when the toggle cannot be typed', async () => {
    const agent = standInAgent();
    const views = new HistoryViews(agent.dependencies(), FAST);
    await views.open('session-1');
    agent.state.live = false;

    views.close('session-1');
    expect(views.isActive('session-1')).toBe(false);
  });

  it('keeps the mark while the agent has not gone back, and drops it after writeOutWaitMs', async () => {
    const agent = standInAgent();
    const views = new HistoryViews(agent.dependencies(), FAST);
    await views.open('session-1');

    views.close('session-1');
    // The toggle went out but the stream never entered the alternate screen.
    expect(agent.state.writes).toEqual(['\x0f', '[', '\x0f']);
    expect(views.isActive('session-1')).toBe(true);
    await expect.poll(() => views.isActive('session-1'), { timeout: 1000, interval: 10 }).toBe(false);
  });
});

describe('HistoryViews.open, when the write-out outlasts its wait', () => {
  /** The `[` is typed and the agent leaves transcript mode, so the late write-out is still to come. */
  async function openWithLateWriteOut(options: { screenMovesAfterBracket: boolean }) {
    const agent = standInAgent({ writesOut: false });
    const dependencies = agent.dependencies();
    if (options.screenMovesAfterBracket) {
      // The screen is no longer the history view when the wait runs out.
      dependencies.screenRows = () => (
        agent.state.writes.includes('\x0f') && !agent.state.writes.includes('[') ? TRANSCRIPT_SCREEN : PROMPT_SCREEN
      );
    }
    const views = new HistoryViews(dependencies, FAST);
    const result = await views.open('session-1');
    return { agent, views, result };
  }

  it('resolves did-not-open with the mark gone once the toggle went back and the agent shows its own screen', async () => {
    const { agent, views, result } = await openWithLateWriteOut({ screenMovesAfterBracket: false });
    expect(result).toBe('did-not-open');
    expect(views.isActive('session-1')).toBe(false);
    expect(agent.state.writes).toEqual(['\x0f', '[', '\x0f']);

    // The toggle already went back, so nothing more is typed.
    views.noteAltScreenExit('session-1');
    expect(agent.state.writes).toEqual(['\x0f', '[', '\x0f']);
  });

  it('types the toggle exactly once when the late write-out lands, if it was not sent back', async () => {
    const { agent, views, result } = await openWithLateWriteOut({ screenMovesAfterBracket: true });
    expect(result).toBe('did-not-open');
    expect(views.isActive('session-1')).toBe(true);
    expect(agent.state.writes).toEqual(['\x0f', '[']);

    views.noteAltScreenExit('session-1');
    expect(agent.state.writes).toEqual(['\x0f', '[', '\x0f']);
    views.noteAltScreenExit('session-1');
    expect(agent.state.writes).toEqual(['\x0f', '[', '\x0f']);
  });

  it('drops the mark after writeOutWaitMs, so the toggle is never typed later', async () => {
    const { agent, views } = await openWithLateWriteOut({ screenMovesAfterBracket: true });
    await expect.poll(() => views.isActive('session-1'), { timeout: 1000, interval: 10 }).toBe(false);
    views.noteAltScreenExit('session-1');
    expect(agent.state.writes).toEqual(['\x0f', '[']);
  });
});

describe('HistoryViews.open while the previous view is closing', () => {
  it('waits for the agent to go back, then opens afresh', async () => {
    const agent = standInAgent();
    const views = new HistoryViews(agent.dependencies(), FAST);
    await expect(views.open('session-1')).resolves.toBe('opened');
    // The bar closed: the toggle is out and the stream has not entered the alternate screen yet.
    views.close('session-1');
    expect(agent.state.writes).toEqual(['\x0f', '[', '\x0f']);

    const reopening = views.open('session-1');
    // Nothing typed while it waits.
    expect(agent.state.writes).toEqual(['\x0f', '[', '\x0f']);
    views.noteAltScreenEnter('session-1');

    await expect(reopening).resolves.toBe('opened');
    expect(agent.state.writes).toEqual(['\x0f', '[', '\x0f', '\x0f', '[']);
    expect(agent.state.view).toBe('written-out');
  });
});

describe('HistoryViews.open, concurrent and unanswered', () => {
  it('resolves both callers did-not-open when the agent never answers, and types the toggle once', async () => {
    const agent = standInAgent({ answers: false });
    const views = new HistoryViews(agent.dependencies(), FAST);

    const results = await Promise.all([views.open('session-1'), views.open('session-1')]);
    expect(results).toEqual(['did-not-open', 'did-not-open']);
    expect(agent.state.writes).toEqual(['\x0f']);
    expect(views.isActive('session-1')).toBe(false);
  });
});

describe('HistoryViews.open, a bar that closes and reopens while the first open is under way', () => {
  it('cancels the close the first bar asked for, so the view the second bar opened stays open', async () => {
    const agent = standInAgent();
    const views = new HistoryViews(agent.dependencies(), FAST);

    const first = views.open('session-1');
    views.close('session-1');
    const second = views.open('session-1');

    await expect(Promise.all([first, second])).resolves.toEqual(['opened', 'opened']);
    // No third key: the second bar wants the written-out conversation, so the agent stays in it.
    expect(agent.state.writes).toEqual(['\x0f', '[']);
    expect(agent.state.view).toBe('written-out');
    expect(views.isActive('session-1')).toBe(true);
  });

  it('answers opened without typing again when the view is already open', async () => {
    const agent = standInAgent();
    const views = new HistoryViews(agent.dependencies(), FAST);
    await views.open('session-1');

    await expect(views.open('session-1')).resolves.toBe('opened');
    expect(agent.state.writes).toEqual(['\x0f', '[']);
  });
});

describe('HistoryViews.open, when a key cannot be typed', () => {
  it('answers not-running and leaves no mark when the toggle cannot be typed', async () => {
    const agent = standInAgent();
    agent.state.live = false;
    const views = new HistoryViews(agent.dependencies(), FAST);

    await expect(views.open('session-1')).resolves.toBe('not-running');
    expect(agent.state.writes).toEqual([]);
    expect(views.isActive('session-1')).toBe(false);
  });

  it('answers not-running and leaves no mark when the write-out key cannot be typed', async () => {
    const agent = standInAgent();
    const dependencies = agent.dependencies();
    const typeKeys = dependencies.write;
    // The PTY goes after the toggle: only the write-out key fails.
    dependencies.write = (sessionId: string, keys: string) => (keys === '[' ? false : typeKeys(sessionId, keys));
    const views = new HistoryViews(dependencies, FAST);

    await expect(views.open('session-1')).resolves.toBe('not-running');
    expect(views.isActive('session-1')).toBe(false);
  });
});

describe('CLAUDE_HISTORY_VIEW.isShowing', () => {
  it('reads transcript mode off the footer, at 160 columns and cut at 60', () => {
    expect(CLAUDE_HISTORY_VIEW.isShowing(TRANSCRIPT_SCREEN)).toBe(true);
    expect(CLAUDE_HISTORY_VIEW.isShowing(['✻ Crunched for 32m 38s', '─'.repeat(60), '  Showing detailed transcript · ctrl+o to toggle · ?…verbose', ''])).toBe(true);
  });

  it('never reads the prompt view as transcript mode, even when the conversation quotes the footer', () => {
    expect(CLAUDE_HISTORY_VIEW.isShowing(PROMPT_SCREEN)).toBe(false);
    expect(CLAUDE_HISTORY_VIEW.isShowing(['  The footer reads Showing detailed transcript in that mode.', ...PROMPT_SCREEN])).toBe(false);
    expect(CLAUDE_HISTORY_VIEW.isShowing([])).toBe(false);
  });
});
