---
type: Reference
title: Packaging and security
description: How native modules (better-sqlite3, node-pty, koffi, sqlite-vec, onnxruntime) are packaged and unpacked from the asar, the afterPack worker checks, Electron fuses, the NSIS ACL grant, the auto-update platform guard per OS, and the Linux deb and rpm dependencies.
tags: [packaging, asar, fuses, linux, auto-update]
sources:
  - resource: electron-builder.yml
  - resource: build/afterPack.js
  - resource: build/verify-unpacked-worker.js
  - resource: build/installer.nsh
  - resource: src/main/updater.ts
  - resource: src/main/agent/shared/bridge-utils.ts
  - resource: src/main/utility-process/stderr-tail.ts
---
# Packaging and security

## Native Modules

| Module | Build Strategy | Packaging |
|--------|---------------|-----------|
| better-sqlite3 | Node-API (13+): every platform's addon ships in the package as `prebuilds/<platform>-<arch>.node`; no rebuild needed | Included via `files` in `electron-builder.yml`, with the C++ and SQLite source and its build-time `node_modules` (the `node-addon-api` headers, never loaded at runtime) excluded; unpacked via `asarUnpack`, because the `kangentic-retrieval` utility process opens the project databases from the unpacked tree. `build/afterPack.js` deletes every prebuild but the target's (glibc on Linux) before the load probes run |
| node-pty | Pinned exactly to `1.2.0-beta.15` for its ConPTY handle lock (DESKTOP-1V; see `tests/unit/node-pty-version-pin.test.ts`). Prebuilt NAPI binaries, no rebuild needed, except the macOS `spawn-helper`, which is compiled from `build/spawn-helper/spawn-helper.c` at package time (see macOS Code Signing below) | Included via `files`; the whole package unpacked from asar via `asarUnpack`, since the `kangentic-pty-host` utility process loads it from the unpacked tree |
| sherpa-onnx-node | Prebuilt platform-specific binaries (no rebuild needed) | Included via `files` (`sherpa-onnx-node/**` plus the `sherpa-onnx-*/**` platform packages), unpacked from asar via `asarUnpack: node_modules/sherpa-onnx-*/**` (the voice dictation engine, which runs in its own `kangentic-dictation` utilityProcess - see `.claude/rules/dictation-out-of-process.md` / DESKTOP-X) |
| font-list | Shells out to `fc-list` (Linux) / a PowerShell script (Windows) / a bundled binary (macOS); no rebuild needed | Included via `files` (`font-list/**`), unpacked from asar via `asarUnpack` since the macOS binary is spawned via `child_process` (Terminal Font Family picker) |
| koffi | Prebuilt Node-API binary in a per-platform `@koromix/koffi-*` package; no rebuild needed | Included via `files` (`koffi/**` plus `@koromix/koffi-*/**`), unpacked via `asarUnpack` because a native addon cannot be dlopen'd from inside an asar. The `kangentic-pty-host` utility process loads it on Windows and macOS for the task leftover reap (`src/main/pty/process-tag/`), and the afterPack gate makes one native call through it there |
| sqlite-vec | Loadable SQLite extension shipped as per-platform binary packages; no rebuild needed | Included via `files` (`sqlite-vec/**` plus the `sqlite-vec-*/**` platform packages), unpacked via `asarUnpack` because SQLite's dlopen cannot read a loadable extension inside an asar archive (conversation-memory retrieval) |
| @huggingface/transformers | Pure JavaScript (transformers.js); no rebuild needed | Included via `files`, unpacked via `asarUnpack` so the embed worker resolves it from the unpacked tree by plain node_modules resolution |
| onnxruntime-node | Prebuilt native binaries (`onnxruntime_binding.node`, plus `onnxruntime.dll` and `DirectML.dll` on Windows). 1.30.0 ships none for Intel macOS, so the Knowledge Graph reports itself unavailable there (`src/shared/embedding-runtime.ts`) | Included via `files`, unpacked via `asarUnpack` because a native `.node` addon cannot be dlopen'd from inside asar (the embed worker's execution provider) |
| onnxruntime-web | Pure JavaScript; retained only as transformers' optional peer, its wasm path currently unused | Included via `files` and unpacked alongside the others |
| onnxruntime-common | Pure JavaScript; required at module scope by both transformers.js and onnxruntime-node | Included via `files` and unpacked, because the embed worker resolves from the unpacked tree only (see below) |
| sharp, `@img/*`, detect-libc, semver | sharp's prebuilt libvips binding (`@img/sharp-<platform>`) plus its pure-JavaScript runtime deps; transformers.js requires sharp at module scope even though the worker never touches an image | Included via `files` and unpacked, for the same reason |
| simple-git | Pure JavaScript, bundled by esbuild | Not shipped as node_modules; its code is inside `.vite/build/index.js`. A devDependency, like every other bundled package (see `.claude/rules/dependency-block-parity.md`) |

The `files` array in `electron-builder.yml` explicitly whitelists `.vite/build/**`, `package.json`, `better-sqlite3`, `node-pty`, `sherpa-onnx-node`, the `sherpa-onnx-*` platform packages, `font-list`, `koffi`, the `@koromix/koffi-*` platform packages, `sqlite-vec`, the `sqlite-vec-*` platform packages, `@huggingface/transformers`, `onnxruntime-node`, `onnxruntime-web`, `onnxruntime-common`, `sharp`, the `@img/*` packages, `detect-libc`, and `semver`. The whitelist governs the app's own files; electron-builder copies every production dependency from `package.json` into the asar on its own, so for a runtime dependency the question is never whether it is in the asar but whether it is unpacked. That also makes the `dependencies` block itself a packaging decision: on 0.41.0 it resolved to 302 packages, most of them already bundled into `.vite/build/**`, where 121 were needed (measured then; a new external such as `koffi` adds its own). `.claude/rules/dependency-block-parity.md` is what keeps it there.

The embed worker's closure is the one that bites: the worker is forked from `app.asar.unpacked`, and Node resolution from a real directory never looks inside the asar, so a package the worker reaches only transitively (transformers.js requires `onnxruntime-common` and `sharp` at module scope) must be unpacked too, or the worker exits 1 at module load on every fork. 0.38.0 and 0.39.0 shipped that way (Sentry DESKTOP-6, DESKTOP-H). `build/afterPack.js` now runs `build/verify-unpacked-worker.js` after packing, once per worker with an unpacked native closure to verify (embed, dictation, the retrieval worker and the pty host; line-count is bundled whole by esbuild and has no unpacked closure to check). For the retrieval worker it also loads better-sqlite3 and sqlite-vec under the packaged Electron binary, and for the pty host it spawns a real process with node-pty and, on Windows and macOS, loads koffi and makes one native call through it, both before the fuses turn `ELECTRON_RUN_AS_NODE` off: it loads each worker's external(s) from the unpacked tree in a child `node` whose module resolution is fenced to that tree (an unfenced probe would find the repo's own `node_modules` above `out/` and pass), and fails the package with the child's stderr when anything is missing. The dictation worker (DESKTOP-X) reuses the same gate for `sherpa-onnx-node`. `npm run package` runs it too, so the gate holds locally, not only on the release matrix. The embed probe is skipped on exactly one kind of target: one with no onnxruntime binding that `src/shared/embedding-runtime-gaps.json` lists (Intel macOS). There the app never forks the worker, and afterPack says so in the build log. A target with no binding that the file does not list fails the package instead, so a packaging filter that drops onnxruntime's binaries cannot read as a skip.

Separately, how the embed, line-count, dictation and retrieval workers and the pty host are forked bites on Windows too.
`UTILITY_PROCESS_STDIO` in `src/main/utility-process/stderr-tail.ts` must never mix `inherit` with
a real handle (`pipe` or `ignore`) across the stdout and stderr slots. Electron gives an `inherit`
slot no Windows branch, so its handle stays null, and it passes both handles to
`ServiceProcessHost` anyway. Electron's patch to `child_process_launcher_helper_win.cc` arms the
child's inherit list when either handle is valid, then fills the null slot from
`GetStdHandle(STD_OUTPUT_HANDLE)`, which is NULL in a packaged GUI build because there is no
console. `SetHandleInformation` on that null handle fails a `PCHECK` in `launch_win.cc` and kills
the main process outright. 0.39.1 shipped `['ignore', 'inherit', 'pipe']` and crashed that way
(Sentry DESKTOP-S); the array is now `['ignore', 'ignore', 'pipe']`. All-`inherit` (what passing no
`stdio` gives you) and all-real are both safe, but omitting `stdio` also drops the piped stderr the
crash reports need, so every worker passes the constant. `npm start` cannot catch this, because a dev
terminal hands the process a valid stdout handle. `tests/unit/stderr-tail.test.ts` guards the
mixing rule and also scans every `utilityProcess.fork` call site for the shared constant.

### Bridge Script Unpacking

Bridge scripts (`event-bridge.js`, `status-bridge.js`) are executed by Claude Code hooks in a separate `node` process outside Electron. Plain Node.js cannot read files inside asar archives, so `asarUnpack` names them individually, alongside `embed-worker.js`, `line-count-worker.js`, `dictation-worker.js`, `retrieval-worker.js`, `pty-host.js`, and `plugins/**` (the utility processes are forked from the unpacked tree, so these are unpacked for them rather than for the hook bridges). Only those eight entries under `.vite/build/` are extracted to `app.asar.unpacked/`; the rest of the directory stays inside the archive. The `resolveBridgeScript()` function in `src/main/agent/shared/bridge-utils.ts` rewrites `app.asar` to `app.asar.unpacked` in resolved paths when running in a packaged build.

## Packaging

electron-builder handles platform-specific packaging via `electron-builder.yml`:

| Platform | Format | Builder |
|----------|--------|---------|
| Windows | Installer | NSIS |
| macOS | Disk image + ZIP | DMG |
| Linux | Package | deb, rpm |

### Windows install-folder ACL grant

The NSIS config includes `build/installer.nsh` (`nsis.include`). Its `customInstall` macro runs on
every install and every `--updated` auto-update, which recreates the folder, and on a per-user
(`CurrentUser`) install it runs `icacls "$INSTDIR" /grant *S-1-15-2-1:(OI)(CI)(RX)` to give ALL
APPLICATION PACKAGES read access. Electron 44.5 aborts at launch when the install folder's ACL
carries an AppContainer entry without that one (electron/electron#51761). A failed `icacls` is
logged and the install continues. Delete the file and the `include:` once electron-builder ships
the grant itself (electron-builder#10242); `tests/unit/nsis-acl-grant.test.ts` fails when it does.

## Linux System Dependencies

The deb package declares `depends` on Electron's required system libraries (`libnss3`, `libatk-bridge2.0-0`, `libgtk-3-0`, `libgbm1`, `libasound2t64 | libasound2`, `libdrm2`, `libxshmfence1`); the alternation covers Ubuntu 24.04+'s rename of `libasound2` to `libasound2t64`. The rpm package declares `depends` as `.so` soname capabilities (`libnss3.so()(64bit)`, `libatk-1.0.so.0()(64bit)`, `libgtk-3.so.0()(64bit)`, `libgbm.so.1()(64bit)`, `libasound.so.2()(64bit)`, `libdrm.so.2()(64bit)`, `libxshmfence.so.1()(64bit)`) rather than package names, because RPM package names differ per distro (Fedora `libxshmfence` vs. openSUSE `libxshmfence1`) while every distro's rpmbuild auto-generates a `Provides:` for the soname itself. See `.claude/rules/linux-package-dependencies.md`. Without these, the app crashes on launch, or fails to install at all, on fresh Linux installations.

## Auto-Update Platform Guard

Auto-update via `electron-updater` runs on **all three platforms**. The guard in `src/main/updater.ts` checks `app.isPackaged` only, so the sole exclusion is dev mode.

Linux is included because `electron-updater` ships `DebUpdater` / `RpmUpdater` and selects one via the `package-type` marker `electron-builder` writes into `resourcesPath` for every fpm target in its `supportsAutoUpdate` list. `initUpdater` carries two `process.platform` branches. On Linux it forces `autoInstallOnAppQuit` to `false`, because the package manager always elevates and an auth prompt on the quit path is both confusing and race-prone. On macOS it sets `disableDifferentialDownload`, because the cached `update.zip` the differential path reads gets evicted under disk pressure and the resulting `ENOENT` was once our dominant updater failure. See [Linux auto-update](../releases/deployment.md#linux-auto-update).

Two platform-specific FAILURES have no branch in that guard, because each is recognized by the error it produces rather than by `process.platform`. On Linux a denied elevation prompt is counted and never filed. On macOS an app running from a read-only volume cannot be written over, so it never updates; that one is also the single updater failure the app tells the user about. See [macOS read-only volumes](../releases/deployment.md#macos-read-only-volumes) and the "counted, not reported" entries in [Telemetry](../telemetry/index.md).

Release notes are not gated by that guard either. The post-update "What's New" dialog reads notes inlined into the renderer bundle at build time, so it works for every install route: an `npx kangentic` upgrade and a manual installer run both surface it on the next launch. See [Auto-Update Behavior](../releases/deployment.md#auto-update-behavior).

## Security Fuses

`build/afterPack.js` sets every Electron fuse explicitly and passes `strictlyRequireAllFuses`, so
`flipFuses` fails the build when an Electron upgrade adds a fuse the config does not set, rather
than shipping it at whatever default it came with.

- **RunAsNode disabled.** The app binary cannot be used as a Node.js runtime.
- **NodeOptions disabled.** Blocks `NODE_OPTIONS` injection.
- **Inspection disabled.** No `--inspect` debugging in production.
- **Cookie encryption enabled.** Encrypts stored cookies.
- **ASAR integrity validation enabled.** Verifies the archive has not been tampered with.
- **OnlyLoadAppFromAsar enabled.** Code loads only from the asar, never from an extracted directory.
- **LoadBrowserProcessSpecificV8Snapshot disabled**, Electron's default. No browser-process
  snapshot is built.
- **GrantFileProtocolExtraPrivileges enabled**, Electron's default, and load-bearing: every window
  loads the renderer over `file://` through `loadFile`, its lazy chunks and the Monaco workers
  included. Turning it off needs a `protocol.handle` migration first.
- **WasmTrapHandlers enabled**, Electron's default.

`tests/unit/afterpack-unpacked-worker-verification.test.ts` pins each value by name, fails when
`@electron/fuses` knows a fuse the config does not set, and reads the installed Electron binary's
fuse wire so a bump that adds a fuse fails before any packaging run.
