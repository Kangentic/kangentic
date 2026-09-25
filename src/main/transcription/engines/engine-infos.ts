import type { DictationEngineInfo } from '../../../shared/types';

/**
 * The static `DictationEngineInfo` constant each engine exposes as its
 * `readonly info`, pulled out of the engine implementation files so the
 * settings panel's `listEngineInfos()` (engine-selection.ts, main-resident)
 * can read them without importing a file that pulls in `sherpa-onnx-node`.
 * See DESKTOP-X / dictation-out-of-process.md: the native module must never
 * load into the main process, and a constant declared alongside a `sherpa`
 * import would defeat that the moment anything imported it for its info.
 */

export const SHERPA_HYBRID_INFO: DictationEngineInfo = {
  id: 'hybrid',
  displayName: 'Hybrid (live + accurate)',
  streaming: true,
  punctuation: true,
  license: 'Apache-2.0 + MIT',
  requiresModelDownload: true,
};

export const SHERPA_ONLINE_INFO: DictationEngineInfo = {
  id: 'sherpa-onnx',
  displayName: 'sherpa-onnx (streaming)',
  streaming: true,
  punctuation: false,
  license: 'Apache-2.0',
  requiresModelDownload: true,
};

export const SHERPA_WHISPER_INFO: DictationEngineInfo = {
  id: 'whisper-cpp',
  displayName: 'Accurate (offline)',
  streaming: false,
  punctuation: true,
  license: 'CC-BY-4.0 / MIT',
  requiresModelDownload: true,
};

export const CHUNKED_OFFLINE_INFO: DictationEngineInfo = {
  id: 'chunked-offline',
  displayName: 'Accurate live (chunked)',
  streaming: true,
  punctuation: true,
  license: 'CC-BY-4.0 / MIT',
  requiresModelDownload: true,
};

export const REMOTE_OPENAI_INFO: DictationEngineInfo = {
  id: 'remote-openai',
  displayName: 'Cloud (live preview + remote final)',
  // The local streaming Zipformer drives the live preview (Cloud is built as
  // a hybrid in engine-build.ts), so the cloud path is streaming too.
  streaming: true,
  punctuation: true,
  license: 'remote',
  // The ~70 MB transducer for the live preview is downloaded; the cloud
  // endpoint produces the final.
  requiresModelDownload: true,
};

export const STUB_INFO: DictationEngineInfo = {
  id: 'stub',
  displayName: 'Stub (test)',
  streaming: true,
  punctuation: true,
  license: 'none',
  requiresModelDownload: false,
};
