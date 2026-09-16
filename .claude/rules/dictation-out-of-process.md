# Rule: the dictation engine never runs in the main process

DESKTOP-X: an unhandled C++ exception inside `sherpa-onnx.node`, the dictation engine's native
module, took down the whole app and every running agent with it. The minidump showed the crash
happening at app quit: a `napi_create_async_work` item queued by `OfflineRecognizer.createAsync` /
`decodeAsync` was still outstanding when the user quit, its completion callback ran during Node
environment teardown, a napi call inside it failed, and node-addon-api's resulting C++ `throw` had
nothing between it and the CRT to catch it. There is no small fix: once the async work is queued
its completion callback will run, `napi_cancel_async_work` is not reachable from JS, and the
sherpa wrapper exposes no cancel or free. The fix is process isolation - the whole engine layer now
runs in the `kangentic-dictation` `utilityProcess` worker (`dictation-worker.ts`), following the
`kangentic-embeddings` (#601) and `kangentic-line-count` precedent, so a native fault there can
never reach `CrBrowserMain`.

## The rule

- **`sherpa-onnx-node` is imported only by the three sherpa engine files**
  (`sherpa-online-engine.ts`, `sherpa-whisper-engine.ts`, `chunked-offline-engine.ts`), each of
  which runs exclusively inside the dictation worker's bundle. Never import it from a
  main-resident file (`transcription-service.ts`, `engine-selection.ts`, an IPC handler, or
  anywhere else under `src/main/`) - doing so links the native addon into main's `index.js` bundle
  regardless of whether the import is ever exercised at runtime, reopening DESKTOP-X.
- **The selection/construction split stays split.** `engine-selection.ts` (main) maps a
  `DictationConfig` to a serializable `EngineSelection` - pure data, no sherpa import - for the
  settings panel and the worker request. `engine-build.ts` (worker-only) is the one place that
  constructs a concrete `TranscriptionEngine` from that selection. Do not fold engine construction
  back into `engine-selection.ts` or `transcription-service.ts`.
- **`DictationClient` is constructed only in `dictation-client.ts`**, as the module-level
  `dictationClient` singleton. `TranscriptionService` takes it as an injectable constructor
  parameter (for tests) but never constructs its own.
- **The warm-engine LRU and every `TranscriptionEngine` / `TranscriptionEngineSession` instance
  live only in the worker** (`dictation-worker.ts`). `TranscriptionService` (main) holds only
  session bookkeeping (the `active` map, the frame-drain barrier) and routes audio through
  `DictationClient`; it must never hold a reference to an actual engine or session object.
- **The dictation worker is its own esbuild entry** (`src/main/transcription/dictation-worker.ts`
  -> `.vite/build/dictation-worker.js`) registered in both `scripts/build.js` and `scripts/dev.js`
  - a worker pulled into the main bundle instead defeats the split even with every import rule
  above followed, since esbuild would inline the whole engine graph into `index.js`.
- **The worker shuts down via `process.exit()`, never a natural return to the event loop.** A
  graceful return would let the worker's OWN Node environment tear down normally - the exact
  sequence whose async-work-completion-during-cleanup crashed the main process in the first place -
  reproducing DESKTOP-X one process over. Mirrors `embed-worker.ts` / `line-count-worker.ts`.
- **Packaging must keep the worker's closure inside `asarUnpack`.** `.vite/build/dictation-worker.js`
  and `node_modules/sherpa-onnx-*/**` (which glob-matches `sherpa-onnx-node` itself, not only the
  per-platform binary packages) must both stay in `electron-builder.yml`'s `asarUnpack:`, and the
  afterPack gate (`build/verify-unpacked-worker.js`'s `DICTATION_WORKER_EXTERNALS` probe) must keep
  running - see [[release-gates-fail-loudly]].

## Enforcement (self-maintaining)

- **Test:** `tests/unit/dictation-out-of-process-boundary.test.ts` statically scans `src/main` and
  fails if `sherpa-onnx-node` is imported outside the three allowlisted engine files, if
  `new DictationClient(` appears outside `dictation-client.ts`, or if the dictation worker stops
  being registered as its own entry in `scripts/build.js` / `scripts/dev.js`. It also fails if an
  allowlisted engine file stops importing sherpa-onnx-node (a stale allowlist entry proving
  nothing). Runs in CI via `npm run test:unit`.
- **Test:** `tests/unit/verify-unpacked-worker.test.ts`'s "dictation worker closure parity" block
  pins the packaging half: the esbuild external, and that `electron-builder.yml` unpacks the
  worker bundle and the sherpa packages.
- **Test:** `tests/unit/stderr-tail.test.ts`'s `utilityProcess.fork` scan (see
  [[cross-platform-parity]]) covers the dictation worker's fork site too, since it scans all of
  `src/main`.
- **Review:** `/code-review`'s always-on conventions finder can flag a new sherpa import outside
  the allowlist, and `/code-review` on a `src/main/transcription/**` change should notice engine
  construction creeping back into a main-resident file.

## Scope

`src/main/transcription/**`. Does not cover the other two utility-process workers
(`src/main/retrieval/embedder/**`, `src/main/git/line-count/**`), which follow the same shape but
are not sherpa/native-module specific and have no dedicated boundary rule of their own.
