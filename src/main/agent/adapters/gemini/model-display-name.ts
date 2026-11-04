/**
 * Model labels for Gemini, derived from the id alone (no table of names, per
 * `cli-features-over-custom-layers.md`).
 *
 * Gemini's ids put the version before the variant (`gemini-3-flash-preview`,
 * `gemini-2.5-pro`), and Google's own names keep that order ("Gemini 3 Flash").
 * The shared `humanizeModelId` follows Anthropic's scheme and moves numeric
 * segments to the end ("Gemini Flash Preview 3"), so Gemini keeps its own:
 * each segment in place, words capitalized, versions as written.
 */
export function geminiModelDisplayName(modelId: string): string | null {
  const segments = modelId.trim().split('-').filter((segment) => segment.length > 0);
  if (segments.length === 0) return null;
  return segments
    .map((segment) => (/^[a-z]/i.test(segment) ? segment.charAt(0).toUpperCase() + segment.slice(1) : segment))
    .join(' ');
}

/**
 * The flags Gemini's command builder emits before the positional prompt, each
 * with one value. Gemini's builder puts no `--` ahead of the prompt, so the
 * reader below stops at the first token that is none of these: a prompt that
 * contains `--model x` is never read as the flag.
 */
const BUILDER_VALUE_FLAGS = new Set(['--approval-mode', '--resume', '--session-id', '--include-directories', '--model']);

/**
 * One piece of a shell word, in the forms `quoteArg` writes:
 *   - a double-quoted run. `\` escapes the next character (nushell), except a
 *     `\` right before a quote that ends the word: PowerShell reads `"C:\dir\"`
 *     with a literal trailing backslash. A nushell value holding `"` before a
 *     space reads the same way and ends the word early, so its command yields
 *     no model, the same answer as a command with no `--model`;
 *   - a single-quoted run. fish reads `\` there as escaping the next character
 *     and writes `\'` inside one; a POSIX shell reads it literally, so bash
 *     quotes `C:\` as `'C:\'`. The command does not say which shell built it,
 *     so it is read the fish way first and the POSIX way when that finds no
 *     model (`modelFromGeminiCommand`);
 *   - a backslash escape outside quotes (POSIX writes an apostrophe as `'\''`);
 *   - a bare run.
 */
const WORD_PIECE_FISH = /"(?:[^"\\]|\\(?!"(?:\s|$))[\s\S]|\\)*"|'(?:[^'\\]|\\[\s\S])*'|\\[\s\S]|[^\s"'\\]+/y;
const WORD_PIECE_POSIX = /"(?:[^"\\]|\\(?!"(?:\s|$))[\s\S]|\\)*"|'[^']*'|\\[\s\S]|[^\s"'\\]+/y;

/** The text a piece stands for, its quotes and escapes removed. */
function unquotePiece(piece: string, singleQuoteEscapes: boolean): string {
  if (piece.startsWith('"')) return piece.slice(1, -1).replace(/\\(["\\])/g, '$1');
  if (piece.startsWith('\'')) {
    const inner = piece.slice(1, -1);
    return singleQuoteEscapes ? inner.replace(/\\(['\\])/g, '$1') : inner;
  }
  if (piece.startsWith('\\')) return piece.slice(1);
  return piece;
}

/**
 * Split a built command into shell words. A word is a run of adjacent pieces
 * with no whitespace between them, so `'o'\''brien'` is one word. Enough for
 * the builder's own output, not for shell syntax in general: a word that does
 * not parse ends the split, and the caller then finds no flag.
 */
function shellWords(command: string, singleQuoteEscapes: boolean): string[] {
  const piecePattern = singleQuoteEscapes ? WORD_PIECE_FISH : WORD_PIECE_POSIX;
  const words: string[] = [];
  let index = 0;
  while (index < command.length) {
    if (/\s/.test(command[index])) {
      index++;
      continue;
    }
    let word = '';
    while (index < command.length && !/\s/.test(command[index])) {
      piecePattern.lastIndex = index;
      const match = piecePattern.exec(command);
      if (!match) return words;
      word += unquotePiece(match[0], singleQuoteEscapes);
      index = piecePattern.lastIndex;
    }
    words.push(word);
  }
  return words;
}

/**
 * The model a built Gemini command pins with `--model`, or null. Walks the
 * command from its start: an optional PowerShell `&`, the executable, then only
 * the builder's own flags and their values. `-p` (the headless prompt flag) and
 * any other token end the walk, since the prompt follows. Read with fish's
 * single quotes, then POSIX's when that finds none (see `WORD_PIECE_FISH`).
 */
export function modelFromGeminiCommand(command: string): string | null {
  return modelFromWords(shellWords(command, true)) ?? modelFromWords(shellWords(command, false));
}

function modelFromWords(words: ReadonlyArray<string>): string | null {
  let index = 0;
  if (words[index] === '&') index++;
  index++; // the executable
  while (index < words.length) {
    const flag = words[index];
    if (!BUILDER_VALUE_FLAGS.has(flag)) return null;
    const value = words[index + 1];
    if (value === undefined) return null;
    if (flag === '--model') {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
    index += 2;
  }
  return null;
}
