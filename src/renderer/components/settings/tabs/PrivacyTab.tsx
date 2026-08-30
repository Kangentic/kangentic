import { ShieldAlert } from 'lucide-react';
import { Pill } from '../../Pill';
import { SectionHeader } from '../shared';

const PRIVACY_CONTACT_EMAIL = 'support@kangentic.com';
const PRIVACY_CONTACT_MAILTO = `mailto:${PRIVACY_CONTACT_EMAIL}`;

export function PrivacyTab() {
  return (
    <div className="space-y-4">
      <Pill as="div" size="lg" className="bg-surface-hover">
        <ShieldAlert className="size-5 text-fg-muted shrink-0" />
        <span className="text-[1em] text-fg-secondary">Anonymous analytics only. No personal data collected.</span>
      </Pill>

      <SectionHeader label="What We Collect" />
      <ul className="list-disc list-inside text-sm text-fg-muted space-y-1 ml-1">
        <li>App launches, platform, and architecture</li>
        <li>App crashes and errors (stack traces with machine-specific paths removed from app code)</li>
        <li>Task and project creation counts</li>
        <li>Agent session starts, exit codes, and duration</li>
        <li>Which features get used, as daily counts (never their content)</li>
      </ul>

      <SectionHeader label="What We Don't Collect" />
      <ul className="list-disc list-inside text-sm text-fg-muted space-y-1 ml-1">
        <li>Task titles, descriptions, or any user-generated content</li>
        <li>File paths, project names, or code</li>
        <li>Usernames, emails, or any personally identifiable information</li>
      </ul>

      <SectionHeader label="How It Works" />
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

      <SectionHeader label="Conversation Search" />
      <p className="text-sm text-fg-muted leading-relaxed">
        Local conversation indexing and semantic search settings live in the{' '}
        <span className="text-fg-secondary">Memory</span> tab. All of it runs on your device with no
        API key; nothing leaves your machine.
      </p>

      <SectionHeader label="How to Opt Out" />
      <p className="text-sm text-fg-muted leading-relaxed">
        Set <code className="font-mono">KANGENTIC_TELEMETRY=0</code> as an environment variable to
        disable all telemetry (analytics and error reporting). Set{' '}
        <code className="font-mono">KANGENTIC_ERROR_REPORTING=0</code> to disable only error
        reporting while keeping anonymous analytics.
      </p>

      <SectionHeader label="Questions" />
      <p className="text-sm text-fg-muted leading-relaxed">
        Ask us anything about what Kangentic collects at{' '}
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
    </div>
  );
}
