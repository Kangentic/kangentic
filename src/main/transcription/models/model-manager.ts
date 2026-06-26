import * as fs from 'node:fs';
import * as path from 'node:path';
import { PATHS } from '../../config/paths';
import { MODELS, getModel, type ModelDef } from './model-registry';
import { downloadModelFiles, type DownloadProgress } from './download-model';

export interface ResolvedModelPaths {
  modelId: string;
  /** The native engine shape this model drives (for hybrid routing). */
  kind: ModelDef['engineKind'];
  dir: string;
  /** sherpa-onnx config role -> absolute file path. */
  paths: Record<string, string>;
}

/** True when every file of the model is present on disk. */
export function isModelInstalled(model: ModelDef): boolean {
  const dir = PATHS.modelDir(model.id);
  return model.files.every((fileSpec) => fs.existsSync(path.join(dir, fileSpec.file)));
}

/** Resolve a model's role -> absolute path map (does not check existence). */
export function resolveModelPaths(model: ModelDef): ResolvedModelPaths {
  const dir = PATHS.modelDir(model.id);
  const paths: Record<string, string> = {};
  for (const [role, filename] of Object.entries(model.roles)) {
    paths[role] = path.join(dir, filename);
  }
  return { modelId: model.id, kind: model.engineKind, dir, paths };
}

/** Download the model if needed, then resolve its on-disk paths. */
export async function ensureModel(
  model: ModelDef,
  onProgress: (progress: DownloadProgress) => void,
): Promise<ResolvedModelPaths> {
  if (!isModelInstalled(model)) {
    await downloadModelFiles(model, PATHS.modelDir(model.id), onProgress);
  }
  return resolveModelPaths(model);
}

/** Ids of every registered model currently installed on disk. */
export function listInstalledModels(): string[] {
  return MODELS.filter((model) => isModelInstalled(model)).map((model) => model.id);
}

/** Remove a downloaded model's files from disk. */
export function deleteModel(modelId: string): void {
  const model = getModel(modelId);
  if (!model) return;
  fs.rmSync(PATHS.modelDir(modelId), { recursive: true, force: true });
}
