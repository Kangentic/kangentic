## What's New

- Terminals have a find bar. In a Claude Code session it searches the whole conversation, not only what is on screen.
- Plain URLs and file paths in terminal output are now links. Open a link in your default browser or in the Kangentic browser, and hover one to see what each click does.
- A Reset terminal hotkey clears stuck terminal modes without touching the agent.
- Browser pane annotations are numbered and sent to the agent together.
- The Changes panel shows a pull request's failing checks, and Send to agent hands them to the task's agent.
- A task can be based on a local branch, a tag or a commit.
- Worktrees can copy folders and globs from the project, and link shared folders instead of copying them.
- Notifications gain an app icon badge, a sound per event, and Mute.
- Opening a task the idle timeout paused resumes it.
- Task cards show priority ahead of labels.
- Each column can carry a description of its purpose, which workflows read when they route tasks.
- Dictation runs on sherpa-onnx 2.0.1, and a speech model whose files are corrupt downloads itself again.

## Bug Fixes

- A long prompt now starts under cmd on Windows, and a resume that finds no conversation starts fresh instead of failing again.
- A command too long for its shell is refused at once with a clear reason, instead of showing a working agent for minutes. Task descriptions are capped at 27,500 characters to stay under that limit.
- Fixed cases where a task showed the wrong working or idle state around background shells, TaskStop, and permission prompts that ended in an error.
- An agent driving the browser no longer brings up a task window.
- Browser automation says when a page refuses a navigation, and `kangentic_browser_eval` reports what the page threw.
- Loopback popups no longer say "Not secure", and popup zoom works.
- Dictation keeps focus in the Browser pane while you draw, ends a hold on any release, and no longer garbles the text when the cursor moves mid-hold.
- Alt letter shortcuts match by key position, so they fire on macOS and AltGr layouts.
- Removing a worktree is refused when its link record cannot be read, so a recursive delete can never follow a linked folder into the main checkout.
- Plan approval no longer reports a failed save when a session folder is missing.
