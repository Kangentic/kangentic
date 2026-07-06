/**
 * Registry of local embedding models for conversation memory. Mirrors the
 * dictation model-registry pattern (a small curated, tiered set of offline
 * models the user picks from in settings). Lives in `shared/` so the renderer's
 * settings dropdown and the main-process engine read one source of truth.
 *
 * All models are ONNX (q8) sentence encoders that run keyless + offline via
 * transformers.js (onnxruntime); files are fetched once by our own downloader
 * into the persistent model cache. Selection is by MTEB-informed tier, all
 * three from the bge-*-en-v1.5 family (same CLS pooling, same query prefix -
 * only size/dimensions/accuracy scale):
 *   balanced - bge-small-en-v1.5 (34M, 384d).
 *   accurate - bge-base-en-v1.5 (110M, 768d).
 *   max      - bge-large-en-v1.5 (335M, 1024d): highest MTEB retrieval score.
 *
 * A prior 'fast' tier (mxbai-embed-xsmall-v1, mean-pooled, no query prefix)
 * was removed: measured against our pipeline it scored short keyword queries
 * (e.g. a single word like "space") BELOW its own noise floor against a
 * genuinely relevant passage, i.e. worse than unrelated text - a real
 * semantic-search miss a user hit directly, not a tuning artifact. Symmetric,
 * un-prefixed, sub-30M models are not accurate enough for this product's
 * query shapes; every tier now uses the same well-behaved family instead of
 * trading correctness for a smaller download.
 *
 * Each model carries its OWN pooling (`mean` vs `cls`), query prefix, and
 * anisotropy `noiseFloor` here so the worker and the search filter read one
 * declarative source of truth. Getting any of these wrong per model silently
 * degrades that model (bge in particular MUST use CLS pooling - it is trained so
 * the [CLS] token carries the sentence meaning; mean-pooling it mushes the vector
 * and collapses the score separation), so they live beside the model, not in the
 * worker.
 */

export type EmbeddingTier = 'balanced' | 'accurate' | 'max';

export interface EmbeddingModelDef {
  /** Stable id persisted in config + as the chunk model-tag base. */
  id: string;
  tier: EmbeddingTier;
  /** transformers.js model id (the on-disk subdir under the cache). */
  hfId: string;
  /**
   * Quality label shown in the SELECTION dropdown ('Balanced' | 'Accurate' |
   * 'Best accuracy'). The concrete model name + size live in the status card,
   * not the dropdown.
   */
  tierLabel: string;
  /** Plain model name for the status card (the card appends the size). */
  displayName: string;
  dimensions: number;
  /** transformers.js dtype (q8 = the WASM default; ~4x smaller than fp32). */
  dtype: 'q8';
  /**
   * Sentence-pooling strategy the model was TRAINED for. `cls` uses the [CLS]
   * token's last hidden state (bge, gte-v1.5, mxbai-large); `mean` averages all
   * token states (mxbai-xsmall, MiniLM, original gte). Using the wrong one
   * silently degrades retrieval, so it is declared per model, never assumed.
   */
  pooling: 'mean' | 'cls';
  approxSizeMb: number;
  license: string;
  /**
   * Instruction prepended to QUERY text before embedding. Retrieval-tuned
   * models (bge/e5/gte) expect an asymmetric query instruction; symmetric
   * models (MiniLM, mxbai) use ''. Passages (documents) never get a prefix.
   */
  queryPrefix: string;
  /**
   * Cosine similarity that UNRELATED text pairs cluster around for this model.
   * These sentence encoders are anisotropic: gibberish does not score ~0, it
   * scores near this floor. The search filter rescales raw cosine against this
   * floor into a model-independent 0-1 relevance, so one relevance cutoff rejects
   * non-matches on every model.
   *
   * MEASURED against our actual pipeline (q8 quantization + asymmetric query
   * prefix + this model's pooling), NOT taken from the fp32/symmetric numbers on
   * the model card - those run much higher (BAAI documents bge at ~0.6) and made
   * the filter reject genuine matches. The floor sits a little above the observed
   * unrelated-pair p90 so that, with the cutoff, the survive-cosine clears even a
   * long, topically-mixed passage's inflated noise while genuine matches (~0.6+)
   * pass with margin. Re-measure empirically if a model or its pooling changes
   * (embed many mutually-unrelated query/passage pairs, take the p90 cosine);
   * tune here, not in the filter.
   */
  noiseFloor: number;
  /**
   * Persisted per chunk as `embedded_model`; a chunk is re-embedded whenever its
   * stored tag != this. So the tag must change whenever the STORED VECTOR would
   * change - not just on a model switch, but on any change to how the vector is
   * computed (pooling, dtype, prefix policy). The `@q8-cls` / `@q8` suffix
   * encodes that: bumping it is how we invalidate stale embeddings after a
   * pooling fix (`noiseFloor` is query-time only, so it never needs a bump).
   */
  modelTag: string;
  /** One-line tier blurb for the settings dropdown. */
  blurb: string;
}

// bge-* v1.5 retrieval query instruction (documented on the model cards).
const BGE_QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

// Best-first.
export const EMBEDDING_MODELS: EmbeddingModelDef[] = [
  {
    id: 'bge-large',
    tier: 'max',
    hfId: 'Xenova/bge-large-en-v1.5',
    tierLabel: 'Best accuracy',
    displayName: 'bge large',
    dimensions: 1024,
    dtype: 'q8',
    pooling: 'cls',
    approxSizeMb: 337,
    license: 'MIT',
    queryPrefix: BGE_QUERY_PREFIX,
    // Measured: unrelated-pair p90 ~0.39, genuine matches ~0.67-0.71 (q8, CLS, prefixed).
    noiseFloor: 0.42,
    modelTag: 'bge-large@q8-cls',
    blurb: 'Highest quality. Largest download and most storage (1024-dim vectors).',
  },
  {
    id: 'bge-base',
    tier: 'accurate',
    hfId: 'Xenova/bge-base-en-v1.5',
    tierLabel: 'Accurate',
    displayName: 'bge base',
    dimensions: 768,
    dtype: 'q8',
    pooling: 'cls',
    approxSizeMb: 110,
    license: 'MIT',
    queryPrefix: BGE_QUERY_PREFIX,
    // Measured: unrelated-pair p90 ~0.34, genuine matches ~0.66-0.76 (q8, CLS, prefixed).
    noiseFloor: 0.44,
    // `-cls` suffix: bge now CLS-pools (was mean); the bump re-embeds stale indexes.
    modelTag: 'bge-base@q8-cls',
    blurb: 'Strong quality. Balanced download and storage (768-dim vectors).',
  },
  {
    id: 'bge-small',
    tier: 'balanced',
    hfId: 'Xenova/bge-small-en-v1.5',
    tierLabel: 'Balanced',
    displayName: 'bge small',
    dimensions: 384,
    dtype: 'q8',
    pooling: 'cls',
    approxSizeMb: 34,
    license: 'MIT',
    queryPrefix: BGE_QUERY_PREFIX,
    // Measured: unrelated-pair p90 ~0.44 (bge-small is more anisotropic than base),
    // genuine matches ~0.73-0.80 (q8, CLS, prefixed).
    noiseFloor: 0.52,
    // `-cls` suffix: bge now CLS-pools (was mean); the bump re-embeds stale indexes.
    modelTag: 'bge-small@q8-cls',
    blurb: 'Smallest and fastest. Good for quick on-device recall.',
  },
];

export const DEFAULT_EMBEDDING_MODEL_ID = 'bge-base';

/** Resolve a config-selected model id to its definition, falling back to the
 *  default when the id is missing or unknown. */
export function resolveEmbeddingModel(id?: string | null): EmbeddingModelDef {
  const found = id ? EMBEDDING_MODELS.find((model) => model.id === id) : undefined;
  return found ?? EMBEDDING_MODELS.find((model) => model.id === DEFAULT_EMBEDDING_MODEL_ID)!;
}

/** transformers.js expects `<localModelPath>/<hfId>/{config,tokenizer,...}` and
 *  `<hfId>/onnx/model_quantized.onnx` for dtype q8. Paths are relative to the
 *  embeddings cache dir and include the model id. */
export function embeddingModelFiles(model: EmbeddingModelDef): Array<{ url: string; file: string }> {
  const base = `https://huggingface.co/${model.hfId}/resolve/main`;
  const names = [
    'config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'special_tokens_map.json',
    'onnx/model_quantized.onnx',
  ];
  return names.map((name) => ({ url: `${base}/${name}`, file: `${model.hfId}/${name}` }));
}
