import { useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import type { AppConfig, ThemeMode, TerminalColorOverrides } from '../../../../shared/types';
import { THEME_BACKGROUNDS, THEME_FOREGROUNDS } from '../../../../shared/types';
import { TERMINAL_DEFAULT_COLORS } from '../../../hooks/useTerminal';
import { SectionHeader, SettingRow, SettingToggleRow, Select, useScopedUpdate } from '../shared';
import { settingProps } from '../settings-registry';
import { ColorPickerPopover, PRESET_COLORS } from '../../backlog/manage-labels/ColorPickerPopover';
import { Pill } from '../../Pill';

type TerminalColorKey = keyof TerminalColorOverrides;

/** What the currently-selected app theme's surface/text color would put in
 *  this terminal color slot - i.e. "what this used to look like" before the
 *  terminal had its own fixed color scheme (it was byte-identical to the app
 *  theme). `cursor` mirrors `foreground`: the terminal's cursor has never
 *  been a distinct app-theme concept, and its own default already always
 *  equals foreground's default. */
function getThemeMatchColor(key: TerminalColorKey, theme: ThemeMode): string {
  return key === 'background' ? THEME_BACKGROUNDS[theme] : THEME_FOREGROUNDS[theme];
}

/** Curated preset swatches for a terminal color field: that field's built-in
 *  default first (a one-click way back to it), then the current app theme's
 *  matching color (skipped if it's identical to the default - e.g.
 *  foreground/cursor on the Dark theme - so slot 2 is never a visible
 *  duplicate of slot 1), then the generic label-color presets. Both branches
 *  yield PRESET_COLORS.length presets (11 today, + the custom-color toggle =
 *  12 cells = a clean two rows in the picker's 6-column grid), regardless of
 *  whether the theme-match slot is shown: PRESET_COLORS's trailing stone gray
 *  (#78716c) is always dropped as a near-duplicate of the leading gray
 *  (#6b7280); when the theme-match slot is ALSO shown, the leading gray is
 *  dropped too, so a third preset never spills onto its own near-empty row.
 *  The two-row result is therefore tied to PRESET_COLORS staying a multiple of
 *  the grid's 6 columns minus one; that array is shared with the label-color
 *  picker, so re-check the row math if its length ever changes. */
function presetsWithDefaultFirst(defaultColor: string, themeMatchColor: string): string[] {
  if (themeMatchColor === defaultColor) return [defaultColor, ...PRESET_COLORS.slice(0, -1)];
  return [defaultColor, themeMatchColor, ...PRESET_COLORS.slice(1, -1)];
}

/** A single terminal color slot: a swatch button that opens the shared color
 *  picker, showing the effective (override or default) color. */
function ColorSwatchField({
  colorKey, label, value, defaultColor, themeMatchColor, onChange,
}: {
  colorKey: TerminalColorKey;
  label: string;
  value: string;
  defaultColor: string;
  themeMatchColor: string;
  onChange: (color: string) => void;
}) {
  const [showPicker, setShowPicker] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  return (
    <div className="flex flex-col items-center gap-1.5 w-16">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setShowPicker(!showPicker)}
        title={`Change ${label}`}
        data-testid={`terminal-color-swatch-${colorKey}`}
        className="w-8 h-8 rounded-md border border-edge-input hover:border-fg-muted hover:scale-105 transition-all shadow-sm"
        style={{ backgroundColor: value }}
      />
      <span className="text-[11px] text-fg-faint text-center leading-tight">{label}</span>
      {showPicker && (
        <ColorPickerPopover
          color={value}
          triggerRef={buttonRef}
          onChange={onChange}
          onClose={() => setShowPicker(false)}
          presetColors={presetsWithDefaultFirst(defaultColor, themeMatchColor)}
        />
      )}
    </div>
  );
}

const TERMINAL_COLOR_FIELDS: { key: TerminalColorKey; label: string }[] = [
  { key: 'background', label: 'Background' },
  { key: 'foreground', label: 'Foreground' },
  { key: 'cursor', label: 'Cursor' },
];

export function LayoutTab({ config, globalConfig }: { config: AppConfig; globalConfig: AppConfig }) {
  const updateGlobal = useScopedUpdate('global');
  // `?? {}` mirrors the optional-chaining every other reader of this field uses
  // (resolveTerminalBackground, useTerminal): the indexed reads below would
  // throw on a config source that predates the field or shallow-merges the
  // `terminal` block rather than deep-merging DEFAULT_CONFIG.
  const terminalColors = globalConfig.terminal.colors ?? {};
  return (
    <>
      <SettingRow {...settingProps('cardDensity')}>
        <Select
          value={globalConfig.cardDensity}
          onChange={(event) => updateGlobal({ cardDensity: event.target.value as AppConfig['cardDensity'] })}
        >
          <option value="compact">Compact</option>
          <option value="default">Default</option>
          <option value="comfortable">Comfortable</option>
        </Select>
      </SettingRow>
      <SettingRow {...settingProps('columnWidth')}>
        <Select
          value={globalConfig.columnWidth}
          onChange={(event) => updateGlobal({ columnWidth: event.target.value as AppConfig['columnWidth'] })}
        >
          <option value="narrow">Narrow</option>
          <option value="default">Default</option>
          <option value="wide">Wide</option>
        </Select>
      </SettingRow>
      <SettingToggleRow
        {...settingProps('showTaskNumbers')}
        checked={globalConfig.showTaskNumbers}
        onChange={(value) => updateGlobal({ showTaskNumbers: value })}
      />
      <SettingToggleRow
        {...settingProps('terminalPanelVisible')}
        checked={globalConfig.terminalPanelVisible !== false}
        onChange={(value) => updateGlobal({ terminalPanelVisible: value })}
      />
      <SettingToggleRow
        {...settingProps('statusBarVisible')}
        checked={globalConfig.statusBarVisible !== false}
        onChange={(value) => updateGlobal({ statusBarVisible: value })}
      />
      <SettingToggleRow
        {...settingProps('restoreWindowPosition')}
        checked={globalConfig.restoreWindowPosition}
        onChange={(value) => updateGlobal({ restoreWindowPosition: value })}
      />
      <SettingToggleRow
        {...settingProps('animationsEnabled')}
        checked={globalConfig.animationsEnabled}
        onChange={(value) => updateGlobal({ animationsEnabled: value })}
      />

      <SectionHeader label="Diff" searchIds={['diffViewMode', 'diffDefaultScope', 'diffIgnoreWhitespace', 'diffCollapseUnchanged', 'diffFileSort', 'diffFlatList']} />
      <SettingRow {...settingProps('diffViewMode')}>
        <Select
          value={globalConfig.diffViewMode}
          onChange={(event) => updateGlobal({ diffViewMode: event.target.value as AppConfig['diffViewMode'] })}
        >
          <option value="split">Side by side</option>
          <option value="inline">Inline</option>
        </Select>
      </SettingRow>
      <SettingRow {...settingProps('diffDefaultScope')}>
        <Select
          value={globalConfig.diffDefaultScope}
          onChange={(event) => updateGlobal({ diffDefaultScope: event.target.value as AppConfig['diffDefaultScope'] })}
        >
          <option value="working">Working</option>
          <option value="staged">Staged</option>
          <option value="branch">Branch</option>
        </Select>
      </SettingRow>
      <SettingToggleRow
        {...settingProps('diffIgnoreWhitespace')}
        checked={globalConfig.diffIgnoreWhitespace}
        onChange={(value) => updateGlobal({ diffIgnoreWhitespace: value })}
      />
      <SettingToggleRow
        {...settingProps('diffCollapseUnchanged')}
        checked={globalConfig.diffCollapseUnchanged}
        onChange={(value) => updateGlobal({ diffCollapseUnchanged: value })}
      />
      <SettingRow {...settingProps('diffFileSort')}>
        <Select
          value={globalConfig.diffFileSort}
          onChange={(event) => updateGlobal({ diffFileSort: event.target.value as AppConfig['diffFileSort'] })}
        >
          <option value="name">Name</option>
          <option value="status">Status</option>
          <option value="size">Size</option>
        </Select>
      </SettingRow>
      <SettingToggleRow
        {...settingProps('diffFlatList')}
        checked={globalConfig.diffFlatList}
        onChange={(value) => updateGlobal({ diffFlatList: value })}
      />

      <SectionHeader label="Terminal" searchIds={['terminal.colors']} />
      <SettingRow
        {...settingProps('terminal.colors')}
        trailing={
          <Pill
            size="sm"
            onClick={() => updateGlobal({ terminal: { colors: {} } })}
            className="text-fg-muted bg-surface-hover/50 hover:bg-surface-hover hover:text-fg-secondary transition-colors"
            data-testid="terminal-colors-reset-all"
          >
            <RotateCcw size={14} /> Reset to default
          </Pill>
        }
      >
        <div className="flex flex-wrap gap-x-2 gap-y-3">
          {TERMINAL_COLOR_FIELDS.map(({ key, label }) => (
            <ColorSwatchField
              key={key}
              colorKey={key}
              label={label}
              value={terminalColors[key] || TERMINAL_DEFAULT_COLORS[key]}
              defaultColor={TERMINAL_DEFAULT_COLORS[key]}
              themeMatchColor={getThemeMatchColor(key, config.theme)}
              onChange={(color) => updateGlobal({ terminal: { colors: { ...terminalColors, [key]: color } } })}
            />
          ))}
        </div>
      </SettingRow>
    </>
  );
}
