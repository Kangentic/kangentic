/**
 * One-time read of the retired `memory` settings block.
 *
 * The conversation index shipped with its settings under `memory`. They moved
 * to `knowledgeGraph` when the Knowledge Graph was named, and two took the
 * names of their Settings rows: `semanticEnabled` is the Knowledge Graph's own
 * switch (`enabled`) and `embeddingModel` is its local model (`localModel`).
 * Only these four keys ever shipped under `memory`, so only they are carried.
 *
 * Runs on the global config, where these settings live. `parsed` is the file
 * as read, since the merged copy already carries the new block's defaults: a
 * key the file already sets under its new name wins over the retired one.
 */

const RETIRED_TO_CURRENT = [
  ['indexingEnabled', 'indexingEnabled'],
  ['semanticEnabled', 'enabled'],
  ['embeddingModel', 'localModel'],
  ['acceleration', 'acceleration'],
] as const;

/**
 * Move the retired `memory` block onto `knowledgeGraph` in `config`, in place.
 * Returns whether anything changed, so the caller knows to persist the result.
 */
export function migrateLegacyMemoryKeys(
  config: Record<string, unknown>,
  parsed: Record<string, unknown>,
): boolean {
  const retired = parsed.memory;
  if (retired === null || typeof retired !== 'object' || Array.isArray(retired)) {
    if (!('memory' in config)) return false;
    delete config.memory;
    return true;
  }
  const retiredKeys = retired as Record<string, unknown>;
  const explicitCurrent = parsed.knowledgeGraph !== null && typeof parsed.knowledgeGraph === 'object'
    ? parsed.knowledgeGraph as Record<string, unknown>
    : {};
  const current: Record<string, unknown> = {
    ...(config.knowledgeGraph as Record<string, unknown> | undefined),
  };
  for (const [retiredKey, currentKey] of RETIRED_TO_CURRENT) {
    if (retiredKey in retiredKeys && !(currentKey in explicitCurrent)) {
      current[currentKey] = retiredKeys[retiredKey];
    }
  }
  config.knowledgeGraph = current;
  delete config.memory;
  return true;
}
