# Rule: `dependencies` is what ships as node_modules, nothing else

electron-builder computes the production dependency tree from `package.json` and copies all of
it into the asar. The `files:` whitelist narrows the app's own files; it does not restrict
node_modules. So a package in `dependencies` that nothing needs at runtime is not bookkeeping,
it and its whole transitive closure are copied into every installer.

Everything under `src/` is bundled. Vite bundles the renderer, esbuild bundles main, preload, and
the three utilityProcess workers, and the only packages left out of those bundles are the
`external` list in `scripts/build.js`. So the set that genuinely has to exist as real
node_modules directories is small and derivable.

The block had drifted a long way from that. It carried `monaco-editor`, `recharts`,
`react-markdown`, `turndown`, `@sentry/electron`, `@aptabase/electron` and eight more, every one
of them already inside `.vite/build/**`. Measured on 0.41.0: 314 production packages resolved
where 122 were needed, 192 packages and about 117 MB of node_modules copied into the asar for
code that already shipped bundled. npm writes a new install into `dependencies` by default, so
drift is the resting state and something has to hold the line.

## The rule

`dependencies` is exactly:

- the esbuild `external` list in `scripts/build.js`, minus `electron`, plus
- any package named directly by a `node_modules/<name>/**` glob in `electron-builder.yml`'s
  `files:`.

Everything else goes in `devDependencies`, including packages that unambiguously ship, because
shipping bundled is not the same as shipping as node_modules.

**`electron` is the one external that stays in `devDependencies`.** electron-builder resolves the
Electron version from `devDependencies` first
(`app-builder-lib/out/electron/electronVersion.js`, `findFromPackageMetadata`), and a production
entry would also copy the whole `electron` npm package into the asar next to the runtime the
packager already places there.

A transitive dependency needs no root declaration. `bindings` and `file-uri-to-path` carry one
anyway because `files:` names them, which is what the rule accepts them on.

### Reading `npm audit` under this rule

The split makes `npm audit --omit=dev` describe the node_modules closure electron-builder
copies. That is a well-defined answer, and it is not everything that ships. Everything Vite and
esbuild bundle ships as code while being declared `devDependencies`, so the production-only audit
does not see monaco (and its vendored dompurify), `@sentry/electron`, `electron-updater`, or
`@hono/node-server`, and it does not see Electron itself. Triage is three parts:

1. `npm audit --omit=dev` for the copied node_modules half.
2. Electron, always, whatever block declares it.
3. A manual pass over the bundled half, which `npm audit` reports only under `--include=dev`
   mixed in with the build toolchain.

A bundled package's advisory is real. `electron-updater` is a devDependency and
`src/main/updater.ts` value-imports it, so `builder-util-runtime`'s credential leak on redirect
was live in a shipped binary while `--omit=dev` said nothing.

### `allowScripts` is live npm config. Do not delete it.

npm 12 blocks a dependency's `install` / `postinstall` script unless `allowScripts` in
`package.json` covers it, and it says so in those words: `packages have install scripts blocked
because they are not covered by allowScripts`. Nothing in this repo reads the key, so a grep for a
consumer finds only its own definition and it reads as dead config from a tool nobody uses.

Deleting it is quiet and expensive. `npm ci` still exits 0, but electron never downloads its
binary, better-sqlite3 and node-pty are never compiled, esbuild never fetches its platform binary,
and onnxruntime-node never fetches its native providers. The install looks clean and the tree is
unusable. `npm install-scripts ls` is what shows the truth.

Every package the lockfile marks `hasInstallScript` needs an entry. A new native dependency
therefore needs one too.

### Changing a runtime dependency

`npm run package` is the only gate that proves the closure. `build/afterPack.js` runs
`build/verify-unpacked-worker.js` for the embed and dictation workers, forking a child `node`
fenced to `app.asar.unpacked`. CI never packages, so a package wrongly moved out of
`dependencies` fails there and nowhere else. See [[release-gates-fail-loudly]].

## Enforcement (self-maintaining)

- **Test:** `tests/unit/dependency-block-parity.test.ts` derives the expected block from
  `scripts/build.js`'s `external` array and `electron-builder.yml`'s `files:` globs, then fails on
  a `dependencies` entry neither of them names, on an external other than `electron` missing from
  `dependencies`, on `electron` appearing in `dependencies`, and on a package declared in both
  blocks. It refuses to run against an empty externals list or an empty `files:` block, and drives
  its glob matcher over known-good and known-bad input, so a regex that stops matching cannot make
  the whole check pass vacuously. Runs in CI via `npm run test:unit`.
- **Test:** `tests/unit/allow-scripts-coverage.test.ts` derives the required `allowScripts` set from
  the lockfile's own `hasInstallScript` flags and fails when the key is missing, when a package with
  an install script is not covered, or when an entry names a package the lockfile does not have. It
  refuses to run against an empty derived set. Runs in CI via `npm run test:unit`.
- **Packaging (correctness):** the afterPack gate above, on `npm run package` / `make` / `publish`.
  It is the only check that proves a runtime dependency actually resolves in the packaged tree.
- **Review:** `/code-review` flags a new `dependencies` entry whose package is bundled.

The test checks placement, not reachability. It cannot tell that a package is genuinely imported,
only that the packaging config claims it. A dependency that becomes dead stays green until someone
greps for it.

## Scope

The root `package.json`. `packages/launcher` and `packages/protocol` are separately published npm
packages with their own manifests and their own consumers, so this rule does not govern them.
