# Release Smoke Checklist

Manual validation against real, authenticated agent CLIs before publishing a draft release. Automated tests use mock fixtures (`tests/fixtures/mock-*.{js,cmd}`) which exercise spawn, capture, and resume mechanics but do not exercise real model latency, real tool calls, or conversation continuity across resume. This checklist closes that gap.

Run from a packaged build (`npm run make`) on the platform you primarily ship from, against a project that has the agent CLI installed and authenticated. Use a throwaway project directory so file writes do not pollute real work.

If any step fails, do not publish the draft release. File a bug, fix forward, cut a new tag.

## OpenCode

Prerequisites:

- `opencode --version` resolves on PATH
- OpenCode is authenticated (logged in to a provider, model selected)
- A scratch project opened in Kangentic with the default swimlanes (`To Do`, `Planning`, `Executing`, `Code Review`, `Tests`, `Ship It`, `Done`) and OpenCode set as the project default agent
- The scratch project contains a file with non-trivial prose (e.g. a real `README.md`) so the prompt in step 1 has something to summarize

Steps:

1. **Create a task** in `To Do` with a title and a description that asks OpenCode to read a known file in the project (e.g. "Read README.md and summarize the first paragraph").
2. **Drag the task to `Planning`.** Verify:
   - A PTY session spawns and the OpenCode TUI renders in the bottom panel
   - The shimmer overlay clears within a few seconds (cursor-hide marker observed)
   - A session ID is captured (visible in the task detail dialog header)
3. **Verify the model responds.** Wait for OpenCode to produce a real assistant turn (not the mock's static greeting). Confirm the response references the prompt content.
4. **Verify a real tool call.** Confirm OpenCode invokes its file-read tool against the file named in the prompt and that the response paraphrases the actual file contents.
5. **Drag the task to `Done`.** Verify the session is suspended and the terminal panel detaches cleanly. Check Task Manager (Windows: look for `opencode.exe`) or `ps` (macOS/Linux: look for `opencode`) to confirm no orphaned process remains.
6. **Unarchive the task** (drag back out of `Done`, or use the unarchive control). Verify the session resumes:
   - The same session ID is reused (no new ID emitted)
   - The TUI reattaches with the prior conversation visible in scrollback
7. **Verify conversation continuity.** Send a second prompt that depends purely on the prior assistant turn (e.g. "Repeat the summary you just gave back to me verbatim" or "What did you just tell me?"). Confirm OpenCode answers using the prior context, proving the resume is real and not a fresh session.
