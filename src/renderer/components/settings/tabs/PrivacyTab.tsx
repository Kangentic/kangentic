import type { ReactNode } from 'react';
import { ChartColumn, HardDrive, Mail, ToggleLeft } from 'lucide-react';
import { SettingsCard, CardTile } from '../settings-card';
import { SETTING_LABEL_CLASS } from '../../SettingText';

const PRIVACY_CONTACT_EMAIL = 'support@kangentic.com';
const PRIVACY_CONTACT_MAILTO = `mailto:${PRIVACY_CONTACT_EMAIL}`;

/** A tile's heading, the same weight a setting row's label has. */
function TileHeading({ children }: { children: ReactNode }) {
  return <div className={`${SETTING_LABEL_CLASS} mb-1.5`}>{children}</div>;
}

export function PrivacyTab() {
  return (
    <div className="space-y-4">
      <SettingsCard
        icon={<ChartColumn size={16} />}
        label="Analytics"
        description="Anonymous analytics only. No personal data collected."
        searchIds={['privacy.info']}
      >
        <CardTile>
          <TileHeading>What we collect</TileHeading>
          <ul className="list-disc pl-4 text-sm text-fg-muted space-y-1">
            <li>App launches, platform, and architecture</li>
            <li>App crashes and errors (stack traces with machine-specific paths removed from app code)</li>
            <li>Task and project creation counts</li>
            <li>Agent session starts, exit codes, and duration</li>
            <li>Which features get used, as daily counts (never their content)</li>
          </ul>
        </CardTile>
        <CardTile>
          <TileHeading>What we don&apos;t collect</TileHeading>
          <ul className="list-disc pl-4 text-sm text-fg-muted space-y-1">
            <li>Task titles, descriptions, or any user-generated content</li>
            <li>File paths, project names, or code</li>
            <li>Usernames, emails, or any personally identifiable information</li>
          </ul>
        </CardTile>
        <CardTile className="space-y-2">
          <TileHeading>How it works</TileHeading>
          <p className="text-sm text-fg-muted leading-relaxed">
            Usage analytics are powered by Aptabase, a privacy-first platform.
            No cookies. IP addresses are used for geographic lookup only, then
            discarded. A single anonymous, non-reversible install id counts unique
            installs; it contains no personal data. GDPR-compliant by design.
          </p>
          <p className="text-sm text-fg-muted leading-relaxed">
            Crash and error reports go to Sentry so bugs can be diagnosed and
            fixed. Stack traces are recorded with machine-specific paths removed
            from app code; no task content, code, or personal data is attached.
          </p>
        </CardTile>
      </SettingsCard>

      <SettingsCard
        icon={<HardDrive size={16} />}
        label="Conversation search"
        description="Indexing and semantic search run on this device."
        searchIds={['privacy.info']}
      >
        <CardTile>
          <p className="text-sm text-fg-muted leading-relaxed">
            Local conversation indexing and semantic search settings live in the{' '}
            <span className="text-fg-secondary">Search</span> tab. All of it runs on your device with no
            API key; nothing leaves your machine.
          </p>
        </CardTile>
      </SettingsCard>

      <SettingsCard
        icon={<ToggleLeft size={16} />}
        label="Opting out"
        description="Environment variables that turn telemetry off."
        searchIds={['privacy.info']}
      >
        <CardTile>
          <p className="text-sm text-fg-muted leading-relaxed">
            Set <code className="font-mono">KANGENTIC_TELEMETRY=0</code> as an environment variable to
            disable all telemetry (analytics and error reporting). Set{' '}
            <code className="font-mono">KANGENTIC_ERROR_REPORTING=0</code> to disable only error
            reporting while keeping anonymous analytics.
          </p>
        </CardTile>
      </SettingsCard>

      <SettingsCard
        icon={<Mail size={16} />}
        label="Questions"
        description="Ask us anything about what Kangentic collects."
        searchIds={['privacy.info']}
      >
        <CardTile>
          <p className="text-sm text-fg-muted leading-relaxed">
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
          </p>
        </CardTile>
      </SettingsCard>
    </div>
  );
}
