/**
 * Embedding worker - runs in an Electron utilityProcess child, isolated from the
 * main process so transformers.js inference never blocks the main event loop
 * (which owns better-sqlite3, the PTYs, and IPC).
 *
 * It is a deliberately dumb translation layer: init the pipeline once, then map
 * each `embed` request to a normalized feature-extraction pass (with the model's
 * declared pooling) and post the resulting Float32Array rows back. All
 * backend/offline policy is
 * pinned here (the execution-provider chain from the init message, explicit
 * dtype, allowRemoteModels false, a local model path) so dev and packaged builds
 * run identically. The backend is native onnxruntime-node (transformers.js v4
 * removed the browser 'wasm' backend in Node); see embed-client for the
 * dml / webgpu / cpu device chain.
 *
 * This file is bundled by esbuild as its own entry (`.vite/build/embed-worker.js`)
 * with `@huggingface/transformers` external, and asarUnpacked so the model and
 * native onnxruntime-node runtime files resolve to real on-disk paths.
 */

import {
  env,
  pipeline,
  type DataType,
  type DeviceType,
  type FeatureExtractionPipeline,
} from '@huggingface/transformers';

interface InitMessage {
  type: 'init';
  modelId: string;
  modelDir: string;
  wasmDir: string;
  dtype: string;
  /** Sentence pooling the model was trained for ('mean' | 'cls'). */
  pooling: string;
  /** Prepended to query texts (retrieval-tuned models); '' for symmetric models. */
  queryPrefix: string;
  /** Execution providers to try in order, most-preferred first (e.g.
   *  ['dml','cpu']). The first that initializes wins; the rest are the fallback. */
  devices: string[];
}
interface EmbedMessage {
  type: 'embed';
  id: number;
  texts: string[];
  /** When true, prepend the model's query prefix to each text. */
  isQuery: boolean;
}
interface ShutdownMessage {
  type: 'shutdown';
}
type IncomingMessage = InitMessage | EmbedMessage | ShutdownMessage;

const parentPort = process.parentPort;

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;
let queryPrefix = '';
/** Pooling the active model was trained for; set from the init message. */
let pooling: 'mean' | 'cls' = 'mean';

function post(message: unknown): void {
  parentPort.postMessage(message);
}

async function initExtractor(
  message: InitMessage,
): Promise<{ extractor: FeatureExtractionPipeline; device: string }> {
  // Fully offline: models come from our own download into modelDir, never the HF
  // hub or a CDN.
  env.allowRemoteModels = false;
  env.localModelPath = message.modelDir;
  if (env.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.wasmPaths = message.wasmDir;
  }

  // Try each execution provider in order (GPU first when requested, CPU last),
  // using the first that initializes. transformers.js v4's Node build accepts
  // dml/webgpu/cpu (the WASM backend is browser-only now), and a GPU provider
  // that is unavailable on this machine throws here, so we fall through to the
  // next. dtype is pinned for reproducibility across dev and packaged builds.
  let lastError: unknown = null;
  for (const device of message.devices) {
    try {
      const extractor = await pipeline('feature-extraction', message.modelId, {
        device: device as DeviceType,
        dtype: message.dtype as DataType,
      });
      return { extractor, device };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('no embedding execution provider available');
}

parentPort.on('message', (event: Electron.MessageEvent) => {
  const message = event.data as IncomingMessage;

  if (message.type === 'init') {
    queryPrefix = message.queryPrefix ?? '';
    pooling = message.pooling === 'cls' ? 'cls' : 'mean';
    const initPromise = initExtractor(message);
    extractorPromise = initPromise.then((result) => result.extractor);
    // Mark this derived promise as handled: the embed path only attaches its own
    // .catch() when a request arrives, so without this a failed init would surface
    // as an unhandledRejection before the first embed message.
    extractorPromise.catch(() => {});
    initPromise.then(
      (result) => post({ type: 'ready', device: result.device }),
      (error: unknown) => post({ type: 'error', message: String(error) }),
    );
    return;
  }

  if (message.type === 'shutdown') {
    process.exit(0);
    return;
  }

  if (message.type === 'embed') {
    const requestId = message.id;
    if (!extractorPromise) {
      post({ type: 'error', id: requestId, message: 'embed before init' });
      return;
    }
    const inputs = message.isQuery && queryPrefix
      ? message.texts.map((text) => queryPrefix + text)
      : message.texts;
    extractorPromise
      .then(async (extractor) => {
        const output = await extractor(inputs, { pooling, normalize: true });
        const rows = output.tolist() as number[][];
        const vectors = rows.map((row) => Float32Array.from(row));
        post({ type: 'result', id: requestId, vectors });
      })
      .catch((error: unknown) => {
        post({ type: 'error', id: requestId, message: String(error) });
      });
  }
});
