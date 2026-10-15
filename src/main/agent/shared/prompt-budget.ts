/**
 * The longest message Kangentic sends inline as an agent's opening prompt.
 * The prompt rides the command line, and the whole command has to fit cmd.exe's
 * 8,191 characters; the rest of it (the CLI path, its flags, the MCP URL)
 * takes up to about 1,000 of them. Past this, a message points the agent at a
 * tool to read the rest instead.
 */
export const INLINE_PROMPT_BUDGET = 7_000;

/** The characters `quoteArg` writes for one `%` on a cmd host (`"^%"`). */
const PERCENT_ON_CMD = 4;

/**
 * A prompt's length on the command line, measured against
 * `INLINE_PROMPT_BUDGET`. A cmd host gets every `%` as `"^%"`, with the run of
 * backslashes right before it doubled (`escapePercentForCmd`), so cmd does not
 * expand a `%NAME%` inside the prompt. That is the one thing that grows under
 * the shell with the 8,191 limit: a `"` becomes `'` and a newline is flattened.
 * PowerShell's own escapes grow the text too, but a PowerShell command line has
 * 32,767 characters.
 */
export function commandLineLength(text: string): number {
  let length = text.length;
  for (const match of text.matchAll(/(\\*)%/g)) {
    length += PERCENT_ON_CMD - 1 + match[1].length;
  }
  return length;
}

/**
 * Cut `text` to at most `maxLength` by `commandLineLength`, marking the cut
 * with `...`. `keep: 'start'` keeps the beginning, `keep: 'end'` the end.
 *
 * A backslash costs more only before a `%`, so a piece's length is measured
 * whole rather than summed per character. It only grows as the piece grows, so
 * a binary search finds the longest piece that fits.
 */
export function fitCommandLine(text: string, maxLength: number, keep: 'start' | 'end'): string {
  if (commandLineLength(text) <= maxLength) return text;
  const marker = '...';
  if (keep === 'start') {
    let longest = 0;
    let tooLong = text.length;
    while (tooLong - longest > 1) {
      const middle = Math.floor((longest + tooLong) / 2);
      if (commandLineLength(text.slice(0, middle) + marker) <= maxLength) longest = middle;
      else tooLong = middle;
    }
    return `${text.slice(0, longest)}${marker}`;
  }
  let shortestStart = text.length;
  let tooEarly = 0;
  while (shortestStart - tooEarly > 1) {
    const middle = Math.floor((tooEarly + shortestStart) / 2);
    if (commandLineLength(marker + text.slice(middle)) <= maxLength) shortestStart = middle;
    else tooEarly = middle;
  }
  return `${marker}${text.slice(shortestStart)}`;
}
