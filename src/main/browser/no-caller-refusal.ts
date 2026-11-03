/**
 * The `no-caller-task` refusal, shared by open, pop out and dock.
 *
 * Reached only by a connection that names no Kangentic session (a manually
 * configured MCP client): a task's agent and a Command Terminal both name their
 * session in the MCP URL. The text used to suggest asking the user to open "the
 * task's" Browser pane, and an agent with no task read that as a cue to find a
 * browser elsewhere: it reached for the user's Chrome extension, which the
 * server instructions forbid. So it says what to tell the user and names no
 * other browser.
 *
 * Its own module so a test that mocks the opener still gets the real text.
 */
export const NO_CALLER_BROWSER_DETAIL =
  'This connection is not bound to a Kangentic task or Command Terminal, so it has no Browser pane. Tell the user you cannot check this in the app\'s browser from here. Do not use another browser in its place.';
