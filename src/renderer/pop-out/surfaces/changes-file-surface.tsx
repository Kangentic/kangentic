import { PopOutChangesFileRoot } from '../roots/PopOutChangesFileRoot';
import type { SurfaceDescriptor } from '../surface-registry';

export const changesFileSurface: SurfaceDescriptor<'changes-file'> = {
  kind: 'changes-file',
  Root: PopOutChangesFileRoot,

  bootstrap: (_params, _context) => {
    // Warm the Monaco-bearing pane chunk so it downloads in parallel with the
    // root's first data fetch; the lazy() mount later reuses this in-flight
    // request. Kicked here (a pop-out renderer only) rather than at the root's
    // module scope, which would make the MAIN window fetch the Monaco chunk at
    // startup (see the lazy-monaco assertion in scripts/build.js).
    void import('../roots/ChangesFileDiffPane');
    // No store hydration: this surface resolves everything from its params boot
    // seed (see PopOutChangesFileParams), so there is nothing to load - store
    // round trips here would only delay the first paint. Live diff updates are
    // the root's own git.subscribeDiff / onDiffChanged wiring.
  },

  hmrResync: () => {
    // No stores to re-sync (see bootstrap); the root's own fetch state survives
    // Fast Refresh, and the watcher subscription re-registers on remount.
  },

  // Additive surface: a detached read of ONE file. The inline diff pane it was
  // opened from stays mounted - there is no in-app counterpart to suppress.
  inAppSurface: null,
};
