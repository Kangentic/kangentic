/**
 * The field a Command Terminal's name turns into while it is renamed, in the
 * header and in the rail's Running list. It is the project sidebar's rename
 * field (`ProjectListItem`): the name's own type, no box, an accent underline.
 * It opens with the name selected, so typing replaces it; an empty field shows
 * the slot title it would go back to. Enter or a click elsewhere saves, Escape
 * cancels.
 */

import { useEffect, useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { COMMAND_TERMINAL_NAME_MAX_LENGTH, commandTerminalTitle } from '../../../shared/command-terminal-name';

interface CommandTerminalNameFieldProps {
  /** The name the field opens with: what the terminal is called now. */
  initialName: string;
  /** The terminal's slot, whose title is the placeholder an empty field shows. */
  slot: string;
  /** Save. `byKey` is true for Enter, false for a click elsewhere, which keeps its focus. */
  onCommit: (value: string, byKey: boolean) => void;
  /** Escape. */
  onCancel: () => void;
  /** The type of the name it replaces: the header's title or a rail row's. */
  className: string;
  'data-testid'?: string;
}

export function CommandTerminalNameField({ initialName, slot, onCommit, onCancel, className, ...rest }: CommandTerminalNameFieldProps) {
  const { t } = useLingui();
  const [value, setValue] = useState(initialName);
  const inputRef = useRef<HTMLInputElement>(null);
  // Enter and Escape end the edit before the blur that follows them, which
  // must not save a second time (or save what Escape threw away).
  const doneRef = useRef(false);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  const finish = (outcome: 'enter' | 'blur' | 'escape'): void => {
    if (doneRef.current) return;
    doneRef.current = true;
    if (outcome === 'escape') onCancel();
    else onCommit(value, outcome === 'enter');
  };

  return (
    <input
      ref={inputRef}
      value={value}
      maxLength={COMMAND_TERMINAL_NAME_MAX_LENGTH}
      placeholder={commandTerminalTitle(slot)}
      aria-label={t`Terminal name`}
      spellCheck={false}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => finish('blur')}
      // The header starts a swap drag on a press, and the rail row expands on a
      // click: neither may see a press that places the caret.
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') {
          event.preventDefault();
          finish('enter');
        } else if (event.key === 'Escape') {
          event.preventDefault();
          finish('escape');
        }
      }}
      // The padding is given back as margin, so the text stays where the name was.
      className={`-mx-0.5 min-w-0 flex-1 border-b border-accent bg-transparent px-0.5 text-fg outline-none select-text ${className}`}
      {...rest}
    />
  );
}
