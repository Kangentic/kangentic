import { formatComboSegments, formatCombo } from '../../../utils/keybindings';

/**
 * Renders a canonical combo as a row of styled `<kbd>` elements, platform-aware
 * (Cmd/Ctrl glyphs on macOS, word labels elsewhere). The `aria-label` carries
 * the spoken form so screen readers announce the hotkey once cleanly. The chip
 * styling is identical for rebindable and fixed hotkeys; a lock icon (rendered
 * by the row) is the only differentiator for fixed ones.
 */
export function KeyCombo({ combo }: { combo: string }) {
  const segments = formatComboSegments(combo);
  return (
    <span
      className="inline-flex items-center gap-1"
      data-testid="key-combo"
      aria-label={formatCombo(combo)}
    >
      {segments.map((segment, index) => (
        <kbd
          key={index}
          className="px-1.5 py-0.5 rounded text-[11px] font-medium border min-w-[20px] text-center bg-surface-raised border-edge-input text-fg-secondary"
        >
          {segment}
        </kbd>
      ))}
    </span>
  );
}
