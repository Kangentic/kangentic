/**
 * showCommandTerminalBrowser (src/renderer/components/command-bar/command-terminal-browser.ts)
 * against the real session store: a link opened from a Command Terminal shows that slot's
 * Browser pane, putting its Changes panel away, and leaves a pane already showing alone.
 * What a user loses if this goes: a link click that opens the browser over a Changes panel
 * both fighting for the terminal's side, or one that closes a pane (or the Changes panel)
 * they already had showing.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useSessionStore } from '../../src/renderer/stores/session-store';
import { commandTerminalChangesEntityId } from '../../src/renderer/stores/session-store/task-changes-panel-slice';
import { showCommandTerminalBrowser } from '../../src/renderer/components/command-bar/command-terminal-browser';
import { commandTerminalBrowserOwner } from '../../src/shared/browser-owner';

const PROJECT = 'project-a';
const SLOT = 'slot-1';
const OWNER_KEY = commandTerminalBrowserOwner(PROJECT, SLOT);
const CHANGES_ID = commandTerminalChangesEntityId(SLOT);

beforeEach(() => {
  useSessionStore.setState({
    browserOpenTasks: new Set(),
    browserHeldTasks: new Set(),
    changesOpenTasks: new Set(),
    changesViewMode: {},
  });
});

describe('showCommandTerminalBrowser', () => {
  it('closes Changes and opens the Browser when Changes is open and the Browser is not', () => {
    useSessionStore.getState().setChangesOpen(CHANGES_ID, true);

    showCommandTerminalBrowser(PROJECT, SLOT);

    const state = useSessionStore.getState();
    expect(state.changesOpenTasks.has(CHANGES_ID)).toBe(false);
    expect(state.browserOpenTasks.has(OWNER_KEY)).toBe(true);
  });

  it('opens the Browser with nothing else open', () => {
    showCommandTerminalBrowser(PROJECT, SLOT);

    const state = useSessionStore.getState();
    expect(state.browserOpenTasks.has(OWNER_KEY)).toBe(true);
    expect(state.changesOpenTasks.has(CHANGES_ID)).toBe(false);
  });

  it('leaves everything as it is when the Browser is already open', () => {
    const state = useSessionStore.getState();
    state.setBrowserOpen(OWNER_KEY, true);
    state.setChangesOpen(CHANGES_ID, true);
    const before = useSessionStore.getState();

    showCommandTerminalBrowser(PROJECT, SLOT);

    const after = useSessionStore.getState();
    expect(after.browserOpenTasks.has(OWNER_KEY)).toBe(true);
    expect(after.changesOpenTasks.has(CHANGES_ID)).toBe(true);
    expect(after.browserOpenTasks).toBe(before.browserOpenTasks);
    expect(after.changesOpenTasks).toBe(before.changesOpenTasks);
  });
});
