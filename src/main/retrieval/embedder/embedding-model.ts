import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../../config/paths';
import { downloadModelFiles, type DownloadProgress } from '../../transcription/models/download-model';
import { embeddingModelFiles, type EmbeddingModelDef } from './embedding-config';

/**
 * Local embedding model presence + download, reusing the dictation model
 * downloader (resumable `.part`, atomic rename, Windows EPERM cleanup, nested
 * dir creation). Each tier's model is fetched once into the persistent model
 * cache and never re-downloaded across data-dir isolation. Keyless: files come
 * straight from the HF resolve URLs, no token, and transformers.js itself is
 * pinned offline.
 */

export function isEmbeddingModelPresent(model: EmbeddingModelDef): boolean {
  try {
    return embeddingModelFiles(model).every((spec) =>
      fs.existsSync(path.join(PATHS.embeddingModelsDir, spec.file)),
    );
  } catch {
    return false;
  }
}

export async function downloadEmbeddingModel(
  model: EmbeddingModelDef,
  onProgress: (progress: DownloadProgress) => void,
): Promise<void> {
  await downloadModelFiles(
    { files: embeddingModelFiles(model), approxSizeMb: model.approxSizeMb },
    PATHS.embeddingModelsDir,
    onProgress,
  );
}
