/**
 * Strict selector matching for the `kangentic_browser_*` tools that act on one
 * element (GitHub #820).
 *
 * A selector used to resolve to its FIRST match in document order, which could
 * be a hidden duplicate or a button in a form covered by an open modal. An agent
 * clicked "Save" in the form behind a dialog, the click landed on the backdrop,
 * and the dialog closed with nothing reporting that the selector had matched
 * twice. Strict resolution counts the VISIBLE matches and refuses to pick one
 * when there is more than one, the way a Playwright Locator does.
 *
 * "Visible" is the agent-facing word for what `buildActionableMatchesExpression`
 * in `cdp.ts` calls a match a user could act on: connected, laid out with a
 * non-zero box, not `visibility: hidden`, and not inside an `inert` subtree.
 *
 * The refusal travels as a thrown error rather than a return value so every
 * primitive in `cdp.ts` keeps its return type, and `withGuest` turns it into
 * the `ambiguous-selector` kind in one place, next to `pane-not-focused`.
 */

/** How many matches a refusal describes. The `total` still counts them all. */
export const AMBIGUOUS_CANDIDATE_LIMIT = 5;

/** One visible match, described so the agent can tell them apart and pick. */
export interface SelectorCandidate {
  index: number;
  tag: string;
  /** Visible text or aria-label, whitespace collapsed and clipped. */
  text: string;
  id: string | null;
  role: string | null;
  ariaLabel: string | null;
  name: string | null;
  /** Inside an open `<dialog>`, `[role=dialog]`, `[role=alertdialog]` or `[aria-modal=true]`. */
  inDialog: boolean;
  /**
   * Whether this element is what a click at its centre would hit. False means
   * something covers it (a modal's backdrop, say). Null when the centre is
   * outside the viewport, so the page cannot say.
   */
  topmost: boolean | null;
  /** Viewport box in CSS pixels, rounded. */
  box: { x: number; y: number; width: number; height: number };
  /** A CSS path unique in the document right now. Retry with it to pick this match. */
  selector: string;
}

/**
 * The longest a described field may be. The page's expression clips `text` to
 * 80, but every field comes from the page, and a multi-megabyte `aria-label`
 * would otherwise ride whole into the agent's error envelope.
 */
export const CANDIDATE_FIELD_MAX_CHARS = 200;

/**
 * The longest `selector` a candidate may carry. A selector is never clipped,
 * because a cut CSS path is invalid or names a different element, and the
 * agent is told to retry with it. A candidate past this is dropped instead.
 */
export const CANDIDATE_SELECTOR_MAX_CHARS = 2000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value.slice(0, CANDIDATE_FIELD_MAX_CHARS) : null;
}

function clippedString(value: unknown): string {
  return stringOrNull(value) ?? '';
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * The candidates a page described, checked field by field. The page runs our
 * expression, but it is still the page: a script can patch what that
 * expression calls, so the shape is not trusted. An entry without a string
 * `selector`, or with one past `CANDIDATE_SELECTOR_MAX_CHARS`, cannot be
 * retried and is dropped; any other field that is the wrong type is read as
 * empty, and a string field is clipped to `CANDIDATE_FIELD_MAX_CHARS`.
 */
export function parseSelectorCandidates(value: unknown): SelectorCandidate[] {
  if (!Array.isArray(value)) return [];
  const candidates: SelectorCandidate[] = [];
  for (const entry of value.slice(0, AMBIGUOUS_CANDIDATE_LIMIT)) {
    if (!isRecord(entry) || typeof entry.selector !== 'string') continue;
    if (entry.selector.length > CANDIDATE_SELECTOR_MAX_CHARS) continue;
    const box = isRecord(entry.box) ? entry.box : {};
    candidates.push({
      index: finiteNumber(entry.index),
      tag: clippedString(entry.tag),
      text: clippedString(entry.text),
      id: stringOrNull(entry.id),
      role: stringOrNull(entry.role),
      ariaLabel: stringOrNull(entry.ariaLabel),
      name: stringOrNull(entry.name),
      inDialog: entry.inDialog === true,
      topmost: typeof entry.topmost === 'boolean' ? entry.topmost : null,
      box: {
        x: finiteNumber(box.x),
        y: finiteNumber(box.y),
        width: finiteNumber(box.width),
        height: finiteNumber(box.height),
      },
      selector: entry.selector,
    });
  }
  return candidates;
}

export class AmbiguousSelectorError extends Error {
  readonly selector: string;
  readonly total: number;
  readonly candidates: SelectorCandidate[];

  constructor(selector: string, total: number, candidates: SelectorCandidate[]) {
    super(`${total} visible elements match the selector.`);
    this.name = 'AmbiguousSelectorError';
    this.selector = selector;
    this.total = total;
    this.candidates = candidates;
  }
}

/**
 * The agent-facing sentence for an `ambiguous-selector` refusal. With no
 * candidates (every one the page described was dropped as unretryable) it does
 * not point the agent at a candidate's selector.
 */
export function ambiguousSelectorDetail(error: AmbiguousSelectorError): string {
  const scopeHint = 'scope the selector to its container '
    + '(for example [role=dialog] button:has-text("Save")), or pass strict: false to act on the first match.';
  if (error.candidates.length === 0) {
    return `${error.total} visible elements match ${error.selector}, so nothing was done. `
      + `None of them could be described with a selector to retry, so ${scopeHint}`;
  }
  return `${error.total} visible elements match ${error.selector}, so nothing was done. `
    + `Retry with one candidate's selector, or ${scopeHint} `
    + 'A candidate with topmost: false is covered by another element.';
}
