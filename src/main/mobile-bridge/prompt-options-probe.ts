/**
 * Prompt-options probe: recovers a pending prompt's numbered option labels
 * from the serialized PTY frame the mobile bridge already snapshots
 * (SessionManager.getSerializedFrame, the read-stream mobile seed), so the
 * phone can render the ACTUAL choices ("1. Yes", "2. Yes, and don't ask
 * again...") instead of answering blind with approve='1\r' / deny=Esc.
 *
 * Pure and best-effort by design: input is a frame string (escape sequences
 * included), output is the labels in keystroke order or null when no
 * numbered dialog is visible. There is no agent-specific branching - any
 * TUI that draws a "1. / 2. / ..." dialog parses; anything else returns
 * null and the phone falls back to today's blind keystrokes. The answer
 * transport is unchanged (answer-permission-prompt still sends raw
 * keystrokes); this probe only labels the buttons.
 */
import { VirtualScreen } from '../pty/virtual-screen';

/** The PTY grid the frame's bytes are laid out for; pass the session's live dimensions when known. */
export interface PromptProbeDimensions {
  cols: number;
  rows: number;
}

const DEFAULT_GRID_COLS = 200;
const DEFAULT_GRID_ROWS = 50;

/**
 * A lone "1. ..." row is far more likely prose (an agent's numbered list)
 * than a dialog; a real choice always offers at least two options.
 */
const MINIMUM_OPTION_COUNT = 2;

/**
 * One rendered option row. Follows the numbered-row shape the Claude
 * model-picker probe parses (parseModelPickerScreen in
 * src/main/agent/adapters/claude/model-picker-probe.ts): an optional ❯
 * selection marker, `<n>.`, then the label. Applied here after stripping
 * the box-drawing border characters permission dialogs are framed in.
 */
const NUMBERED_ROW_PATTERN = /^(?:❯\s*)?(\d+)\.\s+(.+)$/u;

/**
 * Strip the dialog's box-drawing border from a grid row: a bordered dialog
 * renders each option as `│ ❯ 1. Yes ... │`, and the row pattern anchors on
 * the number, not the frame.
 */
function stripDialogBorder(line: string): string {
  let text = line.trim();
  if (text.startsWith('│') || text.startsWith('┃')) text = text.slice(1);
  if (text.endsWith('│') || text.endsWith('┃')) text = text.slice(0, -1);
  return text.trim();
}

/**
 * Extract a numbered dialog's option labels from rendered (plain-text)
 * screen content. Options must be consecutive rows numbered 1, 2, 3, ...;
 * when several such runs exist (say a numbered list in older output above
 * the dialog), the LAST complete run wins, because an awaited dialog always
 * renders at the bottom of the frame, by the cursor.
 */
export function extractNumberedOptions(screenText: string): string[] | null {
  let lastCompleteRun: string[] | null = null;
  let currentRun: string[] = [];

  const closeRun = (): void => {
    if (currentRun.length >= MINIMUM_OPTION_COUNT) lastCompleteRun = currentRun;
    currentRun = [];
  };

  for (const line of screenText.split('\n')) {
    const rowMatch = stripDialogBorder(line).match(NUMBERED_ROW_PATTERN);
    if (!rowMatch) {
      closeRun();
      continue;
    }
    const rowNumber = parseInt(rowMatch[1], 10);
    const label = rowMatch[2].trim();
    if (rowNumber === currentRun.length + 1) {
      currentRun.push(label);
    } else {
      closeRun();
      if (rowNumber === 1) currentRun.push(label);
    }
  }
  closeRun();

  return lastCompleteRun;
}

/**
 * Parse a serialized PTY frame (escape sequences included) into the pending
 * dialog's numbered option labels, in keystroke order: result[0] is the row
 * answered with "1\r". Returns null when the frame shows no numbered
 * dialog. Pure - no PTY, no session state, no side effects.
 *
 * `dimensions` should be the PTY grid the frame was serialized for
 * (SessionManager.getDimensions); the row budget is floored at a generous
 * default so a frame that carries scrollback above the viewport still keeps
 * its bottom-of-screen dialog after the virtual grid scrolls.
 */
export function extractPromptOptions(
  serializedFrame: string,
  dimensions?: PromptProbeDimensions,
): string[] | null {
  if (serializedFrame.length === 0) return null;
  const cols = dimensions?.cols ?? DEFAULT_GRID_COLS;
  const rows = Math.max(dimensions?.rows ?? DEFAULT_GRID_ROWS, DEFAULT_GRID_ROWS);
  const screen = new VirtualScreen(cols, rows);
  screen.write(serializedFrame);
  return extractNumberedOptions(screen.text());
}
