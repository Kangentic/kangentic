/**
 * Shared CDP query result shapes for the in-process Chrome DevTools
 * Protocol driver (`./cdp`). These ship in production: both the user-facing
 * browser-pane driver and the dev-only inspection bridge consume them.
 *
 * The dev-only `src/devtools/shared/types.ts` re-exports these for backward
 * compatibility, so existing devtools consumers keep their import paths.
 */

/**
 * Viewport-space layout box for one element, derived from
 * `getBoundingClientRect()` (CSS pixels relative to the viewport). This
 * differs from the singular bounding-box result, which returns the raw CDP
 * box-model quads (content / padding / border / margin).
 */
export interface QueryAllElementBox {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * One matched element returned by a query-all over a selector. `attributes`
 * and `outerHTML` are only populated when the caller requests them (lean by
 * default for multi-element measurement).
 */
export interface QueryAllElement {
  index: number;
  tag: string;
  attributes?: Record<string, string>;
  box: QueryAllElementBox;
  outerHTML?: string;
  /** Set when `outerHTML` was clipped to the per-element character cap. */
  outerHTMLTruncated?: boolean;
}

/**
 * Result of a query-all over a selector: every matching element measured in
 * a single `Runtime.evaluate`. `total` is the full match count; `elements`
 * is capped at `returned` (the caller's `limit`).
 */
export interface QueryAllResult {
  selector: string;
  /** Resolved selector kind: 'css' | 'text' | 'text-contains' | 'aria'. */
  kind: string;
  total: number;
  returned: number;
  /** True when `total` exceeded `limit` and `elements` was clipped. */
  truncated: boolean;
  elements: QueryAllElement[];
}
