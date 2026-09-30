/**
 * Text from outside a prompt, kept from forging the prompt's structure.
 *
 * Ask's prompt and the summary prompt frame their data in tags (`<related_work>`,
 * `<task>`), and most of what goes inside comes from outside Kangentic: indexed
 * conversation and code passages, task titles and descriptions, commit subjects,
 * the chat. A passage carrying `</related_work>` closed the block early, and
 * whatever followed read to the agent as prompt rather than data. No attacker
 * is needed: this repo's own `answer-prompt.ts` is indexed as source code, so a
 * code question that matched it did exactly that.
 *
 * The fix is narrow on purpose. Only a prompt's own tag names are touched, and
 * only their opening `<`, which becomes a lookalike, so the text reads the same
 * to the agent and a `<div>` in a code passage is left exactly as written.
 */

/** A lookalike of `<` (U+2039) that no prompt parses as a tag. */
const TAG_OPEN_LOOKALIKE = '‹';

/** The pattern that finds any of `tagNames` opening or closing, case-blind,
 *  with space allowed around the slash. Build it once per prompt. */
export function promptTagPattern(tagNames: ReadonlyArray<string>): RegExp {
  return new RegExp(`<(\\s*/?\\s*(?:${tagNames.join('|')}))(?=[\\s/>])`, 'gi');
}

/** `text` with every tag `pattern` finds defused. */
export function defusePromptTags(text: string, pattern: RegExp): string {
  return text.replace(pattern, `${TAG_OPEN_LOOKALIKE}$1`);
}
