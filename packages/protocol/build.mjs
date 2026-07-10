// Bundles the package into dual CJS/ESM outputs. @noble/curves, @noble/hashes,
// and @noble/ciphers ship ESM-only (no "require" export condition), so a plain
// `tsc`-emitted CommonJS build would call require() on an ESM-only package and
// throw ERR_REQUIRE_ESM at runtime for any CJS consumer. Bundling the noble
// dependencies directly into both outputs (instead of leaving them external)
// sidesteps that: neither dist file does a runtime resolve of `@noble/*`.
// `tsconfig.build.json` (run separately, see package.json's `build` script)
// handles the `.d.ts` declaration emit; this script only produces runtime JS.
import esbuild from 'esbuild';

const common = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  sourcemap: false,
  minify: false,
};

await Promise.all([
  esbuild.build({
    ...common,
    platform: 'neutral',
    format: 'esm',
    outfile: 'dist/index.mjs',
  }),
  esbuild.build({
    ...common,
    platform: 'node',
    format: 'cjs',
    outfile: 'dist/index.cjs',
  }),
]);

console.log('[protocol build] Wrote dist/index.mjs and dist/index.cjs');
