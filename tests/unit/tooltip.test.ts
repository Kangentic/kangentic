/**
 * Pins the pure half of Tooltip (src/renderer/utils/tooltip.ts) and the one structural claim
 * a static render can prove: Tooltip adds no element around its trigger.
 *
 * The open state (hover dwell, focus, Escape, clamping on screen) needs a browser and lives in
 * tests/ui/tooltip.spec.ts. What is here is the arithmetic that spec cannot isolate: where a
 * tip sits at both window edges and when there is no room above, what a screen reader is told,
 * and the warm window with the clock injected.
 *
 * `react-dom/server`, no jsdom, the same pattern as data-table-colgroup.test.ts. The description
 * is an attribute on the trigger (`aria-description`), so a static render shows it.
 *
 * The same static render covers what the controls built on Tooltip hand it: the element a Pill
 * stays, the description each `disabledReason` and `tip` produces, and how `describe` and `detail`
 * reach the trigger. A handler cannot be read from markup, so the two checks that need one
 * (a click chained only onto a child that has its own, an empty label arming no dwell timer) record
 * what a probe child receives and call it with a stubbed `window`.
 *
 * The same harness pins what an event aimed at the trigger does. No tip layer mounts in a static
 * render, so `show` and `hide` are silent no-ops there. What a handler leaves behind is read
 * through the two calls it can still make on the stubbed `window`: `setTimeout` when a pointer move
 * arms the dwell, and `clearTimeout` when something cancels a dwell that is pending.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { installTabFocusTracker } from '../../src/renderer/utils/tab-focus';
import {
  TOOLTIP_WARM_MS,
  TIP_OFFSET,
  VIEWPORT_PADDING,
  claimTip,
  isTipWarm,
  placeTip,
  releaseTip,
  repeatsTriggerName,
  resetTipStateForTests,
  showsDisabledReason,
  tipDescription,
  tipLabel,
} from '../../src/renderer/utils/tooltip';
import { Tooltip, type TooltipProps } from '../../src/renderer/components/Tooltip';
import { Pill } from '../../src/renderer/components/Pill';
import { HeaderActionButton } from '../../src/renderer/components/HeaderActionButton';
import { KebabMenuCheckItem } from '../../src/renderer/components/KebabMenu';
import { SegmentedControl, type SegmentedControlOption } from '../../src/renderer/components/SegmentedControl';
import { ToggleSwitch } from '../../src/renderer/components/settings/shared';
import { ButtonGroup } from '../../src/renderer/components/ButtonGroup';
import { IsolatedBadge, IsolatedIcon } from '../../src/renderer/components/IsolatedBadge';

const VIEWPORT = { width: 1000, height: 800 };

function anchorAt(left: number, top: number, width = 30, height = 30) {
  return { left, top, bottom: top + height, width };
}

describe('placeTip', () => {
  it('centres the tip above the trigger when there is room', () => {
    const placement = placeTip(anchorAt(485, 400), { width: 100, height: 24 }, VIEWPORT);
    expect(placement).toEqual({ left: 450, top: 400 - TIP_OFFSET - 24, side: 'above' });
  });

  it('clamps to the left padding for a trigger at the left edge', () => {
    const placement = placeTip(anchorAt(0, 400), { width: 200, height: 24 }, VIEWPORT);
    expect(placement.left).toBe(VIEWPORT_PADDING);
  });

  it('clamps to the right padding for a trigger at the right edge', () => {
    const placement = placeTip(anchorAt(970, 400), { width: 200, height: 24 }, VIEWPORT);
    expect(placement.left + 200).toBe(VIEWPORT.width - VIEWPORT_PADDING);
  });

  it('flips below when the space above is shorter than the tip', () => {
    const placement = placeTip(anchorAt(485, 20), { width: 100, height: 24 }, VIEWPORT);
    expect(placement.side).toBe('below');
    expect(placement.top).toBe(50 + TIP_OFFSET);
  });

  it('keeps a tip that fits neither side inside the window', () => {
    const placement = placeTip(anchorAt(485, 20, 30, 760), { width: 100, height: 300 }, VIEWPORT);
    expect(placement.side).toBe('below');
    expect(placement.top).toBe(VIEWPORT.height - VIEWPORT_PADDING - 300);
  });

  it('starts a tip wider than the window at the left padding', () => {
    const placement = placeTip(anchorAt(485, 400), { width: 1200, height: 24 }, VIEWPORT);
    expect(placement.left).toBe(VIEWPORT_PADDING);
  });
});

describe('tipDescription', () => {
  it('is empty for an icon button whose tip is its own name and which has no shortcut', () => {
    expect(repeatsTriggerName('Close', 'Close')).toBe(true);
    expect(tipDescription({ label: 'Close', readLabel: false, combo: '' })).toBe('');
  });

  it('is the shortcut alone when the label is the trigger\'s name', () => {
    expect(tipDescription({ label: 'Close', readLabel: false, combo: 'Ctrl+Shift+W' })).toBe('Ctrl+Shift+W');
  });

  it('is the reason for a disabled control named for its action', () => {
    expect(repeatsTriggerName('No conversation history for this task yet', 'View conversation')).toBe(false);
    expect(tipDescription({ label: 'No conversation history for this task yet', readLabel: true, combo: '' }))
      .toBe('No conversation history for this task yet');
  });

  it('carries the label with its shortcut, and the detail on its own line', () => {
    expect(tipDescription({ label: 'Show changes', readLabel: true, combo: 'Ctrl+Shift+G', detail: 'Uncommitted only' }))
      .toBe('Show changes (Ctrl+Shift+G)\nUncommitted only');
  });

  it('compares names without case or extra whitespace', () => {
    expect(repeatsTriggerName('  Pop   out ', 'pop out')).toBe(true);
    expect(repeatsTriggerName('Pop out', undefined)).toBe(false);
  });
});

describe('the warm window', () => {
  beforeEach(() => resetTipStateForTests());

  it('is warm while a tip shows and for TOOLTIP_WARM_MS after a warm close', () => {
    const close = (): void => {};
    expect(isTipWarm(1000)).toBe(false);
    claimTip(close);
    expect(isTipWarm(1000)).toBe(true);
    releaseTip(close, true, 1000);
    expect(isTipWarm(1000 + TOOLTIP_WARM_MS - 1)).toBe(true);
    expect(isTipWarm(1000 + TOOLTIP_WARM_MS)).toBe(false);
  });

  it('is cold right after a cold close (Escape, a press)', () => {
    const close = (): void => {};
    claimTip(close);
    releaseTip(close, false, 1000);
    expect(isTipWarm(1001)).toBe(false);
  });

  it('closes the tip on screen when another claims the slot', () => {
    let firstClosed = false;
    const closeFirst = (): void => {
      firstClosed = true;
      releaseTip(closeFirst, true, 1000);
    };
    const closeSecond = (): void => {};
    claimTip(closeFirst);
    claimTip(closeSecond);
    expect(firstClosed).toBe(true);
    // The second tip closes cold, so a warm window can only come from the first tip's release,
    // which counts only if the claim closed it while it still held the slot.
    releaseTip(closeSecond, false, 1000);
    expect(isTipWarm(1000)).toBe(true);
    expect(isTipWarm(1000 + TOOLTIP_WARM_MS)).toBe(false);
  });

  it('ignores a release from a tip that no longer holds the slot', () => {
    const stale = (): void => {};
    const current = (): void => {};
    claimTip(current);
    releaseTip(stale, false, 1000);
    expect(isTipWarm(5000)).toBe(true);
  });
});

describe('Tooltip markup', () => {
  it('adds no element around its trigger', () => {
    const markup = renderToStaticMarkup(
      createElement(Tooltip, { label: 'Close' }, createElement('button', { 'aria-label': 'Close', className: 'flex-1' })),
    );
    expect(markup.startsWith('<button')).toBe(true);
    expect(markup).toContain('class="flex-1"');
    expect(markup).not.toContain('aria-description');
  });

  it('describes a trigger whose tip says more than its name', () => {
    const markup = renderToStaticMarkup(
      createElement(Tooltip, { label: 'Why it is off' }, createElement('button', { 'aria-label': 'Action', disabled: true })),
    );
    expect(markup.startsWith('<button')).toBe(true);
    expect(markup).toContain('aria-description="Why it is off"');
  });

  it('keeps the trigger\'s own props beside the ones it adds', () => {
    const markup = renderToStaticMarkup(
      createElement(Tooltip, { label: 'More' }, createElement('button', { 'aria-label': 'Action', 'data-testid': 'own' })),
    );
    expect(markup).toContain('data-testid="own"');
    expect(markup).toContain('aria-label="Action"');
    expect(markup).toContain('aria-description="More"');
  });
});

// ---------------------------------------------------------------------------
// Static-render helpers. A tip's description is an attribute on its trigger, so a render shows it.
// Test strings below avoid apostrophes and ampersands: React writes those into an attribute as
// entities, and only a newline is kept literal.
// ---------------------------------------------------------------------------

const noop = (): void => {};

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** The `aria-description` in one opening tag, or null when the tag carries none. */
function descriptionIn(openingTag: string): string | null {
  const match = /\saria-description="([^"]*)"/.exec(openingTag);
  return match === null ? null : decodeEntities(match[1]);
}

/** The opening tag the markup starts with. Tooltip adds no wrapper, so that is the trigger. */
function rootTag(markup: string): string {
  const match = /^<[a-z][^>]*>/.exec(markup);
  if (match === null) throw new Error(`Markup does not start with an element: ${markup}`);
  return match[0];
}

/** The opening tag that carries `data-testid="<testId>"`, for a markup with several triggers. */
function tagWithTestId(markup: string, testId: string): string {
  const found = (markup.match(/<[a-z][^>]*>/g) ?? []).find((tag) => tag.includes(`data-testid="${testId}"`));
  if (found === undefined) throw new Error(`No element with data-testid="${testId}" in: ${markup}`);
  return found;
}

/** The description of a trigger rendered as the root of `markup`. */
function rootDescription(markup: string): string | null {
  return descriptionIn(rootTag(markup));
}

/**
 * The props a component child actually receives from Tooltip. A static render cannot show a
 * handler, so a probe child records what Tooltip passed it.
 */
function captureTriggerProps(tipProps: Omit<TooltipProps, 'children'>, childProps: Record<string, unknown>): Record<string, unknown> {
  let captured: Record<string, unknown> = {};
  function Probe(received: Record<string, unknown>) {
    captured = received;
    return createElement('span');
  }
  renderToStaticMarkup(createElement(Tooltip, tipProps, createElement(Probe, childProps)));
  return captured;
}

function GlyphIcon() {
  return createElement('svg');
}

describe('Tooltip around a Pill', () => {
  // Pill picks <button> when it has a non-null onClick, and a <span> otherwise. Tooltip used to
  // inject an onClick into every child, which turned a plain label pill into a button.
  // The Pill's text lives in an inner span either way, so the root tag is what tells them apart.
  it('keeps a Pill with no onClick a span', () => {
    const markup = renderToStaticMarkup(
      createElement(Tooltip, { label: 'Why it is shown' }, createElement(Pill, { size: 'sm' }, 'Tag')),
    );
    expect(markup.startsWith('<span')).toBe(true);
    expect(markup).not.toContain('<button');
    expect(markup).not.toContain('cursor-pointer');
    expect(rootDescription(markup)).toBe('Why it is shown');
  });

  it('keeps a Pill whose onClick is explicitly undefined a span', () => {
    const markup = renderToStaticMarkup(
      createElement(Tooltip, { label: 'Why it is shown' }, createElement(Pill, { size: 'sm', onClick: undefined }, 'Tag')),
    );
    expect(markup.startsWith('<span')).toBe(true);
    expect(markup).not.toContain('<button');
  });

  it('leaves a Pill that has an onClick a button', () => {
    const markup = renderToStaticMarkup(
      createElement(Tooltip, { label: 'Why it is shown' }, createElement(Pill, { size: 'sm', onClick: noop }, 'Tag')),
    );
    expect(markup.startsWith('<button')).toBe(true);
    expect(markup).toContain('cursor-pointer');
  });

  it('leaves an intrinsic button child a button', () => {
    const markup = renderToStaticMarkup(
      createElement(Tooltip, { label: 'Why it is shown' }, createElement('button', { 'aria-label': 'Action' })),
    );
    expect(markup.startsWith('<button')).toBe(true);
  });

  it('chains a click onto a component child only when it already has one', () => {
    expect(captureTriggerProps({ label: 'Tip' }, {}).onClick).toBeUndefined();

    const clicks: string[] = [];
    const withClick = captureTriggerProps({ label: 'Tip' }, { onClick: () => clicks.push('own') });
    expect(typeof withClick.onClick).toBe('function');
    // The chained handler still runs the child's own click first, once.
    (withClick.onClick as (event: unknown) => void)({});
    expect(clicks).toEqual(['own']);
  });
});

describe('Tooltip description wiring', () => {
  it('reads nothing with describe={false}, even when the label differs from the trigger name', () => {
    const markup = renderToStaticMarkup(
      createElement(
        Tooltip,
        { label: 'More than the name says', detail: 'And a detail', describe: false },
        createElement('button', { 'aria-label': 'Action' }),
      ),
    );
    expect(rootDescription(markup)).toBeNull();
  });

  it('reads the label with describe={true}, even when it repeats the aria-label', () => {
    const markup = renderToStaticMarkup(
      createElement(Tooltip, { label: 'Close', describe: true }, createElement('button', { 'aria-label': 'Close' })),
    );
    expect(rootDescription(markup)).toBe('Close');
  });

  it('counts string children as the trigger name when there is no aria-label', () => {
    const sameAsChildren = renderToStaticMarkup(
      createElement(Tooltip, { label: 'Save' }, createElement('button', null, 'Save')),
    );
    expect(rootDescription(sameAsChildren)).toBeNull();

    const saysMore = renderToStaticMarkup(
      createElement(Tooltip, { label: 'Save the draft' }, createElement('button', null, 'Save')),
    );
    expect(rootDescription(saysMore)).toBe('Save the draft');
  });

  it('puts the detail on its own line after the label', () => {
    const markup = renderToStaticMarkup(
      createElement(
        Tooltip,
        { label: 'Show changes', detail: 'Uncommitted only' },
        createElement('button', { 'aria-label': 'Changes' }),
      ),
    );
    expect(rootDescription(markup)).toBe('Show changes\nUncommitted only');
  });

  it('reads the detail alone when the label only repeats the trigger name', () => {
    const markup = renderToStaticMarkup(
      createElement(
        Tooltip,
        { label: 'Show changes', detail: 'Uncommitted only' },
        createElement('button', { 'aria-label': 'Show changes' }),
      ),
    );
    expect(rootDescription(markup)).toBe('Uncommitted only');
  });

  it('gives an empty label no description', () => {
    const markup = renderToStaticMarkup(
      createElement(Tooltip, { label: '' }, createElement('button', { 'aria-label': 'Action' })),
    );
    expect(markup.startsWith('<button')).toBe(true);
    expect(markup).not.toContain('aria-description');
  });

  it('gives a tip held shut no description, even with a detail or a shortcut', () => {
    // `settings.toggle` is a real KEYBINDINGS id, so `keys` resolves to a combo.
    const shutByEmptyLabel = renderToStaticMarkup(
      createElement(Tooltip, { label: '', detail: 'A detail', keys: 'settings.toggle' }, createElement('button', { 'aria-label': 'Action' })),
    );
    const shutByEnabled = renderToStaticMarkup(
      createElement(Tooltip, { label: 'Why', detail: 'A detail', keys: 'settings.toggle', enabled: false }, createElement('button', { 'aria-label': 'Action' })),
    );
    expect(rootDescription(shutByEmptyLabel)).toBeNull();
    expect(rootDescription(shutByEnabled)).toBeNull();
  });

  it("keeps the trigger's own aria-description when the tip adds nothing to read", () => {
    const ownDescription = { 'aria-label': 'Close', 'aria-description': 'Closes the window' };
    const repeatsName = renderToStaticMarkup(
      createElement(Tooltip, { label: 'Close' }, createElement('button', ownDescription)),
    );
    const heldShut = renderToStaticMarkup(
      createElement(Tooltip, { label: '' }, createElement('button', ownDescription)),
    );
    expect(rootDescription(repeatsName)).toBe('Closes the window');
    expect(rootDescription(heldShut)).toBe('Closes the window');
  });

  it("reads the tip over the trigger's own aria-description when the tip has something to say", () => {
    const markup = renderToStaticMarkup(
      createElement(
        Tooltip,
        { label: 'Close this window' },
        createElement('button', { 'aria-label': 'Close', 'aria-description': 'Closes the window' }),
      ),
    );
    expect(rootDescription(markup)).toBe('Close this window');
  });
});

describe('Tooltip with an empty label', () => {
  // The description above cannot tell a held-shut tip from an open one. What can is the dwell
  // timer: a pointer move over an enabled tip arms it, and a tip that is held shut must not. The
  // handler runs against a stubbed `window` because this tier has no DOM.
  afterEach(() => {
    vi.unstubAllGlobals();
    resetTipStateForTests();
  });

  /** How many dwell timers one pointer move over the trigger arms. */
  function dwellTimersArmedByOneMove(tipProps: Omit<TooltipProps, 'children'>): number {
    resetTipStateForTests();
    const captured = captureTriggerProps(tipProps, {});
    const startTimer = vi.fn(() => 1);
    vi.stubGlobal('window', { setTimeout: startTimer, clearTimeout: vi.fn() });
    const target = {};
    (captured.onPointerMove as (event: unknown) => void)({
      pointerType: 'mouse',
      buttons: 0,
      nativeEvent: {},
      target,
      // The move lands on the trigger itself, not on a menu it portals out.
      currentTarget: { contains: (node: unknown) => node === target },
    });
    return startTimer.mock.calls.length;
  }

  it('arms no dwell for a move that bubbled up through a portal from outside the trigger', () => {
    resetTipStateForTests();
    const captured = captureTriggerProps({ label: 'Has text' }, {});
    const startTimer = vi.fn(() => 1);
    vi.stubGlobal('window', { setTimeout: startTimer, clearTimeout: vi.fn() });
    (captured.onPointerMove as (event: unknown) => void)({
      pointerType: 'mouse',
      buttons: 0,
      nativeEvent: {},
      target: {},
      currentTarget: { contains: () => false },
    });
    expect(startTimer).not.toHaveBeenCalled();
  });

  it('arms the dwell for a tip with text, so the harness can tell the cases apart', () => {
    expect(dwellTimersArmedByOneMove({ label: 'Has text' })).toBe(1);
  });

  it('arms no dwell for an empty label', () => {
    expect(dwellTimersArmedByOneMove({ label: '' })).toBe(0);
  });

  it('still arms the dwell for an empty label with a rich body', () => {
    expect(dwellTimersArmedByOneMove({ label: '', content: 'A body' })).toBe(1);
  });

  it('arms no dwell with enabled={false}, the same hold an empty label gives', () => {
    expect(dwellTimersArmedByOneMove({ label: 'Has text', enabled: false })).toBe(0);
  });
});

describe('Tooltip handlers on its trigger', () => {
  type Handler = (event: unknown) => void;

  /** The trigger element. It contains only itself, so an event aimed anywhere else came through a portal. */
  const trigger: { contains: (node: unknown) => boolean } = { contains: (node) => node === trigger };

  /** A node inside a menu the trigger renders into `document.body`: React bubbles its events to the trigger. */
  const nodeInsidePortal = (): object => ({});

  // A fresh `nativeEvent` per event: Tooltip remembers the native events it has answered, so a reused
  // one would make the second trigger stand down.
  const pointerEvent = (target: unknown) => ({ pointerType: 'mouse', buttons: 0, nativeEvent: {}, target, currentTarget: trigger });
  const focusEvent = (target: unknown) => ({ nativeEvent: {}, target, currentTarget: trigger });
  const keyEvent = (key: string, target: unknown) => ({ key, target, currentTarget: trigger });

  /** A stubbed `window` whose timers only record, so nothing fires and the ids are 1, 2, 3 in call order. */
  function stubWindow() {
    let nextTimerId = 0;
    const setTimeoutStub = vi.fn(() => ++nextTimerId);
    const clearTimeoutStub = vi.fn();
    vi.stubGlobal('window', { setTimeout: setTimeoutStub, clearTimeout: clearTimeoutStub });
    return { setTimeoutStub, clearTimeoutStub };
  }

  /**
   * The props Tooltip puts on a trigger of ANY type, read out of the element it returns. A probe
   * component cannot be an intrinsic `button`, so this calls Tooltip as a function inside a host's
   * render, which gives its hooks a dispatcher, and reads the first child of the fragment it returns.
   */
  function renderedTriggerProps(tipProps: Omit<TooltipProps, 'children'>, child: ReactElement): Record<string, unknown> {
    let rendered: Record<string, unknown> = {};
    function Host() {
      const tree = Tooltip({ ...tipProps, children: child }) as ReactElement<{ children: ReactElement<Record<string, unknown>>[] }>;
      rendered = tree.props.children[0].props;
      return null;
    }
    renderToStaticMarkup(createElement(Host));
    return rendered;
  }

  // The real tab-focus module, the same instance Tooltip reads. It installs once per file and keeps
  // its listener, so the keydown listener is captured here and fed Tab through `pressKey`.
  let tabKeyDownListener: Handler | null = null;
  beforeAll(() => {
    const listeners = new Map<string, Handler>();
    vi.stubGlobal('window', {
      addEventListener: (type: string, listener: Handler) => {
        listeners.set(type, listener);
      },
    });
    installTabFocusTracker();
    vi.unstubAllGlobals();
    tabKeyDownListener = listeners.get('keydown') ?? null;
    expect(tabKeyDownListener).not.toBeNull();
  });

  function pressKey(key: string): void {
    (tabKeyDownListener as Handler)({ key });
  }

  beforeEach(() => resetTipStateForTests());
  afterEach(() => {
    // Any non-Tab key clears the Tab flag, so a test that pressed Tab cannot leak it into the next.
    pressKey('Escape');
    vi.unstubAllGlobals();
    resetTipStateForTests();
  });

  describe('pointer enter', () => {
    // A press holds the tip shut until the pointer enters afresh (the comment in handlePointerEnter).
    // A chained click is the way to start that hold here, and a move that arms nothing shows it holds.
    function dwellsArmedByMoveAfterEnter(enterTarget?: object): number {
      const { setTimeoutStub } = stubWindow();
      const captured = captureTriggerProps({ label: 'Has text' }, { onClick: noop });
      (captured.onClick as Handler)({});
      if (enterTarget !== undefined) (captured.onPointerEnter as Handler)(pointerEvent(enterTarget));
      (captured.onPointerMove as Handler)(pointerEvent(trigger));
      return setTimeoutStub.mock.calls.length;
    }

    it('holds the tip shut after a click until the pointer enters again', () => {
      expect(dwellsArmedByMoveAfterEnter()).toBe(0);
    });

    it('ends that hold when the pointer enters the trigger itself', () => {
      expect(dwellsArmedByMoveAfterEnter(trigger)).toBe(1);
    });

    it('keeps that hold when the enter came through a portal from outside the trigger', () => {
      expect(dwellsArmedByMoveAfterEnter(nodeInsidePortal())).toBe(0);
    });
  });

  describe('focus', () => {
    /** The `clearTimeout` calls made when a focus event lands, with a Tab just pressed and a dwell pending (id 1). */
    function clearCallsFromFocusAfterTab(focusTarget: unknown): unknown[][] {
      const { setTimeoutStub, clearTimeoutStub } = stubWindow();
      const captured = captureTriggerProps({ label: 'Has text' }, {});
      (captured.onPointerMove as Handler)(pointerEvent(trigger));
      expect(setTimeoutStub).toHaveBeenCalledTimes(1);
      pressKey('Tab');
      (captured.onFocus as Handler)(focusEvent(focusTarget));
      return clearTimeoutStub.mock.calls;
    }

    // Opening on focus cancels the pending hover dwell (handleFocus calls clearDwell right before it shows).

    it('opens on a Tab focus of the trigger itself', () => {
      expect(clearCallsFromFocusAfterTab(trigger)).toEqual([[1]]);
    });

    it('ignores a Tab focus that came through a portal from outside the trigger', () => {
      expect(clearCallsFromFocusAfterTab(nodeInsidePortal())).toEqual([]);
    });
  });

  describe('keydown', () => {
    it('hands a component child an onKeyDown only when it already has one', () => {
      expect(captureTriggerProps({ label: 'Tip' }, {}).onKeyDown).toBeUndefined();
      expect(typeof captureTriggerProps({ label: 'Tip' }, { onKeyDown: noop }).onKeyDown).toBe('function');
    });

    it('runs a component child\'s own onKeyDown before it closes the tip', () => {
      const { clearTimeoutStub } = stubWindow();
      const order: string[] = [];
      clearTimeoutStub.mockImplementation(() => order.push('tip closes the pending dwell'));
      const captured = captureTriggerProps({ label: 'Has text' }, { onKeyDown: () => order.push('own') });
      (captured.onPointerMove as Handler)(pointerEvent(trigger));
      (captured.onKeyDown as Handler)(keyEvent('Enter', trigger));
      expect(order).toEqual(['own', 'tip closes the pending dwell']);
    });

    it('always hands an intrinsic child an onKeyDown, and still runs its own', () => {
      const { clearTimeoutStub } = stubWindow();
      const plain = renderedTriggerProps({ label: 'Has text' }, createElement('button', { 'aria-label': 'Action' }));
      expect(typeof plain.onKeyDown).toBe('function');
      (plain.onPointerMove as Handler)(pointerEvent(trigger));
      (plain.onKeyDown as Handler)(keyEvent('Enter', trigger));
      expect(clearTimeoutStub).toHaveBeenCalledTimes(1);

      const own: string[] = [];
      const withOwn = renderedTriggerProps(
        { label: 'Has text' },
        createElement('button', { 'aria-label': 'Action', onKeyDown: () => own.push('own') }),
      );
      expect(typeof withOwn.onKeyDown).toBe('function');
      (withOwn.onKeyDown as Handler)(keyEvent('a', trigger));
      expect(own).toEqual(['own']);
    });

    // handleKeyDown: Enter or Space on the trigger itself is a press, so it closes the pending tip
    // and holds it shut, the way handleClick does for a mouse click.

    /** The `clearTimeout` calls a key makes against a dwell that the pointer had armed (id 1). */
    function clearCallsFromKey(key: string, keyTarget: unknown): unknown[][] {
      const { clearTimeoutStub } = stubWindow();
      const captured = captureTriggerProps({ label: 'Has text' }, { onKeyDown: noop });
      (captured.onPointerMove as Handler)(pointerEvent(trigger));
      (captured.onKeyDown as Handler)(keyEvent(key, keyTarget));
      return clearTimeoutStub.mock.calls;
    }

    /**
     * How many dwell timers a move arms after the key. Sent first, on a trigger with nothing armed:
     * once a dwell is armed the move is refused anyway, so the hold could not be told from that.
     */
    function dwellsArmedByMoveAfterKey(key: string, keyTarget: unknown): number {
      const { setTimeoutStub } = stubWindow();
      const captured = captureTriggerProps({ label: 'Has text' }, { onKeyDown: noop });
      (captured.onKeyDown as Handler)(keyEvent(key, keyTarget));
      (captured.onPointerMove as Handler)(pointerEvent(trigger));
      return setTimeoutStub.mock.calls.length;
    }

    it.each(['Enter', ' '])('closes the pending tip on %j pressed on the trigger itself', (key) => {
      expect(clearCallsFromKey(key, trigger)).toEqual([[1]]);
    });

    it.each(['Enter', ' '])('keeps the tip shut after %j pressed on the trigger itself', (key) => {
      expect(dwellsArmedByMoveAfterKey(key, trigger)).toBe(0);
    });

    it.each(['a', 'ArrowDown', 'Tab'])('leaves the tip alone on %j', (key) => {
      expect(clearCallsFromKey(key, trigger)).toEqual([]);
      expect(dwellsArmedByMoveAfterKey(key, trigger)).toBe(1);
    });

    it.each(['Enter', ' '])('ignores %j pressed inside something the trigger holds, such as a portaled menu', (key) => {
      expect(clearCallsFromKey(key, nodeInsidePortal())).toEqual([]);
      expect(dwellsArmedByMoveAfterKey(key, nodeInsidePortal())).toBe(1);
    });
  });
});

describe('showsDisabledReason', () => {
  it('is true only for a disabled control with a non-empty reason', () => {
    expect(showsDisabledReason(true, 'Needs a repo')).toBe(true);
  });

  it('counts an empty, null or missing reason as no reason', () => {
    expect(showsDisabledReason(true, '')).toBe(false);
    expect(showsDisabledReason(true, null)).toBe(false);
    expect(showsDisabledReason(true, undefined)).toBe(false);
  });

  it('is false for a control that is not disabled, with or without a reason', () => {
    expect(showsDisabledReason(false, 'Needs a repo')).toBe(false);
    expect(showsDisabledReason(undefined, 'Needs a repo')).toBe(false);
  });
});

describe('tipLabel', () => {
  it('is the reason for a disabled control that has one', () => {
    expect(tipLabel({ disabled: true, disabledReason: 'Needs a repo', tip: 'Open the repo' })).toBe('Needs a repo');
  });

  it('is the reason for a disabled control that has no tip of its own', () => {
    expect(tipLabel({ disabled: true, disabledReason: 'Needs a repo' })).toBe('Needs a repo');
  });

  it('falls back to the tip when the reason is empty, null or missing', () => {
    expect(tipLabel({ disabled: true, disabledReason: '', tip: 'Open the repo' })).toBe('Open the repo');
    expect(tipLabel({ disabled: true, disabledReason: null, tip: 'Open the repo' })).toBe('Open the repo');
    expect(tipLabel({ disabled: true, disabledReason: undefined, tip: 'Open the repo' })).toBe('Open the repo');
  });

  it('is the tip for a control that is not disabled, even with a reason', () => {
    expect(tipLabel({ disabled: false, disabledReason: 'Needs a repo', tip: 'Open the repo' })).toBe('Open the repo');
    expect(tipLabel({ disabledReason: 'Needs a repo', tip: 'Open the repo' })).toBe('Open the repo');
  });

  it('is empty when there is no tip to show, which holds the tip shut', () => {
    expect(tipLabel({})).toBe('');
    expect(tipLabel({ disabled: true })).toBe('');
    expect(tipLabel({ disabled: false, disabledReason: 'Needs a repo' })).toBe('');
  });
});

describe('ToggleSwitch tip', () => {
  const toggle = (props: Record<string, unknown>): string =>
    renderToStaticMarkup(createElement(ToggleSwitch, { checked: false, onChange: noop, ariaLabel: 'Crash capture', ...props }));

  it('describes a disabled switch by its reason, not its tip', () => {
    const markup = toggle({ disabled: true, disabledReason: 'Managed by policy', tip: 'Turn it on' });
    expect(rootDescription(markup)).toBe('Managed by policy');
  });

  it('describes an enabled switch by its tip when that says more than the aria-label', () => {
    const markup = toggle({ tip: 'Turn it on', disabledReason: 'Managed by policy' });
    expect(rootDescription(markup)).toBe('Turn it on');
  });

  it('falls back to the tip when a disabled switch has an empty reason', () => {
    const markup = toggle({ disabled: true, disabledReason: '', tip: 'Turn it on' });
    expect(rootDescription(markup)).toBe('Turn it on');
  });

  it('describes nothing when there is neither a tip nor a reason to show', () => {
    expect(rootDescription(toggle({}))).toBeNull();
    expect(rootDescription(toggle({ disabledReason: 'Managed by policy' }))).toBeNull();
  });
});

describe('KebabMenuCheckItem tip', () => {
  const checkItem = (props: Record<string, unknown>): string =>
    renderToStaticMarkup(createElement(KebabMenuCheckItem, { label: 'Wrap lines', checked: false, onChange: noop, ...props }));

  it('describes a disabled item by its reason', () => {
    expect(rootDescription(checkItem({ disabled: true, disabledReason: 'No file is open' }))).toBe('No file is open');
  });

  it('describes nothing for an enabled item, whatever reason it was given', () => {
    expect(rootDescription(checkItem({ disabledReason: 'No file is open' }))).toBeNull();
  });

  it('describes nothing for a disabled item with an empty reason', () => {
    expect(rootDescription(checkItem({ disabled: true, disabledReason: '' }))).toBeNull();
    expect(rootDescription(checkItem({ disabled: true }))).toBeNull();
  });
});

describe('HeaderActionButton tip', () => {
  // `settings.toggle` is a real KEYBINDINGS id, so `keys` resolves to a combo.
  const headerButton = (props: Record<string, unknown>): string =>
    renderToStaticMarkup(
      createElement(HeaderActionButton, { icon: GlyphIcon, onClick: noop, tip: 'Show changes', ...props }),
    );

  it('describes a disabled button by exactly its reason, with no combo and no detail', () => {
    const markup = headerButton({
      disabled: true,
      disabledReason: 'Nothing to compare yet',
      keys: 'settings.toggle',
      detail: 'Uncommitted only',
    });
    expect(rootDescription(markup)).toBe('Nothing to compare yet');
  });

  it('does read the combo for an enabled button, so the disabled case above is not vacuous', () => {
    const description = rootDescription(headerButton({ keys: 'settings.toggle' }));
    expect(description).not.toBeNull();
    expect(description).not.toBe('');
  });

  it('puts the detail on its own line after the tip when the name differs from it', () => {
    const markup = headerButton({ ariaLabel: 'Changes', detail: 'Uncommitted only' });
    expect(rootDescription(markup)).toBe('Show changes\nUncommitted only');
  });

  it('reads the detail alone when an icon-only button is named by its tip', () => {
    expect(rootDescription(headerButton({ detail: 'Uncommitted only' }))).toBe('Uncommitted only');
  });

  it('falls back to the tip when a disabled button has an empty reason', () => {
    const markup = headerButton({ ariaLabel: 'Changes', disabled: true, disabledReason: '' });
    expect(rootDescription(markup)).toBe('Show changes');
  });

  it('keeps the button a button and its testid on the root', () => {
    const markup = headerButton({ testId: 'header-action' });
    expect(markup.startsWith('<button')).toBe(true);
    expect(markup).toContain('data-testid="header-action"');
  });
});

describe('ButtonGroup icon tip', () => {
  const options = [
    { value: 'status', label: 'Status' },
    { value: 'project', label: 'Project' },
  ];

  const group = (props: Record<string, unknown> = {}): string =>
    renderToStaticMarkup(createElement(ButtonGroup, { options, value: 'status', onChange: noop, ...props }));

  /** The opening tag of the leading icon, the one span with `pl-2` that is hidden from assistive tech. */
  const iconTag = (markup: string): string => {
    const found = (markup.match(/<span[^>]*>/g) ?? []).find((tag) => tag.includes('pl-2'));
    if (found === undefined) throw new Error(`No icon span in: ${markup}`);
    return found;
  };

  it('reads no description on the icon, because the group already carries the name', () => {
    // The icon is aria-hidden and the group's aria-label is the label. Without describe={false} the
    // label differs from the span's (absent) name, so it would be read as a description on a node
    // that assistive tech skips, and again as the group's name.
    const markup = group({ icon: createElement(GlyphIcon), label: 'Group by' });
    const tag = iconTag(markup);
    expect(tag).toContain('aria-hidden="true"');
    expect(descriptionIn(tag)).toBeNull();
    expect(rootTag(markup)).toContain('aria-label="Group by"');
  });

  it('names the group by ariaLabel when both are given, and still reads nothing on the icon', () => {
    const markup = group({ icon: createElement(GlyphIcon), label: 'Group by', ariaLabel: 'Board grouping' });
    expect(rootTag(markup)).toContain('aria-label="Board grouping"');
    expect(descriptionIn(iconTag(markup))).toBeNull();
  });

  it('reads nothing on the icon with no label either, which holds its tip shut', () => {
    const markup = group({ icon: createElement(GlyphIcon) });
    expect(descriptionIn(iconTag(markup))).toBeNull();
    expect(rootTag(markup)).not.toContain('aria-label');
  });

  it('renders no icon, and so no tip, without an icon prop', () => {
    const markup = group({ label: 'Group by' });
    expect(markup).not.toContain('pl-2');
    expect(markup).not.toContain('aria-description');
  });
});

describe('IsolatedBadge tip', () => {
  const TIP_TEXT = 'Its own context, separate from the main conversation';

  it('is a span that describes itself with its tip', () => {
    const markup = renderToStaticMarkup(createElement(IsolatedBadge));
    expect(markup.startsWith('<span')).toBe(true);
    expect(markup).toContain('>Isolated</span>');
    expect(rootDescription(markup)).toBe(TIP_TEXT);
  });

  it('merges a passed className onto its own classes', () => {
    const markup = renderToStaticMarkup(createElement(IsolatedBadge, { className: 'ml-2 extra-class' }));
    const classes = /\sclass="([^"]*)"/.exec(rootTag(markup))?.[1] ?? '';
    expect(classes).toContain('inline-flex');
    expect(classes).toContain('text-accent-fg');
    expect(classes).toContain('ml-2');
    expect(classes).toContain('extra-class');
  });

  it('carries no native title, so only the Tooltip explains it', () => {
    // The badge takes the span's attributes (minus title) and spreads them, so the testid lands on the root.
    const passedProps = { 'data-testid': 'isolated-badge' };
    const markup = renderToStaticMarkup(createElement(IsolatedBadge, passedProps));
    expect(rootTag(markup)).not.toMatch(/\stitle=/);
    expect(rootTag(markup)).toContain('data-testid="isolated-badge"');
    expect(rootDescription(markup)).toBe(TIP_TEXT);
  });

  it('leads the word with the Split icon, which the word already explains', () => {
    const markup = renderToStaticMarkup(createElement(IsolatedBadge));
    expect(markup).toMatch(/<svg[^>]*lucide-split[^>]*>.*<\/svg>Isolated<\/span>$/);
    expect(markup).toMatch(/<svg[^>]*aria-hidden="true"/);
  });
});

describe('IsolatedIcon', () => {
  it('leading a word, it is a bare muted svg with no name and no tip', () => {
    const markup = renderToStaticMarkup(createElement(IsolatedIcon, { size: 12 }));
    expect(markup.startsWith('<svg')).toBe(true);
    expect(rootTag(markup)).toContain('aria-hidden="true"');
    expect(rootTag(markup)).toContain('text-fg-muted');
    expect(markup).not.toContain('aria-description');
  });

  it('explained, it names itself for a reader who cannot see it', () => {
    const markup = renderToStaticMarkup(createElement(IsolatedIcon, { size: 13, explained: true }));
    expect(markup.startsWith('<span')).toBe(true);
    expect(rootTag(markup)).toContain('role="img"');
    expect(rootTag(markup)).toContain('aria-label="Isolated session"');
    expect(rootTag(markup)).not.toMatch(/\stitle=/);
  });

  it('takes the tone of the text around it with inheritTone', () => {
    const markup = renderToStaticMarkup(createElement(IsolatedIcon, { size: 11, explained: true, inheritTone: true }));
    expect(rootTag(markup)).not.toContain('text-fg-muted');
  });
});

describe('SegmentedControl option tips', () => {
  const options: SegmentedControlOption<string>[] = [
    { value: 'alpha', label: 'Alpha', testId: 'option-alpha', tip: 'The first choice' },
    { value: 'beta', label: 'Beta', testId: 'option-beta', tip: 'The second choice', disabled: true, disabledReason: 'Needs a repo' },
    { value: 'gamma', label: 'Gamma', testId: 'option-gamma', disabled: true },
    { value: 'delta', label: 'Delta', testId: 'option-delta', disabledReason: 'Never shown while enabled' },
    { value: 'epsilon', label: 'Epsilon', testId: 'option-epsilon', tip: 'The fifth choice', disabled: true, disabledReason: '' },
  ];

  const group = (props: Record<string, unknown> = {}): string =>
    renderToStaticMarkup(createElement(SegmentedControl, { options, value: 'alpha', onChange: noop, ...props }));

  const optionDescription = (markup: string, value: string): string | null =>
    descriptionIn(tagWithTestId(markup, `option-${value}`));

  it('describes an enabled option by its tip', () => {
    expect(optionDescription(group(), 'alpha')).toBe('The first choice');
  });

  it('describes a disabled option by its reason, not its tip', () => {
    expect(optionDescription(group(), 'beta')).toBe('Needs a repo');
  });

  it('describes a disabled option with no reason and no tip by nothing', () => {
    expect(optionDescription(group(), 'gamma')).toBeNull();
  });

  it('ignores a reason on an option that is enabled', () => {
    expect(optionDescription(group(), 'delta')).toBeNull();
  });

  it('falls back to the tip when a disabled option has an empty reason', () => {
    expect(optionDescription(group(), 'epsilon')).toBe('The fifth choice');
  });

  it('gives each option its own description in one markup', () => {
    const markup = group();
    expect([
      optionDescription(markup, 'alpha'),
      optionDescription(markup, 'beta'),
      optionDescription(markup, 'gamma'),
    ]).toEqual(['The first choice', 'Needs a repo', null]);
  });

  it('shows an option reason while the whole group is disabled', () => {
    const markup = group({ disabled: true });
    expect(optionDescription(markup, 'delta')).toBe('Never shown while enabled');
    expect(optionDescription(markup, 'alpha')).toBe('The first choice');
  });
});
