import React, { useCallback, useEffect, useRef } from 'react';
import type { AppConfig, ThemeChoice, ThemeMode } from '../../../../shared/types';
import { NAMED_THEMES, THEME_BASES, resolveTheme } from '../../../../shared/types';
import { useConfigStore } from '../../../stores/config-store';
import { BrandMark } from '../../BrandMark';
import { SettingRow, SettingToggleRow, useScopedUpdate } from '../shared';
import { settingProps } from '../settings-registry';

type ThemeBase = 'dark' | 'light';

/** The pair slot a theme lands in when the system is followed: one per base. */
function pairPatchFor(theme: ThemeMode): Pick<AppConfig, 'themeDark'> | Pick<AppConfig, 'themeLight'> {
  return THEME_BASES[theme] === 'dark' ? { themeDark: theme } : { themeLight: theme };
}

/** The committed value a commit of `theme` is written to, so a pending write can be told apart. */
function committedValueFor(choice: ThemeChoice, theme: ThemeMode): ThemeMode {
  if (!choice.themeFollowsSystem) return choice.theme;
  return THEME_BASES[theme] === 'dark' ? choice.themeDark : choice.themeLight;
}

export function ThemeTab({ config }: { config: AppConfig }) {
  const updateProject = useScopedUpdate('project');
  const systemPrefersDark = useConfigStore((state) => state.systemPrefersDark);
  const following = config.themeFollowsSystem;

  // On: the hand-picked theme seeds its own base's slot, so a Moon user keeps Moon for
  // dark and only gains a light choice. The app then paints the pair member for the
  // OS's current side, which is the hand-picked theme only while the OS is on its
  // side: a Sand user on a dark OS goes to the dark slot's default the moment this is
  // on, because that is what following the system means. Off: the theme being painted
  // right now becomes the hand-picked one, so turning it off never repaints.
  const setFollowing = (value: boolean) => {
    if (value) updateProject({ themeFollowsSystem: true, ...pairPatchFor(config.theme) });
    else updateProject({ themeFollowsSystem: false, theme: resolveTheme(config, systemPrefersDark) });
  };

  return (
    <>
      <SettingToggleRow
        {...settingProps('themeFollowsSystem')}
        checked={following}
        onChange={setFollowing}
      />
      <SettingRow {...settingProps('theme')}>
        <ThemeSwatchGrid
          choice={config}
          onCommit={(theme) => updateProject(following ? pairPatchFor(theme) : { theme })}
        />
      </SettingRow>
    </>
  );
}

/** Tiles per row. The settings panel is a fixed 720px wide, so the grid never reflows. */
const COLUMNS = 3;

/**
 * How long the pointer rests on a tile before the app tries that theme on. A pointer
 * crossing the grid on its way to Peach passes over two or three other tiles in well
 * under this, so it does not flash through their palettes; a pointer that stops sees
 * the theme before it has time to wonder.
 */
const HOVER_PREVIEW_DELAY_MS = 120;

interface ThemeGroup {
  base: ThemeBase;
  label: string;
  themes: typeof NAMED_THEMES;
}

/** The two visual groups, in the order they stack; each shows NAMED_THEMES filtered to its base. */
const BASE_GROUPS: ThemeGroup[] = (['dark', 'light'] as const).map((base) => ({
  base,
  label: base === 'dark' ? 'Dark' : 'Light',
  themes: NAMED_THEMES.filter((theme) => THEME_BASES[theme.id] === base),
}));

/**
 * Accessible names for the two radiogroups in follow-system mode. Screen readers get
 * "when it applies" here; the VISIBLE labels stay "Dark" / "Light", because the switch's
 * own description already says what the pair is for and the dimmed tiles show which two
 * are chosen.
 */
const FOLLOWING_GROUP_NAMES: Record<ThemeBase, string> = {
  dark: 'Dark, when the system is dark',
  light: 'Light, when the system is light',
};

/** A single unmodified letter: the native select's type-ahead, kept here. */
function isTypeAheadKey(event: React.KeyboardEvent): boolean {
  return event.key.length === 1 && /[a-z]/i.test(event.key)
    && !event.ctrlKey && !event.metaKey && !event.altKey;
}

/**
 * One tile per theme, painted from that theme's own tokens so the choice is made by
 * eye. It replaced a `Select` of names; a theme is a visual choice and a dropdown
 * asked the reader to pick "Moon" or "Peach" blind.
 *
 * How a tile paints itself with no hex in this file: the swatch `<span>` carries
 * `theme-<id>` as a class. Tailwind emits every token utility as a variable reference
 * (`bg-accent` is `background-color: var(--kng-accent)`), and the `.theme-<id>` blocks
 * in index.css are bare class selectors, so `bg-surface`, `bg-surface-raised`,
 * `bg-accent`, `bg-fg` and `border-edge` INSIDE the swatch resolve against that theme
 * wherever the tile is nested. A new theme's tile is right the moment its CSS block
 * lands, which is the same source `theme-registry-parity.test.ts` pins. `dark` is
 * `:root` and needed `.theme-dark` grouped onto that block to exist as a class.
 *
 * Only the swatch is scoped. The button, the frame border, the selection ring and the
 * name sit OUTSIDE it and read the app's own tokens: a ring inside the scope would
 * paint in the tile's accent (twelve different rings, some near-invisible on their own
 * surface), and a name inside would sit in a foreign palette outside what the contrast
 * test guarantees.
 *
 * Two modes, one grid. Hand-picked (the default): the twelve are ONE radiogroup with
 * one selection, laid out as two labelled sections. Following the system: each base
 * is its OWN radiogroup with its own selection, the one the OS side matches being what
 * the app paints. The unselected tiles dim so the pair stands out; they still preview
 * on hover and select on click, or the pair could never change.
 *
 * Interaction is the WAI-ARIA radiogroup pattern, as `SegmentedControl`: one tab stop
 * per group (roving tabindex), selection follows focus, so arrowing or typing through
 * the tiles re-themes the app live, which is the keyboard's preview. Left/Right walk
 * the group's flat order and wrap; Up/Down move a row and stop at the edges; Home/End;
 * a letter jumps to the next theme starting with it, as the native select did.
 * `SegmentedControl` itself is not reused: its measured sliding thumb has no meaning
 * on a grid.
 *
 * The pointer's preview is a hover: resting on a tile tries that theme on the whole app
 * without committing it. It is store state (`themePreview`), not an html-class hack, so
 * the diff pane follows it too and nothing writes config. The ring stays on the
 * committed tile throughout. It ends when the pointer leaves the grid and when the grid
 * unmounts (panel close, tab switch, a search that hides the row, a Fast Refresh). A
 * commit (a click, or a keyboard move while the pointer happens to rest on a tile,
 * which would otherwise mask the move) does not end it but MOVES it onto the committed
 * theme: the config write is async, and the app must not drop back to the old theme for
 * the round trip. Once the write lands the preview is retired, by the store when it
 * equals the theme now painted, otherwise here unless the pointer is still resting on
 * that tile (a choice for the OTHER OS side stays a hover while the pointer stays).
 */
function ThemeSwatchGrid({ choice, onCommit }: { choice: ThemeChoice; onCommit: (theme: ThemeMode) => void }) {
  const following = choice.themeFollowsSystem;
  const setThemePreview = useConfigStore((state) => state.setThemePreview);
  const hoverTimerRef = useRef<number | null>(null);
  /** The theme most recently committed here, so a clear can tell a pending commit apart. */
  const lastCommitRef = useRef<ThemeMode | null>(null);
  /** Unsubscribes the watch for the last commit's write landing. */
  const landingWatchRef = useRef<(() => void) | null>(null);
  const pointerInsideRef = useRef(false);

  const cancelPendingPreview = () => {
    if (hoverTimerRef.current === null) return;
    window.clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = null;
  };
  const previewAfterRest = (theme: ThemeMode) => {
    cancelPendingPreview();
    hoverTimerRef.current = window.setTimeout(() => {
      hoverTimerRef.current = null;
      setThemePreview(theme);
    }, HOVER_PREVIEW_DELAY_MS);
  };
  /**
   * Drop the preview, unless it is parked on a commit whose config write has not
   * landed yet. Clearing that one would repaint the app in the OLD theme for the
   * round trip (the flash this exists to prevent); the landing watch below clears it.
   */
  const clearPreviewUnlessPending = useCallback(() => {
    const { themePreview, config } = useConfigStore.getState();
    const pending = themePreview !== null && themePreview === lastCommitRef.current
      && committedValueFor(config, themePreview) !== themePreview;
    if (!pending) setThemePreview(null);
  }, [setThemePreview]);
  const endPreview = () => {
    pointerInsideRef.current = false;
    cancelPendingPreview();
    clearPreviewUnlessPending();
  };
  // Unmount is the last exit: the panel closing, the tab changing, or a search hiding
  // the row all take the grid with them, and the app must not stay on a hover. A
  // commit still in flight keeps its parked preview; its landing watch outlives the
  // grid and clears it then.
  useEffect(() => () => {
    pointerInsideRef.current = false;
    if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current);
    clearPreviewUnlessPending();
  }, [clearPreviewUnlessPending]);

  /**
   * Commit a theme. The preview is moved ONTO the committed theme rather than cleared:
   * the config write is async, so a clear would show the old theme until it lands.
   * When it lands, the store retires the parked preview if it is what the app now
   * paints (config-store.ts, the theme sync subscription); otherwise (a choice for the
   * other OS side) it stays only as a hover, and the watch below ends it.
   *
   * The watch also gives up when "follow system appearance" flips while the write is
   * in flight. The flip re-keys where a commit lands (`theme` against a pair slot), so
   * the value it waits for may never appear, and an open-ended watch would park the
   * app on the preview for good, long after the grid is gone.
   */
  const commit = (theme: ThemeMode) => {
    cancelPendingPreview();
    lastCommitRef.current = theme;
    setThemePreview(theme);
    onCommit(theme);
    landingWatchRef.current?.();
    const followingAtCommit = useConfigStore.getState().config.themeFollowsSystem;
    landingWatchRef.current = useConfigStore.subscribe((state) => {
      const landed = committedValueFor(state.config, theme) === theme;
      const superseded = state.config.themeFollowsSystem !== followingAtCommit;
      if (!landed && !superseded) return;
      landingWatchRef.current?.();
      landingWatchRef.current = null;
      lastCommitRef.current = null;
      if (!pointerInsideRef.current && state.themePreview === theme) setThemePreview(null);
    });
  };

  const groups: { ariaLabel: string; sections: ThemeGroup[]; selected: ThemeMode }[] = following
    ? BASE_GROUPS.map((group) => ({
      ariaLabel: FOLLOWING_GROUP_NAMES[group.base],
      sections: [group],
      selected: choice[group.base === 'dark' ? 'themeDark' : 'themeLight'],
    }))
    : [{ ariaLabel: 'Theme', sections: BASE_GROUPS, selected: choice.theme }];

  return (
    <div
      data-testid="theme-grid"
      data-follows-system={following || undefined}
      className="space-y-2"
      onMouseEnter={() => { pointerInsideRef.current = true; }}
      onMouseLeave={endPreview}
    >
      {groups.map((group) => (
        <RadioGrid
          key={group.ariaLabel}
          ariaLabel={group.ariaLabel}
          sections={group.sections}
          selected={group.selected}
          muteUnselected={following}
          onSelect={commit}
          onHover={previewAfterRest}
        />
      ))}
    </div>
  );
}

interface RadioGridProps {
  ariaLabel: string;
  /** Labelled sections; the keyboard walks them as one flat order, three to a row. */
  sections: ThemeGroup[];
  selected: ThemeMode;
  /** Dim every tile but the selected one, so a chosen pair stands out. */
  muteUnselected: boolean;
  onSelect: (theme: ThemeMode) => void;
  onHover: (theme: ThemeMode) => void;
}

/** One radiogroup: one tab stop, one selection, arrows and type-ahead within it. */
function RadioGrid({ ariaLabel, sections, selected, muteUnselected, onSelect, onHover }: RadioGridProps) {
  const ordered = sections.flatMap((section) => section.themes);
  const tileRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const activeIndex = Math.max(0, ordered.findIndex((theme) => theme.id === selected));

  /** The next theme after `from` whose label starts with `letter`, wrapping; null when none does. */
  const nextByInitial = (from: number, letter: string): number | null => {
    const initial = letter.toLowerCase();
    for (let hop = 1; hop <= ordered.length; hop += 1) {
      const candidate = (from + hop) % ordered.length;
      if (ordered[candidate].label.toLowerCase().startsWith(initial)) return candidate;
    }
    return null;
  };

  const select = (index: number) => {
    const theme = ordered[index];
    if (!theme) return;
    tileRefs.current[index]?.focus();
    onSelect(theme.id);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const count = ordered.length;
    let next: number | null;
    if (event.key === 'ArrowRight') next = (activeIndex + 1) % count;
    else if (event.key === 'ArrowLeft') next = (activeIndex - 1 + count) % count;
    // A row step that leaves the grid stays put. Clamping to an INDEX would slide
    // sideways instead (Down from Mint would land on Peach) and re-theme the app.
    else if (event.key === 'ArrowDown') next = activeIndex + COLUMNS < count ? activeIndex + COLUMNS : activeIndex;
    else if (event.key === 'ArrowUp') next = activeIndex - COLUMNS >= 0 ? activeIndex - COLUMNS : activeIndex;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = count - 1;
    else if (isTypeAheadKey(event)) next = nextByInitial(activeIndex, event.key);
    else return;
    // A letter no name starts with is left alone, so nothing the panel binds is eaten.
    if (next === null) return;
    // Only the keys actually handled are swallowed: Escape and Ctrl+F still reach the panel.
    event.preventDefault();
    event.stopPropagation();
    if (next !== activeIndex) select(next);
  };

  return (
    <div role="radiogroup" aria-label={ariaLabel} onKeyDown={handleKeyDown} className="space-y-2">
      {sections.map((section, sectionIndex) => {
        // Where this section starts in the flat order the keyboard walks.
        const offset = sections.slice(0, sectionIndex).reduce((sum, earlier) => sum + earlier.themes.length, 0);
        return (
          <React.Fragment key={section.base}>
            {/* The `SectionHeader` h3 classes, so the group labels read as the panel's own. */}
            <div className="text-xs font-semibold uppercase tracking-wider text-fg-faint pt-1 first:pt-0">{section.label}</div>
            {/* The column count is `COLUMNS`, which the Up/Down row math reads too, so the
                two cannot drift apart; `grid-cols-3` would be a second copy of it. */}
            <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${COLUMNS}, minmax(0, 1fr))` }}>
              {section.themes.map((theme, themeIndex) => {
                const index = offset + themeIndex;
                return (
                  <ThemeTile
                    key={theme.id}
                    ref={(element) => { tileRefs.current[index] = element; }}
                    id={theme.id}
                    label={theme.label}
                    brand={theme.group === 'kangentic'}
                    selected={index === activeIndex}
                    muted={muteUnselected && index !== activeIndex}
                    onSelect={() => onSelect(theme.id)}
                    onHover={() => onHover(theme.id)}
                  />
                );
              })}
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}

interface ThemeTileProps {
  id: ThemeMode;
  label: string;
  /** The product pair carries the brand mark in the swatch corner. */
  brand: boolean;
  selected: boolean;
  /**
   * Dim the swatch (not the name, which stays readable) while a pair is chosen and this
   * is not one of it. Hover lifts it back, since the tile still previews and selects.
   */
  muted: boolean;
  onSelect: () => void;
  /** The pointer entered the tile; the grid decides when that becomes a preview. */
  onHover: () => void;
  ref: React.Ref<HTMLButtonElement>;
}

function ThemeTile({ id, label, brand, selected, muted, onSelect, onHover, ref }: ThemeTileProps) {
  return (
    <button
      ref={ref}
      // Not optional: settings tabs can sit inside a <form>, where a bare button submits it.
      type="button"
      role="radio"
      aria-checked={selected}
      // Roving tabindex: the group is one tab stop, arrows move within it.
      tabIndex={selected ? 0 : -1}
      aria-label={label}
      onClick={onSelect}
      onMouseEnter={onHover}
      data-testid={`theme-tile-${id}`}
      data-selected={selected}
      data-muted={muted || undefined}
      // The button paints nothing itself: every state lives on the swatch frame below,
      // so the keyboard halo never wraps the name.
      className="group flex w-full min-w-0 flex-col gap-1.5 text-left focus:outline-none"
    >
      {/* Frame, in the APP's tokens. Selected: a 2px accent ring offset 2px in the panel
          ground. Keyboard focus adds a soft halo outside the ring; focus and selection
          coincide in a radiogroup, so it only ever appears on the selected tile. */}
      <span
        className={`block h-[60px] overflow-hidden rounded-md border transition-[box-shadow,opacity] ${
          selected
            ? 'border-edge ring-2 ring-accent ring-offset-2 ring-offset-surface-raised'
            : 'border-edge group-hover:border-edge-input'
        } ${muted ? 'opacity-55 group-hover:opacity-100 group-focus-visible:opacity-100' : ''} group-focus-visible:outline group-focus-visible:outline-4 group-focus-visible:outline-offset-4 group-focus-visible:outline-accent/30`}
      >
        {/* The swatch, scoped to the theme it shows: everything inside reads THAT palette. */}
        <span aria-hidden="true" className={`relative block h-full w-full theme-${id} bg-surface`}>
          {/* A raised card with body text and its supporting line. */}
          <span className="absolute left-2 top-2 bottom-2 w-[60%] rounded border border-edge bg-surface-raised">
            <span className="absolute left-2 top-2 h-[5px] w-1/2 rounded-full bg-fg" />
            <span className="absolute left-2 top-[18px] h-[5px] w-1/3 rounded-full bg-fg-muted" />
            <span className="absolute left-2 top-[29px] h-[5px] w-[42%] rounded-full bg-fg-muted opacity-55" />
          </span>
          {/* The primary button. */}
          <span className="absolute right-2.5 bottom-2.5 h-[11px] w-7 rounded-full bg-accent" />
          {brand && <BrandMark className="absolute right-2 top-2 h-3.5 w-3.5 text-fg-muted" />}
        </span>
      </span>
      <span className={`truncate text-xs ${selected ? 'font-medium text-fg' : 'text-fg-muted group-hover:text-fg-secondary'}`}>
        {label}
      </span>
    </button>
  );
}
