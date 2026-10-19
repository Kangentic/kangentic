/**
 * Downloads and speech synthesis for the dictation scripts that need a clip whose
 * words are known: scripts/measure-dictation-models.mjs scores models against it,
 * and scripts/record-dictation-demo.mjs records the web demo's transcript from it.
 * The speech is sherpa-onnx's own Kokoro TTS, so a clip is regenerated, never
 * committed.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DICTATION_CACHE_ROOT } from './dictation-engine-recipes.mjs';

/** The Kokoro release the clips are synthesized with. */
export const KOKORO_MODEL = 'kokoro-en-v0_19';
const KOKORO_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/${KOKORO_MODEL}.tar.bz2`;

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

/** Download and unpack the Kokoro model once, into the dictation cache. Returns its folder. */
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
  return kokoro;
}

/** A Kokoro TTS over the folder `ensureKokoro` returned, from the caller's sherpa-onnx-node. */
export function createKokoroTts(sherpa, kokoro) {
  return new sherpa.OfflineTts({
    model: {
      kokoro: { model: path.join(kokoro, 'model.onnx'), voices: path.join(kokoro, 'voices.bin'), tokens: path.join(kokoro, 'tokens.txt'), dataDir: path.join(kokoro, 'espeak-ng-data') },
      numThreads: 4, provider: 'cpu', debug: false,
    },
    maxNumSentences: 1,
  });
}
