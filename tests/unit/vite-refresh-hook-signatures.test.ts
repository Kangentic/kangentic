/**
 * scripts/vite-refresh-hook-signatures.mjs: the dev-only transforms that give
 * the renderer's custom hooks Fast Refresh signatures (task #912).
 *
 * Without them, a custom hook in a `.ts` module, or in any module that defines
 * no component, registers no signature, so a component that calls it keeps its
 * hook state across an edit that changes the hook's hook list. Commit 016dbe593
 * did exactly that to `useDictation`, and AppLayout threw "Cannot read
 * properties of null (reading 'getSnapshot')" under the root error boundary.
 * `node scripts/hmr-guest-probe.mjs --file src/renderer/hooks/useDictation.ts
 * --edit-from 016dbe593~1` replays it in a browser; this file pins the
 * mechanism without one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import {
  defineRefreshSignature,
  markHookModule,
  refreshHookSignatures,
} from '../../scripts/vite-refresh-hook-signatures.mjs';

const REPO_ROOT = path.resolve(__dirname, '../..');
const RENDERER_ROOT = path.join(REPO_ROOT, 'src', 'renderer');

/** A module id under the renderer, which is all the transforms look at. */
function rendererId(relativePath: string): string {
  return path.join(RENDERER_ROOT, relativePath).replace(/\\/g, '/');
}

const HOOK_MODULE = `import { useEffect, useState } from 'react';
export function useThing(): number {
  const [value, setValue] = useState(0);
  useEffect(() => { setValue(1); }, []);
  return value;
}
`;

describe('markHookModule (turns the refresh transform on for a .ts hook module)', () => {
  it('marks a .ts module that defines a hook, by declaration or by arrow', () => {
    expect(markHookModule(HOOK_MODULE, rendererId('hooks/useThing.ts'))).toContain("import 'react/jsx-dev-runtime';");
    const arrowHook = 'export const useThing = (id: string): string => { return useBoardStore((state) => state.byId[id]); };\n';
    expect(markHookModule(arrowHook, rendererId('hooks/useThing.ts'))).not.toBeNull();
    const genericHook = 'export function useThing<Value>(value: Value): Value { return useMemo(() => value, [value]); }\n';
    expect(markHookModule(genericHook, `${rendererId('hooks/useThing.ts')}?t=123`)).not.toBeNull();
    const typedHook = 'export const useThing: (id: string) => string = (id) => { return useBoardStore((state) => state.byId[id]); };\n';
    expect(markHookModule(typedHook, rendererId('hooks/useThing.ts'))).not.toBeNull();
    const genericArrowHook = 'export const useThing = <Value,>(value: Value): Value => { return useMemo(() => value, [value]); };\n';
    expect(markHookModule(genericArrowHook, rendererId('hooks/useThing.ts'))).not.toBeNull();
    const defaultHook = 'export default function useThing(): number { return useContext(ThingContext); }\n';
    expect(markHookModule(defaultHook, rendererId('hooks/useThing.ts'))).not.toBeNull();
  });

  it('leaves a store module alone: a store hook\'s hook list never changes with an edit', () => {
    const pinnedStore = "export const useBoardStore = import.meta.hot?.data?.boardStore ?? createBoardStore();\n";
    const plainStore = 'export const useToastStore = create<ToastStore>((set) => ({ toasts: [] }));\n';
    expect(markHookModule(pinnedStore, rendererId('stores/board-store.ts'))).toBeNull();
    expect(markHookModule(plainStore, rendererId('stores/toast-store.ts'))).toBeNull();
  });

  it('leaves .tsx, already-marked and non-renderer modules alone', () => {
    expect(markHookModule(HOOK_MODULE, rendererId('hooks/useThing.tsx'))).toBeNull();
    expect(markHookModule(`${HOOK_MODULE}import 'react/jsx-dev-runtime';\n`, rendererId('hooks/useThing.ts'))).toBeNull();
    expect(markHookModule(HOOK_MODULE, path.join(REPO_ROOT, 'src', 'main', 'useThing.ts').replace(/\\/g, '/'))).toBeNull();
  });

  it('marks every renderer .ts module that exports a hook, so a new one is covered without a list', () => {
    const exportsHook = /^export (?:default )?(?:async )?function use[A-Z]|^export const use[A-Z]\w*(?:: [^=]*(?:=>[^=]*)*)? = (?:async )?[(<]/m;
    const unmarked: string[] = [];
    let hookModules = 0;
    const walk = (directory: string): void => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(entryPath);
          continue;
        }
        if (!entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) continue;
        const source = fs.readFileSync(entryPath, 'utf-8');
        if (!exportsHook.test(source)) continue;
        hookModules += 1;
        if (markHookModule(source, entryPath.replace(/\\/g, '/')) === null) unmarked.push(path.relative(REPO_ROOT, entryPath));
      }
    };
    walk(RENDERER_ROOT);
    // The renderer has dozens; a scan that found none would pass for nothing.
    expect(hookModules).toBeGreaterThan(40);
    expect(unmarked).toEqual([]);
  });
});

describe('defineRefreshSignature (a real $RefreshSig$ where the wrapper gave none)', () => {
  it('defines $RefreshSig$ in a module that calls it without defining it', () => {
    const transformed = 'var _s = $RefreshSig$();\nexport function useThing() { _s(); }\n_s(useThing, "key");\n';
    const defined = defineRefreshSignature(transformed, rendererId('hooks/useThing.tsx'));
    expect(defined).toContain('from "/@react-refresh"');
    expect(defined).toContain('function $RefreshSig$() { return RefreshRuntimeForHooks.createSignatureFunctionForTransform(); }');
  });

  it('leaves a module the wrapper already gave its own $RefreshSig$, and one with no signatures', () => {
    const wrapped = 'var _s = $RefreshSig$();\nfunction $RefreshSig$() { return RefreshRuntime.createSignatureFunctionForTransform(); }\n';
    expect(defineRefreshSignature(wrapped, rendererId('components/Thing.tsx'))).toBeNull();
    expect(defineRefreshSignature('export const value = 1;\n', rendererId('utils/value.ts'))).toBeNull();
    expect(defineRefreshSignature('var _s = $RefreshSig$();\n', path.join(REPO_ROOT, 'demo', 'x.ts').replace(/\\/g, '/'))).toBeNull();
  });
});

describe('refreshHookSignatures (dev server only)', () => {
  it('returns the mark plugin before oxc and the define plugin after the refresh wrapper, both serve-only so a production build never runs them', () => {
    const plugins = refreshHookSignatures();

    expect(plugins).toHaveLength(2);
    const [mark, define] = plugins;
    expect(mark.name).toBe('kangentic:refresh-hook-signatures:mark');
    expect(mark.enforce).toBe('pre');
    expect(define.name).toBe('kangentic:refresh-hook-signatures:define');
    expect(define.enforce).toBe('post');
    // `apply: 'serve'` is what keeps these out of `vite build`: the signature
    // calls and the runtime import are dev-only.
    expect(mark.apply).toBe('serve');
    expect(define.apply).toBe('serve');
  });
});

describe('through a real dev server (the plugins beside react(), as the renderer configs run them)', () => {
  let withPlugins: ViteDevServer;
  let withoutPlugins: ViteDevServer;
  let cacheRoot: string;
  /** What each module looked like after every user plugin, the code import analysis is handed. */
  const captured = new Map<string, string>();

  async function startServer(extraPlugins: ReturnType<typeof refreshHookSignatures>): Promise<ViteDevServer> {
    return createServer({
      configFile: false,
      root: REPO_ROOT,
      logLevel: 'silent',
      cacheDir: fs.mkdtempSync(path.join(cacheRoot, 'cache-')),
      plugins: [
        react(),
        ...extraPlugins,
        {
          // Last of the post plugins, so it sees what the browser would get
          // short of import rewriting. Reading here rather than the request's
          // result keeps the dependency optimizer, which can make import
          // analysis refuse a module mid-run, out of the test.
          name: 'test:capture',
          enforce: 'post',
          transform(code: string, id: string) {
            captured.set(id, code);
            return null;
          },
        },
      ],
      optimizeDeps: { noDiscovery: true, include: [] },
      // No watcher: the modules are virtual, and a watcher on the repo root
      // would compete for inotify watches with every other CI worker.
      server: { middlewareMode: true, ws: false, watch: null },
    });
  }

  beforeAll(async () => {
    cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-hook-signatures-'));
    withPlugins = await startServer(refreshHookSignatures());
    withoutPlugins = await startServer([]);
  }, 60_000);

  afterAll(async () => {
    await withPlugins?.close();
    await withoutPlugins?.close();
    // Retried: on Windows a closed server's cache handles can outlive close().
    fs.rmSync(cacheRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  async function transform(server: ViteDevServer, code: string, relativePath: string): Promise<string> {
    const id = rendererId(relativePath);
    captured.delete(id);
    await server.environments.client.pluginContainer.transform(code, id).catch(() => undefined);
    const transformed = captured.get(id);
    if (transformed === undefined) throw new Error(`the capture plugin never saw ${id}`);
    return transformed;
  }

  const definesRefreshSig = (code: string): number => (code.match(/function \$RefreshSig\$\s*\(/g) ?? []).length;

  it('a .ts hook module: no signature at all without the plugins, a registered one with them', async () => {
    const before = await transform(withoutPlugins, HOOK_MODULE, 'hooks/useProbeHook.ts');
    expect(before).not.toContain('_s(useThing');

    const after = await transform(withPlugins, HOOK_MODULE, 'hooks/useProbeHook.ts');
    expect(after).toContain('_s(useThing');
    expect(definesRefreshSig(after)).toBe(1);
    // The marker only turns the signature transform on. A module with a hook and
    // no component stays out of Fast Refresh's component registry, so it is not
    // a refresh boundary (the component case below is the one that registers).
    expect(after).not.toContain('$RefreshReg$');
  });

  it('a .tsx module with hooks and no component: the global no-op without the plugins, its own with them', async () => {
    const before = await transform(withoutPlugins, HOOK_MODULE, 'hooks/useProbeHook.tsx');
    expect(before).toContain('$RefreshSig$()');
    expect(definesRefreshSig(before)).toBe(0);

    const after = await transform(withPlugins, HOOK_MODULE, 'hooks/useProbeHook.tsx');
    expect(definesRefreshSig(after)).toBe(1);
  });

  it('a component module keeps exactly the one $RefreshSig$ the wrapper gives it', async () => {
    const component = `import { useState } from 'react';\nexport function Probe() {\n  const [value] = useState(0);\n  return <span>{value}</span>;\n}\n`;
    const transformed = await transform(withPlugins, component, 'components/Probe.tsx');
    expect(transformed).toContain('$RefreshReg$');
    expect(definesRefreshSig(transformed)).toBe(1);
  });
});

describe('every renderer dev server registers them', () => {
  const configs = ['vite.config.mts', 'scripts/worktree-vite-config.js', 'scripts/hmr-guest-probe.mjs'];

  it.each(configs)('%s', (relativePath) => {
    const source = fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf-8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n');
    expect(source).toMatch(/vite-refresh-hook-signatures\.mjs/);
    // Spread into a plugins array, the two plugins it returns.
    expect(source).toMatch(/\.\.\.[^\n]*refreshHookSignatures\(\)/);
  });
});
