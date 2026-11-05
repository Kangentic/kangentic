## What's New

- Fourteen more agents now match much more of what Kangentic does with Claude Code, as far as each CLI's own docs support it. Depending on the agent, that adds activity hooks, turn end detection, plan mode, permission modes, model and effort pickers, resume and transcripts.
- Kimi now runs on the Kimi Code CLI 2.x. The older Python kimi-cli no longer runs agents.
- Aider sessions each keep their own chat history, so a session resumes its own conversation and shows its transcript, model and usage.
- A task whose agent never starts now pauses with an "Agent did not start" notice, instead of sitting in its column with nothing to press. Resume tries the launch again.

## Bug Fixes

- Agents on macOS start reliably again. Since v0.53.0, a launch could fail when the shell was slow to start (common with nvm or oh-my-zsh), leaving a cut-off command in the terminal while the session showed as Running. Linux and WSL had the same limit for very long launch commands. The workaround of turning off Browser automation is no longer needed.
- A worktree session now builds its Claude settings from the worktree's own settings file.
- The PR chip counts a ruleset bypass as ready to merge.
- The macOS memory warning now follows the kernel's free memory percentage.
