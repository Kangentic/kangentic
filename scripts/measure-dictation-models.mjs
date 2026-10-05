// Measures dictation models the way the engines run them, so the presets and
// the accuracy labels in src/main/transcription/models/model-registry.ts rest
// on numbers rather than leaderboard ranks. The leaderboard scores words with
// case and punctuation stripped; dictation commits the text as typed.
//
// Clips: dictated prompts of the kind a user sends a coding agent (questions,
// clauses, a name), synthesized in two voices with sherpa-onnx's own Kokoro
// TTS so the exact text is known, plus read-speech clips with transcripts from
// the model repos. Per model it prints:
//
//   word error       edit distance over words, case and punctuation removed
//   as typed         the same over words AND marks, case kept: what lands
//   closing mark     prompts whose final . or ? matches
//   question marks   questions that end in one
//   real-time factor decode seconds per audio second (lower is faster)
//
// Streaming models run as SherpaOnlineEngine does: 0.6 s of lead silence,
// 100 ms pushes, 0.5 s of tail padding. Offline models decode the whole clip.
// Weights download into the dictation smoke cache under the OS temp directory.
//
// Run: node scripts/measure-dictation-models.mjs [model names...]
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const require = createRequire(import.meta.url);
const sherpa = require('sherpa-onnx-node');
const root = path.join(os.tmpdir(), 'kangentic-dictation-smoke');
const hf = (repo, revision, file) => `https://huggingface.co/${repo}/resolve/${revision}/${file}`;

const PROMPTS = [
  'Can you fix the failing test in the login form? It times out after a few seconds.',
  'Rename the helper to parse config, then update every caller.',
  'Why does the build fail on Windows but not on Linux?',
  'Add a retry with exponential backoff, and log each attempt.',
  'Please review the pull request and leave comments on anything risky.',
  'The dropdown should close when I click outside of it.',
  'Move the settings button to the right side of the toolbar.',
  'Write unit tests for the date formatting function, including time zones.',
  'What happens if the user cancels the download halfway through?',
  'Revert the last commit, but keep the changes to the readme.',
];
const VOICES = [0, 6];
const ZIPFORMER = 'csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26';
const NEMOTRON_EN = ['csukuangfj2/sherpa-onnx-nemotron-speech-streaming-en-0.6b-560ms-int8-2026-04-25', '52056fdc070914a48dcd68b31b44d6a6f5b85902'];
const READ_SPEECH = [
  { repo: NEMOTRON_EN, file: 'test_wavs/0.wav', reference: 'after early nightfall the yellow lamps would light up here and there the squalid quarter of the brothels' },
  { repo: NEMOTRON_EN, file: 'test_wavs/1.wav', reference: 'god as a direct consequence of the sin which man thus punished had given her a lovely child whose place was on that same dishonoured bosom to connect her parent for ever with the race and descent of mortals and to be finally a blessed soul in heaven' },
];

const transducer = (repo, revision) => ({
  files: ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'],
  repo, revision,
  config: (dir) => ({ transducer: { encoder: path.join(dir, 'encoder.int8.onnx'), decoder: path.join(dir, 'decoder.int8.onnx'), joiner: path.join(dir, 'joiner.int8.onnx') }, tokens: path.join(dir, 'tokens.txt') }),
});

const MODELS = {
  'parakeet-v3': { kind: 'offline', ...transducer('csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8', '2bda32ec70b097a55adaa07d9a7173915b43cc78'), nemo: true },
  'parakeet-v2': { kind: 'offline', ...transducer('csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8', 'main'), nemo: true },
  'parakeet-unified': { kind: 'offline', ...transducer('csukuangfj2/sherpa-onnx-nemo-parakeet-unified-en-0.6b-int8-non-streaming', '8c3a10fb13408c7a7054f6898958bf1c64a8d6c7'), nemo: true },
  'cohere-transcribe': {
    kind: 'offline',
    repo: 'csukuangfj2/sherpa-onnx-cohere-transcribe-14-lang-int8-2026-04-01', revision: '156a470cf08eefe706a0004f3c52d9ee567ca7a0',
    files: ['encoder.int8.onnx', 'encoder.int8.onnx.data', 'decoder.int8.onnx', 'tokens.txt'],
    config: (dir) => ({ cohereTranscribe: { encoder: path.join(dir, 'encoder.int8.onnx'), decoder: path.join(dir, 'decoder.int8.onnx'), usePunct: 1, useItn: 1 }, tokens: path.join(dir, 'tokens.txt') }),
  },
  'canary-180m-flash': {
    kind: 'offline',
    repo: 'csukuangfj/sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8', revision: 'main',
    files: ['encoder.int8.onnx', 'decoder.int8.onnx', 'tokens.txt'],
    config: (dir) => ({ canary: { encoder: path.join(dir, 'encoder.int8.onnx'), decoder: path.join(dir, 'decoder.int8.onnx'), srcLang: 'en', tgtLang: 'en', usePnc: 1 }, tokens: path.join(dir, 'tokens.txt') }),
  },
  'nemotron-streaming': { kind: 'online', ...transducer(...NEMOTRON_EN) },
  'zipformer': {
    kind: 'online',
    repo: ZIPFORMER, revision: 'main',
    files: [
      ['encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx', 'encoder.int8.onnx'],
      ['decoder-epoch-99-avg-1-chunk-16-left-128.onnx', 'decoder.onnx'],
      ['joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx', 'joiner.int8.onnx'],
      ['tokens.txt', 'tokens.txt'],
    ],
    config: (dir) => ({ transducer: { encoder: path.join(dir, 'encoder.int8.onnx'), decoder: path.join(dir, 'decoder.onnx'), joiner: path.join(dir, 'joiner.int8.onnx') }, tokens: path.join(dir, 'tokens.txt') }),
  },
};

const CACHE_FOLDERS = {
  'parakeet-v3': 'parakeet-v3',
  'parakeet-v2': 'parakeet',
  'parakeet-unified': 'parakeet-unified',
  'cohere-transcribe': 'cohere-transcribe',
  'canary-180m-flash': 'canary-180m-flash',
  'nemotron-streaming': 'nemotron-streaming-en',
  'zipformer': 'streaming-zipformer',
};

async function fetchTo(url, dest) {
  if (fs.existsSync(dest)) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  process.stdout.write(`downloading ${path.basename(dest)}...\n`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(`${dest}.part`));
  fs.renameSync(`${dest}.part`, dest);
}

async function modelDir(name, spec) {
  // The smoke test's folder names, so the two scripts share one download.
  const dir = path.join(root, CACHE_FOLDERS[name] ?? name);
  for (const entry of spec.files) {
    const [remote, local] = Array.isArray(entry) ? entry : [entry, entry];
    await fetchTo(hf(spec.repo, spec.revision, remote), path.join(dir, local));
  }
  return dir;
}

async function dictatedClips() {
  const kokoro = path.join(root, 'kokoro-en-v0_19');
  if (!fs.existsSync(path.join(kokoro, 'model.onnx'))) {
    const archive = path.join(root, 'kokoro-en-v0_19.tar.bz2');
    await fetchTo('https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-en-v0_19.tar.bz2', archive);
    // A relative archive name: GNU tar (Git Bash) reads `C:` in an absolute
    // Windows path as a remote host.
    execFileSync('tar', ['-xjf', path.basename(archive)], { cwd: root });
  }
  const clipDir = path.join(root, 'measure-clips');
  fs.mkdirSync(clipDir, { recursive: true });
  let tts = null;
  const clips = [];
  PROMPTS.forEach((text, index) => {
    for (const voice of VOICES) {
      const file = path.join(clipDir, `prompt-${index}-voice-${voice}.wav`);
      if (!fs.existsSync(file)) {
        tts ??= new sherpa.OfflineTts({
          model: {
            kokoro: { model: path.join(kokoro, 'model.onnx'), voices: path.join(kokoro, 'voices.bin'), tokens: path.join(kokoro, 'tokens.txt'), dataDir: path.join(kokoro, 'espeak-ng-data') },
            numThreads: 4, provider: 'cpu', debug: false,
          },
          maxNumSentences: 1,
        });
        const audio = tts.generate({ text, generationConfig: new sherpa.GenerationConfig({ sid: voice, speed: 1.0 }) });
        // A quarter second of silence either side, as a push-to-talk capture has.
        const pad = Math.round(audio.sampleRate * 0.25);
        const samples = new Float32Array(pad * 2 + audio.samples.length);
        samples.set(audio.samples, pad);
        sherpa.writeWave(file, { samples, sampleRate: audio.sampleRate });
      }
      clips.push({ file, reference: text, dictated: true });
    }
  });
  return clips;
}

const normalizeWords = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').split(/\s+/).filter(Boolean);
const typedTokens = (text) => text.match(/[\p{L}\p{N}']+|[.,?!;:]/gu) ?? [];

function editDistance(reference, hypothesis) {
  let previous = Array.from({ length: hypothesis.length + 1 }, (_value, index) => index);
  for (let row = 1; row <= reference.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= hypothesis.length; column += 1) {
      const cost = reference[row - 1] === hypothesis[column - 1] ? 0 : 1;
      current.push(Math.min(previous[column] + 1, current[column - 1] + 1, previous[column - 1] + cost));
    }
    previous = current;
  }
  return previous[hypothesis.length];
}

function decodeOffline(recognizer, wave) {
  const stream = recognizer.createStream();
  stream.setOption('language', 'en');
  stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples });
  recognizer.decode(stream);
  return recognizer.getResult(stream).text.trim();
}

function decodeOnline(recognizer, wave) {
  const stream = recognizer.createStream();
  stream.setOption('language', 'en');
  stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: new Float32Array(Math.round(wave.sampleRate * 0.6)) });
  const step = Math.round(wave.sampleRate / 10);
  for (let index = 0; index < wave.samples.length; index += step) {
    stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples.subarray(index, index + step) });
    while (recognizer.isReady(stream)) recognizer.decode(stream);
  }
  stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: new Float32Array(Math.round(wave.sampleRate * 0.5)) });
  stream.inputFinished();
  while (recognizer.isReady(stream)) recognizer.decode(stream);
  return recognizer.getResult(stream).text.replace(/ {2,}/g, ' ').trim();
}

async function main() {
  const clips = await dictatedClips();
  for (const clip of READ_SPEECH) {
    const file = path.join(root, 'measure-clips', `read-${path.basename(clip.file)}`);
    await fetchTo(hf(clip.repo[0], clip.repo[1], clip.file), file);
    clips.push({ file, reference: clip.reference, dictated: false });
  }

  const requested = process.argv.slice(2);
  for (const [name, spec] of Object.entries(MODELS)) {
    if (requested.length > 0 && !requested.includes(name)) continue;
    const dir = await modelDir(name, spec);
    const megabytes = fs.readdirSync(dir).reduce((sum, file) => sum + fs.statSync(path.join(dir, file)).size, 0) / (1024 * 1024);
    const modelConfig = { ...spec.config(dir), numThreads: spec.kind === 'online' ? 2 : 4, provider: 'cpu', debug: 0, ...(spec.nemo ? { modelType: 'nemo_transducer' } : {}) };
    const featConfig = { sampleRate: 16000, featureDim: 80 };
    const recognizer = spec.kind === 'online'
      ? new sherpa.OnlineRecognizer({ featConfig, modelConfig, decodingMethod: 'greedy_search', enableEndpoint: false })
      : new sherpa.OfflineRecognizer({ featConfig, modelConfig, decodingMethod: 'greedy_search' });

    const totals = { wordErrors: 0, words: 0, typedErrors: 0, typed: 0, closed: 0, dictated: 0, questions: 0, questionsClosed: 0, decodeSeconds: 0, audioSeconds: 0 };
    for (const clip of clips) {
      const wave = sherpa.readWave(clip.file);
      const started = Date.now();
      const text = spec.kind === 'online' ? decodeOnline(recognizer, wave) : decodeOffline(recognizer, wave);
      totals.decodeSeconds += (Date.now() - started) / 1000;
      totals.audioSeconds += wave.samples.length / wave.sampleRate;
      const referenceWords = normalizeWords(clip.reference);
      totals.wordErrors += editDistance(referenceWords, normalizeWords(text));
      totals.words += referenceWords.length;
      if (!clip.dictated) continue;
      const referenceTokens = typedTokens(clip.reference);
      totals.typedErrors += editDistance(referenceTokens, typedTokens(text));
      totals.typed += referenceTokens.length;
      totals.dictated += 1;
      if (text.slice(-1) === clip.reference.slice(-1)) totals.closed += 1;
      if (clip.reference.endsWith('?')) {
        totals.questions += 1;
        if (text.endsWith('?')) totals.questionsClosed += 1;
      }
    }
    const percent = (value) => `${(value * 100).toFixed(1)}%`;
    process.stdout.write(
      `${name.padEnd(20)} ${megabytes.toFixed(0).padStart(5)} MiB  word error ${percent(totals.wordErrors / totals.words)}`
      + `  as typed ${percent(totals.typedErrors / totals.typed)}  closing mark ${totals.closed}/${totals.dictated}`
      + `  question marks ${totals.questionsClosed}/${totals.questions}  RTF ${(totals.decodeSeconds / totals.audioSeconds).toFixed(3)}\n`,
    );
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exit(1);
});
