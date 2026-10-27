import type { ReactNode } from 'react';
import { ChartColumn, HardDrive, Mail, ToggleLeft } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { SettingsCard, CardTile } from '../settings-card';
import { SETTING_LABEL_CLASS } from '../../SettingText';

const PRIVACY_CONTACT_EMAIL = 'support@kangentic.com';
const PRIVACY_CONTACT_MAILTO = `mailto:${PRIVACY_CONTACT_EMAIL}`;

/** A tile's heading, the same weight a setting row's label has. */
function TileHeading({ children }: { children: ReactNode }) {
  return <div className={`${SETTING_LABEL_CLASS} mb-1.5`}>{children}</div>;
}

export function PrivacyTab() {
  const { t } = useLingui();
  return (
    <div className="space-y-4">
      <SettingsCard
        icon={<ChartColumn size={16} />}
        label={t`Analytics`}
        description={t`Anonymous analytics only. No personal data collected.`}
        searchIds={['privacy.info']}
      >
        <CardTile>
          <TileHeading><Trans>What we collect</Trans></TileHeading>
          <ul className="list-disc pl-4 text-sm text-fg-muted space-y-1">
            <li><Trans>App launches, platform, and architecture</Trans></li>
            <li><Trans>App crashes and errors (stack traces with machine-specific paths removed from app code)</Trans></li>
            <li><Trans>Task and project creation counts</Trans></li>
            <li><Trans>Agent session starts, exit codes, and duration</Trans></li>
            <li><Trans>Which features get used, as daily counts (never their content)</Trans></li>
          </ul>
        </CardTile>
        <CardTile>
          <TileHeading><Trans>What we don&apos;t collect</Trans></TileHeading>
          <ul className="list-disc pl-4 text-sm text-fg-muted space-y-1">
            <li><Trans>Task titles, descriptions, or any user-generated content</Trans></li>
            <li><Trans>File paths, project names, or code</Trans></li>
            <li><Trans>Usernames, emails, or any personally identifiable information</Trans></li>
          </ul>
        </CardTile>
        <CardTile className="space-y-2">
          <TileHeading><Trans>How it works</Trans></TileHeading>
          <p className="text-sm text-fg-muted leading-relaxed">
            <Trans>
              Usage analytics are powered by Aptabase, a privacy-first platform.
              No cookies. IP addresses are used for geographic lookup only, then
              discarded. A single anonymous, non-reversible install id counts unique
              installs; it contains no personal data. GDPR-compliant by design.
            </Trans>
          </p>
          <p className="text-sm text-fg-muted leading-relaxed">
            <Trans>
              Crash and error reports go to Sentry so bugs can be diagnosed and
              fixed. Stack traces are recorded with machine-specific paths removed
              from app code; no task content, code, or personal data is attached.
            </Trans>
          </p>
        </CardTile>
      </SettingsCard>

      <SettingsCard
        icon={<HardDrive size={16} />}
        label={t`Knowledge Graph`}
        description={t`What runs on this device, and what goes to the agent you choose.`}
        searchIds={['privacy.info']}
      >
        <CardTile>
          <p className="text-sm text-fg-muted leading-relaxed">
            <Trans>
              Indexing and the local model that finds by meaning live in the{' '}
              <span className="text-fg-secondary">Knowledge Graph</span> tab, and run on your device with
              no API key. When you ask a question, the agent you choose there receives it with the
              board&apos;s task list, the conversation passages and code found for it, and the chat so far.
              To write a task summary, it receives that task&apos;s title, description, commits, changed
              files and closing messages.
            </Trans>
          </p>
        </CardTile>
      </SettingsCard>

      <SettingsCard
        icon={<ToggleLeft size={16} />}
        label={t`Opting out`}
        description={t`Environment variables that turn telemetry off.`}
        searchIds={['privacy.info']}
      >
        <CardTile>
          <p className="text-sm text-fg-muted leading-relaxed">
            <Trans>
              Set <code className="font-mono">KANGENTIC_TELEMETRY=0</code> as an environment variable to
              disable all telemetry (analytics and error reporting). Set{' '}
              <code className="font-mono">KANGENTIC_ERROR_REPORTING=0</code> to disable only error
              reporting while keeping anonymous analytics.
            </Trans>
          </p>
        </CardTile>
      </SettingsCard>

      <SettingsCard
        icon={<Mail size={16} />}
        label={t`Questions`}
        description={t`Ask us anything about what Kangentic collects.`}
        searchIds={['privacy.info']}
      >
        <CardTile>
          <p className="text-sm text-fg-muted leading-relaxed">
            <Trans>
              Write to{' '}
              <button
                type="button"
                data-testid="privacy-contact-email"
                onClick={() => void window.electronAPI.shell.openExternal(PRIVACY_CONTACT_MAILTO)}
                className="text-fg-secondary underline underline-offset-2 hover:text-fg transition-colors cursor-pointer"
              >
                {PRIVACY_CONTACT_EMAIL}
              </button>
              .
            </Trans>
          </p>
        </CardTile>
      </SettingsCard>
    </div>
  );
}
