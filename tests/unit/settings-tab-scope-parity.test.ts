/**
 * Settings tab/scope parity guard (see .claude/rules/settings-tab-scope.md).
 *
 * `updateProjectOverride` (src/renderer/stores/config-store.ts) silently
 * no-ops when no project is open. That makes the Settings panel's
 * PROJECT/SYSTEM tab split load-bearing, not cosmetic: a `scope: 'project'`
 * setting placed in a `category: 'system'` tab renders in the no-project
 * state, accepts input, and drops the write with no feedback. This is what
 * let Terminal Colors drift across three tab homes before this test existed
 * - the "Settings tab separator" convention was prose with nothing checking
 * it. This file (pure source analysis, runs in CI) makes that drift
 * unmergeable:
 *   (a) every project-scoped setting's tab is category 'project' (hard
 *       rule - never allowlisted);
 *   (b) every global setting stranded in a category 'project' tab is
 *       recorded in PROJECT_TAB_GLOBALS with a reason (a new one fails
 *       until deliberately added; a stale one fails until removed);
 *   (c) every settingProps(...)/searchId/searchIds literal referenced by a
 *       tab component names a real registry id (catches the dead-id class
 *       of drift, not just the scope class);
 *   (d) every registry tabId has a SETTINGS_TABS entry and a TAB_LABELS
 *       entry, so a tab rename can't silently orphan search;
 *   (e) every boolean event key under NotificationConfig.desktop/.toasts has
 *       a `notifications.<key>` registry entry, with an explicit allowlist
 *       for any key deliberately kept out of the UI - the reverse of (c).
 *       This is what let onAgentCrash ship with no Settings row: (c) only
 *       ever walks row -> registry, never config -> row, so a config key
 *       with no UI was invisible to every check in this file;
 *   (f) NotificationConfig.desktop and .toasts declare the same boolean
 *       event key set, since NotifyChannelRow reads and writes both from
 *       one dropdown - a key on only one channel renders as a wrong value,
 *       not a crash, so nothing else would catch it;
 *   (g) every notification row is really RENDERED and wired to the config key
 *       it names: each `notifications.on*` registry id has a NotifyChannelRow,
 *       and each row's `searchId` matches its `eventKey`. Those two props are
 *       independent, so a row can display one setting's label while writing
 *       another's config key, and (c) cannot see it - both ids are real.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SETTINGS_REGISTRY, TAB_LABELS, PROJECT_TAB_GLOBALS } from '../../src/renderer/components/settings/settings-registry';
import { SETTINGS_TABS } from '../../src/renderer/components/settings/settings-tabs';
import { DEFAULT_CONFIG } from '../../src/shared/types';

const REPO_ROOT = path.resolve(__dirname, '../..');
const TABS_DIR = path.join(REPO_ROOT, 'src/renderer/components/settings/tabs');

const tabCategoryById: Record<string, 'project' | 'system'> = Object.fromEntries(
  SETTINGS_TABS.map((tab) => [tab.id, tab.category]),
);

describe('settings tab/scope parity: hard rule', () => {
  it('finds tabs and settings (glob/scan did not silently miss anything)', () => {
    expect(SETTINGS_TABS.length).toBeGreaterThan(0);
    expect(SETTINGS_REGISTRY.length).toBeGreaterThan(0);
  });

  it('every project-scoped setting lives in a project-category tab', () => {
    const misplaced = SETTINGS_REGISTRY
      .filter((entry) => entry.scope === 'project' && tabCategoryById[entry.tabId] !== 'project')
      .map((entry) => `${entry.id} (tabId: ${entry.tabId})`)
      .sort();
    expect(
      misplaced,
      `These settings are scope:'project' but live in a tab that is not category:'project'. `
        + `A project-scoped control in a system tab renders with no project open and silently `
        + `drops its write (updateProjectOverride no-ops without a project path). Move the setting `
        + `to a project tab, or change its scope if it is genuinely global:\n${misplaced.join('\n')}`,
    ).toEqual([]);
  });
});

describe('settings tab/scope parity: global-in-project-tab allowlist', () => {
  it('every global setting inside a project tab is allowlisted with a reason', () => {
    const unlisted = SETTINGS_REGISTRY
      .filter((entry) => entry.scope === 'global' && tabCategoryById[entry.tabId] === 'project')
      .map((entry) => entry.id)
      .filter((id) => !PROJECT_TAB_GLOBALS[id])
      .sort();
    expect(
      unlisted,
      `These settings are scope:'global' but live in a category:'project' tab, so they are `
        + `unreachable with no project open. That is acceptable only when deliberate - add an entry `
        + `to PROJECT_TAB_GLOBALS (settings-registry.ts) explaining why, or move the setting to a `
        + `system tab:\n${unlisted.join('\n')}`,
    ).toEqual([]);
  });

  it('the allowlist has no stale entries', () => {
    const registryIds = new Set(SETTINGS_REGISTRY.map((entry) => entry.id));
    const stale = Object.keys(PROJECT_TAB_GLOBALS).filter((id) => {
      const entry = SETTINGS_REGISTRY.find((candidate) => candidate.id === id);
      if (!entry) return true;
      return !(entry.scope === 'global' && tabCategoryById[entry.tabId] === 'project');
    }).sort();
    expect(
      stale,
      `These PROJECT_TAB_GLOBALS entries no longer name a global setting inside a project tab `
        + `(renamed, moved, or rescoped?). Remove them from settings-registry.ts:\n${stale.join('\n')}`,
    ).toEqual([]);
  });
});

/** Every `settingProps('id')`, `searchId: 'id'`, `searchId="id"`, and
 *  `searchIds={[...]}` literal referenced by a tab component, so a
 *  dead/renamed registry id shows up as a parity failure instead of a
 *  silently-unsearchable row. `searchId="id"` (the JSX attribute form, used
 *  by NotificationsTab's NotifyChannelRow) is distinct from the
 *  `searchId: 'id'` object-property form above it. */
function collectReferencedSettingIds(): Array<{ id: string; file: string }> {
  const references: Array<{ id: string; file: string }> = [];
  const files = fs.readdirSync(TABS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.tsx'))
    .map((entry) => entry.name);

  const settingPropsPattern = /settingProps\(\s*'([^']+)'\s*\)/g;
  const searchIdPropertyPattern = /searchId:\s*'([^']+)'/g;
  const searchIdAttributePattern = /searchId="([^"]+)"/g;
  const searchIdsPattern = /searchIds=\{\[([^\]]*)\]\}/g;
  const quotedIdPattern = /'([^']+)'/g;

  for (const fileName of files) {
    const content = fs.readFileSync(path.join(TABS_DIR, fileName), 'utf-8');

    for (const match of content.matchAll(settingPropsPattern)) {
      references.push({ id: match[1], file: fileName });
    }
    for (const match of content.matchAll(searchIdPropertyPattern)) {
      references.push({ id: match[1], file: fileName });
    }
    for (const match of content.matchAll(searchIdAttributePattern)) {
      references.push({ id: match[1], file: fileName });
    }
    for (const match of content.matchAll(searchIdsPattern)) {
      for (const idMatch of match[1].matchAll(quotedIdPattern)) {
        references.push({ id: idMatch[1], file: fileName });
      }
    }
  }
  return references;
}

describe('settings tab/scope parity: registry to rendered parity', () => {
  it('every settingProps/searchId/searchIds literal names a real registry id', () => {
    const registryIds = new Set(SETTINGS_REGISTRY.map((entry) => entry.id));
    const references = collectReferencedSettingIds();
    expect(references.length).toBeGreaterThan(0);

    const dead = references
      .filter((reference) => !registryIds.has(reference.id))
      .map((reference) => `${reference.file}: '${reference.id}'`)
      .sort();
    expect(
      dead,
      `These tab components reference a setting id that has no SETTINGS_REGISTRY entry (renamed, `
        + `typo\'d, or the entry was deleted?). A dead id here means the row is unsearchable / a `
        + `SectionHeader never hides during search:\n${dead.join('\n')}`,
    ).toEqual([]);
  });
});

/** Boolean event keys declared on one NotificationConfig channel (desktop or
 *  toasts), read from DEFAULT_CONFIG rather than regexed off the interface
 *  text - `durationSeconds` / `maxCount` are numbers and are filtered out
 *  here, since they already have their own full-path registry ids. */
function notificationEventKeys(channel: 'desktop' | 'toasts'): string[] {
  return Object.entries(DEFAULT_CONFIG.notifications[channel])
    .filter(([, value]) => typeof value === 'boolean')
    .map(([key]) => key)
    .sort();
}

/**
 * Notification event keys deliberately NOT exposed in Settings, with a
 * reason. Empty by design: every notification a user can receive should be
 * switchable. Note the id convention below - a row id is
 * `notifications.<key>` (e.g. `notifications.onAgentCrash`), NOT the config
 * path `notifications.desktop.<key>`, because one row owns both channels.
 */
const UNEXPOSED_NOTIFICATION_EVENTS: Record<string, string> = {};

/** Both channels' event keys, and every registry id. Hoisted rather than
 *  recomputed per test: both are pure reads of module-level constants
 *  (DEFAULT_CONFIG, SETTINGS_REGISTRY) with no mutation, so there is no
 *  isolation reason to rebuild them - matching how `tabCategoryById` above is
 *  derived once and shared across describe blocks. */
const NOTIFICATION_EVENT_KEYS = new Set([
  ...notificationEventKeys('desktop'),
  ...notificationEventKeys('toasts'),
]);
const REGISTRY_IDS = new Set(SETTINGS_REGISTRY.map((entry) => entry.id));

describe('settings tab/scope parity: notification config to registry parity', () => {
  it('every notification event boolean has a registry row, or is allowlisted', () => {
    const missing = [...NOTIFICATION_EVENT_KEYS]
      .filter((key) => !UNEXPOSED_NOTIFICATION_EVENTS[key])
      .filter((key) => !REGISTRY_IDS.has(`notifications.${key}`))
      .sort();
    expect(
      missing,
      `These NotificationConfig event booleans (desktop and/or toasts) have no `
        + `SETTINGS_REGISTRY entry, so a user has no way to turn them off (this is exactly `
        + `how onAgentCrash shipped unreachable). Add a 'notifications.<key>' entry `
        + `to settings-registry.ts and a NotifyChannelRow to NotificationsTab.tsx, or - only `
        + `if deliberately kept out of the UI - record the key in UNEXPOSED_NOTIFICATION_EVENTS `
        + `(settings-tab-scope-parity.test.ts) with a reason:\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('the unexposed-events allowlist has no stale entries', () => {
    const stale = Object.keys(UNEXPOSED_NOTIFICATION_EVENTS).filter((key) => {
      if (!NOTIFICATION_EVENT_KEYS.has(key)) return true; // no longer a real config boolean
      return REGISTRY_IDS.has(`notifications.${key}`); // now has a row after all
    }).sort();
    expect(
      stale,
      `These UNEXPOSED_NOTIFICATION_EVENTS entries no longer name a config boolean that is `
        + `missing a registry row (renamed, removed, or a row was added?). Remove them:\n`
        + `${stale.join('\n')}`,
    ).toEqual([]);
  });

  it('every notifications.on* registry id names a real event key', () => {
    const desktopKeys = new Set(notificationEventKeys('desktop'));
    const toastKeys = new Set(notificationEventKeys('toasts'));
    const dead = SETTINGS_REGISTRY
      .filter((entry) => /^notifications\.on/.test(entry.id))
      .map((entry) => entry.id.slice('notifications.'.length))
      .filter((key) => !desktopKeys.has(key) && !toastKeys.has(key))
      .sort();
    expect(
      dead,
      `These SETTINGS_REGISTRY ids look like a notification event row ('notifications.on...') `
        + `but name no real boolean on NotificationConfig.desktop or .toasts (typo'd, or the `
        + `config key was renamed/removed?):\n${dead.join('\n')}`,
    ).toEqual([]);
  });

  it('desktop and toasts declare the same event key set', () => {
    // NotifyChannelRow reads and writes config.desktop[eventKey] and
    // config.toasts[eventKey] together from one dropdown. A key present on
    // only one channel makes the other read `undefined`, which
    // notifyChannelValue silently renders as a wrong-but-plausible value
    // ('Desktop only' / 'Toast only') instead of an error.
    expect(notificationEventKeys('desktop')).toEqual(notificationEventKeys('toasts'));
  });

  it('every NotifyChannelRow pairs its eventKey with the matching searchId', () => {
    // NotifyChannelRow takes `eventKey` and `searchId` as INDEPENDENT props:
    // the visible label/description come from settingProps(searchId), while the
    // value read and written come from config.desktop[eventKey] /
    // config.toasts[eventKey]. Nothing in the type system ties them together,
    // so a row can render "Agent Crash" while silently driving onAgentIdle.
    // That mismatch is invisible to every other check here (both ids are real)
    // and to the UI spec (the label still renders), so it is pinned here.
    const source = fs.readFileSync(path.join(TABS_DIR, 'NotificationsTab.tsx'), 'utf-8');
    const rows = [...source.matchAll(/<NotifyChannelRow\b([\s\S]*?)\/>/g)];
    expect(
      rows.length,
      'found no <NotifyChannelRow .../> elements in NotificationsTab.tsx - did the component '
        + 'get renamed? Update this check with it.',
    ).toBeGreaterThan(0);

    const mismatched = rows
      .map((row) => ({
        eventKey: row[1].match(/eventKey="([^"]+)"/)?.[1],
        searchId: row[1].match(/searchId="([^"]+)"/)?.[1],
      }))
      .filter((row) => row.searchId !== `notifications.${row.eventKey}`)
      .map((row) => `eventKey="${row.eventKey}" paired with searchId="${row.searchId}"`)
      .sort();
    expect(
      mismatched,
      `These NotifyChannelRow rows (NotificationsTab.tsx) label themselves from one setting id `
        + `while reading and writing a different config key, so the row silently drives the wrong `
        + `notification. A row's searchId must be 'notifications.<eventKey>':\n`
        + `${mismatched.join('\n')}`,
    ).toEqual([]);
  });

  it('every notifications.on* registry row is actually rendered in NotificationsTab', () => {
    // The reverse of the dead-id check: that one walks tab file -> registry and
    // only fails on a DANGLING reference, never a MISSING one. So a registry
    // row with no NotifyChannelRow satisfies every other check here while
    // showing up in Settings search as a result pointing at a control that is
    // not on the page - the same "reachable in config, unreachable in UI" shape
    // as the Agent Crash gap, one layer up.
    const source = fs.readFileSync(path.join(TABS_DIR, 'NotificationsTab.tsx'), 'utf-8');
    const rendered = new Set(
      [...source.matchAll(/searchId="([^"]+)"/g)].map((match) => match[1]),
    );
    const unrendered = SETTINGS_REGISTRY
      .filter((entry) => /^notifications\.on/.test(entry.id))
      .map((entry) => entry.id)
      .filter((id) => !rendered.has(id))
      .sort();
    expect(
      unrendered,
      `These SETTINGS_REGISTRY notification rows have no NotifyChannelRow in `
        + `NotificationsTab.tsx, so Settings search offers them but the Notifications tab never `
        + `renders a control for them. Add a NotifyChannelRow, or remove the registry entry:\n`
        + `${unrendered.join('\n')}`,
    ).toEqual([]);
  });

  it('collectReferencedSettingIds picks up the searchId="..." JSX-attribute form', () => {
    // Pins searchIdAttributePattern itself. The dead-id check above only flags
    // ids that ARE collected and are not real, so deleting that regex would
    // silently stop scanning every NotifyChannelRow and leave the suite green.
    // Asserting that a given id was collected pins nothing: SectionHeader's
    // searchIds={[...]} array names the same four ids, so the array alone
    // satisfies any presence check even with the attribute regex removed
    // (verified by deleting it - a presence-based version stayed green).
    // COUNT is the only signal that separates the two forms. Both expected
    // counts are derived from the source rather than hardcoded, so trimming
    // the now-redundant searchIds array adjusts the expectation instead of
    // failing with a misleading message.
    const source = fs.readFileSync(path.join(TABS_DIR, 'NotificationsTab.tsx'), 'utf-8');
    const countMatches = (pattern: RegExp): number => [...source.matchAll(pattern)].length;
    const attributeIds = countMatches(/searchId="([^"]+)"/g);
    const arrayIds = [...source.matchAll(/searchIds=\{\[([^\]]*)\]\}/g)]
      .reduce((total, match) => total + [...match[1].matchAll(/'([^']+)'/g)].length, 0);
    const settingPropsIds = countMatches(/settingProps\(\s*'([^']+)'\s*\)/g);
    expect(attributeIds, 'no searchId="..." attributes left in NotificationsTab.tsx').toBeGreaterThan(0);

    const collected = collectReferencedSettingIds()
      .filter((reference) => reference.file === 'NotificationsTab.tsx');
    expect(
      collected.length,
      `collectReferencedSettingIds found ${collected.length} references in `
        + `NotificationsTab.tsx, but the file literally contains ${attributeIds} searchId="..." `
        + `attributes + ${arrayIds} searchIds={[...]} entries + ${settingPropsIds} settingProps() `
        + `literals. A shortfall of exactly ${attributeIds} means searchIdAttributePattern is no `
        + `longer scanning the JSX-attribute form, leaving every NotifyChannelRow unchecked.`,
    ).toBe(attributeIds + arrayIds + settingPropsIds);
  });
});

describe('settings tab/scope parity: tab enumeration', () => {
  it('every registry tabId has a SETTINGS_TABS entry', () => {
    const tabIds = new Set(SETTINGS_TABS.map((tab) => tab.id));
    const orphaned = [...new Set(
      SETTINGS_REGISTRY
        .filter((entry) => !tabIds.has(entry.tabId))
        .map((entry) => `${entry.id} (tabId: ${entry.tabId})`),
    )].sort();
    expect(
      orphaned,
      `These settings name a tabId with no SETTINGS_TABS entry (settings-tabs.ts). Add the tab, or `
        + `fix the tabId:\n${orphaned.join('\n')}`,
    ).toEqual([]);
  });

  it('every SETTINGS_TABS id has a TAB_LABELS entry', () => {
    const missing = SETTINGS_TABS
      .map((tab) => tab.id)
      .filter((id) => !TAB_LABELS[id])
      .sort();
    expect(
      missing,
      `These tab ids have no TAB_LABELS entry (settings-registry.ts), so their tab name never `
        + `matches a search:\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('every SETTINGS_TABS id has a TAB_ICONS entry (AppSettingsPanel.tsx)', () => {
    // TAB_ICONS lives in AppSettingsPanel.tsx (it needs lucide, which the
    // node-env test cannot import), so scan it as text - the same approach
    // collectReferencedSettingIds uses for the tab components. APP_TABS builds
    // each tab's icon as TAB_ICONS[tab.id]; with noUncheckedIndexedAccess off a
    // missing id type-checks but renders <undefined/>, a hard "Element type is
    // invalid" crash. This is the icon twin of the TAB_LABELS check above.
    const source = fs.readFileSync(
      path.join(REPO_ROOT, 'src/renderer/components/settings/AppSettingsPanel.tsx'),
      'utf-8',
    );
    const iconBlock = source.match(/const TAB_ICONS:[^=]*=\s*\{([\s\S]*?)\};/);
    expect(iconBlock, 'could not locate the TAB_ICONS map in AppSettingsPanel.tsx').not.toBeNull();
    const iconIds = new Set(
      [...(iconBlock?.[1] ?? '').matchAll(/^\s*(\w+):/gm)].map((match) => match[1]),
    );
    const missing = SETTINGS_TABS
      .map((tab) => tab.id)
      .filter((id) => !iconIds.has(id))
      .sort();
    expect(
      missing,
      `These SETTINGS_TABS ids have no TAB_ICONS entry (AppSettingsPanel.tsx). The sidebar renders `
        + `<Icon/> from TAB_ICONS[tab.id]; a missing icon crashes at render instead of failing the `
        + `build. Add the icon:\n${missing.join('\n')}`,
    ).toEqual([]);
  });
});

describe('settings tab/scope parity: tier grouping', () => {
  it('every category "system" tab has a tier', () => {
    const missing = SETTINGS_TABS
      .filter((tab) => tab.category === 'system' && !tab.tier)
      .map((tab) => tab.id)
      .sort();
    expect(
      missing,
      `These system tabs have no tier (settings-tabs.ts). The sidebar groups System tabs by tier `
        + `(Core / Advanced / Other); assign one:\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('tiers form a contiguous run (no tab of a different tier interleaved)', () => {
    const systemTiers = SETTINGS_TABS
      .filter((tab) => tab.category === 'system')
      .map((tab) => tab.tier);
    const seen = new Set<string>();
    let previousTier: string | undefined;
    const reentered: string[] = [];
    for (const tier of systemTiers) {
      if (!tier) continue;
      if (tier !== previousTier) {
        if (seen.has(tier)) reentered.push(tier);
        seen.add(tier);
        previousTier = tier;
      }
    }
    expect(
      [...new Set(reentered)],
      `These tiers appear as more than one run in SETTINGS_TABS (settings-tabs.ts). The sidebar `
        + `prints a tier header at the first tab of each new run, so a split tier would print the `
        + `same header twice. Keep each tier's tabs together:\n${reentered.join('\n')}`,
    ).toEqual([]);
  });
});

describe('settings tab/scope parity: mobile bridge ships in production', () => {
  // Regression guard for the mobile-bridge launch un-gate. This suite
  // compiles with __KANGENTIC_DEV__ = false (vitest.config.ts), i.e. the
  // production build - so a re-introduced `...(__KANGENTIC_DEV__ ? [...] :
  // [])` gate around either the tab entry or the registry entries would
  // make these assertions fail here, not just at runtime in a packaged app.
  it('the Mobile Devices tab is present', () => {
    const mobileTab = SETTINGS_TABS.find((tab) => tab.id === 'mobile');
    expect(mobileTab).toBeDefined();
    expect(mobileTab?.category).toBe('system');
  });

  it('all six mobileBridge.* registry entries are present', () => {
    const mobileIds = SETTINGS_REGISTRY.filter((entry) => entry.tabId === 'mobile').map((entry) => entry.id).sort();
    expect(mobileIds).toEqual([
      'mobileBridge.devices',
      'mobileBridge.enabled',
      'mobileBridge.getApp',
      'mobileBridge.pairing',
      'mobileBridge.relayMode',
      'mobileBridge.relayUrl',
    ]);
  });
});
