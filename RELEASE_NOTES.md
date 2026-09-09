## What's New

- **Semantic memory works in packaged builds.** The embed worker was forked without part of its dependency closure, so it exited at startup on every installed copy and semantic search never ran. If you have only used a released build, this is the first version where it works at all.

## Bug Fixes

- Relaunching Kangentic while it was still running with no visible window no longer crashes. A browser pane that outlived its window kept the process alive holding the single-instance lock, so relaunching appeared to do nothing, and the launch after that crashed.
- Terminal sessions shut down cleanly when macOS or Linux restarts or logs out. Kangentic now asks the OS to wait while it drains them, instead of having them killed mid-write.
- Crash reports are no longer polluted by unrelated programs. Crashes from processes launched out of a Kangentic terminal were being uploaded as ours, and a report sent after an update was blamed on the version that uploaded it rather than the one that crashed.
- Opening a file or folder no longer leaves the request hanging on Linux, where the handler could sit waiting on whatever viewer it launched.
- The Command Terminal reattaches its surviving terminals after a reload instead of losing track of them.
- Usage stats record run duration and board shape, which were missing from the dashboard.
