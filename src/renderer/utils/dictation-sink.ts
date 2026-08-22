/**
 * Where a dictation session writes, abstracted over the two kinds of target.
 *
 * `useDictation` writes to its target from four places - each streaming partial,
 * the clear/"scratch that" path, and the two release branches (submit or
 * populate-only). Branching on target kind at all four was the alternative, and
 * it puts the same "which surface is this" decision in four places that must
 * agree; a sink decides once, at press time, and every write after that is
 * unconditional.
 *
 * The two implementations are genuinely different mechanisms, not two spellings
 * of one. A terminal is another process: text goes over IPC as bytes, an
 * erase is a run of DEL characters, and submitting is a main-process paste
 * engine that presses Enter as a separate settled keystroke. A text input is a
 * DOM node this renderer owns: text goes in through the native value setter, an
 * erase is just writing the empty string back over the anchored span, and
 * submitting is an Enter the field's own handler already understands.
 */

import type { DictationTarget } from './dictation-target';
import type { WebviewElement } from '../components/browser/webview-types';
import { writeGuestField } from './guest-text-target';
import {
  composeTextTargetValue,
  mayAutoSubmit,
  submitTextTarget,
  writeContentEditable,
  writeTextTarget,
  type ContentEditableTarget,
  type TextTargetElement,
} from './text-target';

export interface DictationSink {
  /** Replace whatever this session has written so far with `text`. Called for
   *  every streaming partial, so it must be a replace and not an append. */
  write(text: string): void;
  /** Replace the preview with `text` and commit it, if the surface can commit.
   *  `autoSubmit` off means "populate only", which is a plain `write`. */
  submit(text: string, autoSubmit: boolean): void;
  /** Erase everything this session has written, leaving the field as it was. */
  clear(): void;
}

/**
 * A terminal sink. Text is streamed with `liveWrite` (DELs to erase the previous
 * partial, then the new one) and committed by `submit`, which erases, pastes,
 * and presses Enter in the main process - a `\r` appended to a `liveWrite` does
 * NOT submit, because the agent's TUI reads the Enter in the same write as the
 * text with stale state.
 *
 * `onSubmitStarted` / `onSubmitSettled` let the hook keep its guard against a
 * new push-to-talk landing bytes in the middle of an in-flight bracketed paste.
 */
function createTerminalSink(
  sessionId: string,
  callbacks: { onSubmitStarted: () => void; onSubmitSettled: () => void },
): DictationSink {
  let written = '';

  const replaceWith = (text: string): void => {
    window.electronAPI.dictation.liveWrite(sessionId, '\x7f'.repeat(written.length) + text);
    written = text;
  };

  return {
    write: replaceWith,
    submit(text, autoSubmit) {
      const eraseCount = written.length;
      written = '';
      if (!autoSubmit || text.trim().length === 0) {
        window.electronAPI.dictation.liveWrite(sessionId, '\x7f'.repeat(eraseCount) + text);
        return;
      }
      // Fire-and-forget so the chip closes immediately; the caller's guard is
      // what blocks a new press until the paste settles.
      callbacks.onSubmitStarted();
      void window.electronAPI.dictation
        .submit(sessionId, text, eraseCount)
        .finally(callbacks.onSubmitSettled);
    },
    clear() {
      if (written.length === 0) return;
      window.electronAPI.dictation.liveWrite(sessionId, '\x7f'.repeat(written.length));
      written = '';
    },
  };
}

/**
 * A text-input sink.
 *
 * The anchor is captured ONCE, here, at press time - the value and selection the
 * field had before a single word was spoken. Every later write rewrites that one
 * span, which is what makes a revised partial replace itself in place instead of
 * stuttering the sentence out again. Reading the selection back off the element
 * per write would not work: the previous write already moved it.
 *
 * A selection that was live at press time is REPLACED, matching what typing over
 * it would have done.
 */
function createInputSink(element: TextTargetElement): DictationSink {
  const baseValue = element.value;
  const anchorStart = element.selectionStart ?? baseValue.length;
  const anchorEnd = element.selectionEnd ?? anchorStart;
  let written = '';

  const replaceWith = (text: string): boolean => {
    const composed = composeTextTargetValue({ baseValue, anchorStart, anchorEnd, text });
    // A pane can close mid-dictation. `writeTextTarget` reports the detached
    // case rather than silently no-op'ing, so `written` stays honest.
    if (!writeTextTarget(element, composed.value, composed.caret)) return false;
    written = text;
    return true;
  };

  return {
    write: (text) => void replaceWith(text),
    submit(text, autoSubmit) {
      const landed = replaceWith(text);
      // Committed text is no longer ours to erase, so a later `clear()` must not
      // reach back and delete it. The terminal sink zeroes its own count at the
      // same point, for the same reason.
      written = '';
      if (!landed) return;
      if (!autoSubmit || text.trim().length === 0) return;
      // Re-checked here, against the live DOM, rather than trusted from press
      // time: a form can gain or lose fields while the user is speaking.
      if (!mayAutoSubmit(element)) return;
      // Enter, so "release the hotkey" and "press Enter" are the same act. The
      // field owns what that means; for the Browser pane's note input it sends
      // the capture and the note to the agent.
      submitTextTarget(element);
    },
    clear() {
      if (written.length === 0) return;
      replaceWith('');
    },
  };
}

/**
 * A guest-page sink: a field inside a Browser pane's `<webview>`.
 *
 * Same shape as the input sink, one process further away. The anchor is taken
 * from the PROBE the caller already did rather than read here, because reading
 * it needs a round trip and the caller has to make one anyway to decide whether
 * the field was eligible at all.
 *
 * Every write is fire-and-forget. `executeJavaScript` is a promise, partials
 * arrive faster than awaiting each one would allow, and they are idempotent -
 * each carries the WHOLE composed value, so a late one simply overwrites an
 * earlier one with a superset. Awaiting would serialise the stream behind the
 * round trip for no gain.
 */
function createGuestSink(
  webview: WebviewElement,
  anchor: { baseValue: string; anchorStart: number; anchorEnd: number; richText: boolean },
): DictationSink {
  let written = '';

  const replaceWith = (text: string): void => {
    const previousLength = written.length;
    written = text;
    if (anchor.richText) {
      // A rich-text host has no value to recompose; it replaces its own last
      // insertion instead, exactly as the host-side contenteditable sink does.
      void writeGuestField(webview, text, text.length, previousLength);
      return;
    }
    const composed = composeTextTargetValue({ ...anchor, text });
    void writeGuestField(webview, composed.value, composed.caret);
  };

  return {
    write: replaceWith,
    // A guest field is FILLED, never submitted. `autoSubmit` is accepted for the
    // shared interface and deliberately ignored: pressing Enter in someone
    // else's page commits a form we know nothing about. See the header of
    // `guest-text-target.ts` for why the alternative was worse.
    submit(text) {
      replaceWith(text);
      written = '';
    },
    clear() {
      if (written.length === 0) return;
      replaceWith('');
      written = '';
    },
  };
}

/**
 * A rich-text sink: a `contenteditable` host.
 *
 * Unlike the input sink this keeps no value anchor, only how many characters it
 * last inserted. A contenteditable holds a DOM tree rather than a string, so
 * "recompose the whole value" is not available - but "select back over what I
 * wrote and replace it" is, and that is all a revised partial needs.
 */
function createContentEditableSink(element: ContentEditableTarget): DictationSink {
  let written = '';

  const replaceWith = (text: string): boolean => {
    if (!writeContentEditable(element, text, written.length)) return false;
    written = text;
    return true;
  };

  return {
    write: (text) => void replaceWith(text),
    submit(text, autoSubmit) {
      const landed = replaceWith(text);
      written = '';
      if (!landed) return;
      if (!autoSubmit || text.trim().length === 0) return;
      // A rich-text editor almost always treats Enter as a NEWLINE rather than
      // a commit, so auto-submit here would insert a line break instead of
      // sending anything. Deliberately not pressing it: inserting the text and
      // leaving it is the honest outcome.
    },
    clear() {
      if (written.length === 0) return;
      replaceWith('');
      written = '';
    },
  };
}

export function createDictationSink(
  target: DictationTarget,
  callbacks: {
    onSubmitStarted: () => void;
    onSubmitSettled: () => void;
    /** The guest field's value and selection at press time. Required for a guest
     *  target and ignored otherwise; the caller has already probed for it. */
    guestAnchor?: { baseValue: string; anchorStart: number; anchorEnd: number; richText: boolean };
  },
): DictationSink | null {
  if (target.kind === 'input') return createInputSink(target.element);
  if (target.kind === 'contenteditable') return createContentEditableSink(target.element);
  if (target.kind === 'terminal') return createTerminalSink(target.sessionId, callbacks);
  // A refusal is not a destination: there is deliberately nowhere to write.
  if (target.kind === 'refused') return null;
  // A guest target with no probe cannot be written to. Null rather than a
  // no-op sink, so the caller reports "no target" instead of silently
  // swallowing the user's speech.
  if (!callbacks.guestAnchor) return null;
  return createGuestSink(target.webview, callbacks.guestAnchor);
}
