import { useEffect, useRef, useState } from 'react';
import { comboFromEvent, heldMouseTokens, formatCombo, IS_MAC, MODIFIER_KEY_NAMES } from '../../../utils/keybindings';
import { normalizeCombo } from '../../../../shared/keybindings';
import { setRebindCaptureActive } from '../../../utils/rebind-state';
import { KeyCombo } from './KeyCombo';

/**
 * A short list of OS-reserved combos that DO reach the renderer but should never
 * be assigned (they trigger an OS action instead). Keyed by canonical combo,
 * platform-filtered. Most OS-reserved combos never reach us at all; those are
 * caught by the live availability probe and the delayed "no key detected" hint.
 */
const OS_RESERVED_COMBOS: Record<string, string> = IS_MAC
  ? {
      'Mod+Q': 'Cmd+Q quits the app and is reserved by macOS.',
      'Mod+W': 'Cmd+W is reserved by macOS for closing windows.',
    }
  : {
      'Alt+F4': 'Alt+F4 closes the window and is reserved by your OS.',
    };

function reservedComboMessage(combo: string): string | null {
  return OS_RESERVED_COMBOS[normalizeCombo(combo)] ?? null;
}

/** How long to wait, while capturing, before assuming the keypress was swallowed. */
const NO_KEY_HINT_DELAY_MS = 4000;

interface KeyCaptureInputProps {
  /** Current effective combo, shown in the idle state. */
  combo: string;
  /** Called with the captured canonical combo when the user binds a new one. */
  onCommit: (combo: string) => void;
}

/**
 * Inline rebind widget. Idle shows the current combo plus a Rebind button;
 * capturing shows a focused prompt that records the next key chord. On capture it
 * actively probes whether the combo is already owned by the OS or another app
 * (via the main-process global-shortcut probe) and reports that as an error
 * instead of committing a binding that would silently never fire. Escape cancels,
 * clicking away cancels. Listens on its own element so the app's own shortcuts do
 * not fire while capturing.
 */
export function KeyCaptureInput({ combo, onCommit }: KeyCaptureInputProps) {
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [noKeyHint, setNoKeyHint] = useState(false);
  const boxRef = useRef<HTMLButtonElement>(null);
  // Tracks whether capture is still active across the async probe await, so a
  // click-away or Escape during the probe cancels instead of committing.
  const capturingRef = useRef(false);
  // Latest onCommit, read by the document pointer listeners without re-arming
  // them every render (the effect depends only on `capturing`).
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;

  const stopCapturing = () => {
    setCapturing(false);
    capturingRef.current = false;
    setError(null);
    setChecking(false);
    setNoKeyHint(false);
  };

  useEffect(() => {
    if (!capturing) return;
    boxRef.current?.focus();
    // Suspend every app shortcut while capturing so pressing a combo that is
    // already bound (e.g. the mouse button currently driving push-to-talk) is
    // recorded instead of triggering its action.
    setRebindCaptureActive(true);
    // Accumulate the bindable mouse buttons held during this gesture so a chord
    // (e.g. Back + Forward held together) is captured, then committed on release.
    const heldChord = new Set<string>();
    const onPointerDown = (event: PointerEvent) => {
      const heldTokens = heldMouseTokens(event.buttons);
      if (heldTokens.length === 0) {
        // A non-bindable press (left / right): a click outside the box cancels.
        if (boxRef.current && !boxRef.current.contains(event.target as Node)) stopCapturing();
        return;
      }
      // A bindable mouse button: record it as part of the chord and swallow the
      // event so it neither navigates (back / forward) nor fires its binding.
      event.preventDefault();
      event.stopPropagation();
      setNoKeyHint(false);
      setError(null);
      heldTokens.forEach((token) => heldChord.add(token));
    };
    const onPointerUp = (event: PointerEvent) => {
      if (heldChord.size === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const captured = normalizeCombo(Array.from(heldChord).join('+'));
      heldChord.clear();
      if (!capturingRef.current) return;
      stopCapturing();
      onCommitRef.current(captured);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointerup', onPointerUp, true);
    const noKeyTimer = setTimeout(() => setNoKeyHint(true), NO_KEY_HINT_DELAY_MS);
    return () => {
      setRebindCaptureActive(false);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('pointerup', onPointerUp, true);
      clearTimeout(noKeyTimer);
    };
  }, [capturing]);

  const handleKeyDown = async (event: React.KeyboardEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const native = event.nativeEvent;
    if (native.key === 'Escape') {
      stopCapturing();
      return;
    }
    if (MODIFIER_KEY_NAMES.has(native.key)) return;
    const captured = comboFromEvent(native);
    if (!captured) return;

    setNoKeyHint(false);
    const reserved = reservedComboMessage(captured);
    if (reserved) {
      setError(reserved);
      return;
    }

    // Active failure detection: ask the main process whether this combo can be
    // claimed, i.e. is not already owned by the OS or another running app.
    setError(null);
    setChecking(true);
    let status: 'available' | 'taken' | 'unsupported' = 'available';
    try {
      const result = await window.electronAPI.keybindings.probeGlobal([captured]);
      status = result[captured] ?? 'available';
    } catch {
      // Probe is best-effort; on failure, fall through and allow the binding.
    }
    setChecking(false);

    if (status === 'taken') {
      setError(`${formatCombo(captured)} is already in use by your OS or another app. Pick another.`);
      return; // stay in capture mode so the user can try again
    }
    // The user may have clicked away or pressed Escape while the probe was in
    // flight; honor that cancellation instead of committing the binding.
    if (!capturingRef.current) return;
    stopCapturing();
    onCommit(captured);
  };

  // Mouse-button capture (single button or a multi-button chord) is handled by
  // the document-level pointer listeners in the capturing effect above, which
  // accumulate the held buttons and commit on release. Mouse buttons are never
  // OS global shortcuts, so they skip the availability probe the keyboard path
  // runs.

  if (capturing) {
    const hint = error
      ? error
      : noKeyHint
        ? 'No key detected. It may be reserved by your OS or another app.'
        : 'Press a shortcut, or hold one or more mouse buttons (middle / side) together, then release. Esc to cancel.';
    return (
      <div className="flex flex-col items-end gap-1 max-w-[260px]">
        <button
          ref={boxRef}
          type="button"
          onKeyDown={handleKeyDown}
          data-testid="key-capture-box"
          aria-label="Press the new shortcut or mouse button. Escape to cancel."
          className="px-2.5 py-1 rounded border border-accent bg-surface text-xs text-fg-secondary ring-1 ring-accent focus:outline-none whitespace-nowrap"
        >
          {checking ? 'Checking...' : 'Press a shortcut'}
        </button>
        <span className={`text-[11px] text-right ${error ? 'text-red-400' : 'text-fg-faint'}`} aria-live="polite">
          {hint}
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <KeyCombo combo={combo} />
      <button
        type="button"
        onClick={() => {
          setCapturing(true);
          capturingRef.current = true;
          setError(null);
        }}
        data-testid="key-capture-input"
        className="w-16 py-1 rounded text-xs text-center text-fg-muted hover:text-fg-secondary hover:bg-surface-hover border border-edge-input transition-colors"
      >
        Rebind
      </button>
    </div>
  );
}
