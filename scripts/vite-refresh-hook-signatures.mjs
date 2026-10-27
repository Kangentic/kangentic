/**
 * Fast Refresh signatures for the renderer's custom hooks.
 *
 * React Refresh decides between re-rendering a component in place and
 * remounting it by comparing hook signatures. A component's signature lists the
 * custom hooks it calls, and each of those hooks contributes its own signature,
 * so a hook that gains or loses a React hook changes the caller's signature and
 * the caller remounts. A custom hook with NO registered signature is skipped
 * ("we can assume it won't change during this session", react-refresh's
 * `computeFullKey`). With this toolchain (Vite 8, @vitejs/plugin-react 6,
 * rolldown's refresh wrapper) that was every custom hook outside a component
 * module, which in the renderer means nearly all of them:
 *
 * - Vite's oxc plugin runs the refresh transform only on a `.jsx`/`.tsx` file
 *   or one that imports the JSX runtime (`getModifiedOxcTransformOptions` in
 *   vite/dist/node/chunks/node.js), so a hook in a `.ts` file gets no `_s()`
 *   signature calls at all.
 * - The refresh wrapper defines a module-local `$RefreshSig$` only in a module
 *   that registers a component. A module that defines hooks and no component,
 *   `.tsx` included, calls the preamble's global `$RefreshSig$`, which is a
 *   no-op, so its signatures never register either.
 *
 * Task #912 is what that cost. Commit 016dbe593 added a store selector as the
 * first hook of `useDictation`, which `AppLayout` calls. AppLayout's signature
 * did not change, Fast Refresh kept its hook state, and every hook after the
 * new one read the slot one place off. A zustand selector landed on a
 * `useRef`'s slot and threw "Cannot read properties of null (reading
 * 'getSnapshot')" under the root error boundary, which took the whole window
 * down. `node scripts/hmr-guest-probe.mjs --file src/renderer/hooks/useDictation.ts
 * --edit-from 016dbe593~1` replays it.
 *
 * Two dev-only transforms close it, on renderer sources only:
 *
 * 1. Before oxc, a `.ts` module that defines a hook gets a side-effect import of
 *    the JSX dev runtime, the one thing Vite's check reads to turn the refresh
 *    transform on. Every `.tsx` module already loads that runtime.
 * 2. After the refresh wrapper, a module that calls `$RefreshSig$()` without
 *    defining it gets the definition the wrapper gives a component module.
 *
 * The cost: a hook's signature is keyed the way a component's own hooks are, on
 * each hook call and the variable its result is bound to. So renaming a hook's
 * result variable remounts the caller too. Measured with the probe, a rename in
 * `useDictation` remounts AppLayout and destroys the window's Browser pane guests,
 * where without these transforms it refreshed in place. A comment-only edit still
 * refreshes in place.
 * `tests/unit/vite-refresh-hook-signatures.test.ts` pins both transforms, runs
 * them through a real dev server, and pins that every renderer dev config
 * registers them.
 */

const RENDERER_SOURCE = /\/src\/renderer\/.+\.tsx?$/;
const JSX_DEV_RUNTIME = 'react/jsx-dev-runtime';
// The shapes of a custom hook defined in the module. A pinned store's
// `const useThingStore = import.meta.hot?.data...` and a `create(...)` store
// match none of them, because a store hook's hook list never changes with an edit.
/** `function useThing(` or `function useThing<Value>(`, exported, default or local. */
const HOOK_FUNCTION = String.raw`function\s+use[A-Z][\w$]*\s*[<(]`;
/** `const useThing =`, with an optional type annotation that may itself hold `=>`. */
const HOOK_CONST_NAME = String.raw`const\s+use[A-Z][\w$]*\s*(?::[^=]*(?:=>[^=]*)*)?=\s*`;
/** What a hook const is bound to: `function`, an arrow's `(` or `<Value>(`, or a one-parameter arrow. */
const HOOK_CONST_VALUE = String.raw`(?:async\s+)?(?:function\b|[(<]|[A-Za-z_$][\w$]*\s*=>)`;
const DEFINES_HOOK = new RegExp(String.raw`(?:^|[^\w$.])(?:${HOOK_FUNCTION}|${HOOK_CONST_NAME}${HOOK_CONST_VALUE})`);
const CALLS_REFRESH_SIG = /\$RefreshSig\$\(\)/;
const DEFINES_REFRESH_SIG = /function\s+\$RefreshSig\$\s*\(/;

/** The module id without its query, with forward slashes. */
function sourcePathOf(id) {
  return id.split('?')[0].replace(/\\/g, '/');
}

/** Transform 1: the source with the runtime import that turns oxc's refresh transform on, or null. */
export function markHookModule(code, id) {
  const sourcePath = sourcePathOf(id);
  if (!RENDERER_SOURCE.test(sourcePath) || !sourcePath.endsWith('.ts')) return null;
  if (!DEFINES_HOOK.test(code) || code.includes(JSX_DEV_RUNTIME)) return null;
  return `${code}\nimport '${JSX_DEV_RUNTIME}';\n`;
}

/** Transform 2: the transformed module with a real `$RefreshSig$` when it calls the global no-op, or null. */
export function defineRefreshSignature(code, id) {
  if (!RENDERER_SOURCE.test(sourcePathOf(id))) return null;
  if (!CALLS_REFRESH_SIG.test(code) || DEFINES_REFRESH_SIG.test(code)) return null;
  return `${code}\nimport * as RefreshRuntimeForHooks from "/@react-refresh";\nfunction $RefreshSig$() { return RefreshRuntimeForHooks.createSignatureFunctionForTransform(); }\n`;
}

/** The two plugins, for a renderer dev server's `plugins` beside `react()`. */
export function refreshHookSignatures() {
  // Both only append, so the code before them keeps its place and the
  // existing source map stays right (`map: null`).
  return [
    {
      name: 'kangentic:refresh-hook-signatures:mark',
      apply: 'serve',
      enforce: 'pre',
      transform(code, id) {
        const marked = markHookModule(code, id);
        return marked === null ? null : { code: marked, map: null };
      },
    },
    {
      name: 'kangentic:refresh-hook-signatures:define',
      apply: 'serve',
      enforce: 'post',
      transform(code, id) {
        const defined = defineRefreshSignature(code, id);
        return defined === null ? null : { code: defined, map: null };
      },
    },
  ];
}
