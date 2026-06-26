import { describe, it, expect } from 'vitest';
import { int16ToFloat32, concatInt16ToFloat32 } from '../../src/main/transcription/audio/pcm';

/**
 * PCM conversion unit tests.
 *
 * The renderer captures 16 kHz mono Int16 PCM; sherpa-onnx engines want Float32
 * in [-1, 1]. Division by 32768 is the standard normalization factor (not 32767)
 * because Int16 has an asymmetric range: max positive is 32767 but the magnitude
 * of the most-negative value is 32768. Using 32768 ensures -32768 maps exactly
 * to -1.0 and the positive headroom (~0.99997) is a deliberate and specified
 * property of the encoding.
 */
describe('int16ToFloat32', () => {
  it('converts zero to 0.0', () => {
    const result = int16ToFloat32(new Int16Array([0]));
    expect(result[0]).toBe(0);
  });

  it('converts 32767 (max positive) to approximately 32767/32768', () => {
    const result = int16ToFloat32(new Int16Array([32767]));
    // 32767 / 32768 = 0.999969482421875 - intentionally less than 1.0
    expect(result[0]).toBeCloseTo(32767 / 32768, 5);
    expect(result[0]).toBeLessThan(1.0);
  });

  it('converts -32768 (min negative, full-scale) to exactly -1.0', () => {
    const result = int16ToFloat32(new Int16Array([-32768]));
    expect(result[0]).toBe(-1.0);
  });

  it('produces a Float32Array of the same length as the input', () => {
    const input = new Int16Array([1, 2, 3, -1, -2, -3]);
    const result = int16ToFloat32(input);
    expect(result).toHaveLength(6);
  });

  it('sample-wise: every output[i] equals input[i] / 32768', () => {
    const input = new Int16Array([0, 100, -200, 32767, -32768]);
    const result = int16ToFloat32(input);
    for (let index = 0; index < input.length; index++) {
      expect(result[index]).toBeCloseTo(input[index] / 32768, 6);
    }
  });

  it('handles an empty array without error', () => {
    const result = int16ToFloat32(new Int16Array([]));
    expect(result).toHaveLength(0);
  });
});

describe('concatInt16ToFloat32', () => {
  it('single chunk: values convert correctly', () => {
    const chunk = new Int16Array([1000, -2000]);
    const result = concatInt16ToFloat32([chunk]);
    expect(result).toHaveLength(2);
    expect(result[0]).toBeCloseTo(1000 / 32768, 5);
    expect(result[1]).toBeCloseTo(-2000 / 32768, 5);
  });

  it('two chunks: values appear in order without offset errors', () => {
    const chunkA = new Int16Array([1000, 2000]);
    const chunkB = new Int16Array([3000, -1000]);
    const result = concatInt16ToFloat32([chunkA, chunkB]);
    expect(result).toHaveLength(4);
    expect(result[0]).toBeCloseTo(1000 / 32768, 5);
    expect(result[1]).toBeCloseTo(2000 / 32768, 5);
    expect(result[2]).toBeCloseTo(3000 / 32768, 5);
    expect(result[3]).toBeCloseTo(-1000 / 32768, 5);
  });

  it('chunk boundary: last sample of chunk A is not overwritten by first sample of chunk B', () => {
    // An off-by-one in offset accumulation would write chunk B sample[0] at
    // the last position of chunk A's range, corrupting it. Verify positions
    // at the boundary are both preserved correctly.
    const chunkA = new Int16Array([10, 20, 30]);
    const chunkB = new Int16Array([40, 50]);
    const result = concatInt16ToFloat32([chunkA, chunkB]);
    expect(result).toHaveLength(5);
    expect(result[2]).toBeCloseTo(30 / 32768, 6); // last of A
    expect(result[3]).toBeCloseTo(40 / 32768, 6); // first of B
  });

  it('three chunks: cumulative offset is correct across each boundary', () => {
    const chunkA = new Int16Array([100]);
    const chunkB = new Int16Array([200]);
    const chunkC = new Int16Array([300]);
    const result = concatInt16ToFloat32([chunkA, chunkB, chunkC]);
    expect(result).toHaveLength(3);
    expect(result[0]).toBeCloseTo(100 / 32768, 6);
    expect(result[1]).toBeCloseTo(200 / 32768, 6);
    expect(result[2]).toBeCloseTo(300 / 32768, 6);
  });

  it('returns an empty Float32Array for an empty chunk list', () => {
    const result = concatInt16ToFloat32([]);
    expect(result).toHaveLength(0);
  });

  it('output length equals the sum of all chunk lengths', () => {
    const chunks = [new Int16Array(3), new Int16Array(7), new Int16Array(5)];
    const result = concatInt16ToFloat32(chunks);
    expect(result).toHaveLength(15);
  });
});
