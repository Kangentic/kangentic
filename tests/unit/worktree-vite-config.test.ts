import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/**
 * scripts/worktree-vite-config.js, the one inline Vite config a worktree preview's dev server and
 * its dependency pre-bundle child both run with. Vite keys its dependency cache on a hash of the
 * resolved config, so the pre-bundle only warms a cache the server accepts when both build the
 * same config. The existing parity tests read the callers' source; these run the builder.
 */

const REPO_ROOT = path.resolve(__dirname, '../..');
const nodeRequire = createRequire(import.meta.url);
const { worktreeViteCacheDir, worktreeViteConfig } = nodeRequire(
  path.join(REPO_ROOT, 'scripts', 'worktree-vite-config.js'),
) as {
  worktreeViteCacheDir: (projectDir: string) => string;
  worktreeViteConfig: (projectDir: string, port: number) => Promise<ViteInlineConfig>;
};

interface ViteInlineConfig {
  configFile: false;
  root: string;
  cacheDir: string;
  plugins: unknown[];
  resolve: { alias: Record<string, string>; preserveSymlinks: boolean };
  optimizeDeps: { include: string[] };
  define: Record<string, string>;
  server: { port: number; strictPort: boolean; watch: { ignored: string[] } };
}

/** A forward-slash project directory, so the test holds on a POSIX runner and on Windows alike. */
const PROJECT_DIR = path.join(path.parse(REPO_ROOT).root, 'previews', 'task-1');
const PROJECT_DIR_FORWARD = PROJECT_DIR.replace(/\\/g, '/');

describe('worktreeViteCacheDir', () => {
  it('is <project>/.kangentic/vite-cache, never the junction-shared node_modules/.vite', () => {
    const cacheDir = worktreeViteCacheDir(PROJECT_DIR);
    expect(cacheDir).toBe(path.join(PROJECT_DIR, '.kangentic', 'vite-cache'));
    expect(cacheDir.replace(/\\/g, '/')).not.toContain('node_modules');
  });
});

describe('worktreeViteConfig', () => {
  it('is an inline config rooted at the worktree that bypasses vite.config.mts', async () => {
    const config = await worktreeViteConfig(PROJECT_DIR, 5199);
    expect(config.configFile).toBe(false);
    expect(config.root).toBe(PROJECT_DIR);
    expect(config.cacheDir).toBe(worktreeViteCacheDir(PROJECT_DIR));
  });

  it('listens on the port it is given and refuses to fall back to another', async () => {
    const config = await worktreeViteConfig(PROJECT_DIR, 5199);
    expect(config.server.port).toBe(5199);
    expect(config.server.strictPort).toBe(true);
  });

  it('pre-bundles exactly the renderer dependency list', async () => {
    const config = await worktreeViteConfig(PROJECT_DIR, 5199);
    const expected = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'renderer-optimize-deps.json'), 'utf-8'),
    ) as string[];
    expect(expected.length).toBeGreaterThan(0);
    expect(config.optimizeDeps.include).toEqual(expected);
  });

  it('turns the dev-only build constant on and keeps symlinks unresolved, as the server needs', async () => {
    const config = await worktreeViteConfig(PROJECT_DIR, 5199);
    expect(config.define.__KANGENTIC_DEV__).toBe('true');
    expect(config.resolve.preserveSymlinks).toBe(true);
    expect(config.resolve.alias['@shared']).toBe('/src/shared');
    expect(config.resolve.alias['@kangentic/protocol']).toBe('/packages/protocol/src');
  });

  it('watches the source tree: ignores runtime dirs by absolute path, never a relative **/.kangentic/** glob', async () => {
    const config = await worktreeViteConfig(PROJECT_DIR, 5199);
    const ignored = config.server.watch.ignored;
    for (const directoryName of ['.kangentic', '.claude', '.codex', '.aider', '.vite', 'docs', 'tests']) {
      expect(ignored).toContain(`${PROJECT_DIR_FORWARD}/${directoryName}/**`);
    }
    expect(ignored).toContain(`${PROJECT_DIR_FORWARD}/kangentic.json`);
    expect(ignored).toContain(`${PROJECT_DIR_FORWARD}/kangentic.local.json`);
    // The worktree itself lives under <repo>/.kangentic/worktrees/, so a relative glob for
    // .kangentic would swallow every source file and the watcher would never fire.
    expect(ignored.some((pattern) => pattern.startsWith('**'))).toBe(false);
    expect(ignored).not.toContain(`${PROJECT_DIR_FORWARD}/src/**`);
    expect(ignored.every((pattern) => pattern.startsWith(PROJECT_DIR_FORWARD))).toBe(true);
  });

  it('carries the Tailwind and React plugins', async () => {
    const config = await worktreeViteConfig(PROJECT_DIR, 5199);
    const flattened = config.plugins.flat(Infinity) as Array<{ name?: string }>;
    const names = flattened.map((plugin) => plugin.name ?? '');
    expect(names.some((name) => name.includes('tailwindcss'))).toBe(true);
    expect(names.some((name) => name.includes('react'))).toBe(true);
  });

  it('builds the same cache-relevant config whatever port it is asked for', async () => {
    const first = await worktreeViteConfig(PROJECT_DIR, 5199);
    const second = await worktreeViteConfig(PROJECT_DIR, 5200);
    expect(second.root).toBe(first.root);
    expect(second.cacheDir).toBe(first.cacheDir);
    expect(second.optimizeDeps).toEqual(first.optimizeDeps);
    expect(second.resolve).toEqual(first.resolve);
    expect(second.define).toEqual(first.define);
  });
});
