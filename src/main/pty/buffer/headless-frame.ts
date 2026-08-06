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
 * The DECSTBM margins of one buffer, 0-based and inclusive.
 *
 * xterm has no PUBLIC read path for the scroll region. `IModes` is a bag of
 * mode FLAGS, and DECSTBM is two integers of buffer state, so it structurally
 * cannot appear there; `IBuffer` exposes cursor and viewport geometry only. The
 * margins do live on the internal `Buffer` (`InputHandler.setScrollRegion`
 * writes them), unmangled in the shipped bundle, and `_core` is the same private
 * door `src/renderer/addons/fit-addon.ts` already goes through. The public
 * alternative is a DECRQSS round trip (`\x1bP$qr\x1b\\`, answered on `onData`),
 * which would turn a synchronous property read into an async protocol exchange
 * over the PTY's own data channel. Narrowly typed rather than cast to `any` so
 * the reach stays confined to these two numbers.
 */
interface TerminalWithScrollRegion {
  _core?: { buffers?: { active?: { scrollTop?: number; scrollBottom?: number } } };
}

/**
 * A per-session HEADLESS xterm parser kept in the MAIN process, fed the same
 * PTY output as the raw scrollback ring. Its serialized frame is a snapshot of
 * the PARSED grid - every currently-visible cell whatever its draw age - which
 * the mobile seed and the desktop alt-screen replay use instead of a raw 512KB
 * byte replay. A raw replay drops the write-once static cells of a fullscreen
 * TUI (e.g. Claude Code's static status-line segment) once the bytes that drew
 * them age out of the byte window; the parsed grid always carries them.
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
   * is one macrotask behind the newest chunk (see `serialize`). That is deliberate:
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
   * Snapshot the parsed grid as a self-contained escape-sequence frame a fresh
   * xterm can cold-replay (the mobile seed, and the desktop alt-screen replay
   * via PtyBufferManager.getReplaySnapshot).
   *
   * The snapshot is ATOMIC WITH THE FLUSH BARRIER. xterm parses `write()`
   * chunks asynchronously (the parse runs on a later macrotask), so a
   * zero-length write's callback is the point where every chunk fed BEFORE
   * this call has been parsed - and the grid is serialized synchronously
   * inside that callback, before the parse loop can consume chunks queued
   * BEHIND the barrier. That makes the frame's content boundary exact: bytes
   * fed before serialize() are in, bytes fed after are out, deterministically.
   * getReplaySnapshot's exactly-once accounting of bytes that race a sample
   * rests on this; do not move the serialize back out to a post-await line.
   *
   * The serialize addon includes the alt buffer (`excludeAltBuffer` left at
   * its false default) and the active terminal modes (`excludeModes` left
   * false): it emits the serialized normal buffer first, then the
   * `\x1b[?1049h` switch MID-STREAM followed by the alt grid, and re-asserts
   * DECCKM / mouse-tracking / bracketed-paste / focus modes from
   * `terminal.modes`. So the frame is self-contained - the receiver lands in
   * the right screen with the right input modes without any extra prefix -
   * but the switch is not a leading marker; never `startsWith` on it.
   *
   * What the addon CANNOT carry is the DECSTBM scroll region, so
   * `scrollRegionSuffix` appends it (and the cursor restore DECSTBM would
   * otherwise clobber). That suffix is the frame's TAIL by construction; do not
   * append anything after it that assumes a home cursor.
   */
  async serialize(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.terminal.write('', () => {
        // The callback runs inside xterm's parse loop, so a throw here (e.g. a
        // serializer disposed mid-sample) would otherwise escape as an uncaught
        // main-process exception instead of rejecting this promise.
        try {
          resolve(
            this.serializer.serialize({ scrollback: SERIALIZED_SCROLLBACK_LINES })
              + this.scrollRegionSuffix(),
          );
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  }

  /**
   * Active DECSTBM margins, or null when the region already spans the whole
   * grid (the default, and the common case - a full-screen region needs no
   * re-assert, so the suffix costs zero bytes for every session that never sets
   * one).
   */
  private activeScrollRegion(): { top: number; bottom: number } | null {
    const activeBuffer = (this.terminal as unknown as TerminalWithScrollRegion)._core?.buffers?.active;
    const top = activeBuffer?.scrollTop;
    const bottom = activeBuffer?.scrollBottom;
    if (typeof top !== 'number' || typeof bottom !== 'number') return null;
    if (top <= 0 && bottom >= this.terminal.rows - 1) return null;
    return { top, bottom };
  }

  /**
   * Re-assert the scroll region a replay would otherwise silently drop, and put
   * the cursor back where the frame left it.
   *
   * The serialize addon builds its mode prefix from `terminal.modes`, which
   * carries no margin data, so a replayed frame always lands in a terminal whose
   * region spans the full viewport. Without this, a TUI that sets a region ends
   * up believing in margins the terminal no longer has, and each later
   * region-relative op acts on the wrong rows.
   *
   * Currently DORMANT for Claude Code, and deliberately kept anyway. Its binary
   * ships a DECSTBM capability gate alongside SD/IL emission, but the gate is
   * shut under xterm.js: measured 2026-08-06 with `claude --debug`, which logs
   * `XTVERSION: no reply (terminal ignored query)` and then
   * `DECSTBM: gated (TMUX=unset ZELLIJ=unset TERM_PROGRAM=unset TERM=unset)`.
   * xterm registers `CSI > c` but no `CSI > q`, so it never answers XTVERSION.
   * The gate can reopen on any upgrade (or if we ever set TERM), silently, and
   * the resulting bug is expensive to re-diagnose - hence the guard. The
   * origin-mode branch below is NOT dormant.
   *
   * Order is load-bearing, twice over:
   *
   * - The region must FOLLOW the frame. Set before it, the frame's own row
   *   writes would scroll against it and reflow the replay.
   * - The region must be followed by an absolute CUP. DECSTBM homes the cursor
   *   (`InputHandler.setScrollRegion` ends in `_setCursor(0, 0)`), which would
   *   otherwise discard the position the addon's relative moves just built.
   *
   * The CUP is also emitted for a full-screen region when origin mode is on,
   * because the addon appends its own `\x1b[?6h` AFTER its cursor restore and
   * DECSET 6 homes the cursor too - so that frame arrives with the cursor at
   * home whatever the margins are. Same clobber, same one-line repair.
   */
  private scrollRegionSuffix(): string {
    const region = this.activeScrollRegion();
    const originMode = this.terminal.modes.originMode;
    if (!region && !originMode) return '';

    const buffer = this.terminal.buffer.active;
    // CUP's row is region-relative under origin mode and absolute otherwise; its
    // column is unaffected either way (`_setCursor` offsets only y). `cursorY`
    // is already viewport-relative, which is the space CUP addresses.
    const cursorRow = originMode ? buffer.cursorY - (region?.top ?? 0) + 1 : buffer.cursorY + 1;
    const regionSequence = region ? `\x1b[${region.top + 1};${region.bottom + 1}r` : '';
    return `${regionSequence}\x1b[${Math.max(1, cursorRow)};${buffer.cursorX + 1}H`;
  }

  dispose(): void {
    this.serializer.dispose();
    this.terminal.dispose();
  }
}
