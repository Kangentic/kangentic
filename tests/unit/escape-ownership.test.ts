/**
 * `escapeOwnedElsewhere(event)` in src/renderer/utils/escape-ownership.ts: the
 * guard a surface-level Escape handler (PopOutWindowFrame's window close, the
 * Changes panel's commit deselect) consults to decide whether the keystroke
 * belongs to something else first. It returns true (yield) when ANY of these
 * holds, and false for a plain keystroke:
 *
 *   - the event was already handled (`defaultPrevented`)
 *   - a text field has focus: an INPUT, a TEXTAREA, or an editable node
 *   - a dialog, menu or popover is open (`[data-dismissable-layer]`)
 *   - the key comes from inside a terminal (`.xterm`) or Monaco's find widget
 *     (`.find-widget`)
 *
 * The UI specs reach only some of these branches, and a handler that stops
 * yielding on one of them closes a window on a keystroke that was meant for an
 * edit, an agent interrupt or an open menu. This pins each branch alone: every
 * "owned" case is built so that ONLY its branch applies (everything else is the
 * plain scenario), so deleting that one check turns exactly that case red.
 *
 * The unit tier has no DOM, so the function's four reads are stubbed on
 * globalThis: `document.activeElement`, `document.querySelector`, the
 * `HTMLElement` class its `instanceof` guards test against, and an element's
 * `closest`. The fake element's `closest` really parses the comma-separated
 * class selector and walks the parent chain, so a change to the selector the
 * function passes (not just to its control flow) is caught. The function reads
 * focus from `document.activeElement`, not from `event.target`; the target is
 * only consulted for the `.xterm` / `.find-widget` containment check.
 *
 * Red condition (xterm): drop `.xterm` from the `closest('.xterm, .find-widget')`
 * selector and the "inside a terminal" case fails.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { escapeOwnedElsewhere } from '../../src/renderer/utils/escape-ownership';

// ---------------------------------------------------------------------------
// Fake DOM
// ---------------------------------------------------------------------------

interface FakeElementOptions {
  tagName?: string;
  classNames?: string[];
  parentElement?: FakeHTMLElement | null;
  isContentEditable?: boolean;
}

class FakeHTMLElement {
  readonly tagName: string;
  readonly isContentEditable: boolean;
  private readonly classNames: string[];
  private readonly parentElement: FakeHTMLElement | null;

  constructor(options: FakeElementOptions = {}) {
    this.tagName = options.tagName ?? 'DIV';
    this.isContentEditable = options.isContentEditable ?? false;
    this.classNames = options.classNames ?? [];
    this.parentElement = options.parentElement ?? null;
  }

  /** Matches a comma-separated list of `.class` selectors against this node and its ancestors. */
  closest(selector: string): FakeHTMLElement | null {
    const classNamesWanted = selector
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.startsWith('.'))
      .map((part) => part.slice(1));
    if (classNamesWanted.some((wanted) => this.classNames.includes(wanted))) return this;
    return this.parentElement?.closest(selector) ?? null;
  }
}

interface FakeKeyEvent {
  defaultPrevented: boolean;
  target: unknown;
}

interface Scenario {
  defaultPrevented?: boolean;
  activeElement?: FakeHTMLElement | null;
  target?: unknown;
  /** An element standing for an open `[data-dismissable-layer]` in the document, if any. */
  openLayer?: FakeHTMLElement | null;
}

const DISMISSABLE_LAYER_SELECTOR = '[data-dismissable-layer]';

const globalScope = globalThis as Record<string, unknown>;
const originalDocument = { present: 'document' in globalScope, value: globalScope.document };
const originalHTMLElement = { present: 'HTMLElement' in globalScope, value: globalScope.HTMLElement };

function restoreGlobal(key: string, original: { present: boolean; value: unknown }): void {
  if (original.present) globalScope[key] = original.value;
  else delete globalScope[key];
}

afterEach(() => {
  restoreGlobal('document', originalDocument);
  restoreGlobal('HTMLElement', originalHTMLElement);
});

/** Install the stubbed document, run the guard against the scenario's event, and return its answer. */
function runGuard(scenario: Scenario): boolean {
  const plainBody = new FakeHTMLElement({ tagName: 'BODY' });
  globalScope.HTMLElement = FakeHTMLElement;
  globalScope.document = {
    activeElement: scenario.activeElement === undefined ? plainBody : scenario.activeElement,
    querySelector: (selector: string) => (selector === DISMISSABLE_LAYER_SELECTOR ? (scenario.openLayer ?? null) : null),
  };
  const event: FakeKeyEvent = {
    defaultPrevented: scenario.defaultPrevented ?? false,
    target: scenario.target === undefined ? new FakeHTMLElement({ tagName: 'DIV' }) : scenario.target,
  };
  return escapeOwnedElsewhere(event as unknown as KeyboardEvent);
}

/** A node nested two levels under an element carrying `containerClass`, the way xterm's canvas sits under `.xterm`. */
function nestedUnder(containerClass: string): FakeHTMLElement {
  const container = new FakeHTMLElement({ classNames: [containerClass] });
  const middle = new FakeHTMLElement({ classNames: ['screen'], parentElement: container });
  return new FakeHTMLElement({ tagName: 'CANVAS', parentElement: middle });
}

// ---------------------------------------------------------------------------
// Owned elsewhere: one case per branch, each with ONLY that branch applying
// ---------------------------------------------------------------------------

interface OwnedCase {
  name: string;
  scenario: Scenario;
}

const ownedCases: OwnedCase[] = [
  {
    name: 'the event was already handled (defaultPrevented)',
    scenario: { defaultPrevented: true },
  },
  {
    name: 'an INPUT has focus',
    scenario: { activeElement: new FakeHTMLElement({ tagName: 'INPUT' }) },
  },
  {
    name: 'a TEXTAREA has focus',
    scenario: { activeElement: new FakeHTMLElement({ tagName: 'TEXTAREA' }) },
  },
  {
    name: 'an editable node (contentEditable) has focus',
    scenario: { activeElement: new FakeHTMLElement({ tagName: 'DIV', isContentEditable: true }) },
  },
  {
    name: 'a dialog, menu or popover is open ([data-dismissable-layer])',
    scenario: { openLayer: new FakeHTMLElement({ tagName: 'DIV' }) },
  },
  {
    name: 'the key comes from inside a terminal (.xterm)',
    scenario: { target: nestedUnder('xterm') },
  },
  {
    name: "the key comes from inside Monaco's find widget (.find-widget)",
    scenario: { target: nestedUnder('find-widget') },
  },
];

describe('escapeOwnedElsewhere - true when something else owns the Escape', () => {
  it.each(ownedCases)('yields when $name', ({ scenario }) => {
    expect(runGuard(scenario)).toBe(true);
  });

  it('yields for a target that is itself the .xterm element, not only one nested under it', () => {
    const terminalRoot = new FakeHTMLElement({ classNames: ['xterm'] });

    expect(runGuard({ target: terminalRoot })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Not owned elsewhere: the surface handles it
// ---------------------------------------------------------------------------

describe('escapeOwnedElsewhere - false for a plain keystroke', () => {
  it('does not yield when nothing owns the key (plain target, plain focus, no layer open)', () => {
    expect(runGuard({})).toBe(false);
  });

  it('does not yield when a non-text control has focus (a button)', () => {
    expect(runGuard({ activeElement: new FakeHTMLElement({ tagName: 'BUTTON' }) })).toBe(false);
  });

  it('does not yield when nothing has focus (document.activeElement is null)', () => {
    expect(runGuard({ activeElement: null })).toBe(false);
  });

  it('does not yield when the target sits in an unrelated container', () => {
    const unrelatedTarget = nestedUnder('changes-panel');

    expect(runGuard({ target: unrelatedTarget })).toBe(false);
  });

  it('does not consult a target that is not an HTMLElement (the document itself), even if it answers closest()', () => {
    // A target such as `document` or `window` has no closest() in a browser; this one does,
    // and would claim the key, so only the instanceof guard keeps the answer false.
    const nonElementTarget = { closest: () => ({}) };

    expect(runGuard({ target: nonElementTarget })).toBe(false);
  });
});
