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
 *       entry, so a tab rename can't silently orphan search.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SETTINGS_REGISTRY, TAB_LABELS, PROJECT_TAB_GLOBALS } from '../../src/renderer/components/settings/settings-registry';
import { SETTINGS_TABS } from '../../src/renderer/components/settings/settings-tabs';

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

/** MobileDevicesTab.tsx's `mobileBridge.*` ids are real, but both its
 *  SETTINGS_TABS entry and its SETTINGS_REGISTRY entries are gated behind
 *  `__KANGENTIC_DEV__`, which vitest.config.ts pins to `false` so tests run
 *  production-like. The source literals are unconditional, so a static scan
 *  would see them as dead ids at test time. Excluded here for the same
 *  reason mcp-tool-list-parity.test.ts excludes the dev-only devtools glob:
 *  the dev build is where this file's ids are actually exercised. */
const DEV_ONLY_TAB_FILES = new Set(['MobileDevicesTab.tsx']);

/** Every `settingProps('id')`, `searchId: 'id'`, and `searchIds={[...]}` literal
 *  referenced by a tab component, so a dead/renamed registry id shows up as a
 *  parity failure instead of a silently-unsearchable row. */
function collectReferencedSettingIds(): Array<{ id: string; file: string }> {
  const references: Array<{ id: string; file: string }> = [];
  const files = fs.readdirSync(TABS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.tsx') && !DEV_ONLY_TAB_FILES.has(entry.name))
    .map((entry) => entry.name);

  const settingPropsPattern = /settingProps\(\s*'([^']+)'\s*\)/g;
  const searchIdPattern = /searchId:\s*'([^']+)'/g;
  const searchIdsPattern = /searchIds=\{\[([^\]]*)\]\}/g;
  const quotedIdPattern = /'([^']+)'/g;

  for (const fileName of files) {
    const content = fs.readFileSync(path.join(TABS_DIR, fileName), 'utf-8');

    for (const match of content.matchAll(settingPropsPattern)) {
      references.push({ id: match[1], file: fileName });
    }
    for (const match of content.matchAll(searchIdPattern)) {
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
