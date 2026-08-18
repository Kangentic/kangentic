/**
 * Encode a keystroke as the bytes a terminal expects on stdin.
 *
 * This exists for exactly one caller: a key the user typed while an agent was
 * driving a Browser pane. Those keystrokes are intercepted at the guest and
 * never reach the page (see `.claude/rules/agent-driven-focus.md`), so they have
 * to be delivered to the terminal the user was actually typing in - and the
 * xterm instance that would normally do this encoding never saw the event.
 *
 * Deliberately SMALL. This is not a general terminal input layer and must not
 * grow into one: it covers printable characters, the handful of editing and
 * navigation keys people use mid-sentence, and Ctrl-letter control codes.
 * Anything else returns null, which the caller treats as "drop it" rather than
 * guessing - a wrong byte sequence in someone's shell is worse than a missing
 * one.
 */

export interface TerminalKeyInput {
  /** `KeyboardEvent.key` as Electron reports it on `before-input-event`. */
  key: string;
  control: boolean;
  alt: boolean;
  meta: boolean;
  shift: boolean;
}

/** CSI sequences for the navigation keys, in their normal (non-application) mode. */
const CSI_KEYS: Record<string, string> = {
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',
  Home: '\x1b[H',
  End: '\x1b[F',
  Delete: '\x1b[3~',
  PageUp: '\x1b[5~',
  PageDown: '\x1b[6~',
};

const SIMPLE_KEYS: Record<string, string> = {
  Enter: '\r',
  Tab: '\t',
  Backspace: '\x7f',
  Escape: '\x1b',
};

/**
 * Returns the bytes to write to the PTY, or null when the key has no safe
 * encoding and should be dropped.
 */
export function encodeTerminalKey(input: TerminalKeyInput): string | null {
  const { key, control, alt, meta, shift } = input;

  // Meta chords are OS/app shortcuts, never terminal input.
  if (meta) return null;

  // Every Ctrl chord is dropped, including Ctrl+C.
  //
  // Tempting to map Ctrl-letter to control codes 0x01..0x1a, but the terminal
  // does NOT treat those chords as raw bytes: `terminal-clipboard.ts` owns them,
  // and its rules are contextual in ways this function cannot see. Ctrl+C copies
  // when there is a selection and sends SIGINT when there is not; Ctrl+V pastes
  // rather than sending 0x16 (literal-next), which in a live shell would arm the
  // next keystroke to be taken literally. Re-deriving that here would be a second
  // implementation of the same rules, quietly diverging - exactly what this
  // module's docstring warns against.
  //
  // The cost is small and bounded: the user cannot interrupt or paste during the
  // tens-to-hundreds of milliseconds a drive lasts, and the chord is dropped
  // rather than mis-sent. A wrong control byte in someone's shell is worse.
  if (control) return null;

  if (alt) {
    // Alt+letter is ESC-prefixed (meta) input in a terminal - but ONLY when the
    // key is still ASCII.
    //
    // This is the cross-platform trap in this module. On Windows and Linux,
    // Alt+a reports `key: 'a'` and `\x1ba` is right. On macOS the Option key is
    // a compose modifier: Option+a reports `key: 'å'`, the character the OS
    // actually produced. Emitting `\x1b` + 'å' is wrong under either macOS
    // terminal convention - a terminal with "Option as Meta" wants `\x1ba`, and
    // one without wants the bare 'å' - so it would put a sequence the user never
    // typed into their shell, which is precisely what this module exists to
    // avoid.
    //
    // Restricting to ASCII drops the macOS composed case and changes nothing on
    // Windows or Linux, without branching on `process.platform` (see
    // `.claude/rules/cross-platform-parity.md`: derive behavior from the input,
    // not from the OS, wherever that is possible).
    //
    // NOT verified on macOS hardware - reasoned from Chromium's documented
    // `KeyboardEvent.key` semantics. The failure mode of being wrong here is a
    // dropped chord, not a corrupted one.
    if (key.length === 1 && key.charCodeAt(0) < 128) return `\x1b${key}`;
    return null;
  }

  const simple = SIMPLE_KEYS[key];
  if (simple !== undefined) return simple;

  const csi = CSI_KEYS[key];
  if (csi !== undefined) return csi;

  // A printable character. `key` already carries the shifted form ('A', '!'),
  // so `shift` needs no separate handling; it is in the signature only so a
  // caller cannot forget to pass the modifier state it does matter for.
  if (key.length === 1) return key;
  void shift;

  return null;
}
