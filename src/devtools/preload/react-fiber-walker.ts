/**
 * React fiber walker utilities, used by the dev-only React inspection
 * surface (`window.__kangenticPreviewReact`). Reads the always-installed
 * `__REACT_DEVTOOLS_GLOBAL_HOOK__` to find fibers + walks them to extract
 * component metadata.
 *
 * The shape of the global hook is stable across React 18 / 19; we
 * defensively check for the methods we use and return null if anything
 * is missing instead of throwing.
 */

import type { ReactComponentInfo, ReactRenderRecord } from '../shared/types';

interface ReactFiber {
  type?: { displayName?: string; name?: string } | string | null;
  elementType?: { displayName?: string; name?: string } | string | null;
  memoizedProps?: Record<string, unknown> | null;
  memoizedState?: { memoizedState?: unknown; next?: unknown } | unknown;
  key?: string | null;
  return?: ReactFiber | null;
  child?: ReactFiber | null;
  sibling?: ReactFiber | null;
  _debugSource?: { fileName?: string; lineNumber?: number; columnNumber?: number };
  actualDuration?: number;
  stateNode?: unknown;
}

interface DevToolsHook {
  renderers?: Map<number, unknown>;
  onCommitFiberRoot?: (rendererId: number, root: { current?: ReactFiber }) => void;
  inject?: (renderer: unknown) => number;
}

function getHook(): DevToolsHook | null {
  const hook = (window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: DevToolsHook })
    .__REACT_DEVTOOLS_GLOBAL_HOOK__;
  return hook ?? null;
}

function fiberDisplayName(fiber: ReactFiber | null | undefined): string {
  if (!fiber) return '?';
  const fiberType = fiber.type ?? fiber.elementType;
  if (typeof fiberType === 'string') return fiberType;
  if (fiberType && typeof fiberType === 'object') {
    return fiberType.displayName ?? fiberType.name ?? '?';
  }
  return '?';
}

function isCustomComponent(fiber: ReactFiber): boolean {
  const fiberType = fiber.type ?? fiber.elementType;
  if (typeof fiberType === 'string') return false;
  return fiberType !== null && fiberType !== undefined;
}

function findFiberFromDomNode(node: Element): ReactFiber | null {
  // React 16+ tags the DOM node with `__reactFiber$<random>` and
  // `__reactProps$<random>`. The exact suffix changes per build, so we
  // scan keys.
  for (const key of Object.keys(node)) {
    if (key.startsWith('__reactFiber$')) {
      return (node as unknown as Record<string, ReactFiber>)[key];
    }
  }
  return null;
}

function climbToCustomComponent(fiber: ReactFiber): ReactFiber | null {
  let cursor: ReactFiber | null = fiber;
  while (cursor && !isCustomComponent(cursor)) {
    cursor = cursor.return ?? null;
  }
  return cursor;
}

function sanitizeProps(props: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!props) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (key === 'children') {
      // Children can be huge; summarize.
      out.children = Array.isArray(value) ? `[${value.length} children]` : '<children>';
      continue;
    }
    if (typeof value === 'function') {
      out[key] = `[Function: ${value.name || 'anonymous'}]`;
    } else if (typeof value === 'object' && value !== null) {
      try {
        // Round-trip through JSON to drop circular refs and DOM nodes.
        out[key] = JSON.parse(JSON.stringify(value, circularSafeReplacer()));
      } catch {
        out[key] = '[Unserializable]';
      }
    } else {
      out[key] = value;
    }
  }
  return out;
}

function extractHooks(fiber: ReactFiber): { name: string; value: unknown }[] {
  // Function components store hooks as a linked list rooted at
  // memoizedState.next. The "name" of each hook isn't surfaced by
  // React directly; we report positional names (hook0, hook1, ...) and
  // best-effort sample values.
  const out: { name: string; value: unknown }[] = [];
  const start = fiber.memoizedState as { memoizedState?: unknown; next?: unknown } | null | undefined;
  if (!start || typeof start !== 'object') return out;
  let cursor: { memoizedState?: unknown; next?: unknown } | null | undefined = start;
  let index = 0;
  while (cursor && typeof cursor === 'object' && index < 32) {
    let value: unknown = cursor.memoizedState;
    // Many hooks store [state, dispatch] tuples; only the first slot is the
    // state value.
    if (Array.isArray(value) && value.length >= 2) value = value[0];
    out.push({ name: `hook${index}`, value: sanitizeValue(value) });
    cursor = (cursor.next ?? null) as { memoizedState?: unknown; next?: unknown } | null;
    index += 1;
  }
  return out;
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'function') return `[Function: ${value.name || 'anonymous'}]`;
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.parse(JSON.stringify(value, circularSafeReplacer()));
    } catch {
      return '[Unserializable]';
    }
  }
  return value;
}

function circularSafeReplacer(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();
  return (_key, value) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value as object)) return '[Circular]';
      seen.add(value as object);
    }
    return value;
  };
}

function ancestorChain(fiber: ReactFiber): string[] {
  const chain: string[] = [];
  let cursor: ReactFiber | null = fiber.return ?? null;
  while (cursor) {
    if (isCustomComponent(cursor)) chain.push(fiberDisplayName(cursor));
    cursor = cursor.return ?? null;
  }
  return chain;
}

export function queryReactComponent(selector: string): ReactComponentInfo | null {
  const node = document.querySelector(selector);
  if (!(node instanceof Element)) return null;
  const fiber = findFiberFromDomNode(node);
  if (!fiber) return null;
  const target = climbToCustomComponent(fiber);
  if (!target) return null;
  return {
    name: fiberDisplayName(target),
    file: target._debugSource?.fileName ?? null,
    line: target._debugSource?.lineNumber ?? null,
    column: target._debugSource?.columnNumber ?? null,
    key: target.key ?? null,
    props: sanitizeProps(target.memoizedProps ?? null),
    hooks: extractHooks(target),
    parentChain: ancestorChain(target),
  };
}

interface TreeNode {
  name: string;
  key: string | null;
  children: TreeNode[];
}

export function reactTree(rootSelector: string, maxDepth: number): TreeNode | null {
  const node = document.querySelector(rootSelector);
  if (!(node instanceof Element)) return null;
  const fiber = findFiberFromDomNode(node);
  if (!fiber) return null;
  const root = climbToCustomComponent(fiber) ?? fiber;
  return walkFiberTree(root, maxDepth);
}

function walkFiberTree(fiber: ReactFiber, depthRemaining: number): TreeNode {
  const node: TreeNode = {
    name: fiberDisplayName(fiber),
    key: fiber.key ?? null,
    children: [],
  };
  if (depthRemaining <= 0) return node;
  let child = fiber.child ?? null;
  while (child) {
    if (isCustomComponent(child)) {
      node.children.push(walkFiberTree(child, depthRemaining - 1));
    } else {
      // Recurse through native nodes without consuming a depth slot -
      // a custom component nested inside a stack of <div>s shouldn't
      // disappear from the report.
      node.children.push(...walkFiberTree(child, depthRemaining).children);
    }
    child = child.sibling ?? null;
  }
  return node;
}

const RENDER_RING_SIZE = 100;
const renderRing: ReactRenderRecord[] = [];

/**
 * KNOWN GAP: in a Vite dev server this attaches to nothing, so `recentRenders` (and the
 * `kangentic_devtools_react_recent_renders` tool) returns `[]` forever.
 *
 * Preload runs before any page script, so there is no `__REACT_DEVTOOLS_GLOBAL_HOOK__` yet and
 * this returns early below. `@vitejs/plugin-react`'s react-refresh preamble then creates the
 * hook from scratch, complete with its own no-op `onCommitFiberRoot`, and our wrapper is never
 * in the chain. Confirmed against a running instance: the hook exists, `inject` exists, and
 * `renderers.size === 0`.
 *
 * Read an empty result as "not instrumented", NOT as "no React work happened" - that misreading
 * is the actual hazard here, since the tool fails silently rather than erroring. For render
 * attribution use `kangentic_devtools_event_loop_lag`'s `recentLongFrames`, which the browser
 * attributes per script.
 *
 * The fix would be to CREATE a minimal hook here when none exists, so react-refresh adopts and
 * wraps ours instead of replacing it. It is deliberately not done: even attached, this ring
 * reports `root.current`'s name on every entry (always the root, never the component that
 * re-rendered) and `actualDuration` is 0 outside a profiling build, so it can only answer "did a
 * commit happen at time t". Weigh that against the downside of a stub that does not match what
 * react-refresh expects, which is breaking Fast Refresh in the daily-dogfooded dev loop.
 */
export function installRenderTracker(): ReactRenderRecord[] {
  const hook = getHook();
  if (!hook) return renderRing;

  // Wrap the existing onCommitFiberRoot rather than replace it - React
  // DevTools or other tools may have their own implementation, and
  // breaking their hook would be impolite.
  const original = hook.onCommitFiberRoot;
  hook.onCommitFiberRoot = (rendererId, root) => {
    try {
      const fiber = root.current ?? null;
      if (fiber) {
        renderRing.push({
          ts: new Date().toISOString(),
          fiberName: fiberDisplayName(fiber),
          file: fiber._debugSource?.fileName ?? null,
          durationMs: typeof fiber.actualDuration === 'number' ? fiber.actualDuration : 0,
        });
        while (renderRing.length > RENDER_RING_SIZE) renderRing.shift();
      }
    } catch {
      // Never let our shim crash a real React commit.
    }
    if (typeof original === 'function') {
      original.call(hook, rendererId, root);
    }
  };
  return renderRing;
}

export function recentRenders(limit: number): ReactRenderRecord[] {
  return renderRing.slice(-limit);
}
