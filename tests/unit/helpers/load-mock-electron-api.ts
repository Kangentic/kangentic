/**
 * Runs the real `tests/ui/mock-electron-api.js` in a fresh `node:vm` context and hands back the
 * bridge it installs, so a unit test can drive the mock's own behavior with no browser.
 *
 * The mock is both the UI tier's bridge and the web demo's runtime bridge
 * (`.claude/rules/web-demo-parity.md`), so a case that only reads what the mock answers belongs
 * in the unit tier, not in a Playwright page that never renders anything.
 *
 * Each call returns a NEW context with its own in-memory state, so cases never share data.
 * Seed state through `preConfigure`, the mock's own hook (`window.__mockPreConfigure`), and keep
 * to one namespace per case: a namespace that reassigns the mock's `swimlanes` or `tasks` array
 * after a seed leaves the seed's reference behind.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const MOCK_ELECTRON_API_PATH = path.resolve(__dirname, '..', '..', 'ui', 'mock-electron-api.js');
const MOCK_SOURCE = fs.readFileSync(MOCK_ELECTRON_API_PATH, 'utf-8');

export type MockObject = Record<string, unknown>;

/** The state object `__mockPreConfigure` hands its callback. Only the members the unit tests seed. */
export interface MockSeedState {
  projects: MockObject[];
  tasks: MockObject[];
  swimlanes: MockObject[];
  projectConfigs: Record<string, MockObject>;
  DEFAULT_SWIMLANES: MockObject[];
}

type PreConfigure = (seed: (state: MockSeedState) => { currentProjectId?: string } | void) => void;

export interface LoadedMock<ElectronApi> {
  electronApi: ElectronApi;
  /** Seeds the mock's in-memory state the way a UI spec's init script does. */
  preConfigure: PreConfigure;
}

/**
 * @param windowSeed members to set on `window` before the mock runs (`__mockWorkflows`, ...).
 */
export function loadMockElectronApi<ElectronApi>(windowSeed: MockObject = {}): LoadedMock<ElectronApi> {
  const windowObject: MockObject = { ...windowSeed };
  windowObject.window = windowObject;
  const sandbox: MockObject = {
    window: windowObject,
    document: undefined,
    crypto: webcrypto,
    setTimeout,
    clearTimeout,
    console,
  };
  vm.runInNewContext(MOCK_SOURCE, sandbox, { filename: MOCK_ELECTRON_API_PATH, timeout: 5000 });

  const electronApi = windowObject.electronAPI as ElectronApi | undefined;
  const preConfigure = windowObject.__mockPreConfigure as PreConfigure | undefined;
  if (!electronApi || !preConfigure) {
    throw new Error('load-mock-electron-api: the mock no longer exposes electronAPI or __mockPreConfigure.');
  }
  return { electronApi, preConfigure };
}

/** Values the mock builds live in the vm's realm; a JSON round trip hands back plain host values. */
export function plain<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(value)) as Value;
}
