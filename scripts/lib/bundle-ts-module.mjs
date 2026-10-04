/**
 * Bundle a TypeScript module with esbuild, then import the result.
 *
 * Node 24 strips types itself, which is why scripts/capture-demo-sessions.mjs can import
 * tests/captures/helpers/demo-dataset.ts directly. That works only while every module in the
 * import graph is resolvable by Node ESM, and the agent transcript parsers are not: they use
 * extensionless relative specifiers ('../../shared/history-scan'), which Node answers with
 * ERR_MODULE_NOT_FOUND. esbuild resolves those the way tsc and the app build do.
 *
 * The bundle lands under node_modules/.cache so a runtime `external` still resolves from the
 * repo's own node_modules. A temp directory would put it outside every resolution root.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const cacheDir = path.join(repoRoot, 'node_modules', '.cache', 'kangentic-ts-bundle');
/**
 * A worktree's node_modules is a JUNCTION to the main checkout's, so this cache directory is shared
 * by every worktree on the machine. Several can run a capture or a backfill at once, and they would
 * otherwise write the same file while another process is importing it. Namespacing by the real
 * (un-junctioned) root keeps the bundle inside a resolution root for the externals while giving
 * each worktree its own file.
 */
const rootTag = createHash('sha256').update(repoRoot).digest('hex').slice(0, 8);

/**
 * Bundle `entryPoint` and return its module namespace.
 *
 * Native and Electron dependencies stay external: nothing here runs inside Electron. better-sqlite3
 * is the one native dependency the parsers reach, and it is a Node-API module that loads under the
 * plain Node this tooling runs on.
 */
export async function importTsModule(entryPoint) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const outfile = path.join(cacheDir, `${path.basename(entryPoint, '.ts')}-${rootTag}.mjs`);
  await build({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    external: ['better-sqlite3', 'electron', 'node-pty'],
    // ESM has no `require` binding, so a lazy `require(...)` in the graph (the OpenCode parser's
    // `loadBetterSqlite3` keeps the native binding lazy on purpose, and esbuild cannot rewrite a
    // dynamic require) throws ReferenceError and the caller sees the dependency reported as merely
    // unavailable. Install one.
    banner: {
      js: [
        "import { createRequire as __createRequire } from 'node:module';",
        'const require = __createRequire(import.meta.url);',
      ].join('\n'),
    },
    logLevel: 'warning',
  });
  // Cache-bust the ESM module registry so a re-bundle in the same process is picked up.
  return import(`${pathToFileURL(outfile).href}?v=${Date.now()}`);
}
