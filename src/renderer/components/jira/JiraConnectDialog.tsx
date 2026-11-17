import { useEffect, useRef, useState } from 'react';
import { KeyRound, LoaderCircle, Lock } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { BaseDialog } from '../dialogs/BaseDialog';
import { ArtifactPlatformLogo } from '../VendorMark';
import {
  ConnectChoices,
  ConnectError,
  ConnectField,
  ConnectFooter,
  ConnectFootnote,
  ConnectOpenLink,
  ConnectStepText,
  ConnectSteps,
  type ConnectStep,
} from '../backlog/connect/ConnectParts';
import type { ProviderSetupDialogProps } from '../backlog/import-providers';
import { reportRendererFailure } from '../../utils/renderer-failure';
import type { JiraConnectErrorCode, JiraConnectResult, JiraDeployment, JiraDetectSiteResult } from '../../../shared/types';

type TokenMethod = 'api-token' | 'pat' | 'password';
type Phase = 'detecting' | 'choices' | 'steps';

const ATLASSIAN_API_TOKENS_URL = 'https://id.atlassian.com/manage-profile/security/api-tokens';
const SITE_PLACEHOLDER = 'your-site.atlassian.net'; // i18n-ok: an example host
const EMAIL_PLACEHOLDER = 'you@example.com'; // i18n-ok: an example address
const DATA_CENTER_TOKENS_PATH = '/secure/ViewProfile.jspa?selectedTab=com.atlassian.pats.pats-plugin:jira-user-personal-access-tokens';

/** The site as people read it: no `https://`, no trailing slash. */
function readableSite(site: string): string {
  return site.trim().replace(/^https:\/\//i, '').replace(/\/+$/, '');
}

/**
 * Connect Jira. Opens on the site a link
 * named, asks the site whether it runs Cloud or Data Center, and shows that
 * deployment's ways in: Data Center offers a personal access token or a
 * password as two equal choices; Cloud opens straight on the API token steps
 * until its browser sign-in ships, so Back is hidden there.
 */
export function JiraConnectDialog({ prefill, initialError, onClose, onSaved }: ProviderSetupDialogProps) {
  const { t } = useLingui();
  // Why the dialog was reopened (Jira refused the saved token), shown until the user's own try.
  const [reopenReason, setReopenReason] = useState<string | null>(initialError ?? null);
  const initialSite = readableSite(prefill?.site ?? '');
  const [site, setSite] = useState(initialSite);
  const [siteBase, setSiteBase] = useState<string | null>(null);
  const [deployment, setDeployment] = useState<JiraDeployment | null>(null);
  const [phase, setPhase] = useState<Phase>(initialSite ? 'detecting' : 'steps');
  const [method, setMethod] = useState<TokenMethod>('api-token');
  const [email, setEmail] = useState(prefill?.email ?? '');
  const [username, setUsername] = useState(prefill?.username ?? '');
  const [secret, setSecret] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<Extract<JiraConnectResult, { ok: false }> | null>(null);
  const detectedSiteRef = useRef<string | null>(null);

  // Ask the site which Jira it runs, then show that deployment's ways in. A
  // Reopened for a rejected token (prefill carries a method), it opens the method last used.
  const applyDetection = (typed: string, detected: JiraDetectSiteResult, openedOnSite: boolean) => {
    if (detectedSiteRef.current !== typed) return;
    setSiteBase(detected.site);
    setDeployment(detected.deployment);
    const rememberedMethod = prefill?.method;
    if (detected.deployment === 'cloud') {
      // Cloud has one way in: the API token steps.
      setMethod('api-token');
      setPhase('steps');
    } else if (rememberedMethod === 'pat' || rememberedMethod === 'password') {
      // A reopen goes back to the Data Center method last used.
      setMethod(rememberedMethod);
      setPhase('steps');
    } else if (openedOnSite) {
      // A Data Center site the dialog opened on: offer both ways in.
      setPhase('choices');
    } else {
      // The Site field was edited and the site runs Data Center. Leave the Cloud
      // token steps for a personal access token, and keep a Data Center choice
      // already made.
      setMethod((current) => (current === 'api-token' ? 'pat' : current));
    }
  };

  /** Ask the site which Jira it runs, once per site text. */
  const detect = (siteText: string, openedOnSite: boolean) => {
    const typed = siteText.trim();
    if (!typed || detectedSiteRef.current === typed) return;
    detectedSiteRef.current = typed;
    window.electronAPI.backlog.jira.detectSite(typed)
      .then((detected) => applyDetection(typed, detected, openedOnSite))
      .catch((error: unknown) => {
        reportRendererFailure('jira-connect', 'detect-site', error);
        // A failure for site text the user has since changed says nothing about the new text.
        if (detectedSiteRef.current !== typed) return;
        // Forget the text, so a blur on it asks again.
        detectedSiteRef.current = null;
        setFailure({ ok: false, code: 'invalid' });
        setPhase('steps');
      });
  };

  useEffect(() => {
    if (initialSite) detect(initialSite, true);
    // The first detection runs once, for the site the dialog opened on.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- detect reads state the dialog sets after it
  }, []);

  const canConnect = site.trim().length > 0 && secret.trim().length > 0
    && (method !== 'api-token' || email.trim().length > 0)
    && (method !== 'password' || username.trim().length > 0);

  const connect = async () => {
    if (!canConnect || submitting) return;
    setSubmitting(true);
    setFailure(null);
    setReopenReason(null);
    try {
      const result = await window.electronAPI.backlog.jira.connect({
        site,
        method,
        email: method === 'api-token' ? email : undefined,
        username: method === 'password' ? username : undefined,
        secret,
      });
      if (result.ok) {
        onSaved();
        return;
      }
      setFailure(result);
    } catch (error) {
      reportRendererFailure('jira-connect', 'connect', error);
      setFailure({ ok: false, code: 'unreachable', site: readableSite(site) });
    } finally {
      setSubmitting(false);
    }
  };

  const failureLine = (code: JiraConnectErrorCode, failedSite: string | undefined, detail: string | undefined): string => {
    const shownSite = failedSite ?? readableSite(site);
    switch (code) {
      case 'rejected':
        if (method === 'api-token') return t`Jira rejected this email and token.`;
        if (method === 'password') return t`Jira rejected this username and password.`;
        return t`Jira rejected this token.`;
      case 'unreachable':
        return detail ? t`Couldn't reach ${shownSite}: ${detail}.` : t`Couldn't reach ${shownSite}.`;
      case 'captcha':
        return t`Jira wants a CAPTCHA before password sign-in.`;
      case 'password-off':
        return t`This site turned off password sign-in.`;
      case 'invalid':
        return t`Check the site address.`;
    }
  };

  const siteField = (
    <ConnectField
      id="jira-connect-site"
      label={t`Site`}
      value={site}
      onChange={(value) => { setSite(value); setFailure(null); }}
      onBlur={() => detect(site, false)}
      placeholder={SITE_PLACEHOLDER}
      autoFocus={!initialSite}
      testId="jira-connect-site-input"
    />
  );

  const secretField = (label: string, placeholder: string) => (
    <ConnectField
      id="jira-connect-secret"
      label={label}
      value={secret}
      onChange={(value) => { setSecret(value); setFailure(null); }}
      onEnter={() => void connect()}
      placeholder={placeholder}
      secret
      autoFocus={Boolean(initialSite) && (method !== 'api-token' || email.length > 0)}
      testId="jira-connect-secret-input"
    />
  );

  const errorLine = failure ? failureLine(failure.code, failure.site, failure.detail) : reopenReason;

  const stepsFor = (selected: TokenMethod): ConnectStep[] | null => {
    if (selected === 'api-token') {
      return [
        {
          title: <Trans>Open your Atlassian API tokens</Trans>,
          content: <ConnectOpenLink href={ATLASSIAN_API_TOKENS_URL} label={t`Open id.atlassian.com`} testId="jira-connect-open-tokens-btn" />,
        },
        {
          title: <Trans>Create an API token</Trans>,
          content: (
            <ConnectStepText>
              <Trans comment="The highlighted phrase is a button label in Atlassian's own English interface. Keep it as written.">
                Click <span className="text-fg">Create API token</span>, name it &quot;Kangentic&quot;, and copy it.
              </Trans>
            </ConnectStepText>
          ),
        },
        {
          title: <Trans>Paste it here</Trans>,
          content: (
            <>
              {siteField}
              <ConnectField
                id="jira-connect-email"
                label={t`Email`}
                value={email}
                onChange={(value) => { setEmail(value); setFailure(null); }}
                placeholder={EMAIL_PLACEHOLDER}
                autoFocus={Boolean(initialSite) && email.length === 0}
                testId="jira-connect-email-input"
              />
              {secretField(t`API token`, t`Paste your token`)}
              <ConnectFootnote />
              <ConnectError message={errorLine} testId="jira-connect-error" />
            </>
          ),
        },
      ];
    }
    if (selected === 'pat') {
      const profileUrl = `${siteBase ?? `https://${readableSite(site)}`}${DATA_CENTER_TOKENS_PATH}`;
      const shownSite = readableSite(site);
      return [
        {
          title: <Trans>Open your Jira profile</Trans>,
          content: <ConnectOpenLink href={profileUrl} label={t`Open ${shownSite}`} testId="jira-connect-open-profile-btn" />,
        },
        {
          title: <Trans>Create a personal access token</Trans>,
          content: (
            <ConnectStepText>
              <Trans comment="The highlighted phrases are labels in Jira's own English interface. Keep them as written.">
                Open <span className="text-fg">Personal Access Tokens</span>, click <span className="text-fg">Create token</span>, and copy it.
              </Trans>
            </ConnectStepText>
          ),
        },
        {
          title: <Trans>Paste it here</Trans>,
          content: (
            <>
              {siteField}
              {secretField(t`Personal access token`, t`Paste your token`)}
              <ConnectFootnote />
              <ConnectError message={errorLine} testId="jira-connect-error" />
            </>
          ),
        },
      ];
    }
    return null;
  };

  const steps = stepsFor(method);
  const isDataCenter = deployment === 'datacenter';
  const backToChoices = isDataCenter ? () => { setPhase('choices'); setFailure(null); setSecret(''); } : undefined;

  const body = (() => {
    if (phase === 'detecting') {
      return (
        <div className="flex justify-center py-6" data-testid="jira-connect-detecting">
          <LoaderCircle size={20} className="animate-spin text-fg-faint" />
        </div>
      );
    }
    if (phase === 'choices') {
      return (
        <ConnectChoices
          onChoose={(choice) => { setMethod(choice === 'password' ? 'password' : 'pat'); setPhase('steps'); setFailure(null); }}
          choices={[
            {
              id: 'pat',
              icon: <KeyRound size={16} />,
              label: t`Use a personal access token`,
              sublabel: t`Create one in your Jira profile`,
              accent: true,
              testId: 'jira-connect-choice-pat',
            },
            {
              id: 'password',
              icon: <Lock size={16} />,
              label: t`Use your password`,
              sublabel: t`Your Jira username and password`,
              testId: 'jira-connect-choice-password',
            },
          ]}
        />
      );
    }
    if (steps) return <ConnectSteps steps={steps} />;
    // Password: no steps, just the fields.
    return (
      <div className="flex flex-col gap-2 text-sm">
        {siteField}
        <ConnectField
          id="jira-connect-username"
          label={t`Username`}
          value={username}
          onChange={(value) => { setUsername(value); setFailure(null); }}
          placeholder={t`Your Jira username`}
          autoFocus={username.length === 0}
          testId="jira-connect-username-input"
        />
        {secretField(t`Password`, t`Your Jira password`)}
        <ConnectFootnote />
        <ConnectError message={errorLine} testId="jira-connect-error" />
      </div>
    );
  })();

  return (
    <BaseDialog
      onClose={onClose}
      title={t`Connect Jira`}
      icon={<span className="flex text-accent"><ArtifactPlatformLogo platformId="jira" size={18} /></span>}
      testId="jira-connect-dialog"
      className="w-[480px]"
      save={phase === 'steps' ? { onSave: () => void connect(), disabled: !canConnect || submitting } : undefined}
      footer={
        <ConnectFooter
          onBack={phase === 'steps' ? backToChoices : undefined}
          onCancel={onClose}
          onConnect={phase === 'steps' ? () => void connect() : undefined}
          connectDisabled={!canConnect}
          submitting={submitting}
          testIdPrefix="jira-connect"
        />
      }
    >
      {body}
    </BaseDialog>
  );
}
