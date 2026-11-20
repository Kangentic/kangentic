import { useEffect, useLayoutEffect, useRef, type ClipboardEvent, type KeyboardEvent, type ReactElement, type ReactNode, type RefObject } from 'react';
import { useLingui } from '@lingui/react/macro';
import { PATTERN_LINE_BREAK } from '../../../../shared/final-line-match';

/**
 * A Text match's patterns, one input per line, with a 1px divider between
 * lines (#1072 canvas, board 20E-A). One pattern looks like a plain field.
 *
 * Lines are added and removed as in a text editor (board 20F): Enter splits
 * the line at the caret (at the end, a new empty line below), Backspace at the
 * start joins the line to the one above (an empty line is removed, unless it
 * is the only one), Delete at the end joins the next line, the up and down
 * arrows move between lines, and a paste with line breaks splits into lines.
 * Blank lines stay while editing; the save drops them (`normalizeTextMatch`).
 *
 * The value is the lines joined by "\n", the shape the database stores, so a
 * draft carries it unchanged across a Trigger or kind switch.
 */
export interface PatternLinesFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  disabled: boolean;
  testId: string;
  /** Square the right corners, for a field joined to the Template variable button (#872). */
  joinedRight?: boolean;
  /** Drawn inside the field at the first line's right end (the Patterns tip), with the text kept clear of it. */
  endAdornment?: ReactNode;
  /**
   * Filled with an inserter that puts text at the caret of the line last
   * focused (the first line before any is), for the attached Template
   * variable button, which sits outside the field.
   */
  insertRef?: RefObject<((text: string) => void) | null>;
  /** The field's accessible name. Defaults to "Text match". */
  ariaLabel?: string;
}

/** Where the caret goes after an edit: the line, and the offset in it. */
interface CaretTarget {
  line: number;
  offset: number;
}

export function PatternLinesField({
  value, onChange, placeholder, disabled, testId, joinedRight = false, endAdornment, insertRef, ariaLabel,
}: PatternLinesFieldProps): ReactElement {
  const { t } = useLingui();
  const lines = value.split('\n');
  const inputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const pendingCaret = useRef<CaretTarget | null>(null);
  // Where an inserted variable goes: the line last focused, at its caret.
  const lastCaret = useRef<CaretTarget>({ line: 0, offset: 0 });
  const rememberCaret = (index: number, input: HTMLInputElement): void => {
    lastCaret.current = { line: index, offset: input.selectionStart ?? input.value.length };
  };

  useEffect(() => {
    if (!insertRef) return;
    insertRef.current = (text: string) => {
      const currentLines = value.split('\n');
      const line = Math.min(lastCaret.current.line, currentLines.length - 1);
      const lineText = currentLines[line] ?? '';
      const offset = Math.min(lastCaret.current.offset, lineText.length);
      const next = [...currentLines];
      next[line] = lineText.slice(0, offset) + text + lineText.slice(offset);
      lastCaret.current = { line, offset: offset + text.length };
      pendingCaret.current = { line, offset: offset + text.length };
      onChange(next.join('\n'));
    };
    return () => { insertRef.current = null; };
  }, [insertRef, value, onChange]);

  // Moved after the render that made the line, so a new line exists to focus.
  useLayoutEffect(() => {
    const target = pendingCaret.current;
    if (target === null) return;
    pendingCaret.current = null;
    const input = inputRefs.current[target.line];
    if (!input) return;
    input.focus();
    input.setSelectionRange(target.offset, target.offset);
  });

  const commit = (next: string[], caret: CaretTarget | null): void => {
    pendingCaret.current = caret;
    onChange(next.join('\n'));
  };

  const focusLine = (line: number, offset: number): void => {
    const input = inputRefs.current[line];
    if (!input) return;
    input.focus();
    input.setSelectionRange(offset, offset);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>, index: number): void => {
    // An IME composing a character owns its keys.
    if (event.nativeEvent.isComposing) return;
    const input = event.currentTarget;
    const start = input.selectionStart ?? 0;
    const end = input.selectionEnd ?? start;
    const text = lines[index];
    const collapsed = start === end;

    if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      // The dialog's own Enter (nothing) never sees it; Ctrl+S is still Done.
      event.preventDefault();
      const next = [...lines];
      next.splice(index, 1, text.slice(0, start), text.slice(end));
      commit(next, { line: index + 1, offset: 0 });
      return;
    }
    if (event.key === 'Backspace' && collapsed && start === 0 && index > 0) {
      event.preventDefault();
      const above = lines[index - 1];
      const next = [...lines];
      next.splice(index - 1, 2, above + text);
      commit(next, { line: index - 1, offset: above.length });
      return;
    }
    if (event.key === 'Delete' && collapsed && start === text.length && index < lines.length - 1) {
      event.preventDefault();
      const next = [...lines];
      next.splice(index, 2, text + lines[index + 1]);
      commit(next, { line: index, offset: text.length });
      return;
    }
    // A modified arrow (Shift extends the selection to the line's end) keeps
    // the input's own behavior.
    const plainArrow = !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey;
    if (event.key === 'ArrowUp' && plainArrow && index > 0) {
      event.preventDefault();
      focusLine(index - 1, Math.min(start, lines[index - 1].length));
      return;
    }
    if (event.key === 'ArrowDown' && plainArrow && index < lines.length - 1) {
      event.preventDefault();
      focusLine(index + 1, Math.min(start, lines[index + 1].length));
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLInputElement>, index: number): void => {
    const pasted = event.clipboardData.getData('text/plain');
    // A lone CR is a line break too: left to the input, it would be dropped
    // and join two patterns into one.
    if (!PATTERN_LINE_BREAK.test(pasted)) return;
    event.preventDefault();
    const input = event.currentTarget;
    const start = input.selectionStart ?? 0;
    const end = input.selectionEnd ?? start;
    const text = lines[index];
    const pastedLines = pasted.split(PATTERN_LINE_BREAK);
    const last = pastedLines.length - 1;
    pastedLines[0] = text.slice(0, start) + pastedLines[0];
    const caretOffset = pastedLines[last].length;
    pastedLines[last] += text.slice(end);
    const next = [...lines];
    next.splice(index, 1, ...pastedLines);
    commit(next, { line: index + last, offset: caretOffset });
  };

  return (
    <div
      role="group"
      aria-label={ariaLabel ?? t`Text match`}
      data-testid={testId}
      // `FIELD_CONTROL_CLASS`'s fill, border, value and placeholder tones,
      // drawn on the box, with the accent border when any line has focus.
      className={`relative flex w-full flex-col overflow-hidden rounded border border-edge-input bg-surface-control focus-within:border-accent ${joinedRight ? 'rounded-r-none' : ''} ${disabled ? 'opacity-50' : ''}`}
    >
      {endAdornment && (
        // At the first line's end, so the tip sits beside the pattern it explains.
        <span className="absolute right-2 top-[8px] z-[1] flex">{endAdornment}</span>
      )}
      {lines.map((line, index) => {
        const lineNumber = index + 1;
        return (
          <input
            // The index is the line's identity: lines have no id, and a line's
            // position is what the caret moves by.
            key={index}
            ref={(element) => { inputRefs.current[index] = element; }}
            data-testid={`${testId}-line`}
            aria-label={t`Text match, line ${lineNumber}`}
            value={line}
            placeholder={lines.length === 1 ? placeholder : undefined}
            disabled={disabled}
            spellCheck={false}
            onChange={(event) => {
              const next = [...lines];
              next[index] = event.target.value;
              commit(next, null);
            }}
            onKeyDown={(event) => handleKeyDown(event, index)}
            onKeyUp={(event) => rememberCaret(index, event.currentTarget)}
            onSelect={(event) => rememberCaret(index, event.currentTarget)}
            onFocus={(event) => rememberCaret(index, event.currentTarget)}
            onPaste={(event) => handlePaste(event, index)}
            className={`min-w-0 border-0 border-b border-edge-input bg-transparent px-3 py-1.5 text-sm text-fg-tertiary placeholder-fg-muted outline-none last:border-b-0 disabled:cursor-not-allowed ${endAdornment && index === 0 ? 'pr-8' : ''}`}
          />
        );
      })}
    </div>
  );
}
