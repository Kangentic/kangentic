import type { ComponentType } from 'react';
import type { PopOutKind, PopOutParamsByKind } from '../../shared/pop-out';

export interface SurfaceBootstrapContext {
  /** Aborted when this pop-out window's root unmounts. Every subscription a
   *  surface's bootstrap() registers should be torn down via
   *  `signal.addEventListener('abort', unsubscribe)` rather than a returned
   *  cleanup function, so bootstrap stays a plain void call. */
  signal: AbortSignal;
}

/**
 * One declarative entry per detachable surface. Adding a new surface is one entry
 * here (+ one root component) - the entry branch, bootstrap host, frame, and
 * usePopOut/PopOutButton primitives are all kind-agnostic and need no change.
 */
export interface SurfaceDescriptor<K extends PopOutKind = PopOutKind> {
  kind: K;
  /** Root mounted inside the shared PopOutWindowFrame chrome. */
  Root: ComponentType<{ params: PopOutParamsByKind[K] }>;
  /** Load ONLY the stores/subscriptions this surface consumes (not the full App
   *  bootstrap). Called once per window lifetime; StrictMode-safe by construction
   *  (idempotent loads, signal-scoped subscription teardown). */
  bootstrap: (params: PopOutParamsByKind[K], context: SurfaceBootstrapContext) => void;
  /** Re-sync just this surface's store(s) on this window's OWN vite:afterUpdate
   *  (Pattern B, scoped to this window since App.tsx's handler never runs here). */
  hmrResync: () => void;
  /** The in-app surface this pop-out is mutually exclusive with. */
  inAppSurface: 'stats-overlay' | 'task-changes' | 'browser-pane';
}

// Heterogeneous registry: each entry is fully typed via SurfaceDescriptor<K> at its
// registerSurface() call site; the map itself stores `unknown` and getSurface() casts
// at the single read boundary, so no `any` is needed anywhere in this module.
//
// hmr-safe: PopOutSurfaceRoot.tsx is the sole Fast Refresh boundary importing both this
// module (getSurface) and the registrar (its side-effect `import './surfaces'`), so any
// re-eval of this file re-runs registerSurface() in the same HMR cycle - no window can
// observe an empty map. If a future import decouples the two, revisit this.
const surfaces = new Map<PopOutKind, unknown>();

export function registerSurface<K extends PopOutKind>(descriptor: SurfaceDescriptor<K>): void {
  surfaces.set(descriptor.kind, descriptor);
}

export function getSurface(kind: PopOutKind): SurfaceDescriptor {
  const surface = surfaces.get(kind);
  if (!surface) throw new Error(`No pop-out surface registered for kind "${kind}"`);
  return surface as SurfaceDescriptor;
}

/** Keys of every registered surface. Used by the registry-parity unit test, which
 *  must never import React - this stays a plain string-array read. */
export function registeredSurfaceKinds(): PopOutKind[] {
  return [...surfaces.keys()];
}
