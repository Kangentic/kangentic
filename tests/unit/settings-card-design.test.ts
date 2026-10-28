import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { DESCRIPTION_BUDGET, registryDescriptions, scanRealSettings, scanSnippet } from './helpers/settings-card-scan';

// Guards the settings card design (`.claude/rules/settings-card-design.md`).
// Five things a new tab or a new setting can quietly break, and that no type or
// lint check sees:
//
// 1. Every settings tab is built from cards. A tab's top level holds
//    `SettingsCard`s (plus its dialogs and the dev-only sections), never a loose
//    row, so every tab in the panel flows the same way.
// 2. Every child of a card body is a tile component (`CardRow`,
//    `CardToggleRow`, `CardChoiceRow`, `CardGroupTile`, `CardTile`, or a
//    component whose every return is one). A
//    raw `<div>` in a body renders as a bare block among tiles: no fill, no
//    inset, and a label off the card's left edge.
// 3. A `CardTile` never sets its own fill or padding.
// 4. Every description a card SHOWS (a header's, or a toggle row's with
//    `inlineDescription`) fits on one line. The settings panel is a fixed 720px,
//    but the UI font is the OS's own, so a pixel check on the Linux runner would
//    measure a font no user sees. The budget is characters instead, set from the
//    widest text measured in Segoe UI (5.7px per character) against each
//    context's text column, with room left for the wider macOS and Linux fonts:
//    a header or row beside a switch has 373px, a header with no switch 421px, a
//    nested row 343px. Tooltip (`InfoTip`) text is not shown inline and has no
//    budget.
// 5. A short fixed choice, two to four options, is a segmented control
//    (`CardChoiceRow`, or `SegmentedControl` inside a tile), never a `<Select>`:
//    every option shows at once and any is one click away. A set whose labels
//    do not fit beside the row's label keeps its dropdown and says so with
//    `// choice-select-ok: <reason>`.
//
// The scan parses TSX ASTs, the same way clickable-control-select-none.test.ts
// does, and every detector is driven over known-bad input below so a broken walk
// cannot pass vacuously. The scan itself lives in helpers/settings-card-scan.ts,
// which the translation harness (scripts/i18n/) shares to check that a translated
// description still fits.

const REPO_ROOT = path.resolve(__dirname, '../..');

// The real tree is parsed once for the three checks below. A scan that throws
// leaves nothing cached, so each check still reports the failure on its own.
let realScan: ReturnType<typeof scanRealSettings> | undefined;
const realSettings = () => (realScan ??= scanRealSettings(REPO_ROOT));

describe('settings card design', () => {
  it('every tab is cards, every card body is tiles, and no tile restyles itself', () => {
    const { violations } = realSettings();
    const report = violations.map((violation) => `${violation.file}:${violation.line} in ${violation.where}: ${violation.found}`);
    expect(report, 'Put settings in a SettingsCard; wrap custom content in <CardTile>; use CardRow or CardToggleRow for a setting').toEqual([]);
  });

  it('every description a card shows fits on one line', () => {
    const { descriptions } = realSettings();
    // A length read off anything but text is undefined, and `undefined > budget` passes.
    expect(descriptions.filter((entry) => typeof entry.text !== 'string').map((entry) => entry.owner)).toEqual([]);
    const over = descriptions
      .filter((entry) => entry.text.length > DESCRIPTION_BUDGET[entry.context])
      .map((entry) => `${entry.file}:${entry.line} ${entry.owner}: ${entry.text.length} > ${DESCRIPTION_BUDGET[entry.context]} (${entry.context}) "${entry.text}"`);
    expect(over, 'Shorten the description; the whole sentence has to fit on one line').toEqual([]);
  });

  it('reads the real settings tree, so no check passes vacuously', () => {
    const { cards, checkedTabs, descriptions, tileComponents, tabLabels } = realSettings();
    // Every tab file is covered by the top-level check.
    expect(tabLabels.size).toBeGreaterThan(15);
    expect(checkedTabs.length).toBe(tabLabels.size);
    // A card per feature on tabs across the panel, the dev-only sections included.
    for (const card of ['knowledgeGraph.indexingEnabled', 'git.worktreesEnabled', 'dictation.enabled', 'browserAutomation.enabled',
      'mcpServer.enabled', 'mobileBridge.enabled', 'browser.enabled', '"Board layout"', '"Sessions"', '"Terminal"',
      '"Appearance"', '"Shortcuts"', '"Analytics"', '"Diagnostics"', '"Dev inspection bridge"']) {
      expect(cards, `expected the ${card} card`).toContain(card);
    }
    // Components that render tiles are found wherever they live: a local one, an
    // imported helper, and the keybindings rows.
    for (const component of ['NotifyChannelRow', 'AgentExecutionFields', 'AgentLaunchOptionFields', 'HotkeyRow', 'OsHotkeyBanner', 'SortableActionItem', 'ActionRow', 'AnswerAgentRows', 'EmbeddingModelStatus', 'CardSourceList', 'CardLinkRow']) {
      expect(tileComponents.has(component), `expected ${component} to be recognised as rendering tiles`).toBe(true);
    }
    const owners = descriptions.map((entry) => entry.owner);
    // A registry-sourced header, a literal header, a settingProps binding, an
    // inline row, a nested row, and an unavailable reason.
    expect(owners).toContain('knowledgeGraph.enabled');
    expect(owners).toContain('"Project defaults"');
    expect(descriptions.some((entry) => entry.text === registryDescriptions.get('mobileBridge.relayMode'))).toBe(true);
    // A descriptor-backed entry reaches the budgets as its English sentence, never a
    // message ID or the descriptor itself.
    expect(registryDescriptions.get('displayLanguage')).toMatch(/^Applies after a restart/);
    expect(owners).toContain('browserAutomation.allowInteraction');
    expect(descriptions.find((entry) => entry.owner === 'browserAutomation.restrictNavigationToLocalhost')?.context).toBe('nested_row');
    expect(owners.some((owner) => owner.endsWith('(unavailable)'))).toBe(true);
  });

  it('flags a bare element in a card body and a description over budget', () => {
    const { violations, descriptions } = scanSnippet('bad.tsx', `
      export function Bad() {
        return (
          <SettingsCard icon={null} label="Bad" description="${'x'.repeat(61)}" checked={true} onChange={() => {}}>
            {on ? (
              <>
                <CardRow label="Fine" description="fine"><span /></CardRow>
                <div className="flex">custom</div>
              </>
            ) : null}
            {statusLine}
            {items.map((item) => <CardToggleRow key={item} label={item} description="d" checked onChange={() => {}} />)}
            {items.map((item) => <p key={item}>{item}</p>)}
          </SettingsCard>
        );
      }
    `);
    expect(violations.map((violation) => violation.found)).toEqual(['<div>', 'statusLine', '<p>']);
    expect(descriptions[0].text.length).toBeGreaterThan(DESCRIPTION_BUDGET[descriptions[0].context]);
  });

  it('measures a description written with the t macro, as a translated tab writes it', () => {
    const { descriptions } = scanSnippet('translated.tsx', `
      export function Translated() {
        return (
          <SettingsCard icon={null} label={t\`Translated\`} description={t\`${'x'.repeat(67)}\`}>
            <CardToggleRow label={t\`Row\`} description={t\`Shown for \${projectName}\`} inlineDescription nested checked onChange={() => {}} />
          </SettingsCard>
        );
      }
    `);
    expect(descriptions.map((entry) => [entry.text, entry.context])).toEqual([
      ['x'.repeat(67), 'no_switch'],
      ['Shown for {projectName}', 'nested_row'],
    ]);
    expect(descriptions[0].text.length).toBeGreaterThan(DESCRIPTION_BUDGET[descriptions[0].context]);
  });

  // A converted tab passes its text through Lingui. Red-green: drop `macroText`
  // from `descriptionOf` and nothing is measured here, so the over-budget
  // descriptions pass; drop it from `labelOf` and the card names lose their quotes.
  it('measures a description written through Lingui, and names its card by the English', () => {
    // Over both budgets: 60 beside a switch, 66 with none.
    const long = 'x'.repeat(67);
    const { descriptions, cards } = scanSnippet('translated.tsx', `
      export function Translated() {
        const { t, i18n } = useLingui();
        return (
          <>
            <SettingsCard icon={null} label={t\`Board layout\`} description={t\`${long}\`} checked={true} onChange={() => {}}>
              <CardTile>ok</CardTile>
            </SettingsCard>
            <SettingsCard icon={null} label={t({ message: 'Sessions', context: 'card' })} description={i18n._(msg({ message: '${long}' }))}>
              <CardTile>ok</CardTile>
            </SettingsCard>
          </>
        );
      }
    `);
    expect(cards).toEqual(['"Board layout"', '"Sessions"']);
    expect(descriptions.map((entry) => entry.text)).toEqual([long, long]);
    for (const entry of descriptions) {
      expect(entry.text.length).toBeGreaterThan(DESCRIPTION_BUDGET[entry.context]);
    }
  });

  it('accepts a component that renders only tiles, and rejects one that does not', () => {
    const { violations, tileComponents } = scanSnippet('components.tsx', `
      function GoodRows({ on }) {
        if (!on) return null;
        return (
          <>
            <CardRow label="A" description="a"><span /></CardRow>
            <CardTile className="flex">b</CardTile>
          </>
        );
      }
      function BadRow() {
        return <div className="row">loose</div>;
      }
      export function Host() {
        return (
          <SettingsCard icon={null} label="Host" description="ok">
            <GoodRows on />
            <BadRow />
          </SettingsCard>
        );
      }
    `);
    expect(tileComponents.has('GoodRows')).toBe(true);
    expect(tileComponents.has('BadRow')).toBe(false);
    expect(violations.map((violation) => violation.found)).toEqual(['<BadRow>']);
  });

  it('flags a CardTile that sets its own fill or padding', () => {
    const { violations } = scanSnippet('restyled.tsx', `
      export function Restyled() {
        return (
          <SettingsCard icon={null} label="Restyled" description="ok">
            <CardTile className="flex items-center gap-3">fine</CardTile>
            <CardTile className="flex bg-surface-inset px-2">darker well</CardTile>
          </SettingsCard>
        );
      }
    `);
    expect(violations.map((violation) => violation.found)).toEqual(['restyled tile: "flex bg-surface-inset px-2"']);
  });

  it('flags a tab that renders a loose row outside any card', () => {
    const { violations } = scanSnippet('tabs/LooseTab.tsx', `
      export function LooseTab() {
        return (
          <div className="space-y-4">
            <SettingsCard icon={null} label="Fine" description="ok"><CardTile>ok</CardTile></SettingsCard>
            <div className="loose-row">not in a card</div>
            {showConfirm && <ConfirmDialog />}
            {relocationDialog}
          </div>
        );
      }
    `, true);
    expect(violations.map((violation) => violation.where)).toEqual(['LooseTab top level']);
  });

  it('flags a short fixed dropdown, and leaves a longer, listed or marked one alone', () => {
    const { violations } = scanSnippet('choices.tsx', `
      export function Choices() {
        return (
          <SettingsCard icon={null} label="Choices" description="ok">
            <CardRow label="Two" description="d">
              <Select value="a" onChange={() => {}}>{/* a comment lists nothing */}<option value="a">A</option><option value="b">B</option></Select>
            </CardRow>
            <CardRow label="Four" description="d">
              <Select value="a" onChange={() => {}}><option value="a">A</option><option value="b">B</option><option value="c">C</option><option value="d">D</option></Select>
            </CardRow>
            <CardRow label="Five" description="d">
              <Select value="a" onChange={() => {}}><option value="a">A</option><option value="b">B</option><option value="c">C</option><option value="d">D</option><option value="e">E</option></Select>
            </CardRow>
            <CardRow label="Marked" description="d">
              {/* choice-select-ok: three phrase-length options do not fit. */}
              <Select value="a" onChange={() => {}}><option value="a">A</option><option value="b">B</option><option value="c">C</option></Select>
            </CardRow>
            <CardRow label="Empty marker" description="d">
              {/* choice-select-ok: */}
              <Select value="a" onChange={() => {}}><option value="a">A</option><option value="b">B</option><option value="c">C</option></Select>
            </CardRow>
            <CardRow label="Listed" description="d">
              <Select value="a" onChange={() => {}}><option value="">Auto</option>{shells.map((shell) => <option key={shell}>{shell}</option>)}</Select>
            </CardRow>
            <CardChoiceRow label="Segmented" description="d" options={[]} value="a" onChange={() => {}} />
          </SettingsCard>
        );
      }
    `);
    // Two, four and the empty marker (no reason) are flagged; five, marked and listed are not.
    expect(violations.map((violation) => violation.found)).toEqual(Array(3).fill('short fixed choice as a dropdown: use CardChoiceRow or SegmentedControl'));
  });

  it('takes a CardGroupTile as a tile and still flags a bare grid beside it', () => {
    const { violations } = scanSnippet('groups.tsx', `
      export function Groups() {
        return (
          <SettingsCard icon={null} label="Groups" description="ok">
            <CardGroupTile label="Tasks" count={2} open onToggle={() => {}}>
              <ul className="grid grid-cols-3" />
            </CardGroupTile>
            <div data-testid="grid" />
          </SettingsCard>
        );
      }
    `);
    expect(violations.map((violation) => violation.found)).toEqual(['<div>']);
  });
});
