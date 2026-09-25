/**
 * The marketing captures' seed: the sample install from demo-dataset.ts with every recorded
 * terminal session loaded from tests/captures/fixtures/demo/. Returns a script string for
 * page.addInitScript() that calls window.__mockPreConfigure() after the mock has loaded.
 *
 * The web build (demo/vite.config.mts) seeds the same dataset, so a capture and the live frame
 * show the same install. See demo/README.md for the projects and where the recordings come from.
 */
import { MESSAGE_TRAIL_MAX_ENTRIES } from '../../../src/main/agent/message-trail-tracker';
import { buildDemoPreConfig } from './demo-dataset';
import { buildCellWidthTable, loadDemoChanges, loadDemoEnds, loadDemoHistory, loadDemoMessageTrails, loadDemoOpenFrames, loadDemoPeeks, loadDemoScrollback, readAppVersion, readLiveTailMs } from './demo-scrollback';

export function buildMarketingPreConfig(): string {
  // No peekTimelines here on purpose. The rig has no recordings index, so no session's clock ever
  // runs and the timeline would be dead weight in the seed. A capture shoots one fixed moment,
  // and a Monitor peek that changed on a timer would make the PNGs non-deterministic.
  //
  // messageTrails ARE passed, and the same reasoning is why they are safe. Without a clock the
  // applier only seeds the lines already played at the moment each session opens, which is a fixed
  // function of the recording, so the PNGs stay deterministic. Omitting them would put descriptions
  // on every card in the hero shots while a real install prints the agent's newest message.
  return buildDemoPreConfig({
    scrollback: loadDemoScrollback(), changes: loadDemoChanges(), peeks: loadDemoPeeks(), ends: loadDemoEnds(),
    openFrames: loadDemoOpenFrames(), liveTailMs: readLiveTailMs(), appVersion: readAppVersion(),
    messageTrails: loadDemoMessageTrails(), messageTrailMaxEntries: MESSAGE_TRAIL_MAX_ENTRIES,
    cellWidths: buildCellWidthTable(),
    history: loadDemoHistory(),
  });
}
