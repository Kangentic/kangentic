// Standalone smoke test for the local dictation engine (no Electron, no mic).
// Downloads models, transcribes a known WAV, and prints the result. Proves the
// whole local pipeline (sherpa-onnx-node + model download + offline decode) end
// to end for BOTH offline model kinds: the default NVIDIA Parakeet NeMo
// transducer and Whisper. It also proves the WARM-ENGINE behavior the service
// relies on: a model loads once (seconds), and reusing a held recognizer to
// decode is near-instant - so push-to-talk starts instantly and switching back
// to a recently-used (cached) model does NOT pay a cold reload. The last steps
// load the October 2026 models (Parakeet v3, Nemotron streaming en and 3.5,
// Parakeet unified, and Cohere Transcribe with --with-cohere) through the configs
// the engines build: the refinement text closes its sentence, a streaming
// finalize keeps the clip's last word, and the lead silence keeps its first.
// Run: node scripts/smoke-dictation.mjs [--with-cohere]
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as https from 'node:https';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sherpa = require('sherpa-onnx-node');

const WHISPER_BASE = 'https://huggingface.co/csukuangfj/sherpa-onnx-whisper-tiny.en/resolve/main';
const PARAKEET_BASE =
  'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8/resolve/main';
const STREAMING_BASE =
  'https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26/resolve/main';
const MOONSHINE_BASE =
  'https://huggingface.co/csukuangfj/sherpa-onnx-moonshine-base-en-int8/resolve/main';

function download(url, dest, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 120_000 }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirects <= 0) return reject(new Error('too many redirects'));
        return download(new URL(response.headers.location, url).toString(), dest, redirects - 1).then(resolve, reject);
      }
      if (status !== 200) {
        response.resume();
        return reject(new Error(`HTTP ${status} for ${url}`));
      }
      const out = fs.createWriteStream(dest);
      response.pipe(out);
      out.on('finish', () => out.close(() => resolve()));
      out.on('error', reject);
    }).on('error', reject);
  });
}

async function ensureFiles(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const spec of files) {
    const dest = path.join(dir, spec.file);
    if (fs.existsSync(dest)) continue;
    process.stdout.write(`downloading ${spec.file}...\n`);
    await download(spec.url, dest);
  }
  return files.reduce((sum, spec) => sum + fs.statSync(path.join(dir, spec.file)).size, 0) / (1024 * 1024);
}

/** Decode one clip against a recognizer (the per-press hot path). */
async function decode(recognizer, wavPath) {
  const wave = sherpa.readWave(wavPath);
  const stream = recognizer.createStream();
  stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples });
  const result = await recognizer.decodeAsync(stream);
  return (result.text ?? '').trim();
}

function requireText(label, text) {
  process.stdout.write(`[${label}] TRANSCRIBED: "${text}"\n`);
  if (!text) {
    process.stderr.write(`FAIL: empty transcription from ${label}\n`);
    process.exit(1);
  }
}

async function main() {
  const root = path.join(os.tmpdir(), 'kangentic-dictation-smoke');

  // A shared 16 kHz test clip (from the Whisper repo's test_wavs).
  const wavDir = path.join(root, 'wav');
  await ensureFiles(wavDir, [{ url: `${WHISPER_BASE}/test_wavs/0.wav`, file: '0.wav' }]);
  const wavPath = path.join(wavDir, '0.wav');

  // 1) Parakeet (NeMo transducer) - the default accurate model. Time the LOAD.
  const pDir = path.join(root, 'parakeet');
  const pMb = await ensureFiles(pDir, [
    { url: `${PARAKEET_BASE}/encoder.int8.onnx`, file: 'encoder.int8.onnx' },
    { url: `${PARAKEET_BASE}/decoder.int8.onnx`, file: 'decoder.int8.onnx' },
    { url: `${PARAKEET_BASE}/joiner.int8.onnx`, file: 'joiner.int8.onnx' },
    { url: `${PARAKEET_BASE}/tokens.txt`, file: 'tokens.txt' },
  ]);
  const pLoadStart = Date.now();
  const parakeet = await sherpa.OfflineRecognizer.createAsync({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: path.join(pDir, 'encoder.int8.onnx'),
        decoder: path.join(pDir, 'decoder.int8.onnx'),
        joiner: path.join(pDir, 'joiner.int8.onnx'),
      },
      tokens: path.join(pDir, 'tokens.txt'),
      numThreads: 4,
      provider: 'cpu',
      debug: 0,
      modelType: 'nemo_transducer',
    },
    decodingMethod: 'greedy_search',
  });
  const parakeetLoadMs = Date.now() - pLoadStart;
  process.stdout.write(`parakeet (${pMb.toFixed(0)} MB) COLD LOAD: ${parakeetLoadMs} ms\n`);
  requireText('parakeet', await decode(parakeet, wavPath));

  // 2) Whisper tiny.en - the alternate offline model. Time the LOAD.
  const wDir = path.join(root, 'whisper-tiny');
  await ensureFiles(wDir, [
    { url: `${WHISPER_BASE}/tiny.en-encoder.int8.onnx`, file: 'encoder.int8.onnx' },
    { url: `${WHISPER_BASE}/tiny.en-decoder.int8.onnx`, file: 'decoder.int8.onnx' },
    { url: `${WHISPER_BASE}/tiny.en-tokens.txt`, file: 'tokens.txt' },
  ]);
  const wLoadStart = Date.now();
  const whisper = await sherpa.OfflineRecognizer.createAsync({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      whisper: {
        encoder: path.join(wDir, 'encoder.int8.onnx'),
        decoder: path.join(wDir, 'decoder.int8.onnx'),
        language: 'en',
        task: 'transcribe',
      },
      tokens: path.join(wDir, 'tokens.txt'),
      numThreads: 4,
      provider: 'cpu',
      debug: 0,
    },
  });
  const whisperLoadMs = Date.now() - wLoadStart;
  process.stdout.write(`whisper-tiny COLD LOAD: ${whisperLoadMs} ms\n`);
  requireText('whisper-tiny', await decode(whisper, wavPath));

  // 3) Warm reuse: a SECOND decode on the already-loaded Parakeet recognizer is
  // the per-press hot path (no reload). This is why push-to-talk is instant.
  const warmStart = Date.now();
  requireText('parakeet (warm reuse)', await decode(parakeet, wavPath));
  const warmReuseMs = Date.now() - warmStart;
  process.stdout.write(`parakeet WARM REUSE (cached recognizer): ${warmReuseMs} ms\n`);

  // 4) A/B switch back to a cached model. The service's warm LRU (cap 2 on the
  // accurate tier) holds the previous model, so switching Parakeet -> Whisper ->
  // back to Parakeet hits the cache instead of a cold reload. Simulate the LRU
  // with both recognizers held and measure a switch-back.
  const lru = new Map([
    ['hybrid|...,parakeet-tdt-0.6b-en|', parakeet],
    ['hybrid|...,whisper-tiny-en|', whisper],
  ]);
  const switchStart = Date.now();
  const switchedBack = lru.get('hybrid|...,parakeet-tdt-0.6b-en|'); // instant: no reload
  requireText('switch-back to parakeet', await decode(switchedBack, wavPath));
  const switchBackMs = Date.now() - switchStart;
  process.stdout.write(`switch BACK to cached parakeet: ${switchBackMs} ms (cold load was ${parakeetLoadMs} ms)\n`);

  // The warm/switch-back path must be a small fraction of the cold load - that
  // is the whole point (instant press, instant A/B switch).
  if (warmReuseMs >= parakeetLoadMs) {
    process.stderr.write(`FAIL: warm reuse (${warmReuseMs} ms) not faster than cold load (${parakeetLoadMs} ms)\n`);
    process.exit(1);
  }
  if (switchBackMs >= parakeetLoadMs) {
    process.stderr.write(`FAIL: cached switch-back (${switchBackMs} ms) not faster than cold load (${parakeetLoadMs} ms)\n`);
    process.exit(1);
  }

  // 5) Streaming Zipformer - the DEFAULT live engine. Feed the clip in chunks and
  // prove it emits live partials as audio arrives, then a sane final on flush.
  const zDir = path.join(root, 'streaming-zipformer');
  await ensureFiles(zDir, [
    { url: `${STREAMING_BASE}/encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx`, file: 'encoder.int8.onnx' },
    { url: `${STREAMING_BASE}/decoder-epoch-99-avg-1-chunk-16-left-128.onnx`, file: 'decoder.onnx' },
    { url: `${STREAMING_BASE}/joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx`, file: 'joiner.int8.onnx' },
    { url: `${STREAMING_BASE}/tokens.txt`, file: 'tokens.txt' },
  ]);
  const online = new sherpa.OnlineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: path.join(zDir, 'encoder.int8.onnx'),
        decoder: path.join(zDir, 'decoder.onnx'),
        joiner: path.join(zDir, 'joiner.int8.onnx'),
      },
      tokens: path.join(zDir, 'tokens.txt'),
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
    },
    decodingMethod: 'greedy_search',
    enableEndpoint: false,
  });
  const streamWave = sherpa.readWave(wavPath);
  const onlineStream = online.createStream();
  const streamingPartials = [];
  let lastStreamingText = '';
  for (let index = 0; index < streamWave.samples.length; index += 1600) {
    onlineStream.acceptWaveform({ sampleRate: streamWave.sampleRate, samples: streamWave.samples.subarray(index, index + 1600) });
    while (online.isReady(onlineStream)) online.decode(onlineStream);
    const text = online.getResult(onlineStream).text;
    if (text && text !== lastStreamingText) {
      lastStreamingText = text;
      streamingPartials.push(text);
    }
  }
  onlineStream.acceptWaveform({ sampleRate: streamWave.sampleRate, samples: new Float32Array(8000) });
  onlineStream.inputFinished();
  while (online.isReady(onlineStream)) online.decode(onlineStream);
  const streamingFinal = online.getResult(onlineStream).text.trim();
  process.stdout.write(`streaming Zipformer LIVE partials: ${streamingPartials.length}; final: "${streamingFinal}"\n`);
  if (streamingPartials.length < 1) {
    process.stderr.write('FAIL: streaming Zipformer emitted no live partials\n');
    process.exit(1);
  }
  requireText('streaming final', streamingFinal);

  // 6) Chunked-offline LIVE preview - the new accurate-live engine. Re-decode the
  // GROWING buffer in steps (what ChunkedOfflineEngine does on its ~350ms timer)
  // and prove it emits MULTIPLE partials over the clip, converging to a sane final.
  const chunkWave = sherpa.readWave(wavPath);
  const chunkedPartials = [];
  for (const fraction of [0.4, 0.7, 1.0]) {
    const slice = chunkWave.samples.subarray(0, Math.floor(chunkWave.samples.length * fraction));
    const chunkStream = parakeet.createStream();
    chunkStream.acceptWaveform({ sampleRate: chunkWave.sampleRate, samples: slice });
    const result = await parakeet.decodeAsync(chunkStream);
    const text = (result.text ?? '').trim();
    chunkedPartials.push(text);
    process.stdout.write(`chunked-offline partial @ ${(fraction * 100).toFixed(0)}%: "${text}"\n`);
  }
  const chunkedNonEmpty = chunkedPartials.filter((text) => text.length > 0);
  if (chunkedNonEmpty.length < 2) {
    process.stderr.write(`FAIL: chunked-offline live emitted < 2 partials (got ${chunkedNonEmpty.length})\n`);
    process.exit(1);
  }
  requireText('chunked-offline final', chunkedPartials[chunkedPartials.length - 1]);

  // 7) Moonshine (offline) - the fast/light low-end option, a DISTINCT sherpa-onnx
  // model kind (preprocessor + encoder + uncached/cached decoders). Downloading +
  // decoding through it proves its config is wired correctly (~286 MB).
  const mDir = path.join(root, 'moonshine-base');
  await ensureFiles(mDir, [
    { url: `${MOONSHINE_BASE}/preprocess.onnx`, file: 'preprocess.onnx' },
    { url: `${MOONSHINE_BASE}/encode.int8.onnx`, file: 'encode.int8.onnx' },
    { url: `${MOONSHINE_BASE}/uncached_decode.int8.onnx`, file: 'uncached_decode.int8.onnx' },
    { url: `${MOONSHINE_BASE}/cached_decode.int8.onnx`, file: 'cached_decode.int8.onnx' },
    { url: `${MOONSHINE_BASE}/tokens.txt`, file: 'tokens.txt' },
  ]);
  const moonshine = await sherpa.OfflineRecognizer.createAsync({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      moonshine: {
        preprocessor: path.join(mDir, 'preprocess.onnx'),
        encoder: path.join(mDir, 'encode.int8.onnx'),
        uncachedDecoder: path.join(mDir, 'uncached_decode.int8.onnx'),
        cachedDecoder: path.join(mDir, 'cached_decode.int8.onnx'),
      },
      tokens: path.join(mDir, 'tokens.txt'),
      numThreads: 4,
      provider: 'cpu',
      debug: 0,
    },
  });
  requireText('moonshine-base', await decode(moonshine, wavPath));

  await smokeRefreshedModels(root, wavPath);

  process.stdout.write('\nOK\n');
}

// The October 2026 models, pinned to the commits the registry downloads.
const PARAKEET_V3_BASE =
  'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/2bda32ec70b097a55adaa07d9a7173915b43cc78';
const PARAKEET_UNIFIED_BASE =
  'https://huggingface.co/csukuangfj2/sherpa-onnx-nemo-parakeet-unified-en-0.6b-int8-non-streaming/resolve/8c3a10fb13408c7a7054f6898958bf1c64a8d6c7';
const NEMOTRON_EN_BASE =
  'https://huggingface.co/csukuangfj2/sherpa-onnx-nemotron-speech-streaming-en-0.6b-560ms-int8-2026-04-25/resolve/52056fdc070914a48dcd68b31b44d6a6f5b85902';
const NEMOTRON_MULTI_BASE =
  'https://huggingface.co/csukuangfj2/sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-2026-06-11/resolve/ab43d895f5985b1bbab8b6eac8607fcdc05343f3';
const COHERE_TRANSCRIBE_BASE =
  'https://huggingface.co/csukuangfj2/sherpa-onnx-cohere-transcribe-14-lang-int8-2026-04-01/resolve/156a470cf08eefe706a0004f3c52d9ee567ca7a0';

const transducerFiles = (base) => ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt']
  .map((file) => ({ url: `${base}/${file}`, file }));

const transducerPaths = (dir) => ({
  encoder: path.join(dir, 'encoder.int8.onnx'),
  decoder: path.join(dir, 'decoder.int8.onnx'),
  joiner: path.join(dir, 'joiner.int8.onnx'),
});

/** The offline NeMo config `buildOfflineConfig` builds (featureDim 80, which
 *  sherpa overrides from the model's own metadata). */
function offlineNemo(dir) {
  return sherpa.OfflineRecognizer.createAsync({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: { transducer: transducerPaths(dir), tokens: path.join(dir, 'tokens.txt'), numThreads: 4, provider: 'cpu', debug: 0, modelType: 'nemo_transducer' },
    decodingMethod: 'greedy_search',
  });
}

/** The online config `SherpaOnlineEngine` builds, unchanged for a NeMo model. */
function onlineTransducer(dir) {
  return new sherpa.OnlineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: { transducer: transducerPaths(dir), tokens: path.join(dir, 'tokens.txt'), numThreads: 2, provider: 'cpu', debug: 0 },
    decodingMethod: 'greedy_search',
    enableEndpoint: false,
  });
}

/** What a `SherpaOnlineEngine` session does: the stream pinned to its language,
 *  0.6 s of lead silence, 100 ms pushes with a drain after each, then 0.5 s of
 *  tail padding, inputFinished and a last drain on finalize. */
function streamTranscribe(recognizer, wave, language) {
  const stream = recognizer.createStream();
  stream.setOption('language', language);
  stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: new Float32Array(Math.round(wave.sampleRate * 0.6)) });
  while (recognizer.isReady(stream)) recognizer.decode(stream);
  const started = Date.now();
  let partials = 0;
  let last = '';
  const step = Math.round(wave.sampleRate / 10);
  for (let index = 0; index < wave.samples.length; index += step) {
    stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples.subarray(index, index + step) });
    while (recognizer.isReady(stream)) recognizer.decode(stream);
    const text = recognizer.getResult(stream).text;
    if (text && text !== last) {
      last = text;
      partials += 1;
    }
  }
  stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: new Float32Array(Math.round(wave.sampleRate * 0.5)) });
  stream.inputFinished();
  while (recognizer.isReady(stream)) recognizer.decode(stream);
  const seconds = wave.samples.length / wave.sampleRate;
  return { text: recognizer.getResult(stream).text.replace(/ {2,}/g, ' ').trim(), partials, realTimeFactor: (Date.now() - started) / 1000 / seconds };
}

const lastWord = (text) => (text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []).pop() ?? '';

function requireCased(label, text) {
  requireText(label, text);
  if (!/\p{Ll}/u.test(text) || !/\p{Lu}/u.test(text)) {
    process.stderr.write(`FAIL: ${label} is not cased: "${text}"\n`);
    process.exit(1);
  }
}

/** A refinement model's text must close with a mark: it is the text committed. */
function requireClosed(label, text) {
  requireCased(label, text);
  if (!/[.?!]$/.test(text)) {
    process.stderr.write(`FAIL: ${label} does not close its sentence: "${text}"\n`);
    process.exit(1);
  }
}

async function smokeRefreshedModels(root, wavPath) {
  // 8) Parakeet v3 - Best's refinement pass and Balanced's one model, English.
  const v3Dir = path.join(root, 'parakeet-v3');
  const v3Mb = await ensureFiles(v3Dir, transducerFiles(PARAKEET_V3_BASE));
  const v3LoadStart = Date.now();
  const v3 = await offlineNemo(v3Dir);
  process.stdout.write(`parakeet v3 (${v3Mb.toFixed(0)} MiB) COLD LOAD: ${Date.now() - v3LoadStart} ms\n`);
  const offlineStart = Date.now();
  const v3Text = await decode(v3, wavPath);
  const clipSeconds = sherpa.readWave(wavPath).samples.length / 16000;
  process.stdout.write(`parakeet v3 real-time factor: ${((Date.now() - offlineStart) / 1000 / clipSeconds).toFixed(3)}\n`);
  requireClosed('parakeet v3', v3Text);

  // 9) Nemotron streaming en - Best's live model, through the plain transducer
  // config. Its finalize must keep the clip's last word; it never closes the
  // sentence, which is why a refinement pass follows it.
  const nemotronDir = path.join(root, 'nemotron-streaming-en');
  const nemotronMb = await ensureFiles(nemotronDir, [
    ...transducerFiles(NEMOTRON_EN_BASE),
    { url: `${NEMOTRON_EN_BASE}/test_wavs/1.wav`, file: '1.wav' },
  ]);
  const nemotron = onlineTransducer(nemotronDir);
  process.stdout.write(`nemotron streaming en (${nemotronMb.toFixed(0)} MiB) loaded\n`);
  for (const clip of [wavPath, path.join(nemotronDir, '1.wav')]) {
    const reference = await decode(v3, clip);
    const streamed = streamTranscribe(nemotron, sherpa.readWave(clip), 'en');
    process.stdout.write(`nemotron ${path.basename(clip)}: "${streamed.text}" (${streamed.partials} partials, RTF ${streamed.realTimeFactor.toFixed(3)})\n`);
    requireCased(`nemotron ${path.basename(clip)}`, streamed.text);
    if (streamed.partials < 1) {
      process.stderr.write('FAIL: nemotron emitted no live partials\n');
      process.exit(1);
    }
    if (lastWord(streamed.text) !== lastWord(reference)) {
      process.stderr.write(`FAIL: nemotron lost the last word ("${lastWord(reference)}")\n`);
      process.exit(1);
    }
  }

  // 10) Nemotron 3.5 - the multilingual live model, each stream pinned to its
  // language. The lead silence is what keeps the German clip's first word.
  const multiDir = path.join(root, 'nemotron-3.5-streaming');
  await ensureFiles(multiDir, [
    ...transducerFiles(NEMOTRON_MULTI_BASE),
    { url: `${NEMOTRON_MULTI_BASE}/test_wavs/de.wav`, file: 'de.wav' },
    { url: `${NEMOTRON_MULTI_BASE}/test_wavs/en.wav`, file: 'en.wav' },
  ]);
  const multi = onlineTransducer(multiDir);
  for (const language of ['de', 'en']) {
    const result = streamTranscribe(multi, sherpa.readWave(path.join(multiDir, `${language}.wav`)), language);
    process.stdout.write(`nemotron 3.5 pinned to ${language}: "${result.text}" (RTF ${result.realTimeFactor.toFixed(3)})\n`);
    requireCased(`nemotron 3.5 ${language}`, result.text);
  }
  const german = streamTranscribe(multi, sherpa.readWave(path.join(multiDir, 'de.wav')), 'de');
  if (!german.text.startsWith('Alles')) {
    process.stderr.write(`FAIL: nemotron 3.5 dropped the German clip's first word: "${german.text}"\n`);
    process.exit(1);
  }

  // 11) Parakeet v3 on German, the European refinement.
  const v3German = await decode(v3, path.join(multiDir, 'de.wav'));
  process.stdout.write(`parakeet v3 on de.wav: "${v3German}"\n`);
  requireClosed('parakeet v3 de', v3German);

  // 12) Parakeet unified, a Custom choice: its config loads and decodes.
  const unifiedDir = path.join(root, 'parakeet-unified');
  await ensureFiles(unifiedDir, transducerFiles(PARAKEET_UNIFIED_BASE));
  requireCased('parakeet unified', await decode(await offlineNemo(unifiedDir), wavPath));

  // 13) Cohere Transcribe, a Custom choice: 2.7 GiB, so only with --with-cohere.
  if (process.argv.includes('--with-cohere')) {
    const cohereDir = path.join(root, 'cohere-transcribe');
    await ensureFiles(cohereDir, ['encoder.int8.onnx', 'encoder.int8.onnx.data', 'decoder.int8.onnx', 'tokens.txt']
      .map((file) => ({ url: `${COHERE_TRANSCRIBE_BASE}/${file}`, file })));
    const cohere = await sherpa.OfflineRecognizer.createAsync({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        cohereTranscribe: { encoder: path.join(cohereDir, 'encoder.int8.onnx'), decoder: path.join(cohereDir, 'decoder.int8.onnx'), usePunct: 1, useItn: 1 },
        tokens: path.join(cohereDir, 'tokens.txt'), numThreads: 4, provider: 'cpu', debug: 0,
      },
    });
    for (const [language, clip] of [['en', wavPath], ['de', path.join(multiDir, 'de.wav')]]) {
      const wave = sherpa.readWave(clip);
      const stream = cohere.createStream();
      stream.setOption('language', language);
      stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples });
      const text = ((await cohere.decodeAsync(stream)).text ?? '').trim();
      process.stdout.write(`cohere transcribe ${language}: "${text}"\n`);
      // Cased, not necessarily closed: it closed every dictated prompt in the
      // lineup's measurement, but leaves the read-speech clip unclosed.
      requireCased(`cohere transcribe ${language}`, text);
    }
  }
}

main().catch((error) => {
  process.stderr.write(`FAIL: ${error?.stack ?? error}\n`);
  process.exit(1);
});
