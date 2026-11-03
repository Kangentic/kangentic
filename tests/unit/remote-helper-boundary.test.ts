import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';

/**
 * The host helper (#913) runs on a Linux machine with node-pty and nothing else of this app:
 * no Electron, no better-sqlite3, no main-process modules. A module in its graph that reaches
 * for them throws on the host's first start, with no Kangentic anywhere to show why, so the
 * helper's bundle, built the way scripts build it, must hold none of them. The link side
 * (`src/main/remote/link`) runs inside Kangentic and is free to; only the helper and the
 * protocol it shares with the link are held to this.
 */

const REPO_ROOT = path.resolve(__dirname, '../..');
const HOST_ENTRY = 'src/main/remote/helper/host-main.ts';
const FORBIDDEN_IMPORTS = new Set(['electron', 'better-sqlite3', 'koffi', 'sherpa-onnx-node']);
const MAIN_ONLY_MODULES = /src\/main\/(analytics|ipc|pop-out|retrieval|mobile-bridge|db\/(database|repositories))\//;
/**
 * The task-tag readers for Windows and macOS load koffi with a dynamic `await import('koffi')`
 * inside a loader that only runs on those platforms, and a Linux host never calls it. They sit
 * in the core's graph through the reader factory, so they are the one place koffi may appear.
 */
const KOFFI_LOADERS = new Set(['src/main/pty/process-tag/win32-reader.ts', 'src/main/pty/process-tag/darwin-reader.ts']);

function readEsbuildExternals(): string[] {
  const buildSource = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'build.js'), 'utf-8');
  const match = buildSource.match(/external:\s*\[([^\]]*)\]/);
  return [...(match?.[1] ?? '').matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
}

async function bundleGraph(entry: string, devBuild: boolean): Promise<esbuild.Metafile['inputs']> {
  const result = await esbuild.build({
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    external: readEsbuildExternals(),
    conditions: ['require'],
    define: {
      MAIN_WINDOW_VITE_DEV_SERVER_URL: JSON.stringify(''),
      MAIN_WINDOW_VITE_NAME: JSON.stringify('main_window'),
      __KANGENTIC_DEV__: devBuild ? 'true' : 'false',
    },
    entryPoints: [path.join(REPO_ROOT, entry)],
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
  return result.metafile.inputs;
}

describe('the host helper bundle', () => {
  it('holds no electron, no better-sqlite3 and no main-process module, in dev and production builds', async () => {
    for (const devBuild of [false, true]) {
      const inputs = await bundleGraph(HOST_ENTRY, devBuild);
      const offenders: string[] = [];
      for (const [input, info] of Object.entries(inputs)) {
        const normalized = input.replace(/\\/g, '/');
        if (MAIN_ONLY_MODULES.test(normalized)) offenders.push(`${normalized} (main-only module)`);
        if (/src\/devtools\//.test(normalized)) offenders.push(`${normalized} (dev tooling)`);
        if (/node_modules\/(@sentry|@aptabase)\//.test(normalized)) offenders.push(`${normalized} (main-only package)`);
        for (const imported of info.imports) {
          if (imported.path === 'koffi' && KOFFI_LOADERS.has(normalized)) continue;
          if (FORBIDDEN_IMPORTS.has(imported.path)) offenders.push(`${normalized} imports ${imported.path}`);
        }
      }
      expect(
        offenders,
        `The helper's ${devBuild ? 'dev' : 'production'} graph reaches code that does not exist on a host. Trace each from `
          + `${HOST_ENTRY} and keep it on the link side:\n${offenders.join('\n')}`,
      ).toEqual([]);
      // Not vacuous: the helper bundles the core, the frame codec and the real adapters' detectors.
      const names = Object.keys(inputs).map((input) => input.replace(/\\/g, '/'));
      expect(names.some((name) => name.endsWith('src/main/pty/host/pty-host-core.ts'))).toBe(true);
      expect(names.some((name) => name.endsWith('src/main/remote/protocol/frame-codec.ts'))).toBe(true);
      expect(names.some((name) => name.endsWith('src/main/agent/agent-registry.ts'))).toBe(true);
    }
  }, 60_000);

  it('keeps the helper and the protocol free of the link, and the link free of the helper', () => {
    const importsOf = (relativePath: string): string[] =>
      [...fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf-8').matchAll(/from '([^']+)'/g)].map((match) => match[1]);
    for (const file of ['src/main/remote/helper/helper-server.ts', 'src/main/remote/helper/host-main.ts']) {
      expect(importsOf(file).filter((specifier) => specifier.includes('/link/')), `${file} must not import the link`).toEqual([]);
    }
    expect(importsOf('src/main/remote/link/remote-link.ts').filter((specifier) => specifier.includes('/helper/'))).toEqual([]);
    for (const file of ['frame-codec.ts', 'resume-endpoint.ts', 'messages.ts']) {
      const imports = importsOf(`src/main/remote/protocol/${file}`);
      expect(imports.filter((specifier) => specifier.includes('/link/') || specifier.includes('/helper/')), `${file} is shared by both sides`).toEqual([]);
    }
  });
});
