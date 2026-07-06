/**
 * Registry of local embedding models for conversation memory. Mirrors the
 * dictation model-registry pattern (a small curated, tiered set of offline
 * models the user picks from in settings). Lives in `shared/` so the renderer's
 * settings dropdown and the main-process engine read one source of truth.
 *
 * All models are ONNX (q8) sentence encoders that run keyless + offline via
 * transformers.js WASM; files are fetched once by our own downloader into the
 * persistent model cache. Selection is by MTEB-informed tier:
 *   fast     - mxbai-embed-xsmall-v1 (24M, 384d): modern, tiny, no query prefix.
 *   balanced - bge-small-en-v1.5 (33M, 384d): stronger retrieval, same dims.
 *   accurate - bge-base-en-v1.5 (109M, 768d): best quality, larger + 768 dims.
 */

export type EmbeddingTier = 'fast' | 'balanced' | 'accurate';

export interface EmbeddingModelDef {
  /** Stable id persisted in config + as the chunk model-tag base. */
  id: string;
  tier: EmbeddingTier;
  /** transformers.js model id (the on-disk subdir under the cache). */
  hfId: string;
  /**
   * Quality label shown in the SELECTION dropdown, using the same vocabulary as
   * the dictation Mode dropdown ('Best accuracy' | 'Balanced' | 'Fastest'). The
   * concrete model name + size live in the status card, not the dropdown.
   */
  tierLabel: string;
  /** Plain model name for the status card (the card appends the size). */
  displayName: string;
  dimensions: number;
  /** transformers.js dtype (q8 = the WASM default; ~4x smaller than fp32). */
  dtype: 'q8';
  approxSizeMb: number;
  license: string;
  /**
   * Instruction prepended to QUERY text before embedding. Retrieval-tuned
   * models (bge/e5/gte) expect an asymmetric query instruction; symmetric
   * models (MiniLM, mxbai) use ''. Passages (documents) never get a prefix.
   */
  queryPrefix: string;
  /** Persisted per chunk; changing it (model switch) triggers a re-embed. */
  modelTag: string;
  /** One-line tier blurb for the settings dropdown. */
  blurb: string;
}

// bge-* v1.5 retrieval query instruction (documented on the model cards).
const BGE_QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

// Best-first, matching the dictation Mode dropdown's ordering.
export const EMBEDDING_MODELS: EmbeddingModelDef[] = [
  {
    id: 'bge-base',
    tier: 'accurate',
    hfId: 'Xenova/bge-base-en-v1.5',
    tierLabel: 'Best accuracy',
    displayName: 'bge base',
    dimensions: 768,
    dtype: 'q8',
    approxSizeMb: 110,
    license: 'MIT',
    queryPrefix: BGE_QUERY_PREFIX,
    modelTag: 'bge-base@q8',
    blurb: 'Best quality. Larger download and more storage (768-dim vectors).',
  },
  {
    id: 'bge-small',
    tier: 'balanced',
    hfId: 'Xenova/bge-small-en-v1.5',
    tierLabel: 'Balanced',
    displayName: 'bge small',
    dimensions: 384,
    dtype: 'q8',
    approxSizeMb: 34,
    license: 'MIT',
    queryPrefix: BGE_QUERY_PREFIX,
    modelTag: 'bge-small@q8',
    blurb: 'Stronger retrieval quality at nearly the same size and dimensions.',
  },
  {
    id: 'mxbai-xsmall',
    tier: 'fast',
    hfId: 'mixedbread-ai/mxbai-embed-xsmall-v1',
    tierLabel: 'Fastest',
    displayName: 'mxbai xsmall',
    dimensions: 384,
    dtype: 'q8',
    approxSizeMb: 24,
    license: 'Apache-2.0',
    queryPrefix: '',
    modelTag: 'mxbai-xsmall@q8',
    blurb: 'Smallest and fastest. Good for quick on-device recall.',
  },
];

export const DEFAULT_EMBEDDING_MODEL_ID = 'mxbai-xsmall';

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
