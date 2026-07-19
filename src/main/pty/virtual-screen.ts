/**
 * Minimal VT100 screen-grid renderer, shared by every consumer that needs
 * to know what a PTY byte stream actually SHOWS rather than what it
 * contains. Extracted from the Claude model-picker probe
 * (src/main/agent/adapters/claude/model-picker-probe.ts, which re-exports
 * it) so the mobile bridge's prompt-options probe can parse dialog frames
 * without importing an agent adapter.
 *
 * TUIs repaint with absolute cursor positioning, cursor-forward gaps, and
 * erase-character sequences, so a regex strip of the raw stream drops
 * characters mid-word. Interpreting the stream into a fixed grid reproduces
 * what the terminal actually shows, which is the only reliable thing to
 * parse.
 *
 * Handles the sequences observed in agent TUI repaints (CUP, CUU/CUD/
 * CUF/CUB, CHA, VPA, ED, EL, ECH, CR, LF, BS); everything else (SGR colors,
 * OSC titles, mode toggles) is consumed and ignored.
 */

const DEFAULT_COLS = 200;
const DEFAULT_ROWS = 50;

export class VirtualScreen {
  private readonly cols: number;
  private readonly rows: number;
  private readonly grid: string[][];
  private cursorRow = 0;
  private cursorColumn = 0;

  constructor(cols: number = DEFAULT_COLS, rows: number = DEFAULT_ROWS) {
    this.cols = cols;
    this.rows = rows;
    this.grid = Array.from({ length: rows }, () => new Array<string>(cols).fill(' '));
  }

  write(data: string): void {
    let index = 0;
    while (index < data.length) {
      const char = data[index];
      if (char === '\x1b') {
        index += this.consumeEscape(data, index);
        continue;
      }
      if (char === '\r') {
        this.cursorColumn = 0;
      } else if (char === '\n') {
        this.lineFeed();
      } else if (char === '\b') {
        this.cursorColumn = Math.max(0, this.cursorColumn - 1);
      } else if (char >= ' ') {
        this.putChar(char);
      }
      index++;
    }
  }

  /** The visible screen, one line per row, trailing whitespace trimmed. */
  text(): string {
    return this.grid.map((row) => row.join('').replace(/\s+$/u, '')).join('\n');
  }

  private putChar(char: string): void {
    if (this.cursorColumn >= this.cols) {
      this.cursorColumn = 0;
      this.lineFeed();
    }
    this.grid[this.cursorRow][this.cursorColumn] = char;
    this.cursorColumn++;
  }

  private lineFeed(): void {
    if (this.cursorRow >= this.rows - 1) {
      this.grid.shift();
      this.grid.push(new Array<string>(this.cols).fill(' '));
    } else {
      this.cursorRow++;
    }
  }

  private clampRow(row: number): number {
    return Math.min(Math.max(row, 0), this.rows - 1);
  }

  private clampColumn(column: number): number {
    return Math.min(Math.max(column, 0), this.cols - 1);
  }

  private eraseInLine(mode: number): void {
    const row = this.grid[this.cursorRow];
    if (mode === 1) {
      for (let column = 0; column <= this.cursorColumn && column < this.cols; column++) row[column] = ' ';
    } else if (mode === 2) {
      row.fill(' ');
    } else {
      for (let column = this.cursorColumn; column < this.cols; column++) row[column] = ' ';
    }
  }

  private eraseInDisplay(mode: number): void {
    if (mode === 1) {
      for (let row = 0; row < this.cursorRow; row++) this.grid[row].fill(' ');
      this.eraseInLine(1);
    } else if (mode === 2 || mode === 3) {
      for (const row of this.grid) row.fill(' ');
    } else {
      this.eraseInLine(0);
      for (let row = this.cursorRow + 1; row < this.rows; row++) this.grid[row].fill(' ');
    }
  }

  /** Consume one escape sequence starting at `start`; returns chars consumed. */
  private consumeEscape(data: string, start: number): number {
    const next = data[start + 1];
    if (next === '[') {
      // CSI: ESC [ <params> <final byte in @-~>
      let end = start + 2;
      while (end < data.length && !(data[end] >= '@' && data[end] <= '~')) end++;
      if (end >= data.length) return data.length - start; // truncated chunk tail
      const params = data.slice(start + 2, end).replace(/^[?<>=!]/u, '');
      const final = data[end];
      this.applyCsi(params, final);
      return end - start + 1;
    }
    if (next === ']') {
      // OSC: ESC ] ... terminated by BEL or ST (ESC \)
      let end = start + 2;
      while (end < data.length) {
        if (data[end] === '\x07') return end - start + 1;
        if (data[end] === '\x1b' && data[end + 1] === '\\') return end - start + 2;
        end++;
      }
      return data.length - start;
    }
    if (next === '(' || next === ')' || next === '#') return 3; // charset / line attr
    return 2; // ESC + single byte (=, >, 7, 8, ...)
  }

  private applyCsi(params: string, final: string): void {
    const numbers = params.split(';').map((part) => parseInt(part, 10));
    const first = Number.isFinite(numbers[0]) ? numbers[0] : undefined;
    const count = first !== undefined && first > 0 ? first : 1;
    switch (final) {
      case 'H':
      case 'f': {
        const second = Number.isFinite(numbers[1]) ? numbers[1] : undefined;
        this.cursorRow = this.clampRow((first ?? 1) - 1);
        this.cursorColumn = this.clampColumn((second ?? 1) - 1);
        break;
      }
      case 'A': this.cursorRow = this.clampRow(this.cursorRow - count); break;
      case 'B': this.cursorRow = this.clampRow(this.cursorRow + count); break;
      case 'C': this.cursorColumn = this.clampColumn(this.cursorColumn + count); break;
      case 'D': this.cursorColumn = this.clampColumn(this.cursorColumn - count); break;
      case 'G': this.cursorColumn = this.clampColumn((first ?? 1) - 1); break;
      case 'd': this.cursorRow = this.clampRow((first ?? 1) - 1); break;
      case 'J': this.eraseInDisplay(first ?? 0); break;
      case 'K': this.eraseInLine(first ?? 0); break;
      case 'X': {
        const row = this.grid[this.cursorRow];
        for (let offset = 0; offset < count && this.cursorColumn + offset < this.cols; offset++) {
          row[this.cursorColumn + offset] = ' ';
        }
        break;
      }
      default: break; // SGR (m), mode toggles, cursor save/restore - ignored
    }
  }
}
