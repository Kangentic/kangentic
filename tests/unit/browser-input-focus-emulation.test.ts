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
  dragFromTo,
  getDialogEntries,
  getNetworkEntries,
  hoverSelector,
  scrollBy,
  selectOptionOnSelector,
  setDialogResponse,
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
    /** Fire a CDP event at the attached listener, as Chromium would. */
    emit: (method: string, params: unknown) => {
      for (const handler of listeners.message ?? []) {
        (handler as unknown as (event: unknown, method: string, params: unknown) => void)(
          {},
          method,
          params,
        );
      }
    },
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
  it('enables exactly the domains it uses', () => {
    const { guest, methods } = fakeGuest();
    attachDebugger(guest);
    // `Page` is load-bearing and NOT free: enabling it moves JavaScript
    // dialogs off Chromium's own UI and onto the debugger, so the message
    // listener must answer every one (see the dialog cases below). Enabling
    // it without that handler would wedge the page on the first `confirm()`.
    expect(methods()).toEqual([
      'Console.enable',
      'DOM.enable',
      'Runtime.enable',
      'CSS.enable',
      'Network.enable',
      'Page.enable',
    ]);
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

  it('typeText sends a keyDown CARRYING the text, then a keyUp, per character', async () => {
    // The keyDown fires the page's keydown handlers (React key filtering,
    // search-as-you-type, per-keystroke validation, editor hotkeys) and inserts
    // the text only if none of them cancelled it, which is how a real keyboard
    // behaves.
    const { guest, sent } = fakeGuest();
    attachDebugger(guest);
    sent.length = 0;

    await typeText(guest, 'a1');

    expect(sent.map((entry) => entry.params)).toEqual([
      { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, text: 'a', unmodifiedText: 'a' },
      { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 },
      { type: 'keyDown', key: '1', code: 'Digit1', windowsVirtualKeyCode: 49, text: '1', unmodifiedText: '1' },
      { type: 'keyUp', key: '1', code: 'Digit1', windowsVirtualKeyCode: 49 },
    ]);
    expect(sent.every((entry) => entry.method === 'Input.dispatchKeyEvent')).toBe(true);
    detachDebugger(guest);
  });

  it('never sends a separate char event, which typed every character twice in xterm', async () => {
    // The text used to ride a separate `char` after a text-free keyDown.
    // Measured against a live guest (task #720): xterm.js received every
    // character twice, a field whose keydown handler cancelled letters received
    // them anyway, `"query\n"` submitted no form, and `"a\nb"` reached a
    // textarea as `ab`. Putting the text on the keyDown fixed all four.
    const { guest, sent } = fakeGuest();
    attachDebugger(guest);
    sent.length = 0;

    await typeText(guest, 'ab\n');

    expect(sent.some((entry) => (entry.params as { type: string }).type === 'char')).toBe(false);
    detachDebugger(guest);
  });

  it('typeText sends a newline as Enter carrying \\r, which is what submits a form', async () => {
    const { guest, sent } = fakeGuest();
    attachDebugger(guest);
    sent.length = 0;

    await typeText(guest, '\n');

    expect(sent.map((entry) => entry.params)).toEqual([
      { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' },
      { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
    ]);
    detachDebugger(guest);
  });

  it('typeText normalizes a CRLF line ending to ONE Enter, not two', async () => {
    // \r\n is a single newline, and the loop must press Enter once for it. A
    // CRLF line that pressed Enter twice submitted a form twice.
    const { guest, sent } = fakeGuest();
    attachDebugger(guest);
    sent.length = 0;

    await typeText(guest, 'a\r\nb');

    expect(sent.map((entry) => entry.params)).toEqual([
      { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, text: 'a', unmodifiedText: 'a' },
      { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 },
      { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' },
      { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
      { type: 'keyDown', key: 'b', code: 'KeyB', windowsVirtualKeyCode: 66, text: 'b', unmodifiedText: 'b' },
      { type: 'keyUp', key: 'b', code: 'KeyB', windowsVirtualKeyCode: 66 },
    ]);
    detachDebugger(guest);
  });

  it('typeText still carries a plausible key for a symbol it has no code for', async () => {
    // A physical `code` for punctuation would be a lie on any non-US layout, so
    // only `key` is claimed. Handlers key off `event.key`, which is what matters.
    const { guest, sent } = fakeGuest();
    attachDebugger(guest);
    sent.length = 0;

    await typeText(guest, '!');

    expect(sent[0].params).toMatchObject({ type: 'keyDown', key: '!', text: '!' });
    expect(sent[0].params).not.toHaveProperty('code');
    expect(sent[1].params).toMatchObject({ type: 'keyUp', key: '!' });
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
    expect(sent[0].params).not.toHaveProperty('text');
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

  /** A guest that never acknowledges a mouse move, the way a hidden window
   *  behaves until Chromium's fallback timer fires seconds later. */
  function guestWithheldMoveAcks(quad: number[]) {
    const fake = fakeGuest(resolvableNode(quad));
    const fakeDebugger = (fake.guest as unknown as { debugger: { sendCommand: (method: string, params?: Record<string, unknown>) => Promise<unknown> } }).debugger;
    const answerEverythingElse = fakeDebugger.sendCommand;
    fakeDebugger.sendCommand = (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseMoved') {
        fake.sent.push({ method, params });
        return new Promise(() => {});
      }
      return answerEverythingElse(method, params);
    };
    return fake;
  }

  it('clickAtCenterOfSelector bounds its wait for the mouseMoved acknowledgement, which a hidden window withholds', async () => {
    // Chromium queues a mouse move until the next animation frame, and a
    // minimized or fully occluded window (where a preview an agent drives
    // usually sits) produces none, so the move's reply waits on a fallback
    // timer. Measured on Electron 41 with the window minimized: 5.0s per
    // selector click, every one reported as a timeout at the MCP layer even
    // though each landed, while a coordinate click (no move) took 1-3ms. The
    // move stays queued and precedes the press when the press flushes the
    // queue; only the wait for its reply is capped. This fake never answers
    // the move at all, so the old fully awaited form hangs here.
    const { guest, sent } = guestWithheldMoveAcks([10, 20, 110, 20, 110, 40, 10, 40]);
    attachDebugger(guest);

    const clicked = clickAtCenterOfSelector(guest, '#target');
    const ok = await Promise.race([
      clicked,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('the click waited on the mouseMoved reply')), 1000);
      }),
    ]);

    expect(ok).toBe(true);
    const mouse = sent.filter((entry) => entry.method === 'Input.dispatchMouseEvent');
    expect(mouse.map((entry) => (entry.params as { type: string }).type))
      .toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
    detachDebugger(guest);
  });

  it('dragFromTo bounds the wait on every intermediate move, so a hidden window does not cost seconds per step', async () => {
    // Same mechanism as the click, multiplied by the step count: a ten-step
    // drag in a minimized window took 50s. Three withheld steps must finish
    // well inside a second, and the release must still follow every move.
    const { guest, sent } = guestWithheldMoveAcks([10, 20, 110, 20, 110, 40, 10, 40]);
    attachDebugger(guest);

    const dragged = dragFromTo(guest, '#from', '#to', { steps: 3 });
    const ok = await Promise.race([
      dragged,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('the drag waited on a mouseMoved reply')), 1500);
      }),
    ]);

    expect(ok).toBe(true);
    const mouse = sent.filter((entry) => entry.method === 'Input.dispatchMouseEvent');
    expect(mouse.map((entry) => (entry.params as { type: string }).type))
      .toEqual(['mousePressed', 'mouseMoved', 'mouseMoved', 'mouseMoved', 'mouseReleased']);
    detachDebugger(guest);
  });

  it('dragFromTo re-resolves the source after the target, because DOM.getDocument re-issues every node id', async () => {
    // A node id is valid only until the next DOM.getDocument, and a CSS resolve
    // calls it each time. Holding the source id across the target's resolve
    // made every two-selector drag fail as "selector did not match": the stale
    // id's box read as null. This fake re-issues ids per getDocument and
    // rejects any command that names an id from an older generation, the way
    // Chromium does.
    const fromQuad = [10, 20, 110, 20, 110, 40, 10, 40];
    const toQuad = [10, 220, 110, 220, 110, 240, 10, 240];
    const sent: SentCommand[] = [];
    let generation = 0;
    const issued = new Map<number, number>();
    const guest = {
      isDestroyed: () => false,
      debugger: {
        attach: vi.fn(),
        detach: vi.fn(),
        sendCommand: vi.fn((method: string, params?: Record<string, unknown>) => {
          sent.push({ method, params });
          if (method === 'DOM.getDocument') {
            generation += 1;
            return Promise.resolve({ root: { nodeId: generation * 100 } });
          }
          if (method === 'DOM.querySelector') {
            const nodeId = generation * 100 + (params?.selector === '#from' ? 1 : 2);
            issued.set(nodeId, generation);
            return Promise.resolve({ nodeId });
          }
          if (method === 'DOM.scrollIntoViewIfNeeded' || method === 'DOM.getBoxModel') {
            const nodeId = params?.nodeId as number;
            if (issued.get(nodeId) !== generation) {
              return Promise.reject(new Error(`Could not find node with given id ${nodeId}`));
            }
            const content = nodeId % 100 === 1 ? fromQuad : toQuad;
            return Promise.resolve({ model: { content, width: 100, height: 20 } });
          }
          return Promise.resolve({});
        }),
        on: () => {},
        removeListener: () => {},
      },
    } as unknown as WebContents;
    attachDebugger(guest);

    const ok = await dragFromTo(guest, '#from', '#to', { steps: 2 });

    expect(ok).toBe(true);
    const mouse = sent
      .filter((entry) => entry.method === 'Input.dispatchMouseEvent')
      .map((entry) => entry.params as { type: string; x: number; y: number });
    expect(mouse.map((entry) => entry.type)).toEqual(['mousePressed', 'mouseMoved', 'mouseMoved', 'mouseReleased']);
    expect(mouse[0]).toMatchObject({ x: 60, y: 30 });
    expect(mouse[3]).toMatchObject({ x: 60, y: 230 });
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
      { type: 'keyDown', key: 'A', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 8, text: 'A', unmodifiedText: 'A' },
      { type: 'keyUp', key: 'A', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 8 },
    ]);
    detachDebugger(guest);
  });

  it('dispatchKeypress Enter carries \\r so it submits a form, but a Ctrl+Enter shortcut carries none', async () => {
    // Without text, Enter reached a form's input and submitted nothing
    // (measured, task #720). Any modifier other than Shift makes it a shortcut,
    // which types nothing on a real keyboard either.
    const { guest, sent } = fakeGuest();
    attachDebugger(guest);
    sent.length = 0;

    await dispatchKeypress(guest, 'Enter');
    await dispatchKeypress(guest, 'Ctrl+Enter');

    expect(sent[0].params).toMatchObject({ type: 'keyDown', key: 'Enter', text: '\r', unmodifiedText: '\r' });
    expect(sent[1].params).toMatchObject({ type: 'keyUp', key: 'Enter' });
    expect(sent[1].params).not.toHaveProperty('text');
    expect(sent[2].params).toMatchObject({ type: 'keyDown', key: 'Enter', modifiers: 2 });
    expect(sent[2].params).not.toHaveProperty('text');
    detachDebugger(guest);
  });

  it('dispatchKeypress SHIFT+Enter still carries \\r, since Shift is the one modifier that keeps Enter as text', async () => {
    // Shift+Enter is the soft-newline chord in many editors, not a shortcut,
    // so it must carry the same \r a bare Enter does (the case above). Any
    // OTHER modifier turns Enter into a shortcut with no text, which the
    // Ctrl+Enter case above already pins. The rule (see `producesText` in
    // cdp.ts) is: a special key that produces text keeps that text only when
    // no modifier OTHER than Shift is held.
    const { guest, sent } = fakeGuest();
    attachDebugger(guest);
    sent.length = 0;

    const dispatchedOk = await dispatchKeypress(guest, 'Shift+Enter');

    expect(dispatchedOk).toBe(true);
    // Shift = 8.
    expect(sent.map((entry) => entry.params)).toEqual([
      { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8, text: '\r', unmodifiedText: '\r' },
      { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8 },
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

    expect(sent.some((entry) => (entry.params as { text?: string }).text !== undefined)).toBe(false);
    expect(sent.map((entry) => (entry.params as { type: string }).type)).toEqual(['keyDown', 'keyUp']);
    detachDebugger(guest);
  });

  it('dispatchKeypress reports the key the way a physical keyboard does, whatever the chord spelling', async () => {
    // A real Ctrl+V press carries `key: 'v'`; handlers compare on it (xterm's
    // paste chord is `key === 'v'`). Spelled `Ctrl+V`, the chord used to arrive
    // with `key: 'V'` and no Shift, an unknown combination that did nothing while
    // the tool reported success. Shift in the chord is what makes the key
    // uppercase, exactly as on a keyboard.
    const { guest, sent } = fakeGuest();
    attachDebugger(guest);
    sent.length = 0;

    await dispatchKeypress(guest, 'Ctrl+V');
    await dispatchKeypress(guest, 'Ctrl+Shift+v');

    expect(sent.map((entry) => entry.params)).toEqual([
      { type: 'keyDown', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 2 },
      { type: 'keyUp', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 2 },
      { type: 'keyDown', key: 'V', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 10 },
      { type: 'keyUp', key: 'V', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 10 },
    ]);
    detachDebugger(guest);
  });

  it('dispatchKeypress leaves a shifted SYMBOL text-free rather than guessing a layout', async () => {
    // Shift+1 is `!` on a US layout and something else on many others, and there
    // is no layout map here. Guessing would be a lie; `type` is the right tool.
    const { guest, sent } = fakeGuest();
    attachDebugger(guest);
    sent.length = 0;

    await dispatchKeypress(guest, 'Shift+1');

    expect(sent.some((entry) => (entry.params as { text?: string }).text !== undefined)).toBe(false);
    detachDebugger(guest);
  });

  it('dispatchKeypress sends the page-navigation keys rather than refusing them', async () => {
    // Found by a live agent run, not by review: PageDown, End and Home all
    // came back `unknown-key`, so a page that handles them itself could not be
    // driven at all.
    //
    // They deliver the KEY, not the browser's default action. Measured against
    // a live guest: two PageDowns on a focused document left `scrollY` at 0,
    // and only `scrollBy`'s wheel event moved it. Do not restore the claim
    // that these scroll - the tool description said so for one commit and it
    // was wrong.
    const { guest, sent } = fakeGuest();
    attachDebugger(guest);

    for (const [combo, key, vk] of [
      ['PageDown', 'PageDown', 34],
      ['PageUp', 'PageUp', 33],
      ['End', 'End', 35],
      ['Home', 'Home', 36],
      ['Delete', 'Delete', 46],
    ] as const) {
      sent.length = 0;
      const ok = await dispatchKeypress(guest, combo);
      expect(ok, `${combo} must be a known key`).toBe(true);
      // A keyDown/keyUp PAIR with no text: these are commands, not typing.
      expect(sent.map((entry) => entry.params)).toEqual([
        { type: 'keyDown', key, code: key, windowsVirtualKeyCode: vk, modifiers: 0 },
        { type: 'keyUp', key, code: key, windowsVirtualKeyCode: vk, modifiers: 0 },
      ]);
    }
    detachDebugger(guest);
  });

  it('dispatchKeypress refuses a SEQUENCE, since the argument is one combo', async () => {
    // The same live run tried "ArrowDown ArrowDown ArrowDown" and got
    // `unknown-key`, which is correct but reads as the key being unsupported
    // rather than the shape being wrong. Pinned so the refusal stays a refusal:
    // silently pressing the first key would be worse than saying no.
    const { guest, sent } = fakeGuest();
    attachDebugger(guest);
    sent.length = 0;

    const ok = await dispatchKeypress(guest, 'ArrowDown ArrowDown');

    expect(ok).toBe(false);
    expect(sent).toEqual([]);
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

  it('dispatchKeypress refuses a combo whose key or modifier is an inherited Object.prototype property', async () => {
    // `SPECIAL_KEY_MAP` and `MODIFIER_FLAGS` are plain objects, so a bare
    // lookup resolves `SPECIAL_KEY_MAP['constructor']` to the inherited
    // Object function and accepts `MODIFIER_FLAGS['toString']` as a known
    // no-op modifier, sending a keyDown with undefined key/code instead of
    // refusing. The own-property checks in `parseKeyCombo` must reject both.
    const { guest, sent } = fakeGuest();
    attachDebugger(guest);
    sent.length = 0;

    const constructorAsTargetRefused = await dispatchKeypress(guest, 'constructor');
    expect(constructorAsTargetRefused).toBe(false);
    expect(sent).toEqual([]);

    const toStringAsModifierRefused = await dispatchKeypress(guest, 'toString+a');
    expect(toStringAsModifierRefused).toBe(false);
    expect(sent).toEqual([]);

    detachDebugger(guest);
  });
});

/**
 * A JavaScript dialog blocks the renderer while it is open. Enabling the CDP
 * `Page` domain moves dialogs off Chromium's own UI and onto the debugger, so
 * from that moment WE own every one: a dialog nobody answers leaves the page
 * blocked with nothing on screen for the user to dismiss, and every later CDP
 * command queues behind it until the drive lock times out.
 *
 * These are not tests of a convenience feature. They pin the thing that makes
 * enabling `Page` safe at all.
 */
describe('JavaScript dialogs', () => {
  const opening = (overrides: Record<string, unknown> = {}) => ({
    type: 'confirm',
    message: 'Delete this item?',
    url: 'http://localhost:5173/',
    ...overrides,
  });

  it('answers EVERY dialog, dismissing by default', () => {
    const { guest, sent, emit } = fakeGuest();
    attachDebugger(guest);
    sent.length = 0;

    emit('Page.javascriptDialogOpening', opening());

    expect(sent).toEqual([
      { method: 'Page.handleJavaScriptDialog', params: { accept: false } },
    ]);
    detachDebugger(guest);
  });

  it('records what the dialog said, so a verification can read it back', () => {
    const { guest, emit } = fakeGuest();
    attachDebugger(guest);

    emit('Page.javascriptDialogOpening', opening());

    expect(getDialogEntries(guest)).toMatchObject([
      { type: 'confirm', message: 'Delete this item?', accepted: false, promptText: null },
    ]);
    detachDebugger(guest);
  });

  it('accepts when armed, and the arm is consumed by ONE dialog', () => {
    // One-shot by default: an agent arms accept, clicks Delete, and the next
    // unrelated confirm does not also get accepted behind its back.
    const { guest, sent, emit } = fakeGuest();
    attachDebugger(guest);
    setDialogResponse(guest, { accept: true, once: true });
    sent.length = 0;

    emit('Page.javascriptDialogOpening', opening());
    emit('Page.javascriptDialogOpening', opening());

    expect(sent).toEqual([
      { method: 'Page.handleJavaScriptDialog', params: { accept: true, promptText: '' } },
      { method: 'Page.handleJavaScriptDialog', params: { accept: false } },
    ]);
    detachDebugger(guest);
  });

  it('keeps answering the same way when the arm persists', () => {
    const { guest, sent, emit } = fakeGuest();
    attachDebugger(guest);
    setDialogResponse(guest, { accept: true, promptText: 'hello', once: false });
    sent.length = 0;

    emit('Page.javascriptDialogOpening', opening({ type: 'prompt' }));
    emit('Page.javascriptDialogOpening', opening({ type: 'prompt' }));

    expect(sent).toEqual([
      { method: 'Page.handleJavaScriptDialog', params: { accept: true, promptText: 'hello' } },
      { method: 'Page.handleJavaScriptDialog', params: { accept: true, promptText: 'hello' } },
    ]);
    detachDebugger(guest);
  });

  it('sends no promptText when dismissing', () => {
    const { guest, sent, emit } = fakeGuest();
    attachDebugger(guest);
    setDialogResponse(guest, { accept: false, promptText: 'ignored', once: false });
    sent.length = 0;

    emit('Page.javascriptDialogOpening', opening({ type: 'prompt' }));

    expect(sent[0].params).toEqual({ accept: false });
    detachDebugger(guest);
  });
});

describe('network capture', () => {
  it('pairs a request with its response and reports the status', () => {
    const { guest, emit } = fakeGuest();
    attachDebugger(guest);

    emit('Network.requestWillBeSent', {
      requestId: '1',
      request: { url: 'http://localhost:5173/api/items', method: 'POST' },
      type: 'Fetch',
      timestamp: 100,
    });
    emit('Network.responseReceived', { requestId: '1', response: { status: 500 }, timestamp: 100.25 });

    expect(getNetworkEntries(guest)).toMatchObject([
      {
        method: 'POST',
        url: 'http://localhost:5173/api/items',
        resourceType: 'Fetch',
        status: 500,
        durationMs: 250,
      },
    ]);
    detachDebugger(guest);
  });

  it('reports a request still IN FLIGHT rather than hiding it', () => {
    // A dev server that accepted the connection and went quiet is usually the
    // answer an agent is looking for. Omitting it would make the list say the
    // page finished loading when it did not.
    const { guest, emit } = fakeGuest();
    attachDebugger(guest);

    emit('Network.requestWillBeSent', {
      requestId: '2',
      request: { url: 'http://localhost:5173/api/slow', method: 'GET' },
      timestamp: 5,
    });

    expect(getNetworkEntries(guest)).toMatchObject([
      { url: 'http://localhost:5173/api/slow', status: null },
    ]);
    detachDebugger(guest);
  });

  it('leaks no internal field into a PENDING entry', () => {
    // `getNetworkEntries` returns in-flight requests too, and the start
    // timestamp used to be stashed on the entry and deleted only when it
    // settled - so a pending request shipped an undocumented `startedAt` into
    // the tool response. It is held beside the entry now. The raw value could
    // not be reported anyway: CDP timestamps are a monotonic clock with an
    // arbitrary origin, so only the difference means anything.
    const { guest, emit } = fakeGuest();
    attachDebugger(guest);

    emit('Network.requestWillBeSent', {
      requestId: 'p1',
      request: { url: 'http://localhost:5173/api/pending', method: 'GET' },
      timestamp: 12,
    });

    const [pending] = getNetworkEntries(guest);
    expect(Object.keys(pending).sort()).toEqual(
      ['durationMs', 'errorText', 'method', 'resourceType', 'status', 'ts', 'url'],
    );
    detachDebugger(guest);
  });

  it('bounds the in-flight map, so requests that never settle cannot grow forever', () => {
    // The ring is capped; the pending map was not. A request that never
    // settles is never deleted - an aborted fetch, a long poll, or anything
    // in flight when the page navigates away - so a long session against a
    // dev server leaked one entry per abandoned request.
    const { guest, emit } = fakeGuest();
    attachDebugger(guest);

    for (let index = 0; index < 400; index += 1) {
      emit('Network.requestWillBeSent', {
        requestId: `never-${index}`,
        request: { url: `http://localhost:5173/${index}`, method: 'GET' },
        timestamp: index,
      });
    }

    const entries = getNetworkEntries(guest);
    expect(entries.length, 'the pending map must be bounded like the ring').toBeLessThanOrEqual(300);
    // The OLDEST are dropped, so the most recent in-flight requests survive -
    // which is the half an agent is asking about.
    expect(entries.at(-1)?.url).toBe('http://localhost:5173/399');
    detachDebugger(guest);
  });

  it('records a failure with its error text', () => {
    const { guest, emit } = fakeGuest();
    attachDebugger(guest);

    emit('Network.requestWillBeSent', {
      requestId: '3',
      request: { url: 'http://localhost:9999/', method: 'GET' },
      timestamp: 1,
    });
    emit('Network.loadingFailed', {
      requestId: '3',
      errorText: 'net::ERR_CONNECTION_REFUSED',
      timestamp: 1.01,
    });

    expect(getNetworkEntries(guest)).toMatchObject([
      { url: 'http://localhost:9999/', status: null, errorText: 'net::ERR_CONNECTION_REFUSED' },
    ]);
    detachDebugger(guest);
  });
});

describe('scroll, hover and select', () => {
  it('scrollBy sends a mouseWheel with no button, which Chromium requires', async () => {
    // A wheel event carrying `button: "left"` is rejected outright by
    // `Input.dispatchMouseEvent`, so the pressless default is load-bearing
    // rather than cosmetic.
    const { guest, sent } = fakeGuest({
      'Page.getLayoutMetrics': {
        cssLayoutViewport: { clientWidth: 800, clientHeight: 600 },
        cssContentSize: { width: 800, height: 4000 },
      },
      'Runtime.evaluate': { result: { value: 1 } },
    });
    attachDebugger(guest);
    sent.length = 0;

    const ok = await scrollBy(guest, { deltaY: 600 });

    expect(ok).toBe(true);
    const wheel = sent.find((entry) => entry.method === 'Input.dispatchMouseEvent');
    expect(wheel?.params).toEqual({
      type: 'mouseWheel',
      x: 400,
      y: 300,
      button: 'none',
      clickCount: 0,
      deltaX: 0,
      deltaY: 600,
    });
    detachDebugger(guest);
  });

  it('scrollBy aims at an element when given one, so a panel scrolls and not the page', async () => {
    const { guest, sent } = fakeGuest(resolvableNode([10, 20, 110, 20, 110, 40, 10, 40]));
    attachDebugger(guest);
    sent.length = 0;

    const ok = await scrollBy(guest, { selector: '.list', deltaY: 120 });

    expect(ok).toBe(true);
    const wheel = sent.find((entry) => entry.method === 'Input.dispatchMouseEvent');
    expect(wheel?.params).toMatchObject({ type: 'mouseWheel', x: 60, y: 30, deltaY: 120 });
    detachDebugger(guest);
  });

  it('hoverSelector moves the pointer and presses nothing', async () => {
    const { guest, sent } = fakeGuest(resolvableNode([0, 0, 100, 0, 100, 20, 0, 20]));
    attachDebugger(guest);
    sent.length = 0;

    const ok = await hoverSelector(guest, '.menu');

    expect(ok).toBe(true);
    const mouse = sent.filter((entry) => entry.method === 'Input.dispatchMouseEvent');
    expect(mouse).toHaveLength(1);
    expect(mouse[0].params).toMatchObject({ type: 'mouseMoved', x: 50, y: 10, button: 'none' });
    detachDebugger(guest);
  });

  it('selectOptionOnSelector runs against the RESOLVED node, not the whole page', async () => {
    // `Runtime.callFunctionOn` with an objectId is what keeps this out of the
    // `eval` capability: it is a scoped DOM operation on one element, the same
    // reasoning that lets `type` write text without arbitrary JS.
    const { guest, sent } = fakeGuest({
      'DOM.getDocument': { root: { nodeId: 1 } },
      'DOM.querySelector': { nodeId: 7 },
      'DOM.resolveNode': { object: { objectId: 'obj-7' } },
      'Runtime.callFunctionOn': { result: { value: { ok: true, value: 'uk' } } },
    });
    attachDebugger(guest);
    sent.length = 0;

    const result = await selectOptionOnSelector(guest, '#country', { label: 'United Kingdom' });

    expect(result).toEqual({ ok: true, value: 'uk' });
    const call = sent.find((entry) => entry.method === 'Runtime.callFunctionOn');
    expect(call?.params).toMatchObject({ objectId: 'obj-7', returnByValue: true });
    expect(sent.some((entry) => entry.method === 'Runtime.evaluate')).toBe(false);
    detachDebugger(guest);
  });

  it('selectOptionOnSelector distinguishes "not a select" from "no such option"', async () => {
    // Two different fixes for the agent: one says use click on a custom
    // dropdown, the other says read the options and pass a real value.
    const notSelect = fakeGuest({
      'DOM.getDocument': { root: { nodeId: 1 } },
      'DOM.querySelector': { nodeId: 7 },
      'DOM.resolveNode': { object: { objectId: 'obj-7' } },
      'Runtime.callFunctionOn': { result: { value: { ok: false, reason: 'not-a-select' } } },
    });
    attachDebugger(notSelect.guest);
    expect(await selectOptionOnSelector(notSelect.guest, '.dropdown', { value: 'x' })).toEqual({
      ok: false,
      reason: 'not-a-select',
    });
    detachDebugger(notSelect.guest);

    const noMatch = fakeGuest({
      'DOM.getDocument': { root: { nodeId: 1 } },
      'DOM.querySelector': { nodeId: 7 },
      'DOM.resolveNode': { object: { objectId: 'obj-7' } },
      'Runtime.callFunctionOn': { result: { value: { ok: false, reason: 'no-match' } } },
    });
    attachDebugger(noMatch.guest);
    expect(await selectOptionOnSelector(noMatch.guest, '#country', { value: 'zz' })).toEqual({
      ok: false,
      reason: 'no-match',
    });
    detachDebugger(noMatch.guest);
  });
});
