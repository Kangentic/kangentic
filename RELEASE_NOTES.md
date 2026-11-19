## What's New

- Import Tasks reads five more sources: Jira Cloud and Data Center (a board, project, saved filter or JQL query), Trello boards, Linear teams, GitLab projects and groups on gitlab.com or a self-managed server, and Obsidian vaults (one task per note, or one per checklist item). Imports are one-way. Nothing is written back.
- Connect offers a browser sign-in for Jira Cloud (Sign in with Atlassian), Trello, Linear and gitlab.com, beside the API key or token. Kangentic renews a sign-in older than seven days, so a source you import from once a month stays signed in.
- A paused card says "Paused while idle" when the idle timeout paused it, and keeps "Paused" for a pause you made. The task window's Resume prompt says which one it is.
- Task artifacts recognize YouTube and Substack links in a description, and a GitHub artifact can be a pull request, discussion, file, release or gist.
- The welcome screen counts setup as ready once Git and one signed-in agent are found. A signed-out agent beside a working one no longer holds it up, and the screen keeps a single accent color.

## Bug Fixes

- Windows installers keep a valid signature after their signing certificate ends. Earlier installers lost theirs about three days after release.
- A `/login` inside a session no longer lists a login twice in the Accounts tab or drops one from it, and a replaced login can be signed back in through Add account. Reading an account no longer signs it out or holds up an agent start.
- Resuming a task whose agent never took a turn starts it fresh on its prompt after a quit, instead of failing with "No conversation found".
- An On task exit message waits for an agent that is still starting, and is skipped when the move ends the agent (To Do, Done, or a column that runs none), instead of failing with a toast that stays.
- Messages held for a task opened after an idle pause arrive at the agent's next turn end even while it keeps background shells running, and the Stop script's note says when it stopped them.
- When an agent moves a task because you asked it to in its session, the move counts as yours, so a column's run-once automation runs again after a rework loop.
- On Windows, an agent launched through a chain of `.cmd` shims starts, and a shell that dies before its command runs is retried once.
- On Linux, an update that fails because sudo cannot ask for a password shows an "Updates blocked" notice instead of failing silently on every Restart to update.
- An agent's browser screenshot is no longer refused when Kangentic's record of the pane size was out of date.
