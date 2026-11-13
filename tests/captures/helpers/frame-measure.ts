/**
 * What a frame lays out, measured in the page, and how two such measures differ.
 *
 * kangentic.com shows a poster of each demo scene until the live frame is ready, and the owner's bar
 * (kangentic.com #137) is that nothing about the text moves at the lift: the same face, the same
 * wrapping, the same layout. A pixel diff alone cannot say that across operating systems, since
 * each rasterizes text its own way, so the poster rig records this measure beside every poster
 * (tests/captures/features/scenes.capture.ts, hero.capture.ts) and the release gate
 * (tests/captures/features/poster-gate.capture.ts) measures the live frame the same way and
 * compares.
 *
 *   textNodes  every visible text node in document order, its text, the character offsets where it
 *              wraps, and one box per line (Range.getClientRects, merged per line).
 *   terminals  every mounted xterm: its grid, its cell as the frame shows it, and the rect it draws
 *              in. xterm paints into a canvas, so no text node of it exists, and this is what holds
 *              its layout to the poster's.
 *
 * `compareFrameMeasures` is the bar. A different text, line count or wrap offset always fails; a
 * line's box may move by at most the tolerances, because each OS's text scaler rounds advances
 * differently (DirectWrite, CoreText, FreeType) and Chromium snaps a border to whole device pixels,
 * so at 125 percent the bottom panel sits 0.2 CSS px higher than at 100 (measured, task #1079).
 */
import type { Page } from '@playwright/test';

export interface MeasuredBox { x: number; y: number; width: number; height: number }

export interface MeasuredTextNode {
  /** The node's element path from <body>, for a readable report. */
  path: string;
  text: string;
  /** Character offsets where a new line starts; empty for a node on one line. */
  breaks: number[];
  lines: MeasuredBox[];
}

export interface MeasuredTerminal {
  session: string | null;
  cols: number;
  rows: number;
  /** The cell as drawn on screen, in CSS px (after the demo's cell scale, if any). */
  cell: { width: number; height: number };
  rect: MeasuredBox;
}

export interface FrameMeasure {
  viewport: { width: number; height: number };
  textNodes: MeasuredTextNode[];
  terminals: MeasuredTerminal[];
}

/**
 * Measure the frame on `page`. The function passed to evaluate is self-contained: Playwright
 * serializes its source, so it may reach nothing outside itself.
 */
export async function measureFrame(page: Page): Promise<FrameMeasure> {
  return page.evaluate((): FrameMeasure => {
    const round = (value: number): number => Math.round(value * 100) / 100;
    // The exported types are erased before Playwright serializes this function, so naming them
    // here reaches nothing outside it.
    const box = (rect: DOMRect | { left: number; top: number; width: number; height: number }): MeasuredBox => ({
      x: round(rect.left), y: round(rect.top), width: round(rect.width), height: round(rect.height),
    });
    const pathCache = new Map<Element, string>();
    const pathOf = (element: Element): string => {
      const cached = pathCache.get(element);
      if (cached !== undefined) return cached;
      const parent = element.parentElement;
      if (!parent || element === document.body) return 'body';
      const sameTag = Array.from(parent.children).filter((child) => child.tagName === element.tagName);
      const step = `${element.tagName.toLowerCase()}${sameTag.length > 1 ? `:${sameTag.indexOf(element) + 1}` : ''}`;
      const testId = element.getAttribute('data-testid');
      const path = `${pathOf(parent)} > ${step}${testId ? `[${testId}]` : ''}`;
      pathCache.set(element, path);
      return path;
    };
    const isShown = (element: Element): boolean => {
      const style = getComputedStyle(element);
      return style.visibility !== 'hidden' && style.display !== 'none';
    };

    const textNodes: MeasuredTextNode[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!node.nodeValue || !node.nodeValue.trim() || !parent) return NodeFilter.FILTER_REJECT;
        // xterm's own DOM (its helper textarea, its accessibility tree) is measured as a terminal
        // below; an extension's node is hidden by demo/boot.js and never the page's.
        if (parent.closest('.xterm, [data-demo-foreign], script, style, noscript, template')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const range = document.createRange();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement as Element;
      if (!isShown(parent)) continue;
      range.selectNodeContents(node);
      const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
      if (rects.length === 0) continue;
      // One box per line: a line can come back as several rects (a bidi run), joined here.
      const lines: Array<{ left: number; top: number; right: number; bottom: number }> = [];
      for (const rect of rects) {
        const line = lines.find((candidate) => Math.abs(candidate.top - rect.top) < 1);
        if (line) {
          line.left = Math.min(line.left, rect.left);
          line.right = Math.max(line.right, rect.right);
          line.bottom = Math.max(line.bottom, rect.bottom);
        } else {
          lines.push({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
        }
      }
      lines.sort((first, second) => first.top - second.top);
      // Where each line after the first starts, by character: the first character whose box sits
      // on that line. Read only for a node that wraps, so a one-line node costs one rect read.
      const breaks: number[] = [];
      const text = node.nodeValue ?? '';
      if (lines.length > 1) {
        let lineIndex = 1;
        for (let offset = 0; offset < text.length && lineIndex < lines.length; offset++) {
          range.setStart(node, offset);
          range.setEnd(node, offset + 1);
          const characterRect = Array.from(range.getClientRects()).find((rect) => rect.width > 0 || rect.height > 0);
          if (characterRect && characterRect.top >= lines[lineIndex].top - 0.5) {
            breaks.push(offset);
            lineIndex += 1;
          }
        }
      }
      textNodes.push({
        path: pathOf(parent),
        text,
        breaks,
        lines: lines.map((line) => box({ left: line.left, top: line.top, width: line.right - line.left, height: line.bottom - line.top })),
      });
    }

    const terminals: MeasuredTerminal[] = [];
    for (const xterm of Array.from(document.querySelectorAll<HTMLElement>('.xterm'))) {
      const canvas = xterm.querySelector<HTMLCanvasElement>('.xterm-screen canvas');
      const textarea = xterm.querySelector<HTMLElement>('.xterm-helper-textarea');
      if (!canvas || !textarea) continue;
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0 || !isShown(xterm)) continue;
      // The textarea's style carries xterm's own CSS cell, before any transform the frame applies.
      const cellWidth = parseFloat(textarea.style.width);
      const cellHeight = parseFloat(textarea.style.height);
      const cssWidth = parseFloat(canvas.style.width);
      const cssHeight = parseFloat(canvas.style.height);
      if (!(cellWidth > 0 && cellHeight > 0 && cssWidth > 0 && cssHeight > 0)) continue;
      const cols = Math.round(cssWidth / cellWidth);
      const rows = Math.round(cssHeight / cellHeight);
      terminals.push({
        session: xterm.closest('[data-session-id]')?.getAttribute('data-session-id') ?? null,
        cols,
        rows,
        cell: { width: round(rect.width / cols), height: round(rect.height / rows) },
        rect: box(rect),
      });
    }

    return { viewport: { width: window.innerWidth, height: window.innerHeight }, textNodes, terminals };
  });
}

/** How far a line box or a terminal may move, in CSS px, before the gate calls it a layout change. */
export interface FrameTolerances { x: number; y: number }

/** The bar the owner signed off on (task #1079): wraps exact, a line's box within half a pixel across and one pixel down. */
export const FRAME_TOLERANCES: FrameTolerances = { x: 0.5, y: 1 };

/**
 * How far a terminal's rect may move or resize, in CSS px, on both axes. Looser across than a
 * line of text: the terminal's width is a whole number of cells, each floored to device pixels,
 * so it rounds as a line's height does, not as a line's advance does.
 */
const TERMINAL_TOLERANCE_PX = 1;

export interface CompareOptions {
  /**
   * Whether line boxes are held to the poster's positions. True at the scale the poster was shot
   * at. At any other scale Chromium snaps each line box and border to whole device pixels, so text
   * drifts down a page (measured on Windows on 2026-11-12: up to 8 px at 125 percent and 13 px at
   * 150 deep in a list, with every wrap the same), and only wraps, text, and each terminal's grid
   * and size are held.
   */
  comparePositions?: boolean;
}

/** A text that differs from the poster's only in its digits: a clock or a counter that moved on. */
export function differsOnlyInDigits(expected: string, found: string): boolean {
  return expected !== found && expected.replace(/[0-9]/g, '0') === found.replace(/[0-9]/g, '0');
}

/** How many text nodes on the frame are the poster's with other digits: clocks and counters. */
export function countClockTexts(reference: FrameMeasure, actual: FrameMeasure): number {
  let count = 0;
  const nodeCount = Math.min(reference.textNodes.length, actual.textNodes.length);
  for (let index = 0; index < nodeCount; index++) {
    if (differsOnlyInDigits(reference.textNodes[index].text, actual.textNodes[index].text)) count += 1;
  }
  return count;
}

const MAX_PROBLEMS = 20;

function describeBox(measured: MeasuredBox): string {
  return `(${measured.x}, ${measured.y}) ${measured.width}x${measured.height}`;
}

function boxMoved(reference: MeasuredBox, actual: MeasuredBox, tolerances: FrameTolerances): boolean {
  return Math.abs(reference.x - actual.x) > tolerances.x
    || Math.abs(reference.width - actual.width) > tolerances.x
    || Math.abs(reference.y - actual.y) > tolerances.y
    || Math.abs(reference.height - actual.height) > tolerances.y;
}

/**
 * Every way `actual` lays out differently from `reference`, one line each, at most MAX_PROBLEMS
 * (and a last line saying how many more). Empty means the frame matches its poster. A text that
 * differs only in its digits (differsOnlyInDigits) is a clock or a counter, not a different frame:
 * its line count is held and its width is not, since digits are not all one width.
 */
export function compareFrameMeasures(reference: FrameMeasure, actual: FrameMeasure, options: CompareOptions = {}): string[] {
  const comparePositions = options.comparePositions ?? true;
  const problems: string[] = [];
  let more = 0;
  const report = (problem: string): void => {
    if (problems.length < MAX_PROBLEMS) problems.push(problem);
    else more += 1;
  };

  if (reference.viewport.width !== actual.viewport.width || reference.viewport.height !== actual.viewport.height) {
    report(`viewport is ${actual.viewport.width}x${actual.viewport.height}, the poster's is ${reference.viewport.width}x${reference.viewport.height}`);
  }

  const nodeCount = Math.max(reference.textNodes.length, actual.textNodes.length);
  for (let index = 0; index < nodeCount; index++) {
    const expected = reference.textNodes[index];
    const found = actual.textNodes[index];
    if (!expected || !found) {
      report(`${reference.textNodes.length} text nodes on the poster, ${actual.textNodes.length} on the frame; the first unmatched is ${JSON.stringify((expected ?? found).text)} at ${(expected ?? found).path}`);
      break;
    }
    const clock = differsOnlyInDigits(expected.text, found.text);
    if (expected.text !== found.text && !clock) {
      report(`text node ${index} reads ${JSON.stringify(found.text)} where the poster reads ${JSON.stringify(expected.text)} (${expected.path})`);
      break;
    }
    const label = `${JSON.stringify(expected.text.length > 60 ? `${expected.text.slice(0, 57)}...` : expected.text)} (${expected.path})`;
    if (expected.lines.length !== found.lines.length || (!clock && expected.breaks.join(',') !== found.breaks.join(','))) {
      report(`${label} wraps at [${found.breaks.join(', ')}] on ${found.lines.length} line(s), the poster at [${expected.breaks.join(', ')}] on ${expected.lines.length}`);
      continue;
    }
    if (!comparePositions) continue;
    const lineTolerances = clock ? { x: Number.POSITIVE_INFINITY, y: FRAME_TOLERANCES.y } : FRAME_TOLERANCES;
    expected.lines.forEach((line, lineIndex) => {
      if (boxMoved(line, found.lines[lineIndex], lineTolerances)) {
        report(`${label} line ${lineIndex + 1} is at ${describeBox(found.lines[lineIndex])}, the poster's at ${describeBox(line)}`);
      }
    });
  }

  if (reference.terminals.length !== actual.terminals.length) {
    report(`${actual.terminals.length} terminal(s) on the frame, ${reference.terminals.length} on the poster`);
  } else {
    reference.terminals.forEach((expected, index) => {
      const found = actual.terminals[index];
      const label = `terminal ${expected.session ?? index}`;
      if (expected.cols !== found.cols || expected.rows !== found.rows) {
        report(`${label} is ${found.cols} by ${found.rows}, the poster's ${expected.cols} by ${expected.rows}`);
        return;
      }
      // The rect's place on the page drifts with the same device-pixel snapping as the text above
      // it, so off the poster's scale only its size is held, as only a line's wrap is.
      const position = comparePositions ? TERMINAL_TOLERANCE_PX : Number.POSITIVE_INFINITY;
      const rectMoved = Math.abs(expected.rect.x - found.rect.x) > position
        || Math.abs(expected.rect.y - found.rect.y) > position
        || Math.abs(expected.rect.width - found.rect.width) > TERMINAL_TOLERANCE_PX
        || Math.abs(expected.rect.height - found.rect.height) > TERMINAL_TOLERANCE_PX;
      if (rectMoved) {
        report(`${label} draws at ${describeBox(found.rect)}, the poster's at ${describeBox(expected.rect)}`);
      }
    });
  }

  if (more > 0) problems.push(`... and ${more} more`);
  return problems;
}
