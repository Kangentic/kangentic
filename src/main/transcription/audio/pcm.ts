/**
 * PCM conversion helpers shared by the engines. The renderer captures 16 kHz
 * mono Int16 PCM; sherpa-onnx wants Float32 samples in [-1, 1].
 */

/** Convert one Int16 PCM frame to Float32 [-1, 1]. */
export function int16ToFloat32(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length);
  for (let index = 0; index < pcm.length; index++) {
    out[index] = pcm[index] / 32768;
  }
  return out;
}

/** Concatenate buffered Int16 frames into one Float32 buffer. */
export function concatInt16ToFloat32(chunks: Int16Array[]): Float32Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    for (let index = 0; index < chunk.length; index++) {
      out[offset + index] = chunk[index] / 32768;
    }
    offset += chunk.length;
  }
  return out;
}
