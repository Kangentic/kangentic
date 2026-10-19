// Records the dictation the web demo plays: what the desktop's own dictation
// engine types into a text field while someone holds push-to-talk and says the
// phrase. The web demo has no microphone to hear and no engine to run, so the
// `dictation-field` scene replays this recording on its own clock: the partials
// as the live model streamed them, then the refined final on release
// (demo/README.md, Dictation).
//
// The speech is sherpa-onnx's Kokoro TTS saying the phrase, so the clip is
// regenerated here rather than committed, and only the transcript is. The
// engine is the real one: this bundles the dictation worker's own engine code
// (engine-build.ts and the engines it builds) with esbuild, resolves the same
// selection the demo's Dictation tab shows (the Best preset: Nemotron streaming
// live, Parakeet v3 to refine), and feeds it the clip the way the renderer's
// worklet does, 20 ms frames of 16 kHz mono PCM. Each partial's time is the
// audio clock at the frame that produced it, measured from the press.
//
// Weights download into the dictation smoke cache under the OS temp directory,
// from the model registry's own URLs.
//
// Run: node scripts/record-dictation-demo.mjs [--wav <path to a 16 kHz or other mono clip>]
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { CACHE_FOLDERS, DICTATION_CACHE_ROOT } from './lib/dictation-engine-recipes.mjs';
import { KOKORO_MODEL, createKokoroTts, ensureKokoro } from './lib/dictation-tts.mjs';

const require = createRequire(import.meta.url);
const sherpa = require('sherpa-onnx-node');
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(REPO_ROOT, 'tests', 'captures', 'fixtures', 'demo', 'dictation', 'settings-search.json');

/** What is said. It names a Dictation tab row, so the Settings search it lands in narrows to that row. */
const PHRASE = 'Push to talk.';
const VOICE = 0;
const SAMPLE_RATE = 16000;
/** The renderer's worklet posts 20 ms frames (src/renderer/audio/pcm-worklet.js). */
const FRAME_SAMPLES = 320;
const FRAME_MS = 20;
/** From the press to the first word, and from the last word to letting go, as a person speaks. */
const ONSET_SECONDS = 0.4;
const LET_GO_SECONDS = 0.35;

// The sample install's machine, so the selection is the one the demo's Dictation tab names
// (DEMO_DICTATION_HARDWARE in tests/captures/helpers/demo-dataset.ts; the fixture's guard,
// tests/unit/demo-dictation-recording-seeded.test.ts, holds the two to the same models).
const DEMO_HARDWARE = { cpuModel: 'Unknown CPU', cpuCores: 8, totalRamGb: 16, hasAvx2: false, gpu: 'none', platform: 'win32', arch: 'x64' };

/** The dictation worker's engine code, bundled for this Node process. sherpa-onnx-node stays external. */
async function loadEngineCode() {
  const outfile = path.join(REPO_ROOT, 'node_modules', '.cache', 'kangentic-record-dictation', 'engine.cjs');
  await esbuild.build({
    stdin: {
      contents: [
        "export { buildEngine } from './src/main/transcription/engines/engine-build';",
        "export { selectEngine } from './src/main/transcription/engines/engine-selection';",
        "export { downloadModelFiles } from './src/main/transcription/models/download-model';",
        "export { DEFAULT_CONFIG } from './src/shared/types';",
      ].join('\n'),
      resolveDir: REPO_ROOT,
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['sherpa-onnx-node'],
    outfile,
    logLevel: 'warning',
  });
  return require(outfile);
}

/** Linear resampling to the capture rate; the worklet does its own on the desktop. */
function resample(samples, fromRate) {
  if (fromRate === SAMPLE_RATE) return samples;
  const length = Math.round(samples.length * SAMPLE_RATE / fromRate);
  const out = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const position = index * fromRate / SAMPLE_RATE;
    const left = Math.floor(position);
    const right = Math.min(left + 1, samples.length - 1);
    const fraction = position - left;
    out[index] = samples[left] * (1 - fraction) + samples[right] * fraction;
  }
  return out;
}

/** The phrase as a person says it into the mic: silence from the press, the words, silence to the release. */
async function speech(wavPath) {
  let samples;
  let source;
  if (wavPath) {
    const wave = sherpa.readWave(wavPath);
    samples = resample(wave.samples, wave.sampleRate);
    source = { kind: 'wav' };
  } else {
    const tts = createKokoroTts(sherpa, await ensureKokoro());
    const audio = tts.generate({ text: PHRASE, generationConfig: new sherpa.GenerationConfig({ sid: VOICE, speed: 1.0 }) });
    samples = resample(audio.samples, audio.sampleRate);
    source = { kind: 'tts', model: KOKORO_MODEL, voice: VOICE, text: PHRASE };
  }
  const onset = Math.round(SAMPLE_RATE * ONSET_SECONDS);
  const letGo = Math.round(SAMPLE_RATE * LET_GO_SECONDS);
  const clip = new Float32Array(onset + samples.length + letGo);
  clip.set(samples, onset);
  return { clip, source };
}

function toFrames(clip) {
  const frames = [];
  for (let start = 0; start < clip.length; start += FRAME_SAMPLES) {
    const frame = new Int16Array(FRAME_SAMPLES);
    for (let index = 0; index < FRAME_SAMPLES && start + index < clip.length; index += 1) {
      frame[index] = Math.max(-32768, Math.min(32767, Math.round(clip[start + index] * 32767)));
    }
    frames.push(frame);
  }
  return frames;
}

// The smoke and measure scripts keep these same weights under their own folder names, at the
// revisions the registry pins (tests/unit/dictation-script-pins.test.ts), so the three share one
// download. A model they do not load gets a folder of its own.
const SHARED_CACHE_FOLDERS = {
  'nemotron-streaming-0.6b-en': CACHE_FOLDERS.nemotronEnglish,
  'parakeet-tdt-0.6b-v3': CACHE_FOLDERS.parakeetV3,
};

async function resolveModels(engineCode, selection) {
  const resolved = [];
  for (const model of selection.models) {
    const directory = path.join(DICTATION_CACHE_ROOT, SHARED_CACHE_FOLDERS[model.id] ?? model.id);
    let lastReported = 0;
    await engineCode.downloadModelFiles(model, directory, (progress) => {
      const percent = Math.floor((progress.downloadedBytes / progress.totalBytes) * 100);
      if (percent >= lastReported + 10) {
        lastReported = percent;
        process.stdout.write(`  ${model.id}: ${percent}%\n`);
      }
    });
    const paths = Object.fromEntries(Object.entries(model.roles).map(([role, file]) => [role, path.join(directory, file)]));
    resolved.push({ id: model.id, engineId: selection.id, kind: model.engineKind, paths });
  }
  return resolved;
}

async function main() {
  const wavFlag = process.argv.indexOf('--wav');
  const wavPath = wavFlag !== -1 ? process.argv[wavFlag + 1] : null;
  const engineCode = await loadEngineCode();
  const config = engineCode.DEFAULT_CONFIG.dictation;
  const selection = engineCode.selectEngine(DEMO_HARDWARE, config);
  if (!selection.liveModelId || !selection.finalModelId) {
    throw new Error(`The demo's selection should be a live and a refinement model; got ${selection.liveModelId} and ${selection.finalModelId}`);
  }
  process.stdout.write(`selection: ${selection.liveModelId} live, ${selection.finalModelId} final\n`);
  const engine = engineCode.buildEngine(selection, undefined);
  await engine.load(await resolveModels(engineCode, selection));

  // The refinement model loads on the first press, overlapped with the utterance. A first
  // session that finalizes waits for it, so the recorded session's decode time is a warm one,
  // like every press after the first on the desktop.
  const warmup = engine.createSession({ sampleRate: SAMPLE_RATE, language: selection.language, onPartial: () => undefined });
  warmup.push(new Int16Array(FRAME_SAMPLES * 25));
  await warmup.finalize();
  warmup.dispose();

  const { clip, source } = await speech(wavPath);
  const frames = toFrames(clip);
  const partials = [];
  let frameIndex = 0;
  const session = engine.createSession({
    sampleRate: SAMPLE_RATE,
    language: selection.language,
    onPartial: (text) => { partials.push({ t: (frameIndex + 1) * FRAME_MS, text }); },
  });
  // The press is t=0. The release is the end of the clip, and the release buffer keeps the mic
  // open after it, so the engine hears that much more silence before it finalizes.
  const releaseMs = frames.length * FRAME_MS;
  const bufferFrames = Math.round(config.releaseBufferMs / FRAME_MS);
  for (let index = 0; index < bufferFrames; index += 1) frames.push(new Int16Array(FRAME_SAMPLES));
  for (frameIndex = 0; frameIndex < frames.length; frameIndex += 1) session.push(frames[frameIndex]);
  const decodeStarted = Date.now();
  const finalText = await session.finalize();
  const decodeMs = Date.now() - decodeStarted;
  session.dispose();

  if (partials.length === 0) throw new Error('The live model produced no partials for the clip');
  if (!finalText.trim()) throw new Error('The refinement produced no text for the clip');
  const recording = {
    source,
    liveModelId: selection.liveModelId,
    finalModelId: selection.finalModelId,
    language: selection.language,
    frameMs: FRAME_MS,
    releaseMs,
    releaseBufferMs: config.releaseBufferMs,
    partials,
    final: { text: finalText, decodeMs },
  };
  fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
  fs.writeFileSync(FIXTURE, `${JSON.stringify(recording, null, 2)}\n`);
  process.stdout.write(`partials: ${partials.map((partial) => `${partial.t}ms "${partial.text}"`).join(', ')}\n`);
  process.stdout.write(`final: "${finalText}" in ${decodeMs}ms\nwrote ${path.relative(REPO_ROOT, FIXTURE)}\n`);
}

// process.exit, never a return to the event loop: a sherpa async decode still settling while Node
// tears down is the native fault the dictation worker exits for (DESKTOP-X,
// .claude/rules/dictation-out-of-process.md), and a plain Node process has the same teardown.
main().then(() => process.exit(0), (error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exit(1);
});
