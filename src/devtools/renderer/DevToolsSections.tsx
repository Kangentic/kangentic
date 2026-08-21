import { Network, Code2, Compass, Megaphone, Sparkles, Rocket } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { AppConfig } from '../../shared/types';
import type { Announcement, AnnouncementArchiveEntry } from '../../shared/announcements';
import { useScopedUpdate } from '../../renderer/components/settings/shared';
import { useConfigStore } from '../../renderer/stores/config-store';
import { useProjectStore } from '../../renderer/stores/project-store';
import { useUpdaterStore } from '../../renderer/stores/updater-store';
import { useAnnouncementsStore } from '../../renderer/stores/announcements-store';
import {
  Code,
  Description,
  GroupHeading,
  ToggleRow,
} from '../../renderer/components/settings/tabs/dev-tab-primitives';

const FIXTURE_RELEASE_NOTES = `## What's New

- **Release notes modal** - see what changed before you restart to update.
- **Faster board load** - the initial swimlane render is now [twice as fast](https://github.com/Kangentic/kangentic).

## Bug Fixes

- Fixed a crash when opening an empty board.
- \`Escape\` now closes the release-notes modal like every other dialog.
`;

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * A feed and archive shaped like a real poll's output, exercising every
 * announcement surface at once: the banner takes the highest-priority active
 * entry, the badge counts the two unread, and history additionally carries an
 * entry that is NO LONGER active, which is the case only the local archive can
 * produce.
 *
 * Ids are stamped per click rather than fixed. Dismissal persists per id in
 * `dismissedAnnouncementIds`, so a fixed id would hide the banner permanently
 * after the first dismissal with no UI to undo it. Stale fixture ids drain
 * themselves on the next dismissal (computeDismissedIdsAfterDismiss prunes to
 * ids still in the active feed).
 */
function buildAnnouncementFixture(): {
  active: Announcement[];
  history: AnnouncementArchiveEntry[];
} {
  const stamp = Date.now();
  const headline: Announcement = {
    id: `dev-fixture-headline-${stamp}`,
    title: 'Kangentic Mobile is almost here - iOS in review, Android in beta',
    body: 'The mobile companion app is on its way to **both stores**. Here is where each platform stands.',
    links: [],
    sections: [
      { heading: 'iOS: in App Store review', body: 'Submitted and waiting on Apple. Nothing to do yet.' },
      {
        heading: 'Android: open for beta testers',
        body: 'Two steps: join the group, then become a tester.',
        links: [
          { label: 'Join the testers Google Group', url: 'https://groups.google.com/g/kangentic-testers', qr: true },
        ],
      },
    ],
    publishedAt: isoDaysAgo(2),
    priority: 5,
  };
  const secondary: Announcement = {
    id: `dev-fixture-secondary-${stamp}`,
    title: 'Agent Monitor now spans every project',
    body: 'One view over every running agent on this machine, not just the open project.',
    links: [{ label: 'Read the docs', url: 'https://kangentic.com/docs/' }],
    publishedAt: isoDaysAgo(16),
  };
  const retired: Announcement = {
    id: `dev-fixture-retired-${stamp}`,
    title: 'Command Terminal: multiple terminals, tiled and persistent',
    body: 'Expired upstream, kept by the local archive. Proves history outlives the feed.',
    links: [],
    publishedAt: isoDaysAgo(120),
  };

  return {
    active: [headline, secondary],
    history: [
      { announcement: headline, firstSeenAt: isoDaysAgo(2), readAt: null },
      { announcement: secondary, firstSeenAt: isoDaysAgo(16), readAt: null },
      { announcement: retired, firstSeenAt: isoDaysAgo(120), readAt: isoDaysAgo(119) },
    ],
  };
}

/**
 * A dev-only trigger row: what it opens on the left, the button that opens it
 * on the right. Local to this file rather than `dev-tab-primitives.tsx` so the
 * whole row stays inside the build-excluded `src/devtools/` tree. The title and
 * description classes mirror `ToggleRow`'s so every row on this tab reads as one
 * family.
 */
function ActionRow({
  icon: Icon,
  title,
  description,
  note,
  label,
  onClick,
  testId,
  disabled,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  /**
   * An extra line under the description, for giving a disabled button its
   * reason. A `title` tooltip cannot do that job: a disabled button leaves the
   * tab order and fires no pointer events, so the tooltip is unreachable by
   * both keyboard and hover.
   */
  note?: string;
  label: string;
  onClick: () => void;
  testId: string;
  disabled?: boolean;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-3 rounded-lg bg-surface-hover px-4 py-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-fg-primary">{title}</div>
          <div className="text-xs text-fg-muted">{description}</div>
          {note && <div className="mt-1 text-xs text-fg-faint">{note}</div>}
        </div>
        <button
          type="button"
          onClick={onClick}
          disabled={disabled}
          data-testid={testId}
          className={`inline-flex flex-shrink-0 items-center gap-1.5 rounded-md border border-edge/60 bg-surface-inset/40 px-2.5 py-1 text-xs font-medium text-fg-secondary transition-colors ${
            disabled
              ? 'opacity-40 cursor-not-allowed'
              : 'hover:border-accent/50 hover:bg-accent/10 hover:text-fg'
          }`}
        >
          <Icon size={13} />
          {label}
        </button>
      </div>
    </section>
  );
}

/**
 * Dev-only sections appended to the bottom of the product Developer
 * settings tab. Rendered only when `__KANGENTIC_DEV__` is true at compile
 * time; production builds tree-shake this entire file out.
 *
 * Reuses primitives from `dev-tab-primitives.tsx` so the visual rhythm
 * matches the product-tier sections above. Importing from a third file
 * (rather than from `DeveloperTab.tsx` directly) avoids a circular module
 * graph - DeveloperTab also renders `<DevToolsSections />`. The boundary
 * between product and dev surfaces is the `Dev Inspection Bridge` heading
 * + thin top border.
 */
export function DevToolsSections({ globalConfig }: { globalConfig: AppConfig }) {
  const updateGlobal = useScopedUpdate('global');
  const currentProject = useProjectStore((state) => state.currentProject);
  const developerConfig = globalConfig.developer ?? {};
  // Inspection bridge defaults ON in dev builds when the user has never
  // touched the toggle. `??` returns the right-hand side only when the
  // stored value is null/undefined; explicit `false` is respected. Mirror
  // of `safeReadDeveloperFlag` in `src/main/index.ts` so the displayed
  // toggle state matches the actual bridge state.
  const inspectionEnabled = developerConfig.previewInspectionServer ?? __KANGENTIC_DEV__;
  // Eval defaults ON in dev builds (mirrors the inspection bridge) so the
  // agent-driven workflow has the high-risk endpoints available on every
  // `/preview` without a manual toggle. Localhost-only and excluded from
  // production builds. An explicit stored value still wins.
  const evalEnabled = developerConfig.previewEvalEnabled ?? __KANGENTIC_DEV__;

  return (
    <div className="space-y-3 pt-4 mt-2 border-t border-edge">
      <GroupHeading>Dev Inspection Bridge</GroupHeading>

      <section className="space-y-2">
        <ToggleRow
          icon={Network}
          title="Inspection Bridge"
          subtitle="Localhost HTTP bridge that powers the kangentic_devtools_* MCP tools"
          checked={inspectionEnabled}
          onChange={(value) => updateGlobal({ developer: { previewInspectionServer: value } })}
        />
        <Description>
          When on, exposes screenshot, click, type, drag, DOM query, React fiber query, console + log
          tail, and engine + renderer state via the <Code>kangentic_devtools_*</Code> MCP tools.
          Writes a per-worktree lockfile at <Code>.kangentic/preview.lock</Code>. Bound to 127.0.0.1
          on a random port, no auth. Defaults on in dev; excluded from production builds entirely.
        </Description>
      </section>

      <section className="space-y-2">
        <ToggleRow
          icon={Code2}
          title="Allow Unsafe Operations"
          subtitle="Lets the agent run JavaScript, fake activity events, or send raw input to a session"
          checked={evalEnabled}
          onChange={(value) => updateGlobal({ developer: { previewEvalEnabled: value } })}
        />
        <Description>
          Off by default. Three high-risk endpoints are gated behind this toggle:{' '}
          <strong>devtools eval</strong> (<Code>kangentic_devtools_eval</Code>, which runs any
          JavaScript in Kangentic&apos;s own renderer process; the agent browser&apos;s eval is a
          separate setting under Agent Browser),{' '}
          <strong>inject session event</strong> (synthesize fake activity-engine events to test
          watchdogs and predicates without spawning a real CLI), and{' '}
          <strong>raw PTY input</strong> (write any byte sequence directly to a session's terminal,
          including control codes that bypass the click/type input path). Flip on for stress-testing
          and hard-to-reach UI paths; leave off otherwise.
        </Description>
      </section>

      {/* initUpdater() early-returns on !app.isPackaged (see
          src/main/updater.ts), so the release-notes modal is unreachable while
          dogfooding from `npm start`. This trigger fires it directly with
          fixture notes so the modal stays visible to whoever is working on it. */}
      <ActionRow
        icon={Sparkles}
        title="Release Notes Modal"
        description="Fire an update-downloaded push with fixture markdown notes. The real trigger is unreachable in dev (the updater only runs on a packaged build)."
        label="Show modal"
        testId="dev-trigger-release-notes-modal"
        onClick={() => {
          useUpdaterStore.getState().receiveUpdate({
            version: '99.0.0',
            releaseNotes: FIXTURE_RELEASE_NOTES,
          });
        }}
      />

      {/* The post-restart counterpart. Its real trigger is a version change on
          launch, which a dev session never produces, so open it directly. The
          notes are the build's own baked RELEASE_NOTES.md, not a fixture. */}
      <ActionRow
        icon={Rocket}
        title="What's New Dialog"
        description="Open the post-update notes for the running version. Normally shown once on the first launch after the version changes; the status-bar version pill is the way back in."
        label="Show dialog"
        testId="dev-trigger-whats-new-dialog"
        onClick={() => {
          useUpdaterStore.getState().openWhatsNew({ autoOpened: false });
        }}
      />

      {/* The announcements poll runs 10s after launch and then every 4 hours
          against the live feed on `main`, so in dev you wait on the network to
          see one, and the feed usually holds a single entry - which is not
          enough to exercise the badge count, the multi-row history, or a
          history entry that has left the active set.

          This pushes the same two store actions the announcements:changed IPC
          push calls, exactly as the release-notes trigger above reuses
          receiveUpdate. It is store-only: the real poll ALSO writes the archive
          sidecar, so this does not survive an HMR resync or the next real poll,
          both of which re-read main's copy. Use KANGENTIC_ANNOUNCEMENTS_URL
          against a local fixture file when you need the persistent path. */}
      <ActionRow
        icon={Megaphone}
        title="Announcements Feed"
        description="Push two active announcements plus an expired one, so the banner, the megaphone badge, and a multi-row history all have something to show without waiting on the 4-hour poll. Not persisted: a resync or the next real poll replaces it."
        label="Seed feed"
        testId="dev-trigger-announcements-feed"
        onClick={() => {
          const { active, history } = buildAnnouncementFixture();
          const store = useAnnouncementsStore.getState();
          store.receiveActive(active);
          store.receiveHistory(history);
        }}
      />

      {/* Onboarding auto-opens once per project and retires itself on skip or
          completion, so re-running the flow has no trigger at all after that
          first time - which is exactly what working on it needs. RESTART, not
          reopen: merely reopening shows a checklist still ticked from the last
          run, because the baseline steps 1 and 2 compare against is captured
          first-write-wins and never re-taken. Disabled with no project rather
          than hidden: this is a `category: 'system'` tab, so it renders with
          none open, and firing the setter then leaves the store flag true
          behind a dialog that returns null, with nothing on screen to unset
          it. */}
      <ActionRow
        icon={Compass}
        title="Onboarding Checklist"
        description="Restart the welcome checklist for the current project from step one. Clears its recorded progress; steps that read live board state stay ticked while those tasks exist."
        note={currentProject ? undefined : 'Open a project first - the checklist runs against the current one.'}
        label="Restart checklist"
        testId="dev-trigger-onboarding-checklist"
        disabled={!currentProject}
        onClick={() => {
          if (!currentProject) return;
          // Reset first, THEN open: the dialog re-baselines on mount and that capture is
          // first-write-wins, so opening before the write lands keeps steps 1 and 2 ticked.
          // The catch is load-bearing, not decoration: `updateConfig` does not swallow a
          // failed `config.set`, so without it a failed write leaves the fulfillment handler
          // unrun (the button silently does nothing) and the rejection unhandled.
          void useConfigStore.getState().resetOnboarding(currentProject.id)
            .then(() => {
              useConfigStore.getState().setOnboardingChecklistOpen(true);
            })
            .catch((resetError) => {
              console.warn('[DEV] Onboarding reset failed:', resetError);
            });
        }}
      />
    </div>
  );
}
