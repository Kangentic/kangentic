/**
 * OpenCode CLI transcript cleanup for PTY output.
 *
 * OpenCode (verified empirically with v1.14.25) is a Bubble Tea (Go) TUI
 * that uses heavy box-drawing chrome to render the conversation viewport.
 * After ANSI stripping, a single PTY frame collapses into one very wide
 * line because the TUI uses cursor positioning rather than newlines for
 * layout. The captured stripped text therefore looks like:
 *
 *   <banner block-chars> ┃┃ <prompt cell> ┃┃ <model footer> ╹▀▀▀▀... <hints>
 *   ┃┃ <prompt> ┃ ▣ Build · Big Pickle
 *   ┃┃┃┃ <chrome> ■⬝⬝⬝⬝■■⬝⬝■■■... <spinner> ┃ ▣ Build · ... Thinking: ...
 *     <response> 15.4K (8%) · 3.0s ┃ <prompt cell again> ┃ <Thinking again>
 *     <response again> ▣ Build · ... · 3.0s ╹▀▀▀▀...
 *
 * Pipeline (verified against captured v1.14.25 scrollback):
 *
 *   Step 0 - Strip inline chrome substrings. Mode-indicator (`▣ <agent> ·
 *     <model>`), footer brand (`<agent> · <model> OpenCode Zen`), context
 *     readouts, spinners, hint-bar bits, tip line, onboarding panel copy,
 *     and the LSP shutdown indicator are all sequences that get
 *     concatenated INTO an otherwise-meaningful cell. Stripping them as
 *     substrings preserves the surrounding response text. Line-level
 *     filters can't reach these because they'd have to drop the whole
 *     line and eat the response with it.
 *   Step 1 - Recover line structure by splitting on the vertical box
 *     border `┃` (and `│`) and on long horizontal box-drawing runs.
 *     Those characters delimit visual cells in the TUI grid.
 *   Step 2 - Apply line-anchored noise patterns: banner runs, spinner
 *     rows, hint-bar (`? for shortcuts`), standalone context-readout
 *     cells, cwd:branch status line and its wrapped fragments, slash-
 *     command help-table rows (vs. legitimate slash prose), version
 *     footer, session-id line, resume-hint footer.
 *   Step 3 - Collapse internal whitespace runs introduced by column
 *     padding from the TUI grid, then drop residual short / pure-residue
 *     lines (≤2 chars, or only made of border/punctuation glyphs).
 *   Step 4 - Dedup repeated long lines. OpenCode redraws the entire
 *     viewport on each model output, so the user prompt and assistant
 *     response often appear 3-4 times in the captured stream. Dedup is
 *     gated on `line.length > 20` so short legitimate responses (`Yes.`,
 *     `1.`, `OK`) survive and only chrome-redrawn paragraphs collapse.
 *   Step 5 - finalizeTranscript() collapses blank runs, strips trailing
 *     duplicates, and trims.
 *
 * Unlike Codex/Gemini we don't anchor on a per-token response marker;
 * OpenCode streams text into a scrollback view rather than redrawing one
 * marker prefix per token, so this filter pipeline is sufficient.
 *
 * Brand caveat: the inline-chrome regexes match the structural shape
 * `▣ <agent> · <model>` rather than the literal default model name
 * ("Big Pickle" on v1.14.25), so a user who switches models via
 * `/model <provider>/<name>` still gets a clean handoff.
 */

import { filterNoiseLines, finalizeTranscript } from '../../handoff/transcript-cleanup';

/**
 * Inline chrome substrings that get concatenated into otherwise-meaningful
 * cells by the TUI's cursor positioning. Stripped IN-PLACE before the
 * cell-recovery split so a response line carrying "...response text▣ Build ·
 * Big Pickle" doesn't get dropped wholesale by the line-level filter.
 */
const OPENCODE_INLINE_CHROME: RegExp[] = [
  // Banner/separator runs (kept here too so they collapse mid-line residue
  // even after the cell-recovery split has handled long isolated runs).
  /[█▀▄]{4,}/g,
  // Spinner runs (■/⬝ mixes; tolerate up to one space between cells)
  /[■⬝]{3,}/g,
  // Mode indicator: ▣ <agent> · <model display> with optional · N.Ns timer.
  // Matches the structural shape rather than the literal "Build · Big Pickle"
  // (the v1.14.25 default), so users on a different model still get clean
  // handoffs. Bounded to ≤4 model-name words to avoid gobbling response prose
  // that happens to follow a `·` separator.
  /▣\s+\w+\s+·\s+[\w-]+(?:[\s-][\w-]+){0,3}(?:\s+·\s+\d+(?:\.\d+)?s)?/g,
  // Footer brand: <agent> · <model display> OpenCode Zen. Anchored on the
  // "OpenCode Zen" suffix (which is the product brand, not the model) so this
  // generalizes across models too.
  /\w+\s+·\s+[\w-]+(?:\s+[\w-]+){0,3}\s+OpenCode\s+Zen/g,
  // Context / cost readouts that get squeezed onto the same row
  /\d+(?:\.\d+)?K\s+\(\d+%\)/g,
  /\d{1,3}(?:,\d{3})+\s+tokens/g,
  /\d+%\s+used/g,
  /\$\d+(?:\.\d+)?\s+spent/g,
  /·\s+\d+(?:\.\d+)?s\b/g,
  // Hint bar fragments
  /tab\s*agents/gi,
  /ctrl\+p\s+commands/gi,
  /esc\s+interrupt/gi,
  // Tip line ("● Tip ..." through to end-of-line)
  /[●•]\s+Tip[^\n]*/g,
  // Input placeholder ("Ask anything... \"<example>\"" through to end-of-line)
  /Ask\s+anything\.\.\.[^\n]*/gi,
  // Onboarding panel fragments
  /⬖\s+Getting\s+started\s*✕?/g,
  /OpenCode\s+includes\s+free\s+models/gi,
  /so\s+you\s+can\s+start\s+immediately\.?/gi,
  /Connect\s+from\s+\d+\+\s+providers\s+to/gi,
  /use\s+other\s+models,\s+including/gi,
  /Claude,\s*GPT,\s*Gemini\s+etc/gi,
  /Connect\s+provider\s+\/connect/gi,
  // LSP / shutdown indicator
  /█+\s*LSP/g,
];

const OPENCODE_NOISE_PATTERNS: RegExp[] = [
  // Block-character banner (logo): runs of ▀ ▄ █ with at most spaces between.
  /^[\s█▀▄]{8,}$/,
  // Spinner runs: long mixes of ■ and ⬝
  /^[\s■⬝]{4,}$/,
  // Bottom hint bar (anchored - inline forms are stripped earlier)
  /^\s*\?\s+for\s+shortcuts/i,
  // Standalone context/cost readout cells
  /^\s*\d+(?:\.\d+)?K\s+\(\d+%\)\s*$/,
  /^\s*\d{1,3}(?:,\d{3})*\s+tokens\s*$/,
  /^\s*\d+%\s+used\s*$/,
  /^\s*\$\d+(?:\.\d+)?\s+spent\s*$/,
  /^\s*Context\s*$/,
  // cwd:branch status line ("~\path:branch-name") - the canonical form before
  // the TUI splits it across the onboarding panel.
  /^\s*\/?~?[\\/].+:[A-Za-z0-9_-]+\s*$/,
  // Path-fragment cells produced when the cwd:branch line wraps inside the
  // onboarding panel column (e.g. "kangentic\worktrees\..." or
  // "/~\Documents\GitHub\..."). Match path-like content that's mostly
  // backslashes/forward-slashes/dots and ends with a continuation slash.
  /^\s*\/?~?[\\/][\w\\.\-/]+[\\/]\s*$/,
  // Standalone slash-command listings (e.g. "/connect" cell)
  /^\s*\/(?:connect|help|exit|quit|clear|compact|init|model|agent|continue|fork|new|providers|stats|undo|redo|share|memory|status|cost|debug|login|logout)\s*$/i,
  // Slash-command help-table rows (≥2 spaces between command and description
  // distinguish a help row from legitimate prose like "/connect to a server").
  /^\s*\/(?:help|exit|quit|clear|compact|init|model|agent|continue|fork|new|providers|stats|undo|redo|share|memory|status|cost|debug|connect|login|logout)\s{2,}\S/i,
  // Version footer
  /^\s*[•·]\s*OpenCode\s+\d+\.\d+(?:\.\d+)?\s*$/i,
  // Session ID line printed by OpenCode for fromOutput regex capture
  /^\s*session\s+id:\s+ses_[A-Za-z0-9_-]{16,64}\s*$/i,
  /^\s*sid[\s:=]+ses_[A-Za-z0-9_-]{16,64}\s*$/i,
  // Resume hint footer
  /^\s*opencode\s+(?:--session|-s)\s+['"]?ses_/i,
];

/** Vertical box-drawing borders that delimit TUI cells in OpenCode's layout. */
const CELL_DELIMITERS = /[┃│]/g;
/** Long horizontal box-drawing runs OpenCode uses as separators. */
const HORIZONTAL_BORDER_RUN = /[─━═▀▄┄┅╌╍╹╺╻]{4,}/g;

export function cleanOpenCodeTranscript(rawText: string): string | null {
  // Step 0: Strip inline TUI chrome that gets concatenated onto otherwise
  // meaningful cells. If left alone, anchored line patterns can't reach
  // these (they need to drop the entire line) but doing so eats the
  // adjacent response text. Remove the chrome substrings first.
  let preCleaned = rawText;
  for (const pattern of OPENCODE_INLINE_CHROME) {
    preCleaned = preCleaned.replace(pattern, ' ');
  }

  // Step 1: Recover line structure. The TUI concatenates cells horizontally
  // separated by `┃` borders, so each frame collapses to one wide line. Splitting
  // on those delimiters (and on long horizontal border runs) gets us back to
  // something line-oriented that the shared filter pipeline can handle.
  const expanded = preCleaned
    .replace(CELL_DELIMITERS, '\n')
    .replace(HORIZONTAL_BORDER_RUN, '\n');

  // Preserve original spacing for noise pattern matching (the slash-command
  // help-table pattern needs ≥2 spaces between command and description to
  // distinguish a help row from prose).
  const lines = expanded.split('\n').map((line) => line.trimEnd());

  // Step 2: Filter noise (shared + OpenCode-specific patterns).
  const filtered = filterNoiseLines(lines, OPENCODE_NOISE_PATTERNS);

  // Step 3: Collapse internal whitespace runs introduced by the cell-recovery
  // split (column padding from the TUI grid leaves long space runs inside
  // otherwise meaningful prose), then drop residual short / pure-residue lines.
  const meaningful = filtered
    .map((line) => line.replace(/\s{2,}/g, ' ').trim())
    .filter((line) => {
      if (!line) return false;
      // Pure punctuation / box residue (input is already trimmed, so the
      // character class doesn't need \s).
      if (/^[\-_=•·●⬝■□◇◆⬖⬗▣▢▪▫]+$/.test(line)) return false;
      // Lines shorter than 3 chars are almost always TUI residue.
      if (line.length < 3) return false;
      return true;
    });

  // Step 4: Dedup repeated long lines. OpenCode redraws the entire viewport
  // on each model output, so the user prompt and assistant response often
  // appear 3-4 times in the captured stream. Gating on length > 20 means
  // chrome-redrawn paragraphs (prompt, Thinking block, response sentences)
  // collapse but short legitimate repeats (`Yes.`, `1.`, `OK`, multi-turn
  // single-word answers) survive.
  const DEDUP_LENGTH_THRESHOLD = 20;
  const seenLong = new Set<string>();
  const deduped: string[] = [];
  for (const line of meaningful) {
    if (line.length > DEDUP_LENGTH_THRESHOLD) {
      if (seenLong.has(line)) continue;
      seenLong.add(line);
    }
    deduped.push(line);
  }

  const text = deduped.join('\n').replace(/\n{3,}/g, '\n\n');
  return finalizeTranscript(text);
}
