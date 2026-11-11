/**
 * The terminal link tip (src/renderer/utils/terminal-links/link-tip.ts): where it points and what
 * it says. What a user loses if this goes: a tip over the wrong row of a wrapped or scrolled link,
 * one that tells a Mac user to Ctrl+click, which there is a right click, or an OSC 8 link whose
 * text ("canvas") hides where the click goes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Terminal } from '@xterm/headless';
import { activateUnicode11 } from '../../src/shared/xterm-unicode11';
import {
  createTerminalLinkTip,
  linkRowAnchor,
  linkTipContent,
  osc8Destination,
  type CellGrid,
  type LinkHover,
  type LinkTipContent,
  type LinkTipTerminal,
} from '../../src/renderer/utils/terminal-links/link-tip';
import { TOOLTIP_DWELL_MS, resetTipStateForTests } from '../../src/renderer/utils/tooltip';
import { planLinkActions } from '../../src/renderer/utils/link-open';
import { readRangeText } from '../../src/renderer/utils/terminal-links/buffer-line-text';

/** 40 by 10 cells of 8 by 16 pixels, with the screen's top left corner at (100, 50). */
const GRID: CellGrid = { left: 100, top: 50, cellWidth: 8, cellHeight: 16, rows: 10, cols: 40, viewportY: 0 };

/** A pointer a few pixels into the given 0-based viewport row. */
function pointerOnViewportRow(row: number, grid: CellGrid = GRID): number {
  return grid.top + row * grid.cellHeight + 3;
}

describe('linkRowAnchor', () => {
  it('covers the cells of a one-row link', () => {
    const range = { start: { x: 5, y: 3 }, end: { x: 14, y: 3 } };
    expect(linkRowAnchor(range, GRID, pointerOnViewportRow(2))).toEqual({ left: 132, width: 80, top: 82, bottom: 98 });
  });

  it('points at the row under the pointer of a wrapped link, clipped to that row', () => {
    const range = { start: { x: 30, y: 2 }, end: { x: 6, y: 4 } };
    // First row: from the link's start to the edge.
    expect(linkRowAnchor(range, GRID, pointerOnViewportRow(1))).toEqual({ left: 332, width: 88, top: 66, bottom: 82 });
    // A middle row: the whole row.
    expect(linkRowAnchor(range, GRID, pointerOnViewportRow(2))).toEqual({ left: 100, width: 320, top: 82, bottom: 98 });
    // Last row: from the edge to the link's end.
    expect(linkRowAnchor(range, GRID, pointerOnViewportRow(3))).toEqual({ left: 100, width: 48, top: 98, bottom: 114 });
  });

  it('reads buffer rows against a scrolled viewport', () => {
    const scrolled = { ...GRID, viewportY: 100 };
    const range = { start: { x: 1, y: 103 }, end: { x: 4, y: 103 } };
    expect(linkRowAnchor(range, scrolled, pointerOnViewportRow(2, scrolled))).toEqual({ left: 100, width: 32, top: 82, bottom: 98 });
  });

  it('keeps to the link rows when the pointer reads just off them', () => {
    const range = { start: { x: 1, y: 3 }, end: { x: 4, y: 3 } };
    expect(linkRowAnchor(range, GRID, pointerOnViewportRow(3))).toEqual({ left: 100, width: 32, top: 82, bottom: 98 });
  });

  it('points nowhere when the link row has scrolled out of view', () => {
    const range = { start: { x: 1, y: 3 }, end: { x: 4, y: 3 } };
    expect(linkRowAnchor(range, { ...GRID, viewportY: 5 }, pointerOnViewportRow(0))).toBeNull();
  });

  it('points nowhere before the terminal has a size', () => {
    const range = { start: { x: 1, y: 1 }, end: { x: 4, y: 1 } };
    expect(linkRowAnchor(range, { ...GRID, cellWidth: 0 }, pointerOnViewportRow(0))).toBeNull();
  });
});

describe('linkTipContent', () => {
  const BOTH = planLinkActions('default', true, false).actions;
  const SWAPPED = planLinkActions('kangentic', true, false).actions;
  const NO_KANGENTIC_BROWSER = planLinkActions('default', false, false).actions;

  it('lists a URL\'s two actions, the plain click first, with their chips', () => {
    expect(linkTipContent('url', BOTH, null, false)).toEqual({
      destination: null,
      rows: [
        { label: 'Open in default browser', keys: ['Click'], target: 'default-browser' },
        { label: 'Open in Kangentic browser', keys: ['Ctrl', 'Click'], target: 'kangentic-browser' },
      ],
    });
  });

  it('swaps the rows when the setting names the Kangentic browser', () => {
    expect(linkTipContent('url', SWAPPED, null, false)?.rows).toEqual([
      { label: 'Open in Kangentic browser', keys: ['Click'], target: 'kangentic-browser' },
      { label: 'Open in default browser', keys: ['Ctrl', 'Click'], target: 'default-browser' },
    ]);
  });

  it('shows one row where there is no Kangentic browser', () => {
    expect(linkTipContent('url', NO_KANGENTIC_BROWSER, null, false)?.rows).toEqual([
      { label: 'Open in default browser', keys: ['Click'], target: 'default-browser' },
    ]);
  });

  it('draws the Mac glyph on a Mac, where Ctrl+click is a right click', () => {
    expect(linkTipContent('url', BOTH, null, true)?.rows.map((row) => row.keys)).toEqual([['Click'], ['⌘', 'Click']]);
  });

  it('shows a path in its folder on Ctrl+click, whatever the link actions are', () => {
    expect(linkTipContent('path', [], null, false)).toEqual({ destination: null, rows: [{ label: 'Show in folder', keys: ['Ctrl', 'Click'] }] });
  });

  it('carries the destination it is given, and says nothing for a URL with no action', () => {
    expect(linkTipContent('url', BOTH, 'https://claude.ai/artifact/abc', false)?.destination).toBe('https://claude.ai/artifact/abc');
    expect(linkTipContent('url', [], null, false)).toBeNull();
  });
});

describe('osc8Destination', () => {
  it('names the URL when the link\'s cells say something else', () => {
    expect(osc8Destination('https://claude.ai/artifact/abc', 'canvas')).toBe('https://claude.ai/artifact/abc');
  });

  it('adds nothing when the cells already read as the URL, a trailing slash aside', () => {
    expect(osc8Destination('https://example.com/', ' https://example.com ')).toBeNull();
  });
});

/** Just enough DOM for the tip: elements that take attributes and children, a body, a window. */
class FakeNode {
  attributes: Record<string, string> = {};
  children: FakeNode[] = [];
  parent: FakeNode | null = null;
  className = '';
  textContent = '';
  offsetWidth = 120;
  offsetHeight = 24;
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  setAttribute(name: string, value: string): void { this.attributes[name] = value; }
  append(...nodes: FakeNode[]): void {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }
  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }
}

function fakeTerminal(): { terminal: LinkTipTerminal; body: FakeNode } {
  const body = new FakeNode();
  const view = { addEventListener: vi.fn(), removeEventListener: vi.fn(), innerWidth: 1000, innerHeight: 800 };
  const ownerDocument = { createElement: () => new FakeNode(), body, defaultView: view };
  const element = {
    isConnected: true,
    ownerDocument,
    addEventListener: vi.fn(),
    querySelector: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 160 }) }),
  };
  const terminal = { element, cols: 40, rows: 10, buffer: { active: { viewportY: 0 } } } as unknown as LinkTipTerminal;
  return { terminal, body };
}

function hoverOf(osc8Uri?: string): LinkHover {
  return { event: { clientY: 5 }, range: { start: { x: 1, y: 1 }, end: { x: 4, y: 1 } }, kind: 'url', osc8Uri };
}

const ONE_ROW: LinkTipContent = { destination: null, rows: [{ label: 'Open in default browser', keys: ['Click'], target: 'default-browser' }] };

describe('createTerminalLinkTip', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetTipStateForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetTipStateForTests();
  });

  it('renders no tip when the link has nothing to say', () => {
    const { terminal, body } = fakeTerminal();
    const describeLink = vi.fn(() => null);
    const tip = createTerminalLinkTip(terminal, describeLink);
    tip.show(hoverOf());
    vi.advanceTimersByTime(TOOLTIP_DWELL_MS);
    expect(describeLink).toHaveBeenCalledTimes(1);
    expect(body.children).toHaveLength(0);
    tip.dispose();
  });

  it('draws one action as the label tip, and an action under a destination as the stack', () => {
    const label = fakeTerminal();
    const labelTip = createTerminalLinkTip(label.terminal, () => ONE_ROW);
    labelTip.show(hoverOf());
    vi.advanceTimersByTime(TOOLTIP_DWELL_MS);
    expect(label.body.children.map((node) => node.attributes['data-shape'])).toEqual(['label']);
    labelTip.dispose();

    resetTipStateForTests();
    const stack = fakeTerminal();
    const stackTip = createTerminalLinkTip(stack.terminal, () => ({ ...ONE_ROW, destination: 'https://example.com/a' }));
    stackTip.show(hoverOf());
    vi.advanceTimersByTime(TOOLTIP_DWELL_MS);
    expect(stack.body.children.map((node) => node.attributes['data-shape'])).toEqual(['stack']);
    stackTip.dispose();
  });

  it('carries on a visit when the same link comes straight back, and ends it for the same cells with another address', () => {
    const { terminal, body } = fakeTerminal();
    const describeLink = vi.fn(() => ONE_ROW);
    const tip = createTerminalLinkTip(terminal, describeLink);
    tip.show(hoverOf('https://example.com/a'));
    vi.advanceTimersByTime(TOOLTIP_DWELL_MS);
    expect(describeLink).toHaveBeenCalledTimes(1);
    const [firstTip] = body.children;

    // A repaint over the same link: no new visit, the tip stays.
    tip.show(hoverOf('https://example.com/a'));
    expect(describeLink).toHaveBeenCalledTimes(1);
    expect(body.children).toEqual([firstTip]);

    // An agent painted a different OSC 8 link over the same cells: the old tip goes, the new link is described.
    tip.show(hoverOf('https://example.com/b'));
    expect(describeLink).toHaveBeenCalledTimes(2);
    expect(describeLink).toHaveBeenLastCalledWith(expect.objectContaining({ osc8Uri: 'https://example.com/b' }));
    expect(firstTip.parent).toBeNull();
    expect(body.children).toHaveLength(1);
    expect(body.children[0]).not.toBe(firstTip);
    tip.dispose();
  });
});

describe('readRangeText', () => {
  it('reads an OSC 8 link\'s text from its cells, across a wrap', async () => {
    const terminal = new Terminal({ cols: 10, rows: 4, allowProposedApi: true });
    activateUnicode11(terminal);
    await new Promise<void>((resolve) => terminal.write('ab canvas-link-text', resolve));
    const range = { start: { x: 4, y: 1 }, end: { x: 9, y: 2 } };
    expect(readRangeText(terminal.buffer.active, range, terminal.cols)).toBe('canvas-link-text');
  });
});
