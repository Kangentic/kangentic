import { useId, useRef, useState } from 'react';
import { RotateCcw, SquareTerminal } from 'lucide-react';
import type { AppConfig, ThemeMode, TerminalColorOverrides } from '../../../../shared/types';
import { DEFAULT_CONFIG, THEME_BACKGROUNDS, THEME_FOREGROUNDS, resolveTheme } from '../../../../shared/types';
import { TERMINAL_DEFAULT_COLORS } from '../../../hooks/useTerminal';
import { TERMINAL_FONT_SIZE_MAX, TERMINAL_FONT_SIZE_MIN } from '../../../utils/terminal-font-size';
import { useConfigStore } from '../../../stores/config-store';
import { Select, INPUT_CLASS, useScopedUpdate } from '../shared';
import { SettingsCard, CardRow, CardToggleRow, CardChoiceRow } from '../settings-card';
import { settingProps } from '../settings-registry';
import { ColorPickerPopover, PRESET_COLORS } from '../../backlog/manage-labels/ColorPickerPopover';
import { Pill } from '../../Pill';
import { FontCombobox } from '../../dialogs/FontCombobox';

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

/** What the font size field is holding while it is focused. */
interface FontSizeDraft {
  text: string;
  seenValue: number;
  pendingValues: number[];
}

function isTerminalFontSizeInRange(fontSize: number): boolean {
  return Number.isFinite(fontSize) && fontSize >= TERMINAL_FONT_SIZE_MIN && fontSize <= TERMINAL_FONT_SIZE_MAX;
}

/**
 * The terminal font size field. Like the other number fields it commits per
 * keystroke, but only a value inside its range. Typing "12" passes through "1",
 * and committing that put every mounted terminal at 1px, which crashes xterm's
 * WebGL renderer (DESKTOP-1J/1K; useTerminal floors the size too) and refits
 * every PTY on the way. The typed text lives in a draft so the field can show
 * "1" while the user is still typing, and blur puts back the committed value.
 *
 * The draft remembers the setting it was typed against (`seenValue`) and every
 * value it committed that the store has not reached yet (`pendingValues`, in
 * commit order). The store only moves after each config round trip, so it can
 * step through several of those, and any of them keeps the draft. Once it
 * reaches one, the earlier ones are settled and dropped. Any other value came
 * from outside the field (another window, an agent, a hand-edited config), and
 * the field shows it instead of hiding it behind a stale draft until blur.
 */
function FontSizeField({ value, onCommit }: { value: number; onCommit: (fontSize: number) => void }) {
  const [draft, setDraft] = useState<FontSizeDraft | null>(null);
  const liveDraft = draft && (value === draft.seenValue || draft.pendingValues.includes(value)) ? draft : null;
  // A draft the store moved away from is dropped, not just hidden. Kept, it
  // came back if the setting later returned to the value it was typed against.
  if (draft !== null && liveDraft === null) setDraft(null);
  // Empty is mid-edit, not an error. A typed value outside the range is
  // rejected, and the field says so instead of ignoring it silently.
  const outOfRange = liveDraft !== null && liveDraft.text !== '' && !isTerminalFontSizeInRange(Number(liveDraft.text));
  const rangeMessageId = useId();
  return (
    <>
      <input
        type="number"
        value={liveDraft ? liveDraft.text : value}
        onChange={(event) => {
          const text = event.target.value;
          const fontSize = Number(text);
          const commits = text !== '' && isTerminalFontSizeInRange(fontSize);
          // Commits still in flight stay pending across later keystrokes, rejected
          // or not. The store reaches them in order, so the ones before the value
          // it reads now are settled.
          const inFlight = liveDraft?.pendingValues ?? [];
          const settledIndex = inFlight.indexOf(value);
          const stillPending = settledIndex >= 0 ? inFlight.slice(settledIndex) : inFlight;
          setDraft({
            text,
            seenValue: value,
            pendingValues: commits ? [...stillPending, fontSize] : stillPending,
          });
          if (commits) onCommit(fontSize);
        }}
        onBlur={() => setDraft(null)}
        min={TERMINAL_FONT_SIZE_MIN}
        max={TERMINAL_FONT_SIZE_MAX}
        aria-invalid={outOfRange}
        aria-describedby={outOfRange ? rangeMessageId : undefined}
        placeholder={String(DEFAULT_CONFIG.terminal.fontSize)}
        className={`${INPUT_CLASS} ${outOfRange ? 'border-warning focus:border-warning' : ''}`}
      />
      {outOfRange && (
        // Shown only while the typed value is rejected, so a valid field keeps
        // the card's one-line height.
        <span id={rangeMessageId} data-testid="terminal-font-size-range" className="text-[11px] text-warning">
          Use {TERMINAL_FONT_SIZE_MIN} to {TERMINAL_FONT_SIZE_MAX}.
        </span>
      )}
    </>
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
 * read-only for the theme choice, which drives the Colors row's
 * theme-match swatch - that must track whichever theme is actually painted
 * (project override or global, and the OS side when following the system),
 * not just the global default.
 */
export function TerminalTab({ config, globalConfig, shells, fonts }: {
  config: AppConfig;
  globalConfig: AppConfig;
  shells: Array<{ name: string; path: string }>;
  fonts: string[];
}) {
  const updateGlobal = useScopedUpdate('global');
  // The theme-match swatch offers the RESOLVED committed theme (config-store.ts's
  // vocabulary: resolved is committed plus the OS side, shown adds a hover preview),
  // which with "follow system appearance" on is the pair member for the OS's side.
  const systemPrefersDark = useConfigStore((state) => state.systemPrefersDark);
  const resolvedTheme = resolveTheme(config, systemPrefersDark);
  // `?? {}` mirrors the optional-chaining every other reader of this field uses
  // (resolveTerminalBackground, useTerminal): the indexed reads below would
  // throw on a config source that predates the field or shallow-merges the
  // `terminal` block rather than deep-merging DEFAULT_CONFIG.
  const terminalColors = globalConfig.terminal.colors ?? {};
  return (
    <div className="space-y-4">
      <SettingsCard
        icon={<SquareTerminal size={16} />}
        label="Terminal"
        description="The shell, font, cursor and colors every terminal uses."
        searchIds={['terminal.shell', 'terminal.fontSize', 'terminal.fontFamily', 'terminal.cursorStyle', 'terminal.backspaceSendsCtrlH', 'terminal.colors']}
      >
        <CardRow {...settingProps('terminal.shell')}>
          <Select
            value={globalConfig.terminal.shell || ''}
            onChange={(event) => updateGlobal({ terminal: { shell: event.target.value || null } })}
          >
            <option value="">Auto-detect</option>
            {shells.map((shell) => (
              <option key={shell.path} value={shell.path}>{shell.name}</option>
            ))}
          </Select>
        </CardRow>
        <CardRow {...settingProps('terminal.fontSize')}>
          <FontSizeField
            value={globalConfig.terminal.fontSize ?? DEFAULT_CONFIG.terminal.fontSize}
            onCommit={(fontSize) => updateGlobal({ terminal: { fontSize } })}
          />
        </CardRow>
        <CardRow {...settingProps('terminal.fontFamily')}>
          <FontCombobox
            value={globalConfig.terminal.fontFamily ?? ''}
            onChange={(value) => updateGlobal({ terminal: { fontFamily: value } })}
            fonts={fonts}
            placeholder={DEFAULT_CONFIG.terminal.fontFamily}
            testId="terminal-font-family"
          />
        </CardRow>
        <CardChoiceRow
          {...settingProps('terminal.cursorStyle')}
          options={[
            { value: 'block', label: 'Block' },
            { value: 'underline', label: 'Underline' },
            { value: 'bar', label: 'Bar' },
          ]}
          value={globalConfig.terminal.cursorStyle}
          onChange={(value) => updateGlobal({ terminal: { cursorStyle: value } })}
          testId="terminal-cursor-style-choice"
        />
        <CardToggleRow
          {...settingProps('terminal.backspaceSendsCtrlH')}
          checked={globalConfig.terminal.backspaceSendsCtrlH}
          onChange={(value) => updateGlobal({ terminal: { backspaceSendsCtrlH: value } })}
        />
        <CardRow
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
                themeMatchColor={getThemeMatchColor(key, resolvedTheme)}
                onChange={(color) => updateGlobal({ terminal: { colors: { ...terminalColors, [key]: color } } })}
              />
            ))}
          </div>
        </CardRow>
      </SettingsCard>
    </div>
  );
}
