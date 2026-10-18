/**
 * Makes the demo's choreography player (demo/choreography.ts) loadable from demo/boot.js, a
 * classic script that cannot import: the chunk is fetched only by a scene that has a choreography
 * and is either a live frame under loop=1 or a still with a pose, so every other frame loads this
 * one-line loader and nothing else.
 */
import type { ChoreographyOptions, ChoreographyPlayer } from './choreography';
import type { ChoreographyStep } from '../tests/captures/scenes';

declare global {
  interface Window {
    __demoLoadChoreography?: () => Promise<{ createChoreography: (steps: ChoreographyStep[], options: ChoreographyOptions) => ChoreographyPlayer }>;
  }
}

window.__demoLoadChoreography = () => import('./choreography');
