import { isPopOutKind } from '../../shared/pop-out';
import type { PopOutDescriptor } from '../../shared/pop-out';

/**
 * Read this renderer's pop-out descriptor, if any. Authoritative source is the base64
 * additionalArguments payload the main process attaches when it opens a pop-out window
 * (exposed synchronously as electronAPI.popOut.descriptor, read from process.argv in
 * preload) - it carries params for task-scoped surfaces and survives an in-window
 * reload. A bare `#<kind>` URL hash is a redundant fallback for the param-less global
 * 'stats' surface only, in case a window is ever opened without the argv flag.
 *
 * Returns null for the main window, which never carries the descriptor flag.
 */
export function readPopOutDescriptor(): PopOutDescriptor | null {
  const fromArgs = window.electronAPI?.popOut?.descriptor ?? null;
  // Validate the kind before trusting it: the descriptor is JSON-parsed from argv in
  // preload without kind validation, and an unrecognized kind would throw from
  // getSurface() at mount. An invalid one falls through to the hash / full-app fallback.
  if (fromArgs && isPopOutKind(fromArgs.kind)) return fromArgs;

  const hash = window.location.hash.replace(/^#/, '');
  if (hash && isPopOutKind(hash) && hash === 'stats') {
    return { kind: 'stats', params: {} };
  }
  return null;
}
