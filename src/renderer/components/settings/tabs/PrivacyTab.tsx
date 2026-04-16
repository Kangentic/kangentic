import { ShieldAlert } from 'lucide-react';
import { Pill } from '../../Pill';
import { SectionHeader } from '../shared';

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
        <li>App crashes and errors (sanitized, no file paths)</li>
        <li>Task and project creation counts</li>
        <li>Agent session starts, exit codes, and duration</li>
      </ul>

      <SectionHeader label="What We Don't Collect" />
      <ul className="list-disc list-inside text-sm text-fg-muted space-y-1 ml-1">
        <li>Task titles, descriptions, or any user-generated content</li>
        <li>File paths, project names, or code</li>
        <li>Usernames, emails, or any personally identifiable information</li>
      </ul>

      <SectionHeader label="How It Works" />
      <p className="text-sm text-fg-muted leading-relaxed">
        Analytics are powered by Aptabase, a privacy-first platform.
        No cookies or persistent identifiers. IP addresses are used
        for geographic lookup only, then discarded. GDPR-compliant by design.
      </p>

      <SectionHeader label="How to Opt Out" />
      <p className="text-sm text-fg-muted leading-relaxed">
        Set <code className="font-mono">KANGENTIC_TELEMETRY=0</code> as an environment variable to disable analytics.
      </p>
    </div>
  );
}
