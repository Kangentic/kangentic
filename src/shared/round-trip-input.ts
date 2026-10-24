/**
 * How the round-trip probes (`src/renderer/utils/scroll-latency-probe.ts` and
 * `src/main/diagnostics/pty-round-trip-probe.ts`) classify one PTY write, so
 * the renderer and the pty host count the same inputs and the k-th of each
 * side pair up. Dev tooling only reads these; nothing routes input on them.
 */

/** An SGR report (`ESC [ < b ; x ; y M|m`) or an X10 one (`ESC [ M` + 3 bytes). */
const MOUSE_REPORT = /^(?:\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[M[\s\S]{3})$/;

/** One printable ASCII character, or Backspace as DEL or as Ctrl+H. */
const KEYSTROKE = /^(?:[\x20-\x7e]|\x7f|\x08)$/;

export type RoundTripInput = 'mouse' | 'key';

/** True when a write is exactly one mouse report, which the renderer paces
 *  one per write (`writePaced`). */
export function isSingleMouseReport(data: string): boolean {
  return MOUSE_REPORT.test(data);
}

/** True when a write is exactly one typed character or Backspace. A paste,
 *  a focus report and the repaint nudge's focus pair are all excluded. */
export function isSingleKeystroke(data: string): boolean {
  return KEYSTROKE.test(data);
}
