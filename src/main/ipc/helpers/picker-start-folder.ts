import * as path from 'node:path';

/**
 * The folder an OS file picker opens in. A leading `~` is the home folder, so a caller can ask for `~/.ssh`
 * without knowing where home is, and a folder that is not there falls back to home instead of to wherever
 * the OS remembers (Electron 43 opens in Downloads when no default is given).
 */
export function resolvePickerStartFolder(requested: string | undefined, home: string, exists: (candidate: string) => boolean): string {
  if (!requested) return home;
  const expanded = requested === '~' ? home : /^~[\\/]/.test(requested) ? path.join(home, requested.slice(2)) : requested;
  return exists(expanded) ? expanded : home;
}
