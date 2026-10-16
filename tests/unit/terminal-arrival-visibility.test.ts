/**
 * `isArrivingTerminalVisible`: the tier-0 probe of the arrival-focus arbiter.
 *
 * A terminal that the user cannot see (a modal backdrop over it, the Agent
 * Monitor overlay, a zero-size box) must never take keyboard focus on arrival.
 * The probe hit-tests five points of the terminal's box and asks whether any
 * of them lands inside the terminal's pane. Its contract:
 *
 *   - a box with no width or no height is not visible, whatever the hit test says;
 *   - ONE probe landing in the pane is enough, so a small cover (a toast, an open
 *     menu) over the middle does not read as the whole terminal being hidden;
 *   - containment is against the host pane (`[data-terminal-host]`), not the xterm
 *     element alone, because a host's own cover (the launch overlay) is part of
 *     the terminal as far as the user is concerned;
 *   - with no host ancestor, the element itself is the pane.
 *
 * The unit tier has no DOM, so `document` and the elements are minimal fakes
 * that follow the two DOM semantics the probe depends on: `contains` is true for
 * the node itself and any descendant, and `closest` walks up through ancestors.
 * Real hit-testing (pointer-events-none layers being skipped) is the UI tier's
 * (tests/ui/terminal-arrival-focus-hidden.spec.ts).
 *
 * Every case says which regression turns it red.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isArrivingTerminalVisible,
  mayTakeArrivalFocus,
  claimArrivalFocus,
} from '../../src/renderer/utils/terminal-arrival-focus';

interface FakeRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A DOM node reduced to what the probe reads. */
class FakeNode {
  readonly children: FakeNode[] = [];

  constructor(
    readonly label: string,
    readonly parent: FakeNode | null = null,
    readonly isTerminalHost = false,
    private readonly rect: FakeRect = { left: 0, top: 0, width: 0, height: 0 },
  ) {
    parent?.children.push(this);
  }

  /** DOM semantics: true for the node itself and for every descendant. */
  contains(other: FakeNode | null): boolean {
    for (let currentNode: FakeNode | null = other; currentNode; currentNode = currentNode.parent) {
      if (currentNode === this) return true;
    }
    return false;
  }

  /** Only the host selector is ever asked for; anything else is a test bug. */
  closest(selector: string): FakeNode | null {
    if (selector !== '[data-terminal-host]') throw new Error(`unexpected selector ${selector}`);
    if (this.isTerminalHost) return this;
    return this.parent ? this.parent.closest(selector) : null;
  }

  getBoundingClientRect(): FakeRect {
    return { ...this.rect };
  }
}

function asElement(node: FakeNode): HTMLElement {
  return node as unknown as HTMLElement;
}

/**
 * A non-zero origin and exact dyadic fractions, so a probe that forgets to add
 * `rect.left` or `rect.top` lands somewhere else, and the arithmetic is exact.
 * These mirror VISIBILITY_PROBES: the centre, then the four quarter points.
 */
const BOX: FakeRect = { left: 100, top: 50, width: 200, height: 100 };
const CENTER = { x: 200, y: 100 };
const QUARTER_POINTS = [
  { label: 'upper left', x: 150, y: 75 },
  { label: 'upper right', x: 250, y: 75 },
  { label: 'lower left', x: 150, y: 125 },
  { label: 'lower right', x: 250, y: 125 },
];

interface Scene {
  root: FakeNode;
  host: FakeNode;
  xterm: FakeNode;
  launchOverlay: FakeNode;
  /** A sibling of the host under the root: a dialog backdrop, the monitor overlay. */
  outsideCover: FakeNode;
}

/** root > [host > [xterm, launchOverlay], outsideCover] */
function buildScene(xtermRect: FakeRect = BOX): Scene {
  const root = new FakeNode('root');
  const host = new FakeNode('host', root, true);
  const xterm = new FakeNode('xterm', host, false, xtermRect);
  const launchOverlay = new FakeNode('launch-overlay', host);
  const outsideCover = new FakeNode('outside-cover', root);
  return { root, host, xterm, launchOverlay, outsideCover };
}

type HitTest = (x: number, y: number) => FakeNode | null;

/** Install a fake `document` whose hit test is `resolve`, and return its spy. */
function stubHitTest(resolve: HitTest): ReturnType<typeof vi.fn> {
  const elementFromPoint = vi.fn(resolve);
  vi.stubGlobal('document', { activeElement: null, elementFromPoint });
  return elementFromPoint;
}

/** Hit `inside` at exactly one point and `elsewhere` at every other. */
function hitInsideOnlyAt(point: { x: number; y: number }, inside: FakeNode, elsewhere: FakeNode): HitTest {
  return (x, y) => (x === point.x && y === point.y ? inside : elsewhere);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isArrivingTerminalVisible', () => {
  describe('size', () => {
    it.each([
      ['zero width', { ...BOX, width: 0 }],
      ['zero height', { ...BOX, height: 0 }],
      ['no width and no height', { ...BOX, width: 0, height: 0 }],
      ['negative width', { ...BOX, width: -10 }],
    ])('is not visible with %s, even when every hit lands in its own pane', (_label, rect) => {
      // Red if the size check is dropped: the hit test below answers "inside the
      // pane" for every point, so the probe would report visible.
      const scene = buildScene(rect);
      const elementFromPoint = stubHitTest(() => scene.xterm);

      expect(isArrivingTerminalVisible(asElement(scene.xterm))).toBe(false);
      // The size check runs before any hit test.
      expect(elementFromPoint).not.toHaveBeenCalled();
    });
  });

  describe('probes', () => {
    it('is visible when the centre hits the terminal itself', () => {
      // Red if the probe always answers false (a gate that denies every arrival).
      const scene = buildScene();
      stubHitTest(() => scene.xterm);

      expect(isArrivingTerminalVisible(asElement(scene.xterm))).toBe(true);
    });

    it.each(QUARTER_POINTS)(
      'is visible when only the $label probe lands in the pane and the centre is covered',
      (point) => {
        // Red if the probe is centre-only (the centre is covered here), or if this
        // quarter probe is dropped or computed without rect.left / rect.top: the
        // resolver answers "inside" at this exact coordinate and nowhere else.
        const scene = buildScene();
        stubHitTest(hitInsideOnlyAt(point, scene.xterm, scene.outsideCover));

        expect(isArrivingTerminalVisible(asElement(scene.xterm))).toBe(true);
      },
    );

    it('is visible when only the centre lands in the pane and every quarter point is covered', () => {
      // Red if the centre probe is dropped from the probe list.
      const scene = buildScene();
      stubHitTest(hitInsideOnlyAt(CENTER, scene.xterm, scene.outsideCover));

      expect(isArrivingTerminalVisible(asElement(scene.xterm))).toBe(true);
    });

    it('is not visible when every probe hits an element outside the host pane, and tries the centre and all four quarter points', () => {
      // Red if containment is dropped (any non-null hit would count as visible).
      // The probe set is read back too: a centre-only probe makes one call.
      const scene = buildScene();
      const elementFromPoint = stubHitTest(() => scene.outsideCover);

      expect(isArrivingTerminalVisible(asElement(scene.xterm))).toBe(false);

      const probedPoints = elementFromPoint.mock.calls.map(([x, y]) => `${x},${y}`).sort();
      const expectedPoints = [CENTER, ...QUARTER_POINTS].map((point) => `${point.x},${point.y}`).sort();
      expect(probedPoints).toEqual(expectedPoints);
    });

    it('is not visible when every probe hits the document root above the host pane', () => {
      // Red if containment is checked against a node wider than the pane, such as
      // the host's parent: the root contains the host, but the pane does not
      // contain the root.
      const scene = buildScene();
      stubHitTest(() => scene.root);

      expect(isArrivingTerminalVisible(asElement(scene.xterm))).toBe(false);
    });

    it('is not visible when nothing answers the hit test at any probe', () => {
      // Red if a null hit (a point off-screen or over nothing) is read as inside.
      const scene = buildScene();
      stubHitTest(() => null);

      expect(isArrivingTerminalVisible(asElement(scene.xterm))).toBe(false);
    });
  });

  describe('pane containment', () => {
    it.each([
      ['a sibling inside the host pane (the launch overlay)', (scene: Scene) => scene.launchOverlay],
      ['the host pane itself', (scene: Scene) => scene.host],
    ])('is visible when the hit is %s, which is not the xterm element', (_label, pickHit) => {
      // Red if containment is checked against the xterm element alone
      // (`element.contains(hit)`): a host's own cover would read as hiding it.
      const scene = buildScene();
      stubHitTest(() => pickHit(scene));

      expect(isArrivingTerminalVisible(asElement(scene.xterm))).toBe(true);
    });

    it('uses the nearest host pane, so a hit inside the xterm subtree counts', () => {
      // Red if containment becomes an identity check (`hit === pane` or
      // `hit === element`) instead of `contains`: xterm hit-tests to its canvas
      // or viewport child, never to the element it was opened into.
      const scene = buildScene();
      const deepDescendant = new FakeNode('xterm-canvas', scene.xterm);
      stubHitTest(() => deepDescendant);

      expect(isArrivingTerminalVisible(asElement(scene.xterm))).toBe(true);
    });
  });

  describe('with no data-terminal-host ancestor', () => {
    function buildBareScene(): { wrapper: FakeNode; element: FakeNode; child: FakeNode; sibling: FakeNode } {
      const wrapper = new FakeNode('wrapper');
      const element = new FakeNode('element', wrapper, false, BOX);
      const child = new FakeNode('element-child', element);
      const sibling = new FakeNode('sibling', wrapper);
      return { wrapper, element, child, sibling };
    }

    it('treats the element itself as the pane: a hit on it or its descendant is visible', () => {
      // Red if the fallback is dropped (closest(...) is null, so contains would
      // throw) or points at something that excludes the element itself.
      const { element, child } = buildBareScene();

      stubHitTest(() => element);
      expect(isArrivingTerminalVisible(asElement(element))).toBe(true);

      stubHitTest(() => child);
      expect(isArrivingTerminalVisible(asElement(element))).toBe(true);
    });

    it('is not visible when every hit is an element beside it, not inside it', () => {
      // Red if the fallback pane is wider than the element (its parent, or the
      // document): a sibling cover would then read as part of the terminal.
      const { element, sibling, wrapper } = buildBareScene();

      stubHitTest(() => sibling);
      expect(isArrivingTerminalVisible(asElement(element))).toBe(false);

      stubHitTest(() => wrapper);
      expect(isArrivingTerminalVisible(asElement(element))).toBe(false);
    });
  });
});

/**
 * The same probe, reached through the real `mayTakeArrivalFocus` wrapper, so a
 * wrapper that stopped passing the element on (or stopped feeding the answer
 * into tier 0) goes red.
 *
 * ONE session id is used by every call. The arbiter's tier-3 burst hold denies a
 * DIFFERENT session that arrives within 500ms of a grant, so two ids would let a
 * dropped tier 0 still deny the covered call as `burst-taken`, and the covered
 * assertions would pass for the wrong reason. The same id is never burst-held.
 */
describe('mayTakeArrivalFocus with an arriving element', () => {
  const SESSION_ID = 'sess-arrival-visibility';

  beforeEach(() => {
    claimArrivalFocus(null);
  });

  afterEach(() => {
    claimArrivalFocus(null);
  });

  it('allows a visible terminal and denies the same session once it is covered', () => {
    const scene = buildScene();

    stubHitTest(() => scene.xterm);
    expect(mayTakeArrivalFocus(SESSION_ID, 'tab-init', asElement(scene.xterm))).toBe(true);

    // Red if the wrapper ignores the element or hard-codes `terminalVisible: true`:
    // nothing else is in play (no claim, no window, focus not in a typing
    // surface), so tier 3 would allow it.
    stubHitTest(() => scene.outsideCover);
    expect(mayTakeArrivalFocus(SESSION_ID, 'tab-init', asElement(scene.xterm))).toBe(false);
  });

  it('denies a covered terminal even when a live claim names its session', () => {
    // Red if tier 0 sits below the claim: a claim lives up to 30 seconds, long
    // enough for a dialog to open over the terminal the user clicked earlier.
    const scene = buildScene();
    claimArrivalFocus(SESSION_ID);

    stubHitTest(() => scene.xterm);
    expect(mayTakeArrivalFocus(SESSION_ID, 'reload', asElement(scene.xterm))).toBe(true);

    stubHitTest(() => scene.outsideCover);
    expect(mayTakeArrivalFocus(SESSION_ID, 'reload', asElement(scene.xterm))).toBe(false);
  });

  it('denies a terminal with no size', () => {
    // Red if the wrapper does not run the size check: the hit test says "inside".
    const scene = buildScene({ ...BOX, width: 0 });
    stubHitTest(() => scene.xterm);

    expect(mayTakeArrivalFocus(SESSION_ID, 'mount-replay', asElement(scene.xterm))).toBe(false);
  });

  it('counts a host cover inside the pane as the terminal, not as a cover', () => {
    // Red if the wrapper judges the xterm element alone: the launch overlay
    // answers every hit test while the agent starts, and the terminal must still
    // take focus once it arrives.
    const scene = buildScene();
    stubHitTest(() => scene.launchOverlay);

    expect(mayTakeArrivalFocus(SESSION_ID, 'deferred-init', asElement(scene.xterm))).toBe(true);
  });

  it('judges nothing when the host gave no element, and never hit-tests', () => {
    // Red if a missing element is read as hidden: a host with nothing to judge
    // would never focus. Also red if the wrapper hit-tests without an element.
    const elementFromPoint = stubHitTest(() => null);

    expect(mayTakeArrivalFocus(SESSION_ID, 'tab-init')).toBe(true);
    expect(mayTakeArrivalFocus(SESSION_ID, 'tab-init', null)).toBe(true);
    expect(elementFromPoint).not.toHaveBeenCalled();
  });
});
