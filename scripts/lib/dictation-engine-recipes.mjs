/**
 * What the dictation engines do, for the two dictation scripts
 * (scripts/measure-dictation-models.mjs and scripts/smoke-dictation.mjs), so a
 * measurement and a smoke run load and stream a model the way the app does. The
 * engines are TypeScript in the dictation worker's bundle and import
 * sherpa-onnx-node, so a plain Node script cannot import them.
 * tests/unit/dictation-script-pins.test.ts holds this module to them instead:
 * the recognizer configs to `buildOfflineConfig` and `SherpaOnlineEngine.load`,
 * the stream recipe to a `SherpaOnlineEngine` session, and the file lists and
 * roles to the model registry.
 */
import os from 'node:os';
import path from 'node:path';

/** Where both scripts keep downloaded weights and clips, so they share one download. */
export const DICTATION_CACHE_ROOT = path.join(os.tmpdir(), 'kangentic-dictation-smoke');

/** Each model's folder under DICTATION_CACHE_ROOT. */
export const CACHE_FOLDERS = {
  parakeetV2: 'parakeet',
  parakeetV3: 'parakeet-v3',
  parakeetUnified: 'parakeet-unified',
  nemotronEnglish: 'nemotron-streaming-en',
  nemotronMultilingual: 'nemotron-3.5-streaming',
  cohereTranscribe: 'cohere-transcribe',
  zipformer: 'streaming-zipformer',
};

/** The four files every sherpa-onnx transducer export ships, by role (the registry's `transducerFiles`). */
export const TRANSDUCER_ROLES = {
  encoder: 'encoder.int8.onnx',
  decoder: 'decoder.int8.onnx',
  joiner: 'joiner.int8.onnx',
  tokens: 'tokens.txt',
};
export const TRANSDUCER_FILES = Object.values(TRANSDUCER_ROLES);

/** Cohere Transcribe's roles, and its files: the encoder keeps its weights in
 *  `encoder.int8.onnx.data` beside it, under the name the graph refers to. */
export const COHERE_TRANSCRIBE_ROLES = {
  encoder: 'encoder.int8.onnx',
  decoder: 'decoder.int8.onnx',
  tokens: 'tokens.txt',
};
export const COHERE_TRANSCRIBE_FILES = ['encoder.int8.onnx', 'encoder.int8.onnx.data', 'decoder.int8.onnx', 'tokens.txt'];

/** Absolute paths keyed by role, for a model whose files sit in `directory`. */
export function rolePaths(directory, roles) {
  return Object.fromEntries(Object.entries(roles).map(([role, file]) => [role, path.join(directory, file)]));
}

const FEAT_CONFIG = { sampleRate: 16000, featureDim: 80 };

/**
 * The `OfflineRecognizer` config `buildOfflineConfig` builds for `kind`, from
 * paths keyed by role. Only the kinds the scripts load are here.
 */
export function offlineRecognizerConfig(kind, paths) {
  if (kind === 'offline-nemo-transducer') {
    const { encoder, decoder, joiner, tokens } = paths;
    return {
      featConfig: FEAT_CONFIG,
      modelConfig: { transducer: { encoder, decoder, joiner }, tokens, numThreads: 4, provider: 'cpu', debug: 0, modelType: 'nemo_transducer' },
      decodingMethod: 'greedy_search',
    };
  }
  if (kind === 'offline-cohere-transcribe') {
    const { encoder, decoder, tokens } = paths;
    return {
      featConfig: FEAT_CONFIG,
      modelConfig: { cohereTranscribe: { encoder, decoder, usePunct: 1, useItn: 1 }, tokens, numThreads: 4, provider: 'cpu', debug: 0 },
    };
  }
  throw new Error(`No offline recognizer config for ${kind}`);
}

/** The `OnlineRecognizer` config `SherpaOnlineEngine.load` builds. One config
 *  serves the Zipformer and a NeMo model: sherpa reads a NeMo model's feature
 *  width and chunk size from the model. */
export function onlineRecognizerConfig(paths) {
  const { encoder, decoder, joiner, tokens } = paths;
  return {
    featConfig: FEAT_CONFIG,
    modelConfig: { transducer: { encoder, decoder, joiner }, tokens, numThreads: 2, provider: 'cpu', debug: 0 },
    decodingMethod: 'greedy_search',
    enableEndpoint: false,
  };
}

/** The lead and tail padding `SherpaOnlineEngine` adds, in seconds, and the
 *  size of each push the scripts feed it. */
export const LEAD_PADDING_SECONDS = 0.6;
export const TAIL_PADDING_SECONDS = 0.5;
export const PUSH_SECONDS = 0.1;

/**
 * What a `SherpaOnlineEngine` session does with one clip: the stream pinned to
 * `language`, the lead padding decoded at the press, a drain after every push,
 * then the tail padding, inputFinished and a last drain on finalize. `partials`
 * counts the distinct hypotheses the pushes produced, and `decodeSeconds`
 * leaves out the lead padding, as the press pays it.
 */
export function streamDecode(recognizer, wave, language) {
  const stream = recognizer.createStream();
  stream.setOption('language', language);
  const drain = () => {
    while (recognizer.isReady(stream)) recognizer.decode(stream);
  };
  // Nemotron 3.5 can leave two spaces after a sentence's period.
  const hypothesis = () => recognizer.getResult(stream).text.replace(/ {2,}/g, ' ');
  stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: new Float32Array(Math.round(wave.sampleRate * LEAD_PADDING_SECONDS)) });
  drain();
  const started = Date.now();
  let partials = 0;
  let lastText = '';
  const step = Math.round(wave.sampleRate * PUSH_SECONDS);
  for (let index = 0; index < wave.samples.length; index += step) {
    stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples.subarray(index, index + step) });
    drain();
    const text = hypothesis();
    if (text && text !== lastText) {
      lastText = text;
      partials += 1;
    }
  }
  stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: new Float32Array(Math.round(wave.sampleRate * TAIL_PADDING_SECONDS)) });
  stream.inputFinished();
  drain();
  return { text: hypothesis().trim(), partials, decodeSeconds: (Date.now() - started) / 1000 };
}
