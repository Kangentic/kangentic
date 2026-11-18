# Releases

## Shipping a release

* [Deployment](deployment.md) - How a release ships and installs update: auto-update per platform, Linux package-manager updates, the release.yml sequence (draft, build matrix, asset check, publish, npm, demo, posters), signing secrets, the merged macOS update feed, rollback and cache clearing.
* [Scheduled checks](scheduled-checks.md) - The workflows that run on a schedule to catch what breaks with no commit (a dead signing credential, an agent CLI release that changes what Kangentic reads), what reads each one, what to do when one is red, and what is deliberately not checked.
* [Release smoke checklist](release-checklist.md) - The manual smoke test run against a packaged build with a real authenticated OpenCode CLI (create, plan, finish, resume, conversation continuity), the macOS launch overlay check, and what to do when a step fails.

## User-facing notices

* [In-app announcements](announcements.md) - How the desktop app polls announcements.json every 4 hours, filters entries by version, platform and expiry, shows a banner and megaphone history, keeps a 50-entry local archive with separate dismissed and read state, and how to publish or retract an entry safely.
