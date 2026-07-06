import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

/**
 * embed-worker.ts message-protocol contract.
 *
 * The real file runs inside an Electron utilityProcess and talks over
 * `process.parentPort`; vitest has neither, so this test fakes `process.parentPort`
 * as an EventEmitter with a `postMessage` spy (installed on the real Node `process`
 * before each dynamic import, since the worker module reads `process.parentPort`
 * once at top-level module-evaluation time) and mocks `@huggingface/transformers`'s
 * `pipeline`/`env`. Each test does a fresh `vi.resetModules()` + dynamic import so
 * the worker's module-level state (`extractorPromise`, `pooling`, `queryPrefix`)
 * never leaks between tests.
 */

const { mockPipeline } = vi.hoisted(() => ({ mockPipeline: vi.fn() }));

vi.mock('@huggingface/transformers', () => ({
  env: {
    allowRemoteModels: true,
    localModelPath: '',
    backends: { onnx: { wasm: { wasmPaths: '' } } },
  },
  pipeline: mockPipeline,
}));

type FakeParentPort = EventEmitter & { postMessage: ReturnType<typeof vi.fn> };

function makeFakeParentPort(): FakeParentPort {
  const port = new EventEmitter() as FakeParentPort;
  port.postMessage = vi.fn();
  return port;
}

/** Installs the fake port as `process.parentPort` before the worker module loads it. */
function installParentPort(port: FakeParentPort): void {
  Object.defineProperty(process, 'parentPort', {
    value: port,
    configurable: true,
    writable: true,
  });
}

/** Fresh module instance per test, reading whichever port is currently installed. */
async function importWorker(): Promise<void> {
  vi.resetModules();
  await import('../../src/main/retrieval/embedder/embed-worker');
}

/** Flush the microtask queue (init/embed promise chains) before asserting. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface FakeExtractorOutput {
  tolist(): number[][];
}
type FakeExtractor = (
  inputs: string[],
  options: { pooling: string; normalize: boolean },
) => Promise<FakeExtractorOutput>;

function makeFakeExtractor(): ReturnType<typeof vi.fn> & FakeExtractor {
  return vi.fn(async (inputs: string[]) => ({
    tolist: () => inputs.map(() => [0.1, 0.2]),
  })) as unknown as ReturnType<typeof vi.fn> & FakeExtractor;
}

const BASE_INIT = {
  type: 'init' as const,
  modelId: 'test-model',
  modelDir: '/mock/models',
  wasmDir: '/mock/wasm',
  dtype: 'q8',
  pooling: 'mean',
  queryPrefix: '',
  devices: ['cpu'],
};

describe('embed-worker', () => {
  beforeEach(() => {
    mockPipeline.mockReset();
  });

  afterEach(() => {
    Reflect.deleteProperty(process, 'parentPort');
  });

  it('falls through the device chain: an earlier device that throws is skipped, and ready reports the device that succeeded', async () => {
    const port = makeFakeParentPort();
    installParentPort(port);
    const extractor = makeFakeExtractor();
    mockPipeline
      .mockRejectedValueOnce(new Error('dml unavailable'))
      .mockResolvedValueOnce(extractor);

    await importWorker();

    port.emit('message', {
      data: { ...BASE_INIT, devices: ['dml', 'cpu'] },
      ports: [],
    });
    await flush();

    expect(mockPipeline).toHaveBeenCalledTimes(2);
    expect(mockPipeline).toHaveBeenNthCalledWith(1, 'feature-extraction', 'test-model', {
      device: 'dml',
      dtype: 'q8',
    });
    expect(mockPipeline).toHaveBeenNthCalledWith(2, 'feature-extraction', 'test-model', {
      device: 'cpu',
      dtype: 'q8',
    });
    expect(port.postMessage).toHaveBeenCalledWith({ type: 'ready', device: 'cpu' });
  });

  it('posts an error with the last device error when every device in the chain throws', async () => {
    const port = makeFakeParentPort();
    installParentPort(port);
    mockPipeline
      .mockRejectedValueOnce(new Error('dml unavailable'))
      .mockRejectedValueOnce(new Error('cpu unavailable'));

    await importWorker();

    port.emit('message', {
      data: { ...BASE_INIT, devices: ['dml', 'cpu'] },
      ports: [],
    });
    await flush();

    expect(mockPipeline).toHaveBeenCalledTimes(2);
    expect(port.postMessage).toHaveBeenCalledWith({
      type: 'error',
      message: 'Error: cpu unavailable',
    });
    expect(port.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'ready' }));
  });

  // Priority case: validates the extractorPromise.catch(() => {}) guard that was
  // just added to embed-worker.ts. Without it, a failed init (every device
  // throws) leaves the derived `extractorPromise` with no rejection handler
  // registered until an `embed` message arrives to attach one - and if no
  // `embed` message EVER arrives, Node reports an unhandledRejection. Deleting
  // that .catch() line turns this test red (see the manual red-green
  // verification note in the reporting summary).
  it('does not emit an unhandledRejection when every device fails and no embed message ever arrives', async () => {
    const port = makeFakeParentPort();
    installParentPort(port);
    mockPipeline.mockRejectedValue(new Error('no execution provider available'));

    await importWorker();

    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      port.emit('message', {
        data: { ...BASE_INIT, devices: ['cpu'] },
        ports: [],
      });

      // Give the rejected init-promise chain multiple event-loop turns to
      // surface an unhandledRejection before asserting it never fired.
      await flush();
      await flush();

      expect(unhandledRejections).toEqual([]);
      // The worker still reports the failure through its own channel - the
      // guard only suppresses the redundant Node-level unhandledRejection
      // event, it does not swallow the error.
      expect(port.postMessage).toHaveBeenCalledWith({
        type: 'error',
        message: 'Error: no execution provider available',
      });
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  it('posts an "embed before init" error when an embed message arrives with no prior init', async () => {
    const port = makeFakeParentPort();
    installParentPort(port);

    await importWorker();

    port.emit('message', {
      data: { type: 'embed', id: 7, texts: ['hello'], isQuery: false },
      ports: [],
    });

    expect(port.postMessage).toHaveBeenCalledWith({
      type: 'error',
      id: 7,
      message: 'embed before init',
    });
    expect(mockPipeline).not.toHaveBeenCalled();
  });

  it('prepends queryPrefix to each text only when isQuery is true and the prefix is non-empty', async () => {
    const port = makeFakeParentPort();
    installParentPort(port);
    const extractor = makeFakeExtractor();
    mockPipeline.mockResolvedValue(extractor);

    await importWorker();

    port.emit('message', {
      data: { ...BASE_INIT, queryPrefix: 'query: ' },
      ports: [],
    });
    await flush();

    port.emit('message', {
      data: { type: 'embed', id: 1, texts: ['alpha', 'beta'], isQuery: true },
      ports: [],
    });
    await flush();
    expect(extractor).toHaveBeenLastCalledWith(['query: alpha', 'query: beta'], {
      pooling: 'mean',
      normalize: true,
    });

    port.emit('message', {
      data: { type: 'embed', id: 2, texts: ['gamma'], isQuery: false },
      ports: [],
    });
    await flush();
    expect(extractor).toHaveBeenLastCalledWith(['gamma'], { pooling: 'mean', normalize: true });
  });

  it('does not prefix when queryPrefix is empty even if isQuery is true', async () => {
    const port = makeFakeParentPort();
    installParentPort(port);
    const extractor = makeFakeExtractor();
    mockPipeline.mockResolvedValue(extractor);

    await importWorker();

    port.emit('message', {
      data: { ...BASE_INIT, queryPrefix: '' },
      ports: [],
    });
    await flush();

    port.emit('message', {
      data: { type: 'embed', id: 1, texts: ['solo'], isQuery: true },
      ports: [],
    });
    await flush();

    expect(extractor).toHaveBeenLastCalledWith(['solo'], { pooling: 'mean', normalize: true });
  });

  it("defaults pooling to 'mean' unless the init message says 'cls'", async () => {
    const port = makeFakeParentPort();
    installParentPort(port);
    const extractor = makeFakeExtractor();
    mockPipeline.mockResolvedValue(extractor);

    await importWorker();

    // An unrecognized pooling value (and the plain 'mean' case) both default to 'mean'.
    port.emit('message', {
      data: { ...BASE_INIT, pooling: 'not-a-real-pooling-mode' },
      ports: [],
    });
    await flush();
    port.emit('message', {
      data: { type: 'embed', id: 1, texts: ['x'], isQuery: false },
      ports: [],
    });
    await flush();
    expect(extractor).toHaveBeenLastCalledWith(['x'], { pooling: 'mean', normalize: true });

    // A fresh module instance with pooling: 'cls' uses 'cls'.
    const clsPort = makeFakeParentPort();
    installParentPort(clsPort);
    await importWorker();

    clsPort.emit('message', {
      data: { ...BASE_INIT, pooling: 'cls' },
      ports: [],
    });
    await flush();
    clsPort.emit('message', {
      data: { type: 'embed', id: 1, texts: ['y'], isQuery: false },
      ports: [],
    });
    await flush();
    expect(extractor).toHaveBeenLastCalledWith(['y'], { pooling: 'cls', normalize: true });
  });
});
