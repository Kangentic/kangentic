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

/**
 * The background drain's utilization ceiling: the embed worker infers for at
 * most this fraction of wall-time, sleeping proportionally between batches
 * (see computeEmbedSleepMs in embed-engine.ts). This is a machine-independent
 * AVERAGE ceiling, not a wall-clock target - because the pacer measures each
 * batch's real wall-time, it self-adapts to any backend/model with no
 * per-device tuning table. A large first-run or model-switch backfill is
 * therefore paced too, never pegged; it simply takes longer on slower
 * hardware while holding the same ~20% average.
 */
export const EMBED_DUTY_CYCLE = 0.2;

/** Chunks per background drain batch. Deliberately at or below
 *  EMBEDDING_MAX_BATCH so each burst (the instantaneous spike, as opposed to
 *  the time-averaged duty cycle) stays brief and a live interactive query
 *  never waits behind more than one short in-flight background batch. */
export const EMBED_DRAIN_BATCH = 8;
