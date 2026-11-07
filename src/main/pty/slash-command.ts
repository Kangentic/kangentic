/**
 * A slash command's first word: `/name` or `/plugin:name`. Never a path, which
 * has a second slash, so a message that is an agent's reply and happens to
 * open with `/src/main/...` is pasted whole rather than typed flat.
 */
const SLASH_COMMAND_HEAD = /^\/[A-Za-z][\w:.-]*(?:\s|$)/;

/**
 * Whether a message runs as a slash command. Text added after one becomes its
 * arguments in some CLIs, and text put before one stops it being a command at
 * all, so a message that rides with one goes on its own instead.
 */
export function isSlashCommand(message: string): boolean {
  return SLASH_COMMAND_HEAD.test(message.trimStart());
}
