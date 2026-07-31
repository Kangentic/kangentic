import { useRef, useState, type ClipboardEvent, type KeyboardEvent, type RefObject } from 'react';
import { Paperclip, Eye, PenLine } from 'lucide-react';
import { MarkdownRenderer } from './MarkdownRenderer';
import { DescriptionMentionMenu } from './DescriptionMentionMenu';
import { useDescriptionMentions } from '../hooks/useDescriptionMentions';
import {
  applyTextareaEdit,
  continueListOnEnter,
  indentListSelection,
  linkFromPastedUrl,
  linkSelection,
  shouldConvertPastedHtml,
  toggleWrap,
  type MarkdownEdit,
} from '../utils/markdown-editing';
import { convertHtmlToMarkdown } from '../utils/markdown-paste-html';
import { matchesCombo } from '../utils/keybindings';
import { effectiveCombo } from '../../shared/keybindings';

// Fixed (non-rebindable) formatting combos, registered in KEYBINDINGS for
// display/conflict-detection only; actual handling lives in
// handleTextareaKeyDown / handlePaste below. See keybindings-registry.md.
const BOLD_COMBO = effectiveCombo('description.bold');
const ITALIC_COMBO = effectiveCombo('description.italic');
const LINK_COMBO = effectiveCombo('description.link');
const PASTE_PLAIN_COMBO = effectiveCombo('description.pastePlain');

/**
 * The toggle is a labelled pill, not a bare icon. An icon alone was a 26px
 * target adrift in a large empty field and, at rest, read as decoration rather
 * than a control - the word carries both the hit area and the affordance, the
 * way GitHub's Write/Preview tabs do, without spending a whole row on it.
 */
function toggleButtonClass(active: boolean): string {
  return `inline-flex items-center gap-1.5 rounded border px-2 py-1 text-xs transition active:scale-95 ${
    active
      ? 'border-accent/30 bg-accent/15 text-accent-fg'
      : 'border-edge-input bg-surface-input/80 text-fg-muted hover:text-fg hover:bg-surface-hover'
  }`;
}

interface DescriptionEditorProps {
  value: string;
  onChange: (value: string) => void;
  onPaste?: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  testId?: string;
  placeholder?: string;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  mentionSearchCwd?: string | null;
  /**
   * Extra classes for the editor root. Pass `flex-1` so the editor absorbs the
   * available height inside a flex-column dialog body (e.g. when maximized).
   */
  className?: string;
}

export function DescriptionEditor({
  value,
  onChange,
  onPaste,
  testId = 'description',
  placeholder = 'Describe the task for the agent...',
  textareaRef,
  mentionSearchCwd = null,
  className,
}: DescriptionEditorProps) {
  const [showPreview, setShowPreview] = useState(false);
  const internalTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const resolvedTextareaRef = textareaRef ?? internalTextareaRef;
  // Set on a Mod+Shift+V keydown (which natively fires a real 'paste' event,
  // just like Mod+V), read and cleared at the top of handlePaste. Paste
  // events carry no modifier state, so this is the only way to tell "was
  // Shift held" by the time the paste handler runs.
  const pastePlainRef = useRef(false);
  const mentions = useDescriptionMentions({
    value,
    onChange,
    mentionSearchCwd,
    disabled: showPreview,
    textareaRef: resolvedTextareaRef,
  });

  const togglePreview = () => {
    const nextShowPreview = !showPreview;
    setShowPreview(nextShowPreview);
    // Returning to the source view hands focus back to the textarea, which the
    // click just moved to the toggle button. Deferred a frame because the
    // textarea is still `inert` until React commits this state change, and
    // focusing an inert element is silently refused. Driven from the click
    // rather than an effect so it fires only on a real user toggle, never on
    // mount (where it would steal focus from a dialog's autofocused field).
    if (!nextShowPreview) {
      requestAnimationFrame(() => resolvedTextareaRef.current?.focus());
    }
  };

  const handleTextareaKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    mentions.handleTextareaKeyDown(event);
    if (event.defaultPrevented) return;

    const textarea = event.currentTarget;
    const { selectionStart, selectionEnd, value: textValue } = textarea;
    const nativeEvent = event.nativeEvent;

    if (matchesCombo(nativeEvent, PASTE_PLAIN_COMBO)) {
      pastePlainRef.current = true;
      return;
    }

    // Any other keystroke means the paste the Mod+Shift+V keydown was arming
    // never arrived, so drop the arm here rather than carry it until blur:
    // otherwise a combo that does not map to paste on some platform leaves it
    // set, and the next ordinary Mod+V silently skips HTML conversion. Same
    // defense as the blur clear below, just a much tighter window.
    pastePlainRef.current = false;

    // Enter and Tab are only ours as BARE presses. Mod+Enter belongs to the
    // terminal (terminal.sendNewline) and Ctrl/Alt+Tab to the OS or the
    // window; swallowing either here would shadow a binding this editor does
    // not own.
    const hasNonShiftModifier = event.ctrlKey || event.metaKey || event.altKey;

    if (event.key === 'Enter' && !event.shiftKey && !hasNonShiftModifier && selectionStart === selectionEnd) {
      const edit = continueListOnEnter(textValue, selectionStart);
      if (edit) {
        event.preventDefault();
        applyTextareaEdit(textarea, edit, onChange);
        return;
      }
    }

    if (event.key === 'Tab' && !hasNonShiftModifier) {
      const edit = indentListSelection(textValue, selectionStart, selectionEnd, { outdent: event.shiftKey });
      if (edit) {
        event.preventDefault();
        applyTextareaEdit(textarea, edit, onChange);
      }
      return;
    }

    if (matchesCombo(nativeEvent, BOLD_COMBO)) {
      event.preventDefault();
      applyTextareaEdit(textarea, toggleWrap(textValue, selectionStart, selectionEnd, '**'), onChange);
      return;
    }

    if (matchesCombo(nativeEvent, ITALIC_COMBO)) {
      event.preventDefault();
      applyTextareaEdit(textarea, toggleWrap(textValue, selectionStart, selectionEnd, '_'), onChange);
      return;
    }

    if (matchesCombo(nativeEvent, LINK_COMBO)) {
      event.preventDefault();
      applyTextareaEdit(textarea, linkSelection(textValue, selectionStart, selectionEnd), onChange);
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const pastePlain = pastePlainRef.current;
    pastePlainRef.current = false;

    onPaste?.(event);
    if (event.defaultPrevented) return;
    if (pastePlain) return;

    const textarea = event.currentTarget;
    const clipboardData = event.clipboardData;
    const { selectionStart, selectionEnd, value: textValue } = textarea;
    // Read every clipboard flavor synchronously: the DataTransfer is only
    // valid for the duration of the event, so it cannot be read after an await.
    // Newlines are normalized on the way in. A textarea's `value` getter is
    // guaranteed `\n`-only, but nothing guarantees that of the raw clipboard
    // string, and the caret arithmetic below measures the string we were handed
    // against the value we read back. If a CRLF source ever does survive to
    // here, that mismatch overcounts by one per pair, and the non-execCommand
    // path writes bare `\r` into the saved description. Cheap insurance either
    // way: a no-op on a string that is already `\n`-only.
    const plainText = clipboardData.getData('text/plain').replace(/\r\n?/g, '\n');
    const html = clipboardData.getData('text/html');

    if (selectionStart !== selectionEnd) {
      const urlEdit = linkFromPastedUrl(textValue, selectionStart, selectionEnd, plainText);
      if (urlEdit) {
        event.preventDefault();
        applyTextareaEdit(textarea, urlEdit, onChange);
        return;
      }
    }

    if (html && shouldConvertPastedHtml(html)) {
      event.preventDefault();
      const insertAtCaret = (text: string) => {
        // Re-read the caret rather than reusing the pre-await position: the
        // conversion is async, so the user may have moved or typed since.
        const caretStart = textarea.selectionStart;
        const caretEnd = textarea.selectionEnd;
        const edit: MarkdownEdit = {
          replaceStart: caretStart,
          replaceEnd: caretEnd,
          insert: text,
          selectionStart: caretStart + text.length,
          selectionEnd: caretStart + text.length,
        };
        applyTextareaEdit(textarea, edit, onChange);
      };
      void convertHtmlToMarkdown(html)
        .then(insertAtCaret)
        // We already preventDefault'd, so a failed conversion must still
        // deliver something; fall back to the plain-text flavor rather than
        // silently dropping the user's paste.
        .catch(() => insertAtCaret(plainText));
      return;
    }

    // Falls through: native plain-text paste.
  };

  return (
    <div className={`rounded border border-edge-input overflow-hidden focus-within:border-accent flex flex-col ${className ?? ''}`}>
      {/* Deliberately a fixed floor, not a box that grows with its content.
          Content-driven growth was tried and reverted: a long description pushed
          the fields below the editor (attachments, priority, branch, and the
          Column Settings / Agent Override run-mode controls) under the fold, and
          the windowed dialog neither scrolls nor caps its own height, so the
          footer went off-screen too. Maximizing the dialog is the affordance for
          wanting more room, and it works because every caller passes `flex-1`:
          with a definite height to distribute the editor absorbs all the
          leftover space and this floor stops mattering.

          160 restores the vertical footprint the editor had before the
          full-width Write/Preview tab strip was removed (that strip was ~29px on
          top of a 120px body), plus a few pixels. Do not raise it much further:
          at 280 a To Do task with attachments had to be scrolled to reach its
          own run-mode controls. */}
      <div
        className="relative w-full bg-surface flex-1 min-h-[160px] overflow-hidden"
        data-testid="description-editor-body"
      >
        <textarea
          ref={resolvedTextareaRef}
          data-testid={testId}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onChangeCapture={mentions.handleTextareaChangeCapture}
          onPaste={handlePaste}
          onBlur={() => {
            mentions.handleTextareaBlur();
            // A Mod+Shift+V keydown arms pastePlainRef expecting the browser's
            // own paste-and-match-style command to follow immediately. If
            // focus leaves before that happens (e.g. the combo isn't wired to
            // paste on this platform), clear it so it cannot silently disable
            // HTML conversion on a later, unrelated paste.
            pastePlainRef.current = false;
          }}
          onKeyDown={handleTextareaKeyDown}
          onSelect={mentions.handleTextareaSelect}
          onClick={mentions.handleTextareaClick}
          inert={showPreview}
          className="absolute inset-0 w-full h-full bg-transparent pl-3 pr-28 py-2 text-sm text-fg focus:outline-none resize-none overflow-y-auto"
        />
        {mentions.menuOpen && (
          <DescriptionMentionMenu
            items={mentions.items}
            isLoading={mentions.isLoading}
            activeIndex={mentions.activeIndex}
            helperText={mentions.helperText}
            onSelect={mentions.selectItem}
            onHover={mentions.setActiveIndex}
          />
        )}
        {/* No focus-gated dimming on the empty state below. It used to sit at
            40% opacity until the textarea was focused, which faded it exactly
            when it is most needed: an unfocused empty box is the moment someone
            is deciding what to type, and on a fresh dialog focus starts in the
            title field, so the placeholder was barely legible. The muted tokens
            already carry the "this is placeholder, not content" signal without a
            second multiplier. */}
        {!value && !showPreview && (
          <div className="absolute inset-0 pointer-events-none">
            {/* Two independent layers rather than one column. Stacking them made
                the drop hint centre itself in the space LEFT OVER under the
                text, which reads as sitting too low; centring it on the whole
                box instead puts it where the eye expects. */}
            {/* Placeholder only. A "Markdown supported" line used to sit under
                it and was cut: this dialog is opened constantly, and a standing
                label restating what the Preview pill already implies reads as
                overbearing. Do not restore it. */}
            <div className="absolute inset-x-0 top-0 pl-3 pr-28 py-2">
              <span className="block text-sm text-fg-faint">{placeholder}</span>
            </div>
            {/* A single compact row, not a stacked panel: the editor rests at
                160px, so the old 20px icon over its own line of text took up
                roughly half the box for a secondary hint. */}
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="inline-flex items-center gap-2 rounded-md border border-dashed border-edge px-3 py-1.5 text-xs text-fg-disabled">
                <Paperclip size={14} />
                Paste or drop files here
              </span>
            </div>
          </div>
        )}
        {showPreview && (
          <div
            className="absolute inset-0 bg-surface pl-3 pr-28 py-2 overflow-y-auto"
            data-testid="description-preview"
          >
            {value ? (
              <MarkdownRenderer content={value} />
            ) : (
              <span className="text-sm text-fg-faint">Nothing to preview</span>
            )}
          </div>
        )}
        <button
          type="button"
          onClick={togglePreview}
          // Inset equally on both axes so it reads as sitting in the corner
          // rather than pinned to the top edge. 12px is set by the horizontal
          // requirement - it clears the textarea's 8px scrollbar with a 4px gap,
          // and sitting flush in the corner instead would put the pill directly
          // on the scrollbar track, which read as one broken control - so the
          // top simply matches it.
          className={`absolute top-3 right-3 z-10 ${toggleButtonClass(showPreview)}`}
          title={showPreview ? 'Back to writing markdown' : 'Preview rendered markdown'}
          aria-pressed={showPreview}
          data-testid="description-preview-toggle"
        >
          {showPreview ? <PenLine size={13} /> : <Eye size={13} />}
          {/* "Write" / "Preview" rather than "Source": it is the vocabulary
              every git forge uses for this exact control, so it is what a user
              arrives already knowing. */}
          {showPreview ? 'Write' : 'Preview'}
        </button>
      </div>
    </div>
  );
}
