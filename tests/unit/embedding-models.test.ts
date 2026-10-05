import { describe, it, expect } from 'vitest';
import {
  EMBEDDING_MODELS,
  DEFAULT_EMBEDDING_MODEL_ID,
  resolveEmbeddingModel,
  embeddingModelFiles,
} from '../../src/shared/embedding-models';
import { MODEL_LICENSES } from '../../src/shared/model-licenses';

/**
 * Locks the embedding-model registry that drives the Search quality control and
 * the engine. A malformed entry (bad url, missing file, duplicate tag) would only
 * surface at download/inference time, so assert the shape statically.
 */
describe('embedding-models registry', () => {
  it('every model is well-formed', () => {
    for (const model of EMBEDDING_MODELS) {
      expect(model.id).toBeTruthy();
      expect(model.hfId).toContain('/');
      expect(model.revision).toMatch(/^(main|[0-9a-f]{40})$/);
      expect(model.displayName).toBeTruthy();
      expect(model.dimensions).toBeGreaterThan(0);
      expect(model.approxSizeMb).toBeGreaterThan(0);
      expect(model.dtype).toBe('q8');
      expect(['mean', 'cls']).toContain(model.pooling);
      // The anisotropy floor calibrates relevance filtering; it must be a real
      // cosine in [0, 1) or the filter divides by <= 0 and disables itself.
      expect(model.noiseFloor).toBeGreaterThanOrEqual(0);
      expect(model.noiseFloor).toBeLessThan(1);
      expect(MODEL_LICENSES[model.license]).toBeDefined();
      expect(model.modelTag).toBeTruthy();
      expect(['best', 'light']).toContain(model.tier);
      // The control's label; the model name is carried separately for the
      // status row, not baked into the label.
      expect(['Best', 'Light']).toContain(model.tierLabel);
      expect(model.tierLabel).not.toContain(model.displayName);
    }
  });

  it('is ordered best-first', () => {
    expect(EMBEDDING_MODELS.map((model) => model.tierLabel)).toEqual(['Best', 'Light']);
  });

  it('ids and model tags are unique', () => {
    const ids = EMBEDDING_MODELS.map((model) => model.id);
    const tags = EMBEDDING_MODELS.map((model) => model.modelTag);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(tags).size).toBe(tags.length);
  });

  it('covers each tier exactly once', () => {
    const tiers = EMBEDDING_MODELS.map((model) => model.tier).sort();
    expect(tiers).toEqual(['best', 'light']);
  });

  it('every model is CLS-pooled, with the query prefix its family was trained for', () => {
    // bge was trained for CLS pooling and a retrieval query instruction, and
    // Granite R2 for CLS pooling with none (its 1_Pooling config). Mean-pooling
    // either, or adding or dropping a prefix, silently collapses its score
    // separation. A prior symmetric mean-pooled tier (mxbai) was removed after
    // it scored a real short keyword query below its own noise floor.
    for (const model of EMBEDDING_MODELS) {
      expect(model.pooling).toBe('cls');
      expect(model.queryPrefix === '' || model.queryPrefix.endsWith(': ')).toBe(true);
    }
    expect(resolveEmbeddingModel('bge-small').queryPrefix).toBeTruthy();
    expect(resolveEmbeddingModel('granite-r2').queryPrefix).toBe('');
  });

  it('the default id resolves to a real model', () => {
    const found = EMBEDDING_MODELS.find((model) => model.id === DEFAULT_EMBEDDING_MODEL_ID);
    expect(found).toBeDefined();
  });

  it('resolveEmbeddingModel falls back to the default for missing, unknown and retired ids', () => {
    expect(resolveEmbeddingModel(undefined).id).toBe(DEFAULT_EMBEDDING_MODEL_ID);
    expect(resolveEmbeddingModel(null).id).toBe(DEFAULT_EMBEDDING_MODEL_ID);
    expect(resolveEmbeddingModel('does-not-exist').id).toBe(DEFAULT_EMBEDDING_MODEL_ID);
    // bge-base and bge-large left the registry; a config that saved one runs the default.
    expect(resolveEmbeddingModel('bge-base').id).toBe(DEFAULT_EMBEDDING_MODEL_ID);
    expect(resolveEmbeddingModel('bge-large').id).toBe(DEFAULT_EMBEDDING_MODEL_ID);
    expect(resolveEmbeddingModel('bge-small').id).toBe('bge-small');
  });

  it('embeddingModelFiles yields the model files at the pinned revision, under the model id', () => {
    for (const model of EMBEDDING_MODELS) {
      const files = embeddingModelFiles(model);
      expect(files).toHaveLength(model.externalData ? 6 : 5);
      for (const spec of files) {
        expect(spec.url.startsWith(`https://huggingface.co/${model.hfId}/resolve/${model.revision}/`)).toBe(true);
        expect(spec.file.startsWith(`${model.hfId}/`)).toBe(true);
      }
      expect(files.some((spec) => spec.file.endsWith('onnx/model_quantized.onnx'))).toBe(true);
      expect(files.some((spec) => spec.file.endsWith('tokenizer.json'))).toBe(true);
    }
  });

  // transformers.js reads the weights of an external-data graph from a
  // `.onnx_data` file beside it and refuses to load without it; with remote
  // models off, nothing else would fetch it.
  it('downloads the external weights file beside an external-data graph', () => {
    const granite = embeddingModelFiles(resolveEmbeddingModel('granite-r2'));
    expect(granite.map((spec) => spec.file)).toContain('onnx-community/granite-embedding-english-r2-ONNX/onnx/model_quantized.onnx_data');
    const bge = embeddingModelFiles(resolveEmbeddingModel('bge-small'));
    expect(bge.some((spec) => spec.file.endsWith('.onnx_data'))).toBe(false);
  });
});
