/**
 * Whether bytes written into a terminal carry something a person did there.
 *
 * A Command Terminal that nobody has used yet is replaced in place when the
 * user resumes an earlier conversation from it, and is never recorded in that
 * history. So "used" has to mean typed, pasted or sent, never "xterm answered
 * the agent". Everything xterm writes back on the terminal's behalf travels the
 * same `onData` channel as keystrokes: device attribute and cursor position
 * replies to the agent's startup queries, mode reports, colour and version
 * replies, focus reports, and every mouse report a fullscreen TUI asks for. A
 * fresh terminal's mount alone sends several of those, so counting them would
 * mark every terminal used before anyone touched it.
 *
 * Mouse clicks and wheel ticks are deliberately not counted either: clicking
 * into a terminal to focus it, or scrolling it, changes nothing in its
 * conversation. A key press, a paste, or a submit does.
 */

/** The final byte of a CSI sequence that is a report, never a key. */
const CSI_REPORT_FINAL_BYTES = new Set(['c', 'R', 'n', 'y', 't', 'I', 'O']);

/**
 * True when `data` holds at least one key, character or paste a person sent,
 * after every report xterm generates is set aside.
 */
export function writeCarriesUserContent(data: string): boolean {
  let index = 0;
  while (index < data.length) {
    const character = data[index];
    if (character !== '\x1b') return true;
    const next = data[index + 1];
    if (next === undefined) return true; // A lone Escape is the Escape key.
    if (next === '[') {
      const end = csiEnd(data, index + 2);
      if (end === null) return true;
      const body = data.slice(index + 2, end);
      const finalByte = data[end];
      if (finalByte === 'M' && body === '') {
        // X10 mouse: CSI M plus exactly three bytes (button, column, row).
        index = end + 4;
        continue;
      }
      if (body.startsWith('<') && (finalByte === 'M' || finalByte === 'm')) {
        index = end + 1; // SGR mouse report.
        continue;
      }
      if (CSI_REPORT_FINAL_BYTES.has(finalByte)) {
        index = end + 1;
        continue;
      }
      return true; // Arrows, Home, Delete, function keys, the paste markers.
    }
    if (next === ']' || next === 'P' || next === '_' || next === '^' || next === 'X') {
      // OSC, DCS, APC, PM and SOS strings only ever answer a query here
      // (colour, version, capability replies).
      index = stringEnd(data, index + 2);
      continue;
    }
    return true; // SS3 keys (application-mode arrows) and Alt chords.
  }
  return false;
}

/** Index of the final byte of a CSI whose parameters start at `start`, or null if it never ends. */
function csiEnd(data: string, start: number): number | null {
  for (let index = start; index < data.length; index++) {
    const character = data[index];
    if (character >= '@' && character <= '~') return index;
  }
  return null;
}

/** Index just past the BEL or ST that ends a string started before `start`. */
function stringEnd(data: string, start: number): number {
  for (let index = start; index < data.length; index++) {
    if (data[index] === '\x07') return index + 1;
    if (data[index] === '\x1b' && data[index + 1] === '\\') return index + 2;
  }
  return data.length;
}
