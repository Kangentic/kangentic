import { Network, Code2, Sparkles, Rocket } from 'lucide-react';
import type { AppConfig } from '../../shared/types';
import { useScopedUpdate } from '../../renderer/components/settings/shared';
import { useUpdaterStore } from '../../renderer/stores/updater-store';
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
          <strong>eval</strong> (run any JavaScript in the renderer process),{' '}
          <strong>inject session event</strong> (synthesize fake activity-engine events to test
          watchdogs and predicates without spawning a real CLI), and{' '}
          <strong>raw PTY input</strong> (write any byte sequence directly to a session's terminal,
          including control codes that bypass the click/type input path). Flip on for stress-testing
          and hard-to-reach UI paths; leave off otherwise.
        </Description>
      </section>

      {/* initUpdater() early-returns on !app.isPackaged and on Linux (see
          src/main/updater.ts), so the release-notes modal is unreachable while
          dogfooding from `npm start`. This trigger fires it directly with
          fixture notes so the modal stays visible to whoever is working on it. */}
      <section className="space-y-2">
        <div className="flex items-center justify-between gap-3 rounded-lg bg-surface-hover px-4 py-3">
          <div className="min-w-0">
            <div className="text-sm font-medium text-fg-primary">Release Notes Modal</div>
            <div className="text-xs text-fg-muted">
              Fire an update-downloaded push with fixture markdown notes. The real trigger is
              unreachable in dev (the updater only runs on a packaged Windows/macOS build).
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              useUpdaterStore.getState().receiveUpdate({
                version: '99.0.0',
                releaseNotes: FIXTURE_RELEASE_NOTES,
              });
            }}
            data-testid="dev-trigger-release-notes-modal"
            className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-md border border-edge/60 bg-surface-inset/40 px-2.5 py-1 text-xs font-medium text-fg-secondary transition-colors hover:border-accent/50 hover:bg-accent/10 hover:text-fg"
          >
            <Sparkles size={13} />
            Show modal
          </button>
        </div>
      </section>

      {/* The post-restart counterpart. Its real trigger is a version change on
          launch, which a dev session never produces, so open it directly. The
          notes are the build's own baked RELEASE_NOTES.md, not a fixture. */}
      <section className="space-y-2">
        <div className="flex items-center justify-between gap-3 rounded-lg bg-surface-hover px-4 py-3">
          <div className="min-w-0">
            <div className="text-sm font-medium text-fg-primary">What&apos;s New Dialog</div>
            <div className="text-xs text-fg-muted">
              Open the post-update notes for the running version. Normally shown once on the first
              launch after the version changes; the status-bar version pill is the way back in.
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              useUpdaterStore.getState().openWhatsNew({ autoOpened: false });
            }}
            data-testid="dev-trigger-whats-new-dialog"
            className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-md border border-edge/60 bg-surface-inset/40 px-2.5 py-1 text-xs font-medium text-fg-secondary transition-colors hover:border-accent/50 hover:bg-accent/10 hover:text-fg"
          >
            <Rocket size={13} />
            Show dialog
          </button>
        </div>
      </section>
    </div>
  );
}
