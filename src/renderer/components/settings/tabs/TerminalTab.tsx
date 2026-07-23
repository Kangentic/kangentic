import { useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import type { AppConfig, ThemeMode, TerminalColorOverrides } from '../../../../shared/types';
import { DEFAULT_CONFIG, THEME_BACKGROUNDS, THEME_FOREGROUNDS } from '../../../../shared/types';
import { TERMINAL_DEFAULT_COLORS } from '../../../hooks/useTerminal';
import { SectionHeader, SettingRow, SettingToggleRow, Select, CompactToggleList, INPUT_CLASS, useScopedUpdate } from '../shared';
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
export function getThemeMatchColor(key: TerminalColorKey, theme: ThemeMode): string {
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
export function presetsWithDefaultFirst(defaultColor: string, themeMatchColor: string): string[] {
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

/**
 * Terminal is global-only (see the doc comments on AppConfig['terminal'] in
 * shared/types.ts): shell/font/scrollback/cursor are cosmetic per-machine
 * preferences, and shell in particular was never reliably project-scoped at
 * the PTY-spawn level (SessionManager caches a single configuredShell keyed
 * to whichever project is currently focused). `config` is still needed
 * read-only for `config.theme`, which drives the Colors section's
 * theme-match swatch - that must track whichever theme is actually resolved
 * (project override or global), not just the global default.
 */
export function TerminalTab({ config, globalConfig, shells }: {
  config: AppConfig;
  globalConfig: AppConfig;
  shells: Array<{ name: string; path: string }>;
}) {
  const updateGlobal = useScopedUpdate('global');
  // `?? {}` mirrors the optional-chaining every other reader of this field uses
  // (resolveTerminalBackground, useTerminal): the indexed reads below would
  // throw on a config source that predates the field or shallow-merges the
  // `terminal` block rather than deep-merging DEFAULT_CONFIG.
  const terminalColors = globalConfig.terminal.colors ?? {};
  return (
    <>
      <SettingRow {...settingProps('terminal.shell')}>
        <Select
          value={globalConfig.terminal.shell || ''}
          onChange={(event) => updateGlobal({ terminal: { shell: event.target.value || null } })}
        >
          <option value="">Auto-detect</option>
          {shells.map((shell) => (
            <option key={shell.path} value={shell.path}>{shell.name}</option>
          ))}
        </Select>
      </SettingRow>
      <SettingRow {...settingProps('terminal.fontSize')}>
        <input
          type="number"
          value={globalConfig.terminal.fontSize ?? DEFAULT_CONFIG.terminal.fontSize}
          onChange={(event) => {
            if (event.target.value === '') return;
            const value = Number(event.target.value);
            if (!Number.isNaN(value)) updateGlobal({ terminal: { fontSize: value } });
          }}
          min={8}
          max={32}
          placeholder={String(DEFAULT_CONFIG.terminal.fontSize)}
          className={INPUT_CLASS}
        />
      </SettingRow>
      <SettingRow {...settingProps('terminal.fontFamily')}>
        <input
          type="text"
          value={globalConfig.terminal.fontFamily ?? ''}
          onChange={(event) => updateGlobal({ terminal: { fontFamily: event.target.value } })}
          placeholder={DEFAULT_CONFIG.terminal.fontFamily}
          className={`${INPUT_CLASS} placeholder-fg-faint`}
        />
      </SettingRow>
      <SettingRow {...settingProps('terminal.scrollbackLines')}>
        <input
          type="number"
          value={globalConfig.terminal.scrollbackLines ?? DEFAULT_CONFIG.terminal.scrollbackLines}
          onChange={(event) => {
            if (event.target.value === '') return;
            const value = Number(event.target.value);
            if (!Number.isNaN(value)) updateGlobal({ terminal: { scrollbackLines: value } });
          }}
          min={1000}
          max={100000}
          step={1000}
          placeholder={String(DEFAULT_CONFIG.terminal.scrollbackLines)}
          className={INPUT_CLASS}
        />
      </SettingRow>
      <SettingRow {...settingProps('terminal.cursorStyle')}>
        <Select
          value={globalConfig.terminal.cursorStyle}
          onChange={(event) => updateGlobal({ terminal: { cursorStyle: event.target.value as 'block' | 'underline' | 'bar' } })}
        >
          <option value="block">Block</option>
          <option value="underline">Underline</option>
          <option value="bar">Bar</option>
        </Select>
      </SettingRow>
      <SettingToggleRow
        {...settingProps('terminal.backspaceSendsCtrlH')}
        checked={globalConfig.terminal.backspaceSendsCtrlH}
        onChange={(value) => updateGlobal({ terminal: { backspaceSendsCtrlH: value } })}
      />

      <SectionHeader label="Colors" searchIds={['terminal.colors']} />
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

      <SectionHeader
        label="Context Bar"
        searchIds={[
          'contextBar.showShell', 'contextBar.showVersion', 'contextBar.showElapsed',
          'contextBar.showCost', 'contextBar.showToolCalls', 'contextBar.showAgentActive', 'contextBar.showTokens',
          'contextBar.showContextFraction', 'contextBar.showProgressBar', 'contextBar.showRateLimits',
        ]}
      />
      {/*
        Model and Effort are intentionally NOT toggleable. Those pills double
        as the in-place model/effort picker triggers (clicking them opens a
        popover that lets the user switch models/effort live without restarting
        the session). Hiding them via toggle would silently disable that
        feature, not just declutter the chrome - so they stay a permanent
        fixture of the context bar.
      */}
      <CompactToggleList items={[
        { label: 'Shell Name', description: 'Detected shell name', checked: globalConfig.contextBar.showShell, onChange: (value) => updateGlobal({ contextBar: { showShell: value } }), searchId: 'contextBar.showShell' },
        { label: 'Version', description: 'Agent CLI version', checked: globalConfig.contextBar.showVersion, onChange: (value) => updateGlobal({ contextBar: { showVersion: value } }), searchId: 'contextBar.showVersion' },
        { label: 'Elapsed Time', description: 'Ticking session duration', checked: globalConfig.contextBar.showElapsed, onChange: (value) => updateGlobal({ contextBar: { showElapsed: value } }), searchId: 'contextBar.showElapsed' },
        { label: 'Cost', description: 'Session API cost', checked: globalConfig.contextBar.showCost, onChange: (value) => updateGlobal({ contextBar: { showCost: value } }), searchId: 'contextBar.showCost' },
        { label: 'Tool Calls', description: 'Cumulative tool invocations', checked: globalConfig.contextBar.showToolCalls, onChange: (value) => updateGlobal({ contextBar: { showToolCalls: value } }), searchId: 'contextBar.showToolCalls' },
        { label: 'Agent Active', description: 'Agent active time', checked: globalConfig.contextBar.showAgentActive, onChange: (value) => updateGlobal({ contextBar: { showAgentActive: value } }), searchId: 'contextBar.showAgentActive' },
        { label: 'Token Counts', description: 'Input / output totals', checked: globalConfig.contextBar.showTokens, onChange: (value) => updateGlobal({ contextBar: { showTokens: value } }), searchId: 'contextBar.showTokens' },
        { label: 'Context Window', description: 'Used / total tokens', checked: globalConfig.contextBar.showContextFraction, onChange: (value) => updateGlobal({ contextBar: { showContextFraction: value } }), searchId: 'contextBar.showContextFraction' },
        { label: 'Progress Bar', description: 'Usage bar and percentage', checked: globalConfig.contextBar.showProgressBar, onChange: (value) => updateGlobal({ contextBar: { showProgressBar: value } }), searchId: 'contextBar.showProgressBar' },
        { label: 'Rate Limits', description: 'Claude 5h / weekly quota bars', checked: globalConfig.contextBar.showRateLimits, onChange: (value) => updateGlobal({ contextBar: { showRateLimits: value } }), searchId: 'contextBar.showRateLimits' },
      ]} />
    </>
  );
}
