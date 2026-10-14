import { isEmbeddingRuntimeSupported } from '../../../shared/embedding-runtime';

/**
 * Whether this process can load the local embedding model
 * (`src/shared/embedding-runtime.ts`). Every main-side gate on
 * `knowledgeGraph.enabled` that leads to the model (the embed engine, the model
 * download, the task summaries, the source code sweep) reads this beside the
 * config, so a config carrying `enabled: true` on Intel macOS still never forks
 * an embed worker that cannot load. A function rather than a constant, so a
 * test can stand in another platform.
 */
export function isLocalEmbeddingSupported(): boolean {
  return isEmbeddingRuntimeSupported(process.platform, process.arch);
}
