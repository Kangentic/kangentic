/**
 * Downloads and speech synthesis for the dictation scripts that need a clip whose
 * words are known: scripts/measure-dictation-models.mjs scores models against it,
 * and scripts/record-dictation-demo.mjs records the web demo's transcript from it.
 * The speech is sherpa-onnx's own Kokoro TTS, so a clip is regenerated, never
 * committed.
 *
 * sherpa-onnx 2.0 removed espeak-ng, so Kokoro reads text only through a lexicon, and
 * that frontend drops any word the lexicon lacks while synthesis still succeeds. A
 * clip with a word missing would be scored against the full sentence, so
 * `assertLexiconCovers` runs before synthesis and `assertGeneratedAudio` after it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { DICTATION_CACHE_ROOT } from './dictation-engine-recipes.mjs';

/** The Kokoro release the clips are synthesized with. */
export const KOKORO_MODEL = 'kokoro-en-v0_19';
const KOKORO_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/${KOKORO_MODEL}.tar.bz2`;
const LEXICON_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/lexicon-en-us.txt';
/** Words the release lexicon lacks that the scripts' prompts say. Same format, phonemes from the model's tokens.txt. */
const EXTRA_LEXICON = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dictation-lexicon-extra.txt');

/** Download `url` to `dest` unless it is already there, through a .part file so a cut download never passes as whole. */
export async function fetchTo(url, dest) {
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

/**
 * Download and unpack the Kokoro model once, into the dictation cache, and fetch its
 * lexicon, which ships outside the tarball. Returns `{ kokoro, lexicons }`: the model's
 * folder and the lexicon files, the release's first.
 */
export async function ensureKokoro() {
  const root = DICTATION_CACHE_ROOT;
  const kokoro = path.join(root, KOKORO_MODEL);
  // Written once tar returns, so an extraction cut short runs again rather than
  // passing on whichever file happened to land first.
  const extractedMarker = path.join(kokoro, '.extracted');
  if (!fs.existsSync(extractedMarker)) {
    const archive = path.join(root, `${KOKORO_MODEL}.tar.bz2`);
    await fetchTo(KOKORO_URL, archive);
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
  const releaseLexicon = path.join(root, 'lexicon-en-us.txt');
  await fetchTo(LEXICON_URL, releaseLexicon);
  return { kokoro, lexicons: [releaseLexicon, EXTRA_LEXICON] };
}

/** A Kokoro TTS over what `ensureKokoro` returned, from the caller's sherpa-onnx-node. */
export function createKokoroTts(sherpa, { kokoro, lexicons }) {
  // The `lexicon` option is a comma-separated list, so a comma in a path would split it.
  const commaPath = lexicons.find((lexicon) => lexicon.includes(','));
  if (commaPath) throw new Error(`A lexicon path cannot hold a comma: ${commaPath}`);
  return new sherpa.OfflineTts({
    model: {
      kokoro: { model: path.join(kokoro, 'model.onnx'), voices: path.join(kokoro, 'voices.bin'), tokens: path.join(kokoro, 'tokens.txt'), lexicon: lexicons.join(',') },
      numThreads: 4, provider: 'cpu', debug: false,
    },
    maxNumSentences: 1,
  });
}

/** The lowercase words `text` is read as, keeping an apostrophe inside a word. */
export function spokenWords(text) {
  return text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
}

/** The words a lexicon file defines. A line is `word || phones`, and `#` opens a comment. */
export function lexiconWords(lexiconText) {
  const words = new Set();
  for (const line of lexiconText.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    const separator = line.indexOf('||');
    if (separator > 0) words.add(line.slice(0, separator).trim());
  }
  return words;
}

/** Throw, naming them, when a text says a word no lexicon defines. Kokoro would drop it with no error. */
export function assertLexiconCovers(lexicons, texts) {
  const known = new Set(lexicons.flatMap((lexicon) => [...lexiconWords(fs.readFileSync(lexicon, 'utf8'))]));
  const missing = [...new Set(texts.flatMap((text) => spokenWords(text)))].filter((word) => !known.has(word));
  if (missing.length > 0) {
    throw new Error(`No lexicon defines ${missing.join(', ')}. Add them to scripts/lib/${path.basename(EXTRA_LEXICON)}, with phonemes from the model's tokens.txt.`);
  }
}

/** Throw on empty audio, before a caller writes it. A cached empty clip would be scored on every later run. */
export function assertGeneratedAudio(audio, text) {
  if (!audio?.samples?.length) throw new Error(`Kokoro produced no audio for "${text}"`);
}
