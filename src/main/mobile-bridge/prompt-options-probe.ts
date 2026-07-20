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
 * An awaited dialog renders at the bottom of the frame, by the cursor; a
 * winning run further above than this many rows from the last non-blank row
 * is prose (an agent's numbered list in output), not the dialog. The budget
 * covers the dialog's bottom border plus a few hint/status rows below it.
 */
const BOTTOM_ANCHOR_ROWS = 12;

/**
 * Extract a numbered dialog's option labels from rendered (plain-text)
 * screen content. Options must be consecutive rows numbered 1, 2, 3, ...;
 * when several such runs exist (say a numbered list in older output above
 * the dialog), the LAST complete run wins, and only when it sits near the
 * rendered bottom (BOTTOM_ANCHOR_ROWS), where an awaited dialog lives.
 *
 * Wrapped labels are treated as corruption, not truncation: on a narrow
 * grid an option label can wrap onto a continuation row, and naively
 * closing the run there would publish a PARTIAL option list for a consent
 * prompt (observed shape: the deny option missing). A run interrupted by a
 * non-numbered row and then RESUMED by the next number in sequence is
 * therefore discarded, and a corrupt dialog below the surviving candidate
 * rejects the whole parse - the phone falls back to unlabeled keystrokes,
 * never to confidently wrong buttons. Residual accepted risk: a wrap on
 * the LAST option truncates that one label's text (the option count stays
 * right, so digit answers still map 1:1).
 */
export function extractNumberedOptions(screenText: string): string[] | null {
  const lines = screenText.split('\n');

  let lastCompleteRun: string[] | null = null;
  let lastCompleteRunEndIndex = -1;
  let lastCorruptionIndex = -1;
  let currentRun: string[] = [];
  let currentRunEndIndex = -1;
  let interrupted = false;

  const closeRun = (): void => {
    if (currentRun.length >= MINIMUM_OPTION_COUNT) {
      lastCompleteRun = currentRun;
      lastCompleteRunEndIndex = currentRunEndIndex;
    }
    currentRun = [];
    interrupted = false;
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const rowMatch = stripDialogBorder(lines[lineIndex]).match(NUMBERED_ROW_PATTERN);
    if (!rowMatch) {
      // Not closed yet: if the run RESUMES after this row, the row was a
      // wrapped label's continuation and the run is corrupt, not complete.
      if (currentRun.length > 0) interrupted = true;
      continue;
    }
    const rowNumber = parseInt(rowMatch[1], 10);
    const label = rowMatch[2].trim();
    if (rowNumber === currentRun.length + 1 && !interrupted) {
      currentRun.push(label);
      currentRunEndIndex = lineIndex;
      continue;
    }
    if (rowNumber === currentRun.length + 1 && interrupted) {
      // The sequence resumed across an interruption: a wrapped dialog.
      // Discard it, and do not start a fresh run mid-dialog.
      lastCorruptionIndex = lineIndex;
      currentRun = [];
      interrupted = false;
      continue;
    }
    // A non-continuing number: whatever preceded it ended cleanly.
    closeRun();
    if (rowNumber === 1) {
      currentRun.push(label);
      currentRunEndIndex = lineIndex;
    }
  }
  closeRun();

  if (lastCompleteRun === null) return null;
  // A corrupt (wrapped) dialog BELOW the candidate is closer to the cursor,
  // so it is likelier the real dialog; publishing the candidate's labels
  // for it would mislabel a consent prompt.
  if (lastCorruptionIndex > lastCompleteRunEndIndex) return null;
  let lastContentIndex = lines.length - 1;
  while (lastContentIndex >= 0 && lines[lastContentIndex].trim().length === 0) {
    lastContentIndex -= 1;
  }
  if (lastCompleteRunEndIndex < lastContentIndex - BOTTOM_ANCHOR_ROWS) return null;

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
