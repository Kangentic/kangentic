import { describe, it, expect } from 'vitest';
import {
  EMBEDDING_MODELS,
  DEFAULT_EMBEDDING_MODEL_ID,
  resolveEmbeddingModel,
  embeddingModelFiles,
} from '../../src/shared/embedding-models';

/**
 * Locks the embedding-model registry that drives the settings dropdown and the
 * engine. A malformed entry (bad url, missing file, duplicate tag) would only
 * surface at download/inference time, so assert the shape statically.
 */
describe('embedding-models registry', () => {
  it('every model is well-formed', () => {
    for (const model of EMBEDDING_MODELS) {
      expect(model.id).toBeTruthy();
      expect(model.hfId).toContain('/');
      expect(model.displayName).toBeTruthy();
      expect(model.dimensions).toBeGreaterThan(0);
      expect(model.approxSizeMb).toBeGreaterThan(0);
      expect(model.dtype).toBe('q8');
      expect(['mean', 'cls']).toContain(model.pooling);
      // The anisotropy floor calibrates relevance filtering; it must be a real
      // cosine in [0, 1) or the filter divides by <= 0 and disables itself.
      expect(model.noiseFloor).toBeGreaterThanOrEqual(0);
      expect(model.noiseFloor).toBeLessThan(1);
      expect(model.license).toBeTruthy();
      expect(model.modelTag).toBeTruthy();
      expect(['balanced', 'accurate', 'max']).toContain(model.tier);
      // Dropdown label; the model name is carried separately for the status
      // card, not baked into the label.
      expect(['Balanced', 'Accurate', 'Best accuracy']).toContain(model.tierLabel);
      expect(model.tierLabel).not.toContain(model.displayName);
    }
  });

  it('is ordered best-first', () => {
    expect(EMBEDDING_MODELS.map((model) => model.tierLabel)).toEqual([
      'Best accuracy',
      'Accurate',
      'Balanced',
    ]);
  });

  it('ids and model tags are unique', () => {
    const ids = EMBEDDING_MODELS.map((model) => model.id);
    const tags = EMBEDDING_MODELS.map((model) => model.modelTag);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(tags).size).toBe(tags.length);
  });

  it('covers all three tiers exactly once', () => {
    const tiers = EMBEDDING_MODELS.map((model) => model.tier).sort();
    expect(tiers).toEqual(['accurate', 'balanced', 'max']);
  });

  it('every model is CLS-pooled with a retrieval query prefix (the bge family)', () => {
    // The load-bearing invariant this registry exists to hold: bge was trained
    // for CLS pooling and a retrieval query instruction (mean-pooling it or
    // dropping the prefix silently collapses its score separation). All three
    // tiers are now bge-*-en-v1.5, so this must hold for every entry, not just
    // pinned ids - a prior symmetric mean-pooled tier (mxbai) was removed after
    // it scored a real short keyword query below its own noise floor.
    for (const model of EMBEDDING_MODELS) {
      expect(model.pooling).toBe('cls');
      expect(model.queryPrefix).toBeTruthy();
    }
  });

  it('the default id resolves to a real model', () => {
    const found = EMBEDDING_MODELS.find((model) => model.id === DEFAULT_EMBEDDING_MODEL_ID);
    expect(found).toBeDefined();
  });

  it('resolveEmbeddingModel falls back to the default for missing/unknown ids', () => {
    expect(resolveEmbeddingModel(undefined).id).toBe(DEFAULT_EMBEDDING_MODEL_ID);
    expect(resolveEmbeddingModel(null).id).toBe(DEFAULT_EMBEDDING_MODEL_ID);
    expect(resolveEmbeddingModel('does-not-exist').id).toBe(DEFAULT_EMBEDDING_MODEL_ID);
    expect(resolveEmbeddingModel('bge-base').id).toBe('bge-base');
  });

  it('embeddingModelFiles yields the 5 model files under the model id', () => {
    for (const model of EMBEDDING_MODELS) {
      const files = embeddingModelFiles(model);
      expect(files).toHaveLength(5);
      for (const spec of files) {
        expect(spec.url.startsWith(`https://huggingface.co/${model.hfId}/resolve/main/`)).toBe(true);
        expect(spec.file.startsWith(`${model.hfId}/`)).toBe(true);
      }
      expect(files.some((spec) => spec.file.endsWith('onnx/model_quantized.onnx'))).toBe(true);
      expect(files.some((spec) => spec.file.endsWith('tokenizer.json'))).toBe(true);
    }
  });
});
