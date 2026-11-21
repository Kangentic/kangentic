import { useDictation } from '../../hooks/useDictation';

/**
 * Mounts this window's push-to-talk. A leaf of its own, rendering nothing, so
 * a change to `useDictation`'s hook list remounts only this and never the
 * window's tree, where a remount would end every live Browser pane guest
 * (hmr-patterns, hook signatures). Mounted once per window through
 * `WindowDictation`.
 */
export function DictationHost() {
  useDictation();
  return null;
}
