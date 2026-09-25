/**
 * Makes the demo's replay emulator (demo/replay-emulator.ts) loadable from the seed, a classic
 * script that cannot import: the chunk is fetched the first time a terminal on a grid other than
 * its recording's mounts, and shares the renderer's own xterm chunk.
 */
import type { ReplayEmulator } from './replay-emulator';

declare global {
  interface Window {
    __demoLoadReplayEmulator?: () => Promise<{ createReplayEmulator: (cols: number, rows: number) => ReplayEmulator }>;
  }
}

window.__demoLoadReplayEmulator = () => import('./replay-emulator');
