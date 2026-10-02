import { describe, it, expect, vi } from 'vitest';
import { embedQueryTexts, precomputedEmbedder } from '../../src/main/retrieval/query-vectors';
import type { Embedder } from '../../src/main/retrieval/types';

function fakeEmbedder(embed: Embedder['embed']): Embedder {
  return { embed, dimensions: 2, modelTag: 'fake@2', noiseFloor: 0.6 };
}

describe('query vectors made on main for the retrieval worker', () => {
  it('embeds each distinct text once, as queries, and carries the model fields', async () => {
    const embed = vi.fn<Embedder['embed']>(async (texts) => texts.map((_text, index) => new Float32Array([index, 1])));
    const vectors = await embedQueryTexts(fakeEmbedder(embed), ['terminal renderer', 'terminal renderer', '', 'pty'], 500);
    expect(embed).toHaveBeenCalledWith(['terminal renderer', 'pty'], { timeoutMs: 500, isQuery: true });
    expect(vectors).toEqual({
      modelTag: 'fake@2',
      dimensions: 2,
      noiseFloor: 0.6,
      vectors: [['terminal renderer', new Float32Array([0, 1])], ['pty', new Float32Array([1, 1])]],
    });
  });

  it('is null with no embedder, and keeps the noise floor with no vectors when the embed times out', async () => {
    expect(await embedQueryTexts(null, ['a'])).toBeNull();
    const timedOut = await embedQueryTexts(fakeEmbedder(async () => null), ['a']);
    expect(timedOut).toMatchObject({ noiseFloor: 0.6, vectors: [] });
    const threw = await embedQueryTexts(fakeEmbedder(async () => { throw new Error('worker down'); }), ['a']);
    expect(threw?.vectors).toEqual([]);
  });

  it('answers the worker\'s search only from the vectors it was sent', async () => {
    const embedder = precomputedEmbedder({
      modelTag: 'fake@2',
      dimensions: 2,
      noiseFloor: 0.6,
      vectors: [['pty', new Float32Array([1, 0])]],
    });
    expect(embedder.noiseFloor).toBe(0.6);
    await expect(embedder.embed(['pty'], { isQuery: true })).resolves.toEqual([new Float32Array([1, 0])]);
    await expect(embedder.embed(['something else'], { isQuery: true })).rejects.toThrow(/no query vector/);
    await expect(embedder.embed(['pty'])).rejects.toThrow(/queries only/);
  });
});
