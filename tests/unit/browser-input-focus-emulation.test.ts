/**
 * Unit tests for the REAL cdp.ts input and focus-emulation helpers.
 *
 * Nothing in this repo previously asserted on the CDP payloads the browser tools
 * send - every other suite mocks the whole module away - so a change to the wire
 * format of a click or a keystroke was invisible to CI. These pin the payloads
 * and the focus-emulation lifecycle against a spying fake debugger, using the
 * harness shape from browser-screenshot-timeout.test.ts.
 *
 * The focus-emulation cases exist because of a measured behavior, not a theory
 * (Electron 41, live guest): one `Input.dispatchMouseEvent` gives the guest REAL
 * focus, blurring the terminal the user was typing into (activeElement ->
 * WEBVIEW, document.hasFocus() -> false). Emulation keeps the page BEHAVING as
 * focused across the renderer handing that focus back, so a page that hides UI or
 * pauses on blur still works under automation.
 *
 * What emulation does NOT do is affect input ROUTING - measured inside a guest
 * whose keystrokes were being dropped, `document.hasFocus()` was already `true`.
 * Do not restore a stronger claim here; it was wrong once.
 *
 * Hence the first test below: `attachDebugger` must NOT send it, because the dev
 * inspection bridge attaches through the same function against Kangentic's own
 * window, where a permanently-focused page changes `document.hasFocus()` under
 * the app itself.
 *
 * Tier: Unit (vitest; the debugger is a spy, no Electron).
 */
import { describe, it, expect, vi } from 'vitest';
import type { WebContents } from 'electron';
import {
  attachDebugger,
  detachDebugger,
  ensureFocusEmulation,
  dispatchKeypress,
  typeText,
  dispatchMouseEvent,
  clickAtCenterOfSelector,
} from '../../src/main/browser/cdp/cdp';

interface SentCommand {
  method: string;
  params: Record<string, unknown> | undefined;
}

/**
 * A guest whose debugger records every command instead of talking to Chromium.
 * `replies` lets a test stub specific methods (selector resolution, box model).
 */
function fakeGuest(replies: Record<string, unknown> = {}) {
  const sent: SentCommand[] = [];
  const listeners: Record<string, ((...args: never[]) => void)[]> = {};
  const guest = {
    isDestroyed: () => false,
    debugger: {
      attach: vi.fn(),
      detach: vi.fn(),
      sendCommand: vi.fn((method: string, params?: Record<string, unknown>) => {
        sent.push({ method, params });
        return Promise.resolve(replies[method] ?? {});
      }),
      on: (event: string, handler: (...args: never[]) => void) => {
        (listeners[event] ??= []).push(handler);
      },
      removeListener: () => {},
    },
  };
  return {
    sent,
    methods: () => sent.map((entry) => entry.method),
    guest: guest as unknown as WebContents,
  };
}

/** CDP replies that make one selector resolve to a measurable node. */
function resolvableNode(quad: number[]) {
  return {
    'DOM.getDocument': { root: { nodeId: 1 } },
    'DOM.querySelector': { nodeId: 42 },
    'DOM.getBoxModel': { model: { content: quad, width: 100, height: 20 } },
  };
}

describe('attachDebugger', () => {
  it('enables exactly the four domains it uses', () => {
    const { guest, methods } = fakeGuest();
    attachDebugger(guest);
    expect(methods()).toEqual(['Console.enable', 'DOM.enable', 'Runtime.enable', 'CSS.enable']);
    detachDebugger(guest);
  });

  it('does NOT enable focus emulation on its own', () => {
    // The guard on the dev bridge. `src/devtools/install.ts` attaches through
    // this same function against the app's own window; emulating focus there
    // would make Kangentic's own renderer permanently believe it is focused.
    const { guest, methods } = fakeGuest();
    attachDebugger(guest);
    expect(methods()).not.toContain('Emulation.setFocusEmulationEnabled');
    detachDebugger(guest);
  });
});

describe('ensureFocusEmulation', () => {
  it('sends setFocusEmulationEnabled with enabled true', () => {
    const { guest, sent } = fakeGuest();
    attachDebugger(guest);
    ensureFocusEmulation(guest);
    expect(sent).toContainEqual({
      method: 'Emulation.setFocusEmulationEnabled',
      params: { enabled: true },
    });
    detachDebugger(guest);
  });

  it('is a no-op on a second call for the same session', () => {
    const { guest, methods } = fakeGuest();
    attachDebugger(guest);
    ensureFocusEmulation(guest);
    ensureFocusEmulation(guest);
    ensureFocusEmulation(guest);
    const emulationCalls = methods().filter((method) => method === 'Emulation.setFocusEmulationEnabled');
    expect(emulationCalls).toHaveLength(1);
    detachDebugger(guest);
  });

  it('RE-ARMS after a detach and re-attach', () => {
    // Proves the flag rides the per-session attached state rather than a module
    // Set that would leak across sessions and leave a re-attached guest
    // unemulated - which presents as `type` silently doing nothing.
    const { guest, methods } = fakeGuest();
    attachDebugger(guest);
    ensureFocusEmulation(guest);
    detachDebugger(guest);
    attachDebugger(guest);
    ensureFocusEmulation(guest);
    const emulationCalls = methods().filter((method) => method === 'Emulation.setFocusEmulationEnabled');
    expect(emulationCalls).toHaveLength(2);
    detachDebugger(guest);
  });

  it('is inert on an unattached guest, and does not throw', () => {
    const { guest, sent } = fakeGuest();
    expect(() => ensureFocusEmulation(guest)).not.toThrow();
    expect(sent).toEqual([]);
  });
});

describe('input payloads', () => {
  it('dispatchMouseEvent defaults a press to the left button, one click', async () => {
    const { guest, sent } = fakeGuest();
    attachDebugger(guest);
    sent.length = 0;

    await dispatchMouseEvent(guest, { type: 'mousePressed', x: 10, y: 20 });

    expect(sent).toEqual([{
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mousePressed', x: 10, y: 20, button: 'left', clickCount: 1 },
    }]);
    detachDebugger(guest);
  });

  it('dispatchMouseEvent defaults a move to no button and no click count', async () => {
    const { guest, sent } = fakeGuest();
    attachDebugger(guest);
    sent.length = 0;

    await dispatchMouseEvent(guest, { type: 'mouseMoved', x: 1, y: 2 });

    expect(sent[0].params).toMatchObject({ button: 'none', clickCount: 0 });
    detachDebugger(guest);
  });

  it('typeText sends a full keyDown/char/keyUp triple per character', async () => {
    // A bare `char` inserts the text and fires no `keydown`, so any page doing
    // its work in a keydown handler (React key filtering, search-as-you-type,
    // per-keystroke validation, editor hotkeys) sees nothing happen. That reads
    // as "the agent typed and the app ignored it".
    const { guest, sent } = fakeGuest();
    attachDebugger(guest);
    sent.length = 0;

    await typeText(guest, 'a1');

    expect(sent.map((entry) => entry.params)).toEqual([
      { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 },
      { type: 'char', text: 'a' },
      { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 },
      { type: 'keyDown', key: '1', code: 'Digit1', windowsVirtualKeyCode: 49 },
      { type: 'char', text: '1' },
      { type: 'keyUp', key: '1', code: 'Digit1', windowsVirtualKeyCode: 49 },
    ]);
    expect(sent.every((entry) => entry.method === 'Input.dispatchKeyEvent')).toBe(true);
    detachDebugger(guest);
  });

  it('carries text on the char event ONLY, so nothing is typed twice', () => {
    // In CDP a keyDown with a non-empty `text` performs the insertion by itself
    // (that is how Puppeteer types), so carrying `text` on both the keyDown and
    // the char would insert every character twice. The roles are split
    // deliberately: keyDown fires handlers, char inserts - which keeps the
    // insertion path the one that already worked and makes this change
    // incapable of regressing typing.
    const { guest, sent } = fakeGuest();
    attachDebugger(guest);
    sent.length = 0;

    return typeText(guest, 'ab').then(() => {
      const withText = sent.filter((entry) => (entry.params as { text?: string }).text !== undefined);
      expect(withText).toHaveLength(2);
      expect(withText.every((entry) => (entry.params as { type: string }).type === 'char')).toBe(true);
      detachDebugger(guest);
    });
  });

  it('typeText still carries a plausible key for a symbol it has no code for', async () => {
    // A physical `code` for punctuation would be a lie on any non-US layout, so
    // only `key` is claimed. Handlers key off `event.key`, which is what matters.
    const { guest, sent } = fakeGuest();
    attachDebugger(guest);
    sent.length = 0;

    await typeText(guest, '!');

    expect(sent[0].params).toMatchObject({ type: 'keyDown', key: '!' });
    expect(sent[0].params).not.toHaveProperty('code');
    expect(sent[1].params).toMatchObject({ type: 'char', text: '!' });
    detachDebugger(guest);
  });

  it('dispatchKeypress sends a keyDown/keyUp pair with the parsed modifiers', async () => {
    const { guest, sent } = fakeGuest();
    attachDebugger(guest);
    sent.length = 0;

    const ok = await dispatchKeypress(guest, 'Ctrl+Shift+Enter');

    expect(ok).toBe(true);
    // Ctrl = 2, Shift = 8.
    expect(sent[0].params).toMatchObject({ type: 'keyDown', key: 'Enter', code: 'Enter', modifiers: 10 });
    expect(sent[1].params).toMatchObject({ type: 'keyUp', key: 'Enter', code: 'Enter', modifiers: 10 });
    detachDebugger(guest);
  });

  it('clickAtCenterOfSelector scrolls the element into view BEFORE measuring it', async () => {
    // The bug this pins is the worst shape available: `Input.dispatchMouseEvent`
    // takes VIEWPORT coordinates while `DOM.getBoxModel` measures in page space,
    // so a click on anything below the fold was dispatched far outside the
    // viewport, hit nothing, and still reported success. Measured live against a
    // real page: an element 11,122px down reported that y, the click returned
    // ok, and the page never navigated.
    //
    // Order matters as much as presence - measuring before the scroll returns
    // the same useless coordinate, so the scroll must precede getBoxModel.
    const { guest, methods } = fakeGuest(resolvableNode([10, 20, 110, 20, 110, 40, 10, 40]));
    attachDebugger(guest);

    const ok = await clickAtCenterOfSelector(guest, '#target');

    expect(ok).toBe(true);
    const order = methods();
    const scrollIndex = order.indexOf('DOM.scrollIntoViewIfNeeded');
    const measureIndex = order.indexOf('DOM.getBoxModel');
    expect(scrollIndex).toBeGreaterThanOrEqual(0);
    expect(measureIndex).toBeGreaterThan(scrollIndex);
    detachDebugger(guest);
  });

  it('clickAtCenterOfSelector moves the pointer before pressing, so hover-gated UI opens', async () => {
    // Without a mouseMoved the page never sees mouseover/mouseenter, so a
    // dropdown or hover-revealed button is still closed when the press lands and
    // the click hits whatever is underneath.
    const { guest, sent } = fakeGuest(resolvableNode([10, 20, 110, 20, 110, 40, 10, 40]));
    attachDebugger(guest);

    await clickAtCenterOfSelector(guest, '#target');

    const mouse = sent.filter((entry) => entry.method === 'Input.dispatchMouseEvent');
    expect(mouse.map((entry) => (entry.params as { type: string }).type))
      .toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
    // All three at the centroid of the post-scroll box.
    expect(mouse.every((entry) => (entry.params as { x: number }).x === 60)).toBe(true);
    expect(mouse.every((entry) => (entry.params as { y: number }).y === 30)).toBe(true);
    detachDebugger(guest);
  });

  it('clickAtCenterOfSelector reports FALSE when the selector does not resolve', async () => {
    // The honest-failure half of the same bug: a miss must not read as a click.
    const { guest, sent } = fakeGuest({
      'DOM.getDocument': { root: { nodeId: 1 } },
      'DOM.querySelector': { nodeId: 0 },
    });
    attachDebugger(guest);

    const ok = await clickAtCenterOfSelector(guest, '#missing');

    expect(ok).toBe(false);
    expect(sent.some((entry) => entry.method === 'Input.dispatchMouseEvent')).toBe(false);
    detachDebugger(guest);
  });

  it('dispatchKeypress TYPES a shifted letter instead of silently doing nothing', async () => {
    // `Shift+a` used to send a keyDown/keyUp pair with no `text` at all, so it
    // typed nothing while reporting success - contradicting this function's own
    // contract, where a bare `a` types the letter.
    const { guest, sent } = fakeGuest();
    attachDebugger(guest);
    sent.length = 0;

    const ok = await dispatchKeypress(guest, 'Shift+a');

    expect(ok).toBe(true);
    expect(sent.map((entry) => entry.params)).toEqual([
      { type: 'keyDown', key: 'A', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 8 },
      { type: 'char', text: 'A' },
      { type: 'keyUp', key: 'A', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 8 },
    ]);
    detachDebugger(guest);
  });

  it('dispatchKeypress does NOT insert text for a shortcut chord', async () => {
    // Ctrl / Alt / Meta combos are commands, not typing. Inserting a character
    // for Ctrl+a would put an "a" in the field it was meant to select.
    const { guest, sent } = fakeGuest();
    attachDebugger(guest);
    sent.length = 0;

    await dispatchKeypress(guest, 'Ctrl+a');

    expect(sent.some((entry) => (entry.params as { type: string }).type === 'char')).toBe(false);
    expect(sent.map((entry) => (entry.params as { type: string }).type)).toEqual(['keyDown', 'keyUp']);
    detachDebugger(guest);
  });

  it('dispatchKeypress leaves a shifted SYMBOL text-free rather than guessing a layout', async () => {
    // Shift+1 is `!` on a US layout and something else on many others, and there
    // is no layout map here. Guessing would be a lie; `type` is the right tool.
    const { guest, sent } = fakeGuest();
    attachDebugger(guest);
    sent.length = 0;

    await dispatchKeypress(guest, 'Shift+1');

    expect(sent.some((entry) => (entry.params as { type: string }).type === 'char')).toBe(false);
    detachDebugger(guest);
  });

  it('dispatchKeypress refuses an unknown modifier rather than guessing', async () => {
    const { guest, sent } = fakeGuest();
    attachDebugger(guest);
    sent.length = 0;

    const ok = await dispatchKeypress(guest, 'Hyper+Enter');

    expect(ok).toBe(false);
    expect(sent).toEqual([]);
    detachDebugger(guest);
  });
});
