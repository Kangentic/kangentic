/**
 * Runs the page-side half of strict selector matching (GitHub #820),
 * `buildActionableMatchesExpression`, against a fake document.
 *
 * The expression decides which matches count as ones a user could act on and
 * whether a selector is ambiguous, so a regression here either re-opens #820
 * (two visible buttons, one silently picked) or makes strict refuse a selector
 * that names one visible element (a hidden duplicate counted, or a dialog
 * counted beside its own button). The driver's handling of each answer is in
 * `browser-input-focus-emulation.test.ts`; a real DOM's layout, `inert` and
 * `elementFromPoint` are covered by `tests/e2e/browser-strict-selector.spec.ts`.
 *
 * Tier: Unit. The expression is evaluated with `new Function`, the way
 * `devtools-query-all.test.ts` runs its sibling builder.
 */
import { describe, it, expect } from 'vitest';
import { parseSelectorCandidates, type SelectorCandidate } from '../../src/main/browser/cdp/ambiguous-selector';
import {
  buildActionableMatchesExpression,
  buildSelectorAllExpression,
  buildSelectorExpression,
  parseSelectorSpec,
} from '../../src/main/browser/cdp/cdp';

interface FakeRect {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  left: number;
  right: number;
  bottom: number;
}

interface FakeElementOptions {
  tag: string;
  text?: string;
  id?: string;
  attributes?: Record<string, string>;
  rect?: [number, number, number, number];
  displayNone?: boolean;
  visibility?: string;
  inert?: boolean;
  dialog?: boolean;
  children?: FakeElement[];
}

interface FakeElement {
  nodeType: 1;
  tagName: string;
  id: string;
  innerText: string;
  textContent: string;
  isConnected: boolean;
  parentElement: FakeElement | null;
  children: FakeElement[];
  options: FakeElementOptions;
  getClientRects: () => FakeRect[];
  getBoundingClientRect: () => FakeRect;
  getAttribute: (name: string) => string | null;
  closest: (selector: string) => FakeElement | null;
  contains: (other: FakeElement) => boolean;
}

function rectOf([x, y, width, height]: [number, number, number, number]): FakeRect {
  return { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height };
}

function element(options: FakeElementOptions): FakeElement {
  const children = options.children ?? [];
  const rect = rectOf(options.rect ?? [0, 0, 80, 24]);
  const self: FakeElement = {
    nodeType: 1,
    tagName: options.tag.toUpperCase(),
    id: options.id ?? '',
    innerText: options.text ?? '',
    textContent: options.text ?? '',
    isConnected: true,
    parentElement: null,
    children,
    options,
    getClientRects: () => (options.displayNone ? [] : [rect]),
    getBoundingClientRect: () => rect,
    getAttribute: (name) => options.attributes?.[name] ?? null,
    closest: (selector) => {
      const wantsInert = selector === '[inert]';
      for (let node: FakeElement | null = self; node; node = node.parentElement) {
        if (wantsInert ? node.options.inert : node.options.dialog) return node;
      }
      return null;
    },
    contains: (other) => {
      for (let node: FakeElement | null = other; node; node = node.parentElement) {
        if (node === self) return true;
      }
      return false;
    },
  };
  for (const child of children) child.parentElement = self;
  return self;
}

interface PageAnswer {
  total: number;
  candidates: SelectorCandidate[];
}

/**
 * Evaluate the expression for `selector` over a page whose matches are
 * `matches` (what the selector's `querySelectorAll` returns, in document
 * order). `topmostAt` is what `elementFromPoint` hits.
 */
function evaluate(
  selector: string,
  root: FakeElement,
  matches: FakeElement[],
  topmostAt: (x: number, y: number) => FakeElement | null = () => null,
): { answer: FakeElement | PageAnswer | null; askedSelectors: string[] } {
  const askedSelectors: string[] = [];
  const all: FakeElement[] = [];
  const walk = (node: FakeElement) => {
    all.push(node);
    node.children.forEach(walk);
  };
  walk(root);
  const fakeDocument = {
    documentElement: root,
    querySelectorAll: (query: string) => {
      askedSelectors.push(query);
      if (query.startsWith('#')) return all.filter((node) => `#${node.id}` === query);
      return matches;
    },
    elementFromPoint: topmostAt,
  };
  const fakeWindow = {
    innerWidth: 1000,
    innerHeight: 800,
    getComputedStyle: (node: FakeElement) => ({ visibility: node.options.visibility ?? 'visible' }),
  };
  const fakeCss = { escape: (value: string) => value };
  const expression = buildActionableMatchesExpression(parseSelectorSpec(selector), 5);
  const run = new Function('document', 'window', 'CSS', `return ${expression};`);
  return { answer: run(fakeDocument, fakeWindow, fakeCss), askedSelectors };
}

describe('buildActionableMatchesExpression', () => {
  it('describes two visible matches instead of picking one: the #820 modal and the form behind it', () => {
    const formSave = element({ tag: 'button', text: 'Save', rect: [10, 10, 80, 24] });
    const modalSave = element({ tag: 'button', text: 'Save', id: 'modal-save', rect: [400, 300, 80, 24] });
    const form = element({ tag: 'form', children: [formSave] });
    const dialog = element({ tag: 'div', dialog: true, children: [modalSave] });
    const body = element({ tag: 'body', children: [form, dialog] });
    const root = element({ tag: 'html', children: [body] });
    // The modal's backdrop covers the form, so a click at the form button's
    // centre hits something else.
    const backdrop = element({ tag: 'div' });

    const { answer } = evaluate('text="Save"', root, [formSave, modalSave], (x) => (x > 300 ? modalSave : backdrop));

    expect(answer).toMatchObject({
      total: 2,
      candidates: [
        { index: 0, text: 'Save', id: null, inDialog: false, topmost: false, selector: 'html > body > form > button' },
        { index: 1, text: 'Save', id: 'modal-save', inDialog: true, topmost: true, selector: '#modal-save' },
      ],
    });
  });

  it('answers with the one visible element when its duplicate is not laid out', () => {
    const hidden = element({ tag: 'button', text: 'Delete', displayNone: true });
    const shown = element({ tag: 'button', text: 'Delete' });
    const root = element({ tag: 'html', children: [hidden, shown] });

    const { answer } = evaluate('text="Delete"', root, [hidden, shown]);

    expect(answer).toBe(shown);
  });

  it('does not count a match that is visibility: hidden, zero-sized, or inside an inert subtree', () => {
    const invisible = element({ tag: 'button', text: 'Go', visibility: 'hidden' });
    const empty = element({ tag: 'button', text: 'Go', rect: [0, 0, 0, 0] });
    const inertButton = element({ tag: 'button', text: 'Go' });
    const inertForm = element({ tag: 'form', inert: true, children: [inertButton] });
    const target = element({ tag: 'button', text: 'Go' });
    const root = element({ tag: 'html', children: [invisible, empty, inertForm, target] });

    const { answer } = evaluate('text="Go"', root, [invisible, empty, inertButton, target]);

    expect(answer).toBe(target);
  });

  it('collapses a text match to the innermost element, so a dialog is not ambiguous with its own button', () => {
    const button = element({ tag: 'button', text: 'Save' });
    const dialog = element({ tag: 'div', text: 'Edit task Save', attributes: { role: 'dialog' }, children: [button] });
    const root = element({ tag: 'html', children: [dialog] });

    const { answer } = evaluate('text*="Save"', root, [dialog, button]);

    expect(answer).toBe(button);
  });

  it('keeps nested CSS matches apart, because the caller named both', () => {
    const inner = element({ tag: 'li' });
    const outer = element({ tag: 'li', children: [inner] });
    const root = element({ tag: 'html', children: [outer] });

    const { answer } = evaluate('li', root, [outer, inner]);

    expect(answer).toMatchObject({ total: 2 });
  });

  it('answers null when nothing matches at all', () => {
    const root = element({ tag: 'html' });

    expect(evaluate('text="Nope"', root, []).answer).toBeNull();
  });

  it('answers the first match in document order when matches exist but none is actionable', () => {
    const first = element({ tag: 'button', text: 'Go', displayNone: true });
    const second = element({ tag: 'button', text: 'Go', rect: [0, 0, 0, 0] });
    const root = element({ tag: 'html', children: [first, second] });

    const { answer } = evaluate('text="Go"', root, [first, second]);

    expect(answer).toBe(first);
  });

  it('caps the described candidates at the limit while total counts every match', () => {
    const buttons = Array.from({ length: 7 }, () => element({ tag: 'button', text: 'Item' }));
    const root = element({ tag: 'html', children: buttons });

    const { answer } = evaluate('text="Item"', root, buttons);

    const page = answer as PageAnswer;
    expect(page.total).toBe(7);
    expect(page.candidates).toHaveLength(5);
    expect(page.candidates.map((candidate) => candidate.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it('reports topmost null, without hit-testing, for a match whose centre is outside the window', () => {
    const onScreen = element({ tag: 'button', text: 'Go', rect: [10, 10, 80, 24] });
    const offScreen = element({ tag: 'button', text: 'Go', rect: [1200, 10, 80, 24] });
    const root = element({ tag: 'html', children: [onScreen, offScreen] });
    const hitTested: Array<[number, number]> = [];

    const { answer } = evaluate('text="Go"', root, [onScreen, offScreen], (x, y) => {
      hitTested.push([x, y]);
      return onScreen;
    });

    const page = answer as PageAnswer;
    expect(page.candidates[0].topmost).toBe(true);
    expect(page.candidates[1].topmost).toBeNull();
    expect(hitTested).toEqual([[50, 22]]);
  });

  it('clips a candidate text longer than 80 characters to 80', () => {
    const long = element({ tag: 'button', text: `Item${'a'.repeat(100)}` });
    const short = element({ tag: 'button', text: 'Item' });
    const root = element({ tag: 'html', children: [long, short] });

    const { answer } = evaluate('text*="Item"', root, [long, short]);

    const page = answer as PageAnswer;
    expect(page.candidates[0].text).toBe(`Item${'a'.repeat(76)}`);
    expect(page.candidates[0].text).toHaveLength(80);
    expect(page.candidates[1].text).toBe('Item');
  });

  it('collapses newlines and runs of spaces in candidate text without touching the letter s', () => {
    // The collapse regex sits inside a template literal, where a single
    // backslash would turn \s into a bare s and strip every s from the text.
    const messy = element({ tag: 'button', text: 'Save\n  changes   now' });
    const other = element({ tag: 'button', text: 'Other' });
    const root = element({ tag: 'html', children: [messy, other] });

    const { answer } = evaluate('button', root, [messy, other]);

    const page = answer as PageAnswer;
    expect(page.candidates[0].text).toBe('Save changes now');
  });

  it('numbers same-tag siblings with :nth-of-type in a candidate selector', () => {
    const first = element({ tag: 'button', text: 'Go' });
    const second = element({ tag: 'button', text: 'Go' });
    const body = element({ tag: 'body', children: [first, second] });
    const root = element({ tag: 'html', children: [body] });

    const { answer } = evaluate('button', root, [first, second]);

    const page = answer as PageAnswer;
    expect(page.candidates.map((candidate) => candidate.selector)).toEqual([
      'html > body > button:nth-of-type(1)',
      'html > body > button:nth-of-type(2)',
    ]);
  });

  it('does not shorten a selector to an id that more than one element carries', () => {
    const first = element({ tag: 'button', text: 'Go', id: 'dup' });
    const second = element({ tag: 'button', text: 'Go', id: 'dup' });
    const body = element({ tag: 'body', children: [first, second] });
    const root = element({ tag: 'html', children: [body] });

    const { answer } = evaluate('button', root, [first, second]);

    const page = answer as PageAnswer;
    for (const candidate of page.candidates) {
      expect(candidate.selector).not.toBe('#dup');
      expect(candidate.selector.startsWith('#dup')).toBe(false);
    }
    expect(page.candidates.map((candidate) => candidate.selector)).toEqual([
      'html > body > button:nth-of-type(1)',
      'html > body > button:nth-of-type(2)',
    ]);
  });

  it('round-trips every candidate field through parseSelectorCandidates unchanged (#820 two Save buttons)', () => {
    // The page expression and the parser live in different files and agree
    // only by field name. A field renamed on one side shows up here as a
    // missing or null value on the parsed side.
    const formSave = element({
      tag: 'button',
      text: 'Save',
      rect: [10, 10, 80, 24],
      attributes: { role: 'button', name: 'save-form' },
    });
    const modalSave = element({
      tag: 'button',
      text: 'Save',
      id: 'modal-save',
      rect: [400, 300, 90, 30],
      attributes: { role: 'menuitem', 'aria-label': 'Save changes', name: 'save-modal' },
    });
    const form = element({ tag: 'form', children: [formSave] });
    const dialog = element({ tag: 'div', dialog: true, children: [modalSave] });
    const body = element({ tag: 'body', children: [form, dialog] });
    const root = element({ tag: 'html', children: [body] });
    const backdrop = element({ tag: 'div' });

    const { answer } = evaluate('text*="Save"', root, [formSave, modalSave], (x) => (x > 300 ? modalSave : backdrop));

    const page = answer as PageAnswer;
    expect(page.candidates).toHaveLength(2);
    expect(page.candidates[1]).toMatchObject({
      tag: 'button',
      text: 'Save changes',
      id: 'modal-save',
      role: 'menuitem',
      ariaLabel: 'Save changes',
      name: 'save-modal',
      inDialog: true,
      topmost: true,
      box: { x: 400, y: 300, width: 90, height: 30 },
      selector: '#modal-save',
      index: 1,
    });
    expect(parseSelectorCandidates(page.candidates)).toStrictEqual(page.candidates);
  });

  it('collapses a match nested two levels deep inside other matches to the innermost element', () => {
    const button = element({ tag: 'button', text: 'Save' });
    const middle = element({ tag: 'div', text: 'Save', attributes: { role: 'group' }, children: [button] });
    const outer = element({ tag: 'section', text: 'Save', attributes: { role: 'dialog' }, children: [middle] });
    const root = element({ tag: 'html', children: [outer] });

    const { answer } = evaluate('text*="Save"', root, [outer, middle, button]);

    expect(answer).toBe(button);
  });

  it('keeps two innermost sibling matches ambiguous under one matching ancestor', () => {
    const left = element({ tag: 'button', text: 'Save' });
    const right = element({ tag: 'button', text: 'Save' });
    const wrapper = element({ tag: 'div', text: 'Save Save', attributes: { role: 'dialog' }, children: [left, right] });
    const root = element({ tag: 'html', children: [wrapper] });

    const { answer } = evaluate('text*="Save"', root, [wrapper, left, right]);

    expect(answer).toMatchObject({ total: 2 });
  });

  it('runs a scoped :has-text over the elements its CSS selects', () => {
    const button = element({ tag: 'button', text: 'Save' });
    const root = element({ tag: 'html', children: [button] });

    const { answer, askedSelectors } = evaluate('[role=dialog] button:has-text("Save")', root, [button]);

    expect(askedSelectors[0]).toBe('[role=dialog] button');
    expect(answer).toBe(button);
  });
});

/**
 * A scoped `:has-text` must reach every builder that walks the text candidates,
 * not just the strict one: the first-match and all-match builders share
 * `textCandidatesJs`, so a regression in any of them re-opens "a selector
 * scoped to an open dialog matched a button behind it".
 */
describe('scoped :has-text in the first-match and all-match builders', () => {
  const SCOPED = '[role=dialog] button:has-text("Save")';

  interface FakeNode {
    tagName: string;
    innerText: string;
    textContent: string;
    attributes: unknown[];
    outerHTML: string;
    getAttribute: (name: string) => string | null;
    getBoundingClientRect: () => FakeRect;
  }

  function node(text: string): FakeNode {
    return {
      tagName: 'BUTTON',
      innerText: text,
      textContent: text,
      attributes: [],
      outerHTML: `<button>${text}</button>`,
      getAttribute: () => null,
      getBoundingClientRect: () => rectOf([0, 0, 80, 24]),
    };
  }

  function run(expression: string, nodes: FakeNode[]): { result: unknown; askedSelectors: string[] } {
    const askedSelectors: string[] = [];
    const fakeDocument = {
      querySelectorAll: (query: string) => {
        askedSelectors.push(query);
        return nodes;
      },
    };
    const result = new Function('document', `return ${expression};`)(fakeDocument);
    return { result, askedSelectors };
  }

  const allOptions = { includeHtml: false, includeAttributes: false, limit: 10, htmlMaxChars: 100 };

  it('buildSelectorExpression queries the scope and answers the first match in it', () => {
    const save = node('Save');
    const { result, askedSelectors } = run(buildSelectorExpression(parseSelectorSpec(SCOPED)), [node('Cancel'), save]);

    expect(askedSelectors).toEqual(['[role=dialog] button']);
    expect(result).toBe(save);
  });

  it('buildSelectorAllExpression queries the scope and counts the matches in it', () => {
    const { result, askedSelectors } = run(
      buildSelectorAllExpression(parseSelectorSpec(SCOPED), allOptions),
      [node('Save'), node('Cancel'), node('Save changes')],
    );

    expect(askedSelectors).toEqual(['[role=dialog] button']);
    expect(result).toMatchObject({ total: 2, kind: 'text-contains' });
  });

  it('an unscoped :has-text still queries the candidate pool in both builders', () => {
    const spec = parseSelectorSpec(':has-text("Save")');

    const first = run(buildSelectorExpression(spec), [node('Save')]);
    const all = run(buildSelectorAllExpression(spec, allOptions), [node('Save')]);

    for (const asked of [first.askedSelectors, all.askedSelectors]) {
      expect(asked).toHaveLength(1);
      expect(asked[0]).toContain('[role]');
      expect(asked[0]).not.toContain('[role=dialog]');
    }
  });
});
