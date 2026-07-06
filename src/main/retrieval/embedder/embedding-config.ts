/**
 * Main-process embedding constants + a re-export of the shared model registry.
 * The registry itself lives in `src/shared/embedding-models.ts` so the renderer
 * settings dropdown and this engine read one source of truth.
 */

export {
  EMBEDDING_MODELS,
  DEFAULT_EMBEDDING_MODEL_ID,
  resolveEmbeddingModel,
  embeddingModelFiles,
  type EmbeddingModelDef,
  type EmbeddingTier,
} from '../../../shared/embedding-models';

export const EMBEDDING_MAX_BATCH = 16;
