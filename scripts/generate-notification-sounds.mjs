#!/usr/bin/env node
// Renders Kangentic's notification sounds to WAV, so what ships has no third-party
// source and no license to track. Run it after changing a note:
//
//   node scripts/generate-notification-sounds.mjs
//
// Each note is a soft bell: a sine at its pitch plus a quieter partial at 2.76 times
// it, which decays sooner. The result is committed under src/renderer/assets/sounds/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SAMPLE_RATE = 44100;
const ATTACK_SECONDS = 0.006;
const SILENCE = 0.0001;
const PARTIAL_RATIO = 2.76;
const PARTIAL_DECAY_SHARE = 0.35;

const note = (pitch, at, length, level, bright) => ({ pitch, at, length, level, bright });

const SOUNDS = {
  chime: [note(659.25, 0, 0.45, 0.28, 0.22), note(880, 0.11, 0.6, 0.3, 0.22)],
  rise: [note(440, 0, 0.35, 0.26, 0.2), note(659.25, 0.1, 0.35, 0.28, 0.2), note(880, 0.2, 0.7, 0.3, 0.2)],
  fall: [note(554.37, 0, 0.3, 0.3, 0.08), note(369.99, 0.14, 0.55, 0.32, 0.08)],
  tick: [note(880, 0, 0.2, 0.2, 0.3)],
};

/** The gain of one partial `elapsed` seconds in: an exponential rise, then an exponential fall. */
function envelope(elapsed, peak, decay) {
  if (elapsed < 0 || elapsed >= decay) return 0;
  if (elapsed < ATTACK_SECONDS) return SILENCE * (peak / SILENCE) ** (elapsed / ATTACK_SECONDS);
  return peak * (SILENCE / peak) ** ((elapsed - ATTACK_SECONDS) / (decay - ATTACK_SECONDS));
}

function render(notes) {
  const seconds = Math.max(...notes.map((item) => item.at + item.length));
  const samples = new Float64Array(Math.ceil(seconds * SAMPLE_RATE));
  for (const item of notes) {
    for (const [ratio, amount] of [[1, 1], [PARTIAL_RATIO, item.bright]]) {
      const decay = ratio === 1 ? item.length : item.length * PARTIAL_DECAY_SHARE;
      for (let index = 0; index < samples.length; index += 1) {
        const elapsed = index / SAMPLE_RATE - item.at;
        const gain = envelope(elapsed, item.level * amount, decay);
        if (gain > 0) samples[index] += gain * Math.sin(2 * Math.PI * item.pitch * ratio * elapsed);
      }
    }
  }
  return samples;
}

function encodeWav(samples) {
  const dataBytes = samples.length * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVEfmt ', 8, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(SAMPLE_RATE * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataBytes, 40);
  samples.forEach((sample, index) => {
    const clipped = Math.max(-1, Math.min(1, sample));
    wav.writeInt16LE(Math.round(clipped * 32767), 44 + index * 2);
  });
  return wav;
}

const outputDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer', 'assets', 'sounds');
fs.mkdirSync(outputDir, { recursive: true });
for (const [name, notes] of Object.entries(SOUNDS)) {
  const wav = encodeWav(render(notes));
  fs.writeFileSync(path.join(outputDir, `${name}.wav`), wav);
  console.log(`${name}.wav ${(wav.length / 1024).toFixed(0)} KB`);
}
