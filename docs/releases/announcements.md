---
type: Reference
title: In-app announcements
description: How the desktop app polls announcements.json every 4 hours, filters entries by version, platform and expiry, shows a banner and megaphone history, keeps a 50-entry local archive with separate dismissed and read state, and how to publish or retract an entry safely.
tags: [announcements, feed, banner, archive]
sources:
  - resource: src/main/announcements.ts
  - resource: src/main/announcements-archive.ts
  - resource: src/shared/announcements.ts
    title: Announcement feed schema and selection
---
# In-app announcements

The desktop app periodically fetches a static JSON feed, `announcements.json` on this repo's
`main` branch (served via `raw.githubusercontent.com`), and shows the highest-priority active
announcement as a dismissible banner above the board content; "Learn more" opens a dialog with
the markdown body, external links, and a QR code. There is no backend and no account: an
unreachable, malformed, or empty feed simply means no banner (offline and self-hosted setups
lose nothing). The poll runs 10 seconds after launch and every 4 hours (`src/main/announcements.ts`),
is skipped entirely under `NODE_ENV=test`, and never emits error telemetry.

The banner is not the only way in. A **megaphone button in the title bar** (always present, at the
right end of the icon row just before Settings, beside the update-available indicator) opens the
announcement history and carries a badge counting unread announcements. Rows open the same
"Learn more" dialog, so a dismissed or expired announcement stays re-readable.

Feed schema (`src/shared/announcements.ts`): each entry carries `id`, `title` (banner line),
`body` (markdown intro), `links` (label + https URL; a link flagged `qr: true` renders a large
scannable QR code above its button, for phone-destined links like store opt-in pages), optional
`sections` (titled sub-messages, each `{ heading?, body?, links? }`, for one announcement that
carries several messages such as per-platform statuses), `minVersion` / `maxVersion` (inclusive
version window), `platforms` (`win32` / `darwin` / `linux`; omitted = all - note this targets
the DESKTOP OS, not the user's phone), `publishedAt` / `expiresAt` (ISO 8601), and `priority`.
Unknown fields and malformed entries are ignored, so the feed can grow without breaking released
clients; an entry needing new client behavior sets `minVersion` instead.

**Publishing warning:** an edit to `announcements.json` on `main` is a production push - it
reaches every released client within one poll cycle (about 4 hours, plus ~5 minutes of CDN
cache). Set targeting fields conservatively and put an `expiresAt` on every entry.
`tests/unit/announcements-json-valid.test.ts` validates the committed file through the real
parser on every push, so a typo'd entry (which production would silently drop) fails CI on the
content PR instead of shipping invisible.

**Deleting an expired entry is allowed.** Clients keep their own archive (below), so removing a
long-expired entry from the feed no longer takes it away from anyone who already saw it. Deleting
an entry that has NOT expired still retracts it: it leaves the active list, the banner clears, and
an open banner dialog closes. It stays in the archive of every client that already saw it, and
never enters the archive of one that did not.

## The local archive

Each client keeps `<configDir>/announcements-archive.json`: every announcement that was ever
active **for that client**, most recently seen first, capped at 50 entries with the oldest pruned
on write. Ordering is by when this client first saw an entry, not by the announcement's own
`publishedAt`, so a high-priority older announcement that arrives on a later poll sorts above
entries published after it.
The poll writes it from the same filtered list the banner uses, so targeting is inherited for free
(an announcement that never matched this client never enters its history), and it is what makes the
megaphone useful in the three cases the live feed cannot cover: the ~10 seconds before the first
poll, an offline launch, and an entry deleted upstream. An entry's stored copy is refreshed when
the feed edits it in place, but its `firstSeenAt` and read-state are not. The poll is the only
writer that filters; the ephemeral preview seeds this file directly and does not, so that targeting
guarantee holds everywhere except a preview (see the end of this section).

**Dismissed and read are different states, stored apart:**

| Concept | Stored where | Effect |
|---------|--------------|--------|
| Dismissed | `dismissedAnnouncementIds` in config | hides that announcement's banner strip |
| Read | `readAt` on its archive entry | stops the megaphone badge counting it |

Opening the dialog from either entry point (the banner's "Learn more" or a history row) marks it
read. Dismissing the banner does not: a dismissed-but-unread announcement still lights the badge,
because the megaphone means "there is something you have not read", not "there is a banner". The
badge counts every unread entry, expired ones included.

Read-state cannot live in `dismissedAnnouncementIds` because that list prunes itself to ids still
in the active feed on every write, so it would forget an announcement the moment it expired.

**Authoring contract - no scrolling:** an announcement must fit its dialog without a scrollbar
on a typical desktop window (QR links lay out side by side to help; the dialog's scroll is a
safety valve for very small windows only, and a UI test pins the contract for a realistic
two-QR announcement). Keep bodies to a few short paragraphs and QR links to two or three; if a
message wants more, it should be a link to a page, not a longer announcement.

Dismissals persist per-announcement-id in `dismissedAnnouncementIds` (see the
[Top-Level reference](../settings/app-config.md#top-level)). Read-state does not: it lives on the archive entry.

**The ephemeral preview seeds both states.** A `/preview` boot wipes its data directory, which
takes the archive with it, so the first poll used to re-append every announcement as unread and
relight the badge on every launch. Before Electron starts, `scripts/dev.js` now writes the archive
with every entry's `readAt` stamped AND lists those same ids in `dismissedAnnouncementIds`. Both,
because they are the separate states above: the first darkens the badge, the second keeps the
banner down. `--fresh` skips the seed, so the first-launch experience still shows announcements
unread. A regular `npm start` is unaffected: it uses the real data directory and its real
read-state.

Two limits are deliberate. The seed reads the repo's committed `announcements.json`, so an
announcement published to `main` after this worktree branched is absent from it and still arrives
unread on the next poll; that self-corrects on a rebase. And the seed applies no targeting, so a
preview's history can list an entry that `minVersion` or `platforms` would have filtered for this
client.
