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
 * Modules a bundled main-process import graph loads through a deliberately dynamic
 * `require(variable)`, mapped to a replacement.
 *
 * esbuild cannot rewrite a dynamic require, and the OpenCode parser uses one ON PURPOSE so the
 * native binding stays lazy (see loadBetterSqlite3). So the substitution happens in the `require`
 * the banner installs, not through esbuild's `alias`. better-sqlite3 here is rebuilt against
 * Electron's ABI and will not load under plain Node, which is what capture tooling runs.
 */
const DYNAMIC_REQUIRE_SHIMS = {
  'better-sqlite3': path.join(here, 'better-sqlite3-node-shim.mjs'),
};

/**
 * Bundle `entryPoint` and return its module namespace.
 *
 * Native and Electron dependencies stay external: nothing here runs inside Electron, and the one
 * native dependency that is actually reached is shimmed above.
 */
export async function importTsModule(entryPoint) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const outfile = path.join(cacheDir, `${path.basename(entryPoint, '.ts')}-${rootTag}.mjs`);
  const shimImports = Object.entries(DYNAMIC_REQUIRE_SHIMS)
    .map(([name, file], index) => `import __shim${index} from ${JSON.stringify(pathToFileURL(file).href)};`
      + `\n__shims[${JSON.stringify(name)}] = __shim${index};`)
    .join('\n');
  await build({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    external: ['better-sqlite3', 'electron', 'node-pty'],
    // ESM has no `require` binding, so a lazy `require(...)` in the graph throws ReferenceError and
    // the caller sees the dependency reported as merely unavailable. Install one, and let it answer
    // the shimmed names itself.
    banner: {
      js: [
        "import { createRequire as __createRequire } from 'node:module';",
        'const __shims = {};',
        shimImports,
        'const __nodeRequire = __createRequire(import.meta.url);',
        'const require = (name) => (name in __shims ? __shims[name] : __nodeRequire(name));',
      ].join('\n'),
    },
    logLevel: 'warning',
  });
  // Cache-bust the ESM module registry so a re-bundle in the same process is picked up.
  return import(`${pathToFileURL(outfile).href}?v=${Date.now()}`);
}
