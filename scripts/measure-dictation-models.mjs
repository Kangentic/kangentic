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
// Streaming models run as a SherpaOnlineEngine session does (`streamDecode`).
// Offline models decode the whole clip. Each model loads through the config
// its engine builds (scripts/lib/dictation-engine-recipes.mjs). Weights
// download into the dictation smoke cache under the OS temp directory.
//
// Run: node scripts/measure-dictation-models.mjs [model names...]
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  CACHE_FOLDERS,
  COHERE_TRANSCRIBE_FILES,
  COHERE_TRANSCRIBE_ROLES,
  DICTATION_CACHE_ROOT,
  TRANSDUCER_FILES,
  TRANSDUCER_ROLES,
  offlineRecognizerConfig,
  onlineRecognizerConfig,
  rolePaths,
  streamDecode,
} from './lib/dictation-engine-recipes.mjs';

const require = createRequire(import.meta.url);
const sherpa = require('sherpa-onnx-node');
const root = DICTATION_CACHE_ROOT;
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

const transducer = (repo, revision) => ({ repo, revision, files: TRANSDUCER_FILES });
const offlineNemo = (directory) => offlineRecognizerConfig('offline-nemo-transducer', rolePaths(directory, TRANSDUCER_ROLES));

const MODELS = {
  'parakeet-v3': {
    kind: 'offline', cacheFolder: CACHE_FOLDERS.parakeetV3, recognizerConfig: offlineNemo,
    ...transducer('csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8', '2bda32ec70b097a55adaa07d9a7173915b43cc78'),
  },
  'parakeet-v2': {
    kind: 'offline', cacheFolder: CACHE_FOLDERS.parakeetV2, recognizerConfig: offlineNemo,
    ...transducer('csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8', 'main'),
  },
  'parakeet-unified': {
    kind: 'offline', cacheFolder: CACHE_FOLDERS.parakeetUnified, recognizerConfig: offlineNemo,
    ...transducer('csukuangfj2/sherpa-onnx-nemo-parakeet-unified-en-0.6b-int8-non-streaming', '8c3a10fb13408c7a7054f6898958bf1c64a8d6c7'),
  },
  'cohere-transcribe': {
    kind: 'offline', cacheFolder: CACHE_FOLDERS.cohereTranscribe,
    repo: 'csukuangfj2/sherpa-onnx-cohere-transcribe-14-lang-int8-2026-04-01', revision: '156a470cf08eefe706a0004f3c52d9ee567ca7a0',
    files: COHERE_TRANSCRIBE_FILES,
    recognizerConfig: (directory) => offlineRecognizerConfig('offline-cohere-transcribe', rolePaths(directory, COHERE_TRANSCRIBE_ROLES)),
  },
  'canary-180m-flash': {
    kind: 'offline',
    repo: 'csukuangfj/sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8', revision: 'main',
    files: ['encoder.int8.onnx', 'decoder.int8.onnx', 'tokens.txt'],
    // Measured and not offered, so no engine builds it: the shape of the other
    // offline configs, with Canary's own block.
    recognizerConfig: (directory) => ({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        canary: { encoder: path.join(directory, 'encoder.int8.onnx'), decoder: path.join(directory, 'decoder.int8.onnx'), srcLang: 'en', tgtLang: 'en', usePnc: 1 },
        tokens: path.join(directory, 'tokens.txt'), numThreads: 4, provider: 'cpu', debug: 0,
      },
      decodingMethod: 'greedy_search',
    }),
  },
  'nemotron-streaming': {
    kind: 'online', cacheFolder: CACHE_FOLDERS.nemotronEnglish,
    recognizerConfig: (directory) => onlineRecognizerConfig(rolePaths(directory, TRANSDUCER_ROLES)),
    ...transducer(...NEMOTRON_EN),
  },
  'zipformer': {
    kind: 'online', cacheFolder: CACHE_FOLDERS.zipformer,
    repo: ZIPFORMER, revision: 'main',
    files: [
      ['encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx', 'encoder.int8.onnx'],
      ['decoder-epoch-99-avg-1-chunk-16-left-128.onnx', 'decoder.onnx'],
      ['joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx', 'joiner.int8.onnx'],
      ['tokens.txt', 'tokens.txt'],
    ],
    recognizerConfig: (directory) => onlineRecognizerConfig(rolePaths(directory, {
      encoder: 'encoder.int8.onnx', decoder: 'decoder.onnx', joiner: 'joiner.int8.onnx', tokens: 'tokens.txt',
    })),
  },
};

async function fetchTo(url, dest) {
  if (fs.existsSync(dest)) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  process.stdout.write(`downloading ${path.basename(dest)}...\n`);
  const partPath = `${dest}.part`;
  try {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(partPath));
  } catch (error) {
    fs.rmSync(partPath, { force: true });
    throw error;
  }
  await renameWithRetry(partPath, dest);
}

// Windows antivirus and the search indexer can hold a large file that was just
// written, so the rename retries on a lock before it gives up.
async function renameWithRetry(fromPath, toPath) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.renameSync(fromPath, toPath);
      return;
    } catch (error) {
      if (attempt >= 5 || (error.code !== 'EPERM' && error.code !== 'EBUSY')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
}

async function modelDir(name, spec) {
  // The smoke test's folder names, so the two scripts share one download.
  const directory = path.join(root, spec.cacheFolder ?? name);
  for (const entry of spec.files) {
    const [remote, local] = Array.isArray(entry) ? entry : [entry, entry];
    await fetchTo(hf(spec.repo, spec.revision, remote), path.join(directory, local));
  }
  return directory;
}

async function dictatedClips() {
  const kokoro = path.join(root, 'kokoro-en-v0_19');
  // Written once tar returns, so an extraction cut short runs again rather than
  // passing on whichever file happened to land first.
  const extractedMarker = path.join(kokoro, '.extracted');
  if (!fs.existsSync(extractedMarker)) {
    const archive = path.join(root, 'kokoro-en-v0_19.tar.bz2');
    await fetchTo('https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-en-v0_19.tar.bz2', archive);
    // A relative archive name: GNU tar (Git Bash) reads `C:` in an absolute
    // Windows path as a remote host.
    try {
      execFileSync('tar', ['-xjf', path.basename(archive)], { cwd: root });
    } catch (error) {
      // Windows 10 and later ship a bsdtar that reads bzip2; a minimal Linux
      // image may have tar without bzip2, which fails with no hint.
      throw new Error(`Extracting ${path.basename(archive)} needs tar with bzip2 support on PATH: ${error.message}`, { cause: error });
    }
    fs.writeFileSync(extractedMarker, '');
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
    const directory = await modelDir(name, spec);
    const megabytes = fs.readdirSync(directory).reduce((sum, file) => sum + fs.statSync(path.join(directory, file)).size, 0) / (1024 * 1024);
    const recognizer = spec.kind === 'online'
      ? new sherpa.OnlineRecognizer(spec.recognizerConfig(directory))
      : new sherpa.OfflineRecognizer(spec.recognizerConfig(directory));

    const totals = { wordErrors: 0, words: 0, typedErrors: 0, typed: 0, closed: 0, dictated: 0, questions: 0, questionsClosed: 0, decodeSeconds: 0, audioSeconds: 0 };
    for (const clip of clips) {
      const wave = sherpa.readWave(clip.file);
      const started = Date.now();
      const text = spec.kind === 'online' ? streamDecode(recognizer, wave, 'en').text : decodeOffline(recognizer, wave);
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
