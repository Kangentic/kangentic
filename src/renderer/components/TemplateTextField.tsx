/**
 * A textarea that PAINTS its template variables, over a mirror that renders the
 * same string twice.
 *
 * Why a mirror and not a richer control. `contenteditable` loses native undo,
 * IME composition and selection, and it stops the control being a `<textarea>`,
 * which the UI specs' `fill()`, `spliceAtRange`'s caret math and screen readers
 * all depend on. Monaco is the read-only diff viewer and the wrong paradigm for
 * a three-line field. So the textarea stays exactly what it was and a
 * `pointer-events: none` sibling underneath paints the same characters with the
 * variables highlighted, with the textarea's own text set transparent.
 *
 * The geometry is not new. `DescriptionEditor` already puts a
 * transparent-background textarea at `absolute inset-0` over an `absolute
 * inset-0 pointer-events-none` sibling. What IS new here is rendering the value
 * twice at once, which makes the two layers' type metrics load-bearing: any
 * difference in font, size, weight, letter-spacing, line-height, padding or
 * wrapping drifts the paint away from the caret. `LAYER_CLASS` is therefore ONE
 * string both layers use, and `template-text-field.spec.ts` compares the two
 * layers' computed styles key by key so an edit to one of them fails loudly
 * rather than shipping a highlighter that slides.
 *
 * TEXTAREA FIELDS ONLY, deliberately, though the plan said every field carrying
 * template variables. The three `text` fields (a webhook URL, a notification
 * title and body) are `<input>`s, and mirroring an input is a second geometry
 * with its own drift surface: no wrapping, a horizontal `scrollLeft` to sync,
 * and a different overflow model. It would buy very little, because on those
 * three a variable is usually the WHOLE value (`{{title}}` and `{{toColumn}}`
 * are literally the defaults), so there is nothing for a highlight to pick out.
 * They keep the picker button they already have.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { templateVarsFor } from '../../shared/task-template-vars';
import type { TaskTemplateContextName, TaskTemplateVarInfo } from '../../shared/task-template-vars';
import {
  detectTemplateVariableTrigger,
  spliceAtRange,
  splitTemplateSegments,
} from './dialogs/board-manager/automation-drafts';

/**
 * Every property that decides where a character lands, set once for both
 * layers. Split out of the per-layer classes so neither can be edited alone.
 *
 * `resize-none` is part of it: the textarea sits over the mirror at `inset-0`,
 * so a user drag-resizing only the textarea would slide the two apart. The
 * field's `rows` decides the height.
 */
const LAYER_CLASS = 'w-full px-3 py-1.5 text-sm font-sans leading-5 tracking-normal '
  + 'whitespace-pre-wrap break-words resize-none';

/**
 * A painted `{{variable}}`, given room to breathe WITHOUT moving a glyph.
 *
 * Horizontal padding is cancelled by an equal negative margin, so the
 * background grows while the element's advance stays exactly the text's own.
 * That is not a trick for its own sake: the mirror has to lay out
 * identically to the transparent textarea above it, so padding that actually
 * consumed width would push every later character out of step with the caret -
 * the drift `LAYER_CLASS` and the computed-style parity test exist to prevent.
 *
 * Vertical padding is free and needs no counterweight: padding on an INLINE box
 * paints but does not grow the line box, so 1px above and below thickens the
 * pill without moving any line. It stays at 1px because `leading-5` over 14px
 * type leaves only a few pixels before pills on consecutive wrapped lines touch.
 */
const PILL_CLASS = 'rounded py-[1px]';

/**
 * The horizontal halves of that padding, applied per SIDE and only where the
 * neighbouring character is a space or the end of the value.
 *
 * Because the padding paints outward without taking width, a character typed
 * directly against a pill lands ON its background: type `s` after
 * `{{description}}` and the `s` sits inside the blue. Padding only where there
 * is real whitespace to paint into means the background can never reach a
 * glyph, and the common case - a variable with spaces around it - still gets
 * its room. A pill wedged between two characters simply hugs its text, which is
 * the only honest answer when nothing is there to borrow.
 *
 * 1px, because the space it paints into is the whole budget. A space in this
 * field measures 3.8px (14px system sans, measured), so the 4px this started at
 * covered the entire space and a sliver of the glyph past it: the pill ended up
 * touching the words on both sides, with no gap left to read as a space. 1px
 * leaves about three quarters of the space showing and still paints the pill
 * fractionally wider than its own text. Anything the eye reads as real padding
 * costs the gap, and the gap is what says these are separate words.
 */
const PILL_PAD_LEFT = 'pl-px -ml-px';
const PILL_PAD_RIGHT = 'pr-px -mr-px';

/** Whether a pill may paint into the character on `side`: only a space or an edge. */
function canPadInto(neighbour: string | undefined): boolean {
  return neighbour === undefined || /\s/.test(neighbour);
}

/**
 * A chip with the space the writer would have typed next.
 *
 * Accepting a variable should leave the caret ready for the rest of the
 * sentence, not butted against `}}` waiting for a spacebar press nobody wants
 * to make. `spliceAtRange` puts the caret after everything it inserted, so the
 * space carries it along.
 *
 * Skipped when the text already continues with whitespace, which is what
 * happens when a variable is replaced in the middle of a line: adding another
 * would double the gap every time someone re-picked.
 */
function chipWithTrailingSpace(value: string, insertEnd: number, chip: string): string {
  // Deliberately not `canPadInto`, which looks like the same test and is not:
  // that one treats the END of the value as room to paint into, while here the
  // end is exactly where a space is most wanted.
  const next = value[insertEnd];
  return next !== undefined && /\s/.test(next) ? chip : `${chip} `;
}

export interface TemplateTextFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** Which catalog this field offers, so a spawn prompt never offers a move's variables. */
  context: TaskTemplateContextName;
  testId: string;
  rows?: number;
  placeholder?: string;
  ariaLabel?: string;
  /**
   * Filled with this field's caret-aware inserter, so the label row's Template
   * variable button can insert without owning the textarea. A ref rather than a
   * callback prop because the button sits OUTSIDE this component, beside the
   * field's label, and hoisting the whole label row in here just to reunite
   * them would put the field's label inside the field.
   */
  insertRef?: React.RefObject<TemplateTextFieldInsert | null>;
}

export function TemplateTextField({
  value,
  onChange,
  context,
  testId,
  rows = 3,
  placeholder,
  ariaLabel,
  insertRef,
}: TemplateTextFieldProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  const [trigger, setTrigger] = useState<{ query: string; rangeStart: number; rangeEnd: number } | null>(null);
  const [storedActiveIndex, setActiveIndex] = useState(0);

  const available = useMemo(() => templateVarsFor(context), [context]);
  const known = useMemo(() => new Set(available.map((info) => info.name as string)), [available]);

  const segments = useMemo(() => splitTemplateSegments(value), [value]);
  const unknown = useMemo(
    () => segments.filter((segment) => segment.variable !== null && !known.has(segment.variable)),
    [segments, known],
  );

  const matches = useMemo((): readonly TaskTemplateVarInfo[] => {
    if (!trigger) return [];
    const query = trigger.query.toLowerCase();
    return available.filter((info) => info.name.toLowerCase().includes(query));
  }, [trigger, available]);

  // Clamp rather than reset: retyping a character that narrows the list should
  // not throw the highlight back to the top every keystroke. A derivation, not
  // an effect writing the state back: the stored index survives the narrowing
  // and reads as 0 only while it is out of range.
  const activeIndex = storedActiveIndex < matches.length ? storedActiveIndex : 0;

  /** Mirror the textarea's scroll so a long value keeps the paint on the text. */
  const syncScroll = useCallback(() => {
    const textarea = textareaRef.current;
    const mirror = mirrorRef.current;
    if (!textarea || !mirror) return;
    mirror.scrollTop = textarea.scrollTop;
    mirror.scrollLeft = textarea.scrollLeft;
  }, []);

  const refreshTrigger = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    setTrigger(detectTemplateVariableTrigger(
      textarea.value,
      textarea.selectionStart ?? 0,
      textarea.selectionEnd ?? 0,
    ));
  }, []);

  const commit = useCallback((next: string, cursor: number) => {
    onChange(next);
    setTrigger(null);
    // The rAF is load-bearing, and it is the same one the shipped message field
    // carried: `onChange` re-renders a controlled textarea, and setting the
    // selection before that paint lands puts the caret back where the old value
    // ended.
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(cursor, cursor);
    });
  }, [onChange]);

  const accept = useCallback((info: TaskTemplateVarInfo) => {
    if (!trigger) return;
    const { text, cursor } = spliceAtRange(
      value,
      trigger.rangeStart,
      trigger.rangeEnd,
      chipWithTrailingSpace(value, trigger.rangeEnd, info.chip),
    );
    commit(text, cursor);
  }, [trigger, value, commit]);

  /** Insert at the caret from the outside, which is what the label row's button calls. */
  const insertAtCaret = useCallback((chip: string) => {
    const textarea = textareaRef.current;
    if (!textarea) {
      onChange(`${value}${chip} `);
      return;
    }
    const end = textarea.selectionEnd ?? value.length;
    const { text, cursor } = spliceAtRange(
      value,
      textarea.selectionStart ?? value.length,
      end,
      chipWithTrailingSpace(value, end, chip),
    );
    commit(text, cursor);
  }, [value, onChange, commit]);

  // Re-published on every change to `insertAtCaret`, which closes over the
  // current value. A ref assigned once during the first render would keep
  // splicing into the value this field had when it mounted.
  useEffect(() => {
    if (!insertRef) return;
    insertRef.current = insertAtCaret;
    return () => { insertRef.current = null; };
  }, [insertRef, insertAtCaret]);

  const handleKeyDown =(event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (!trigger || matches.length === 0) return;
    // Stop BEFORE the dialog sees it. This field lives inside a nested dialog
    // whose own Escape handler closes it, and closing the whole editor because
    // someone dismissed an autocomplete is the wrong outcome.
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setTrigger(null);
      return;
    }
    // Step from the CLAMPED index, so a stored index the list has outgrown
    // steps from 0, where the highlight actually is.
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((activeIndex + 1) % matches.length);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((activeIndex - 1 + matches.length) % matches.length);
      return;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      const picked = matches[activeIndex];
      if (picked) accept(picked);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      {/* Two nested boxes, and both are load-bearing. The OUTER one anchors the
          inline picker, which hangs below the field at `top-full` and would be
          clipped away entirely by the inner box's `overflow-hidden`. The INNER
          one carries the border, the background and the focus ring, so neither
          layer paints a background of its own: the textarea sits LATER in DOM
          order and is positioned, so any background on it covers the mirror
          completely. That shipped for exactly one preview: every test passed
          while the field rendered blank, because they assert DOM attributes and
          a blank field has all the right ones. */}
      <div className="relative" data-testid={`${testId}-body`}>
        <div className="relative overflow-hidden rounded border border-edge-input bg-surface-control focus-within:border-accent">
          {/* Under the textarea, and inert. `aria-hidden` because it is the same
              string the textarea already exposes: without it every value is
              announced twice. */}
          <div
            ref={mirrorRef}
            aria-hidden="true"
            data-testid={`${testId}-mirror`}
            className={`${LAYER_CLASS} pointer-events-none absolute inset-0 overflow-hidden text-fg-tertiary`}
          >
            {segments.map((segment, index) => (
              segment.variable === null
                ? <span key={index}>{segment.text}</span>
                : (
                  <span
                    key={index}
                    data-template-variable={segment.variable}
                    data-known={known.has(segment.variable) ? 'true' : 'false'}
                    className={[
                      PILL_CLASS,
                      // The neighbours are the previous run's last character and
                      // the next run's first; `undefined` at either end of the
                      // value, which counts as room.
                      canPadInto(segments[index - 1]?.text.slice(-1)) ? PILL_PAD_LEFT : '',
                      canPadInto(segments[index + 1]?.text[0]) ? PILL_PAD_RIGHT : '',
                      known.has(segment.variable)
                        ? 'bg-accent/15 text-accent'
                        : 'bg-warning/15 text-warning',
                    ].filter(Boolean).join(' ')}
                  >
                    {segment.text}
                  </span>
                )
            ))}
            {/* A value ending in a newline leaves the mirror one line short of
                the textarea, because a trailing line break collapses in flow
                content and does not in a textarea. */}
            {value.endsWith('\n') && <span>{'​'}</span>}
          </div>

          <textarea
            ref={textareaRef}
            data-testid={testId}
            aria-label={ariaLabel}
            value={value}
            rows={rows}
            placeholder={placeholder}
            onChange={(event) => { onChange(event.target.value); refreshTrigger(); }}
            onSelect={refreshTrigger}
            onClick={refreshTrigger}
            onKeyDown={handleKeyDown}
            onScroll={syncScroll}
            onBlur={() => setTrigger(null)}
            // Transparent BOTH ways, and neither is optional. The background
            // would hide the mirror this control exists for; the text would
            // double every character against the mirror's copy. The caret and
            // the selection still come from here, which is what keeps native
            // selection painting and IME correct.
            className={`${LAYER_CLASS} relative block bg-transparent text-transparent caret-fg-tertiary placeholder-fg-muted focus:outline-none overflow-y-auto`}
          />
        </div>

        {trigger && matches.length > 0 && (
          // The Template variable BUTTON's menu is a separate element and IS
          // portaled. This one is the inline `{{` completer, anchored to the
          // caret in the field it completes.
          //
          // popover-inflow-ok: no clipping ancestor at its only mount site.
          // `EditAutomationDialog` is the sole consumer, and its panel root is
          // `overflow-visible` (`BaseDialog.tsx`) while its body is the plain
          // `px-4 py-4` branch, not the `rawBody` one that sets
          // `overflow-hidden`. Re-check if the field gains a second consumer.
          <div
            data-testid={`${testId}-inline-picker`}
            className="absolute left-0 right-0 top-full z-50 mt-1 max-h-56 overflow-y-auto rounded-lg border border-edge bg-surface py-1 shadow-xl"
          >
            {matches.map((info, index) => (
              <button
                key={info.name}
                type="button"
                data-testid={`${testId}-inline-option`}
                data-name={info.name}
                data-active={index === activeIndex ? 'true' : 'false'}
                // `mousedown`, not `click`: the textarea's blur closes the
                // picker, and blur fires first, so a click listener never runs.
                onMouseDown={(event) => { event.preventDefault(); accept(info); }}
                onMouseEnter={() => setActiveIndex(index)}
                className={`flex w-full cursor-pointer flex-col gap-0.5 px-3 py-1.5 text-left ${
                  index === activeIndex ? 'bg-surface-hover' : ''
                }`}
              >
                <span className="font-mono text-xs text-fg">{info.chip}</span>
                <span className="line-clamp-1 text-[11px] text-fg-faint" title={info.description}>
                  {info.description}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {unknown.length > 0 && (
        // Named, not counted. "1 unknown variable" makes the reader hunt for it.
        // Worded as a fact rather than a failure: an unknown name is passed
        // through literally by every interpolator, so nothing breaks, it just
        // does not substitute.
        <span data-testid={`${testId}-unknown`} className="text-[11px] text-warning">
          {unknown.length === 1
            ? `Unknown variable: ${unknown[0].variable}. It will be sent as written.`
            : `Unknown variables: ${unknown.map((segment) => segment.variable).join(', ')}. They will be sent as written.`}
        </span>
      )}
    </div>
  );
}

export type TemplateTextFieldInsert = (chip: string) => void;
