import { describe, expect, it } from 'vitest';
import { migrateLegacyMemoryKeys } from '../../src/main/config/legacy-memory-keys';

/** The merged copy config-manager holds: the new block at its defaults, plus
 *  whatever the file carried under the retired name. */
function mergedWith(parsed: Record<string, unknown>): Record<string, unknown> {
  return {
    knowledgeGraph: { indexingEnabled: true, enabled: false, localModel: 'bge-base', acceleration: 'auto' },
    ...parsed,
  };
}

describe('migrateLegacyMemoryKeys', () => {
  it('leaves a config with no retired block alone', () => {
    const parsed = { knowledgeGraph: { enabled: true } };
    const config = mergedWith(parsed);
    expect(migrateLegacyMemoryKeys(config, parsed)).toBe(false);
    expect(config).toEqual(mergedWith(parsed));
  });

  it('carries the four shipped keys, under the names of their Settings rows', () => {
    // A v0.43.2 install that switched semantic search on and picked the large model.
    const parsed = { memory: { indexingEnabled: false, semanticEnabled: true, embeddingModel: 'bge-large', acceleration: 'cpu' } };
    const config = mergedWith(parsed);
    expect(migrateLegacyMemoryKeys(config, parsed)).toBe(true);
    expect(config).toEqual({
      knowledgeGraph: { indexingEnabled: false, enabled: true, localModel: 'bge-large', acceleration: 'cpu' },
    });
  });

  it('keeps the defaults for a key the retired block never set', () => {
    const parsed = { memory: { semanticEnabled: true } };
    const config = mergedWith(parsed);
    migrateLegacyMemoryKeys(config, parsed);
    expect(config.knowledgeGraph).toEqual({ indexingEnabled: true, enabled: true, localModel: 'bge-base', acceleration: 'auto' });
  });

  it('lets a key the file already sets under its new name win', () => {
    const parsed = { memory: { semanticEnabled: true }, knowledgeGraph: { enabled: false } };
    const config = mergedWith(parsed);
    config.knowledgeGraph = { indexingEnabled: true, enabled: false, localModel: 'bge-base', acceleration: 'auto' };
    migrateLegacyMemoryKeys(config, parsed);
    expect((config.knowledgeGraph as Record<string, unknown>).enabled).toBe(false);
    expect('memory' in config).toBe(false);
  });

  it('drops a retired block that is not an object', () => {
    const parsed = { memory: null };
    const config = mergedWith(parsed);
    expect(migrateLegacyMemoryKeys(config, parsed)).toBe(true);
    expect('memory' in config).toBe(false);
  });
});
