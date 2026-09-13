/**
 * The marketing captures' seed: the sample install from demo-dataset.ts with every recorded
 * terminal session loaded from tests/captures/fixtures/demo/. Returns a script string for
 * page.addInitScript() that calls window.__mockPreConfigure() after the mock has loaded.
 *
 * The web build (demo/vite.config.mts) seeds the same dataset, so a capture and the live frame
 * show the same install. See demo/README.md for the projects and where the recordings come from.
 */
import { buildDemoPreConfig } from './demo-dataset';
import { loadDemoChanges, loadDemoEnds, loadDemoOpenFrames, loadDemoPeeks, loadDemoScrollback, readAppVersion, readLiveTailMs } from './demo-scrollback';

export function buildMarketingPreConfig(): string {
  return buildDemoPreConfig({
    scrollback: loadDemoScrollback(), changes: loadDemoChanges(), peeks: loadDemoPeeks(), ends: loadDemoEnds(),
    openFrames: loadDemoOpenFrames(), liveTailMs: readLiveTailMs(), appVersion: readAppVersion(),
  });
}
