import type { ModelLicenseId } from './model-licenses';

/**
 * Registry of local embedding models for conversation memory. Mirrors the
 * dictation model-registry pattern (a small curated, tiered set of offline
 * models the user picks from in settings). Lives in `shared/` so the renderer's
 * settings control and the main-process engine read one source of truth.
 *
 * All models are ONNX (q8) sentence encoders that run keyless + offline via
 * transformers.js (onnxruntime); files are fetched once by our own downloader
 * into the persistent model cache. Two tiers, each the model that measured best
 * at its size (`node scripts/measure-embedding-models.mjs`, 2026-10-05, this
 * repository's docs and code through the worker's exact pipeline):
 *   best  - IBM granite-embedding-english-r2 (149M, 768d, ModernBERT, CLS, no
 *           query prefix). MRR@10 0.550 on docs, 0.739 on code by description,
 *           0.926 on code by name, against 0.454 / 0.510 / 0.577 for bge-large.
 *   light - bge-small-en-v1.5 (34M, 384d). 0.450 / 0.709 / 0.873.
 *
 * bge-base and bge-large left the registry in that refresh: as the q8 builds
 * we run, both measured below bge-small on code and below Granite on
 * everything, so neither made an honest middle tier. A saved id for either
 * falls back to the default (`resolveEmbeddingModel`).
 *
 * A one-word query must still find a passage about it. A prior 'fast' tier
 * (mxbai-embed-xsmall-v1) was removed for scoring "space" BELOW its own noise
 * floor against a genuinely relevant passage, i.e. worse than unrelated text.
 * The measure script runs that check on every model: Granite R2 passes it best
 * of all (the disk-space passage ranks 1st of 400), and granite-embedding-small
 * -english-r2 fails it the same way (the Space-key passage below its floor,
 * ranked 212th), so it is not offered despite its retrieval scores.
 *
 * Each model carries its OWN pooling (`mean` vs `cls`), query prefix, and
 * anisotropy `noiseFloor` here so the worker and the search filter read one
 * declarative source of truth. Getting any of these wrong per model silently
 * degrades that model (bge in particular MUST use CLS pooling - it is trained so
 * the [CLS] token carries the sentence meaning; mean-pooling it mushes the vector
 * and collapses the score separation), so they live beside the model, not in the
 * worker.
 */

export type EmbeddingTier = 'best' | 'light';

export interface EmbeddingModelDef {
  /** Stable id persisted in config + as the chunk model-tag base. */
  id: string;
  tier: EmbeddingTier;
  /** transformers.js model id (the on-disk subdir under the cache). */
  hfId: string;
  /** The Hugging Face commit the files download from. The downloader skips a
   *  file already on disk, so a re-upload under the same id would never reach an
   *  installed user; a pin makes what ships what downloads. */
  revision: string;
  /**
   * The Search quality control's label ('Best' | 'Light'), the same words
   * dictation's Mode uses. The concrete model name + size live in the status
   * row, not the control.
   */
  tierLabel: string;
  /** Plain model name for the status row (the row appends the size). */
  displayName: string;
  dimensions: number;
  /** transformers.js dtype (q8 = the WASM default; ~4x smaller than fp32). */
  dtype: 'q8';
  /**
   * The ONNX graph keeps its weights in a separate `.onnx_data` file beside it.
   * Mirrors `use_external_data_format` in the repo's config.json, which tells
   * transformers.js to load it; the downloader must fetch it too.
   */
  externalData: boolean;
  /**
   * Sentence-pooling strategy the model was TRAINED for. `cls` uses the [CLS]
   * token's last hidden state (bge, gte-v1.5, Granite R2); `mean` averages all
   * token states (MiniLM, original gte). Using the wrong one silently degrades
   * retrieval, so it is declared per model, never assumed. Read it from the
   * model's `1_Pooling/config.json`, not the ONNX config, whose
   * `classifier_pooling` is for a classification head.
   */
  pooling: 'mean' | 'cls';
  /** Total download size in MiB, summed from the Hugging Face file listing. */
  approxSizeMb: number;
  license: ModelLicenseId;
  /**
   * Instruction prepended to QUERY text before embedding. bge expects an
   * asymmetric query instruction; Granite R2 and other symmetric models use ''.
   * Passages (documents) never get a prefix.
   */
  queryPrefix: string;
  /**
   * Cosine similarity that UNRELATED text pairs cluster around for this model.
   * These sentence encoders are anisotropic: gibberish does not score ~0, it
   * scores near this floor. The search filter rescales raw cosine against this
   * floor into a model-independent 0-1 relevance, so one relevance cutoff rejects
   * non-matches on every model.
   *
   * MEASURED against our actual pipeline (q8 quantization + the model's prefix
   * policy + its pooling), NOT taken from the model card. Re-measure when a model
   * or its pooling changes with `node scripts/measure-embedding-models.mjs`. Its
   * corpus is one repository, so its unrelated pairs run hotter than fully
   * unrelated text and an absolute p90 does not carry across models; instead a
   * new model gets the floor that keeps the same share of unrelated pairs at the
   * search cutoff as the shipped models keep at theirs (the script prints it as
   * "calibrated"), and genuine-kept shares are then comparable. Tune here, not in
   * the filter.
   */
  noiseFloor: number;
  /**
   * Persisted per chunk as `embedded_model`; a chunk is re-embedded whenever its
   * stored tag != this. So the tag must change whenever the STORED VECTOR would
   * change - not just on a model switch, but on any change to how the vector is
   * computed (pooling, dtype, prefix policy). The `@q8-cls` / `@q8` suffix
   * encodes that: bumping it is how we invalidate stale embeddings after a
   * pooling fix (`noiseFloor` is query-time only, so it never needs a bump).
   * A tag change also resets the project's vector table, so two models'
   * vectors never share it (`syncVecTable`).
   */
  modelTag: string;
  /** One-line tier blurb. */
  blurb: string;
}

// bge-* v1.5 retrieval query instruction (documented on the model cards).
const BGE_QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

// Best-first.
export const EMBEDDING_MODELS: EmbeddingModelDef[] = [
  {
    id: 'granite-r2',
    tier: 'best',
    hfId: 'onnx-community/granite-embedding-english-r2-ONNX',
    revision: '2a49b9c076aa627b14bc528b36b67462808ccc23',
    tierLabel: 'Best',
    displayName: 'Granite English R2',
    dimensions: 768,
    dtype: 'q8',
    externalData: true,
    pooling: 'cls',
    approxSizeMb: 153,
    license: 'Apache-2.0',
    queryPrefix: '',
    // Measured: calibrated floor 0.658 keeps 12.3% of unrelated pairs and 87.8% of
    // genuine ones (bge-small at its 0.52: 13.7% and 79.0%).
    noiseFloor: 0.66,
    modelTag: 'granite-r2@q8-cls',
    blurb: 'Most accurate, on prose and on code. 768-dim vectors.',
  },
  {
    id: 'bge-small',
    tier: 'light',
    hfId: 'Xenova/bge-small-en-v1.5',
    revision: 'main',
    tierLabel: 'Light',
    displayName: 'bge small',
    dimensions: 384,
    dtype: 'q8',
    externalData: false,
    pooling: 'cls',
    approxSizeMb: 33,
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

export const DEFAULT_EMBEDDING_MODEL_ID = 'granite-r2';

/** Resolve a config-selected model id to its definition, falling back to the
 *  default when the id is missing or unknown (bge-base and bge-large included). */
export function resolveEmbeddingModel(id?: string | null): EmbeddingModelDef {
  const found = id ? EMBEDDING_MODELS.find((model) => model.id === id) : undefined;
  return found ?? EMBEDDING_MODELS.find((model) => model.id === DEFAULT_EMBEDDING_MODEL_ID)!;
}

/** transformers.js expects `<localModelPath>/<hfId>/{config,tokenizer,...}` and
 *  `<hfId>/onnx/model_quantized.onnx` for dtype q8, plus `model_quantized.onnx_data`
 *  beside it for an external-data model. Paths are relative to the embeddings
 *  cache dir and include the model id. */
export function embeddingModelFiles(model: EmbeddingModelDef): Array<{ url: string; file: string }> {
  const base = `https://huggingface.co/${model.hfId}/resolve/${model.revision}`;
  const names = [
    'config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'special_tokens_map.json',
    'onnx/model_quantized.onnx',
    ...(model.externalData ? ['onnx/model_quantized.onnx_data'] : []),
  ];
  return names.map((name) => ({ url: `${base}/${name}`, file: `${model.hfId}/${name}` }));
}
