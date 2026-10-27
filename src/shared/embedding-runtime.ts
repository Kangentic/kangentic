/**
 * Where the Knowledge Graph's local embedding model can run.
 *
 * The model runs on onnxruntime-node, which `@huggingface/transformers` pins to
 * an exact version and requires at module scope. onnxruntime-node ships one
 * native binding per platform and arch, and from 1.30.0 it ships none for
 * Intel macOS (darwin x64). There the embed worker would exit on every fork,
 * before it could report anything, so the Knowledge Graph reports itself
 * unavailable instead: main never builds an embed client or downloads the
 * model, and Settings and the Knowledge Graph page say why. Keyword search
 * (the index, Quick Find, `kangentic_search`) loads no model and keeps working.
 *
 * The list lives in `embedding-runtime-gaps.json` because `build/afterPack.js`,
 * plain CommonJS, reads it too: it skips the packaged embed worker probe only
 * for a target listed there, and fails a target that is not listed but has no
 * binding. `tests/unit/embedding-runtime.test.ts` checks the list against the
 * bindings the installed onnxruntime-node actually ships, so a bump that adds
 * or drops a target fails there.
 */

import { msg } from '@lingui/core/runtime-macro';
import EMBEDDING_RUNTIME_GAPS from './embedding-runtime-gaps.json';
import type { LocalizedText } from './i18n/text';

/** `<platform>-<arch>` pairs, in Node's `process.platform` / `process.arch` names. */
export const EMBEDDING_RUNTIME_GAP_TARGETS: readonly string[] = EMBEDDING_RUNTIME_GAPS;

/**
 * Whether the local embedding model can load on this platform and arch, in
 * Node's `process.platform` / `process.arch` names.
 */
export function isEmbeddingRuntimeSupported(platform: string, arch: string): boolean {
  return !EMBEDDING_RUNTIME_GAP_TARGETS.includes(`${platform}-${arch}`);
}

/** The machines a gap target names, for the sentence that says the model does
 *  not run there ("The local model does not run on Intel Macs."). A known gap
 *  is a message to resolve where it shows; any other is its platform and arch. */
export function embeddingRuntimeGapName(platform: string, arch: string): LocalizedText {
  if (platform === 'darwin' && arch === 'x64') return msg`Intel Macs`;
  return `${platform} ${arch}`;
}
