import { Terminal, type ITerminalAddon } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';

/**
 * Scrollback rows retained by the headless parser and included in a serialized
 * mobile seed frame. The CURRENT on-screen grid is always serialized in full
 * regardless of this value; these rows give the phone a little history above
 * the fold. A few hundred lines is ample for a phone seed and keeps both the
 * retained buffer and the per-serialize cost bounded.
 */
const SERIALIZED_SCROLLBACK_LINES = 500;

/**
 * `@xterm/headless` declares its OWN `ITerminalAddon` (structurally identical
 * to `@xterm/xterm`'s: `activate(terminal)` + `dispose()`), while
 * `SerializeAddon` implements the `@xterm/xterm` one. The two are nominally
 * distinct modules, so `loadAddon` rejects the addon on type identity alone
 * even though it is byte-for-byte compatible at runtime (the serialize addon
 * reads only the core buffer/mode APIs that headless also exposes). This is the
 * single, minimal typed bridge - no `any`, no runtime shim - between them.
 */
type HeadlessTerminalAddon = ITerminalAddon;

/**
 * A per-session HEADLESS xterm parser kept in the MAIN process, fed the same
 * PTY output as the raw scrollback ring. Its serialized frame is a snapshot of
 * the PARSED grid - every currently-visible cell whatever its draw age - which
 * the mobile seed uses instead of a raw 512KB byte replay. A raw replay drops
 * the write-once static cells of a fullscreen TUI (e.g. Claude Code's static
 * status-line segment) once the bytes that drew them age out of the byte
 * window; the parsed grid always carries them.
 *
 * Never call `.open()`: `@xterm/headless` has no DOM and runs the VT parser
 * plus buffer only.
 */
export class HeadlessFrameBuffer {
  private readonly terminal: Terminal;
  private readonly serializer: SerializeAddon;

  constructor(cols: number, rows: number) {
    this.terminal = new Terminal({
      cols: Math.max(1, Math.floor(cols)),
      rows: Math.max(1, Math.floor(rows)),
      scrollback: SERIALIZED_SCROLLBACK_LINES,
      allowProposedApi: true,
    });
    this.serializer = new SerializeAddon();
    this.terminal.loadAddon(this.serializer as unknown as HeadlessTerminalAddon);
  }

  /** Feed a raw PTY chunk into the parser (the same bytes the scrollback ring receives). */
  write(data: string): void {
    this.terminal.write(data);
  }

  /** Resize the parsed grid to match a PTY resize so serialized frames reflow to the new geometry. */
  resize(cols: number, rows: number): void {
    this.terminal.resize(Math.max(1, Math.floor(cols)), Math.max(1, Math.floor(rows)));
  }

  /**
   * SYNCHRONOUS, per-row grid access for the Agent Monitor's output peek.
   *
   * Deliberately NOT `serialize()`. That builds a self-contained replay frame of
   * the whole grid plus `SERIALIZED_SCROLLBACK_LINES` of history and is `async`,
   * both of which are wrong here: the peek wants a handful of plain-text rows,
   * sampled on a timer, from a synchronous context.
   *
   * Exposed one row at a time rather than as a snapshot array so the caller reads
   * only what it uses. The peek walks up from the cursor and stops as soon as it
   * has enough lines, so materializing the viewport would spend an `xterm`
   * cell-walk and a string allocation on rows nobody looks at, for every session
   * that produced output, twice a second.
   *
   * Unlike `serialize()` these do NOT flush first, so they can read a grid that
   * is one macrotask behind the newest chunk (see `flush`). That is deliberate:
   * the peek is sampled on a repeating timer and self-heals on the next tick, so
   * paying a flush barrier per sample would buy nothing. Do not "fix" it by
   * making these async.
   */

  /** Absolute buffer row the cursor sits on. */
  cursorRow(): number {
    const buffer = this.terminal.buffer.active;
    return buffer.baseY + buffer.cursorY;
  }

  /**
   * Lowest absolute row a peek should look at, bounding the walk on a grid that
   * is mostly blank.
   *
   * @param lookbackRows Already-scrolled rows to allow ABOVE the viewport, for
   *   the case where the cursor sits near the top of a freshly-scrolled viewport
   *   and the interesting output has just passed above it.
   */
  peekFloorRow(lookbackRows: number): number {
    const buffer = this.terminal.buffer.active;
    return Math.max(0, buffer.baseY - Math.max(0, Math.floor(lookbackRows)));
  }

  /** Plain text of one absolute buffer row; empty string when the row is gone. */
  lineAt(row: number): string {
    const line = this.terminal.buffer.active.getLine(row);
    return line ? line.translateToString(true) : '';
  }

  /**
   * Drain the write buffer. xterm parses a normal `write()` asynchronously (it
   * schedules the parse on a macrotask, not synchronously), so serializing
   * right after the last `write()` would snapshot a STALE grid. A zero-length
   * write's callback fires only once every queued chunk ahead of it has been
   * parsed, which is exactly the flush barrier we need.
   */
  private flush(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.terminal.write('', resolve);
    });
  }

  /**
   * Snapshot the parsed grid as a self-contained escape-sequence frame the
   * phone can cold-replay into a fresh xterm. Flushes pending writes first so
   * the frame reflects every byte fed so far.
   *
   * The serialize addon includes the alt buffer (`excludeAltBuffer` left at its
   * false default) and the active terminal modes (`excludeModes` left false):
   * it emits `\x1b[?1049h` when the session is in the alt screen and re-asserts
   * DECCKM / mouse-tracking / bracketed-paste / focus modes from
   * `terminal.modes`. So the frame carries its own mode/alt-screen preamble -
   * the phone lands in the right screen with the right input modes without any
   * extra prefix, matching what the raw scrollback path prepended by hand.
   */
  async serialize(): Promise<string> {
    await this.flush();
    return this.serializer.serialize({ scrollback: SERIALIZED_SCROLLBACK_LINES });
  }

  dispose(): void {
    this.serializer.dispose();
    this.terminal.dispose();
  }
}
