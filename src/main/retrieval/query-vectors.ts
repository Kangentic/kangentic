/**
 * Query embeddings, made on main and used by the retrieval worker.
 *
 * Only the embed engine embeds (`.claude/rules/central-embedding-engine.md`),
 * and it lives on main, so a search that runs in the worker cannot embed its
 * own query. Main embeds the texts first and sends the vectors with the call;
 * the worker hands the search code `precomputedEmbedder`, which answers from
 * those vectors and nothing else. The search code keeps its `Embedder` seam and
 * its degrade paths: a text main could not embed in time is absent, so the
 * search throws inside its own try and falls back to keywords, as it does when
 * a live embed times out.
 */

import type { Embedder } from './types';

/** What a worker call carries in place of an embedder. Structured-cloneable. */
export interface QueryVectors {
  modelTag: string;
  dimensions: number;
  /** The model's anisotropy floor, which the relevance filter reads. */
  noiseFloor: number;
  /** Each embedded text with its vector. Empty when the embed failed or ran
   *  out of time. */
  vectors: Array<[text: string, vector: Float32Array]>;
}

/**
 * Embed `texts` as queries. Null when there is no embedder (semantic search
 * off); vectors empty when it did not answer in `timeoutMs`, which callers
 * treat as keywords only while keeping the model's noise floor.
 */
export async function embedQueryTexts(
  embedder: Embedder | null,
  texts: ReadonlyArray<string>,
  timeoutMs?: number,
): Promise<QueryVectors | null> {
  if (!embedder) return null;
  const unique = [...new Set(texts.filter((text) => text.length > 0))];
  let embedded: Float32Array[] | null = null;
  if (unique.length > 0) {
    try {
      embedded = await embedder.embed(unique, { timeoutMs, isQuery: true });
    } catch {
      embedded = null;
    }
  }
  const vectors: QueryVectors['vectors'] = [];
  if (embedded && embedded.length === unique.length) {
    unique.forEach((text, index) => vectors.push([text, embedded[index]]));
  }
  return { modelTag: embedder.modelTag, dimensions: embedder.dimensions, noiseFloor: embedder.noiseFloor, vectors };
}

/**
 * An `Embedder` that answers only from vectors main already made. It throws
 * for any text it was not given, so search code that tries to embed something
 * new (a passage, a text main never saw) fails loudly instead of quietly
 * searching without it.
 */
export function precomputedEmbedder(queryVectors: QueryVectors): Embedder {
  const byText = new Map(queryVectors.vectors);
  return {
    modelTag: queryVectors.modelTag,
    dimensions: queryVectors.dimensions,
    noiseFloor: queryVectors.noiseFloor,
    embed: async (texts, options) => {
      if (options?.isQuery !== true) throw new Error('the retrieval worker embeds queries only, from vectors main sent');
      return texts.map((text) => {
        const vector = byText.get(text);
        if (!vector) throw new Error('no query vector was sent for this text');
        return vector;
      });
    },
  };
}
