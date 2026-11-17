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
  ConnectWaiting,
  type ConnectStep,
} from '../backlog/connect/ConnectParts';
import { useBrowserSignIn } from '../backlog/connect/useBrowserSignIn';
import type { ProviderSetupDialogProps } from '../backlog/import-providers';
import { reportRendererFailure } from '../../utils/renderer-failure';
import type { JiraConnectErrorCode, JiraConnectResult, JiraDeployment, JiraDetectSiteResult } from '../../../shared/types';

type TokenMethod = 'api-token' | 'pat' | 'password';
type Phase = 'detecting' | 'choices' | 'steps' | 'waiting';

const ATLASSIAN_API_TOKENS_URL = 'https://id.atlassian.com/manage-profile/security/api-tokens';
const SITE_PLACEHOLDER = 'your-site.atlassian.net'; // i18n-ok: an example host
const EMAIL_PLACEHOLDER = 'you@example.com'; // i18n-ok: an example address
const DATA_CENTER_TOKENS_PATH = '/secure/ViewProfile.jspa?selectedTab=com.atlassian.pats.pats-plugin:jira-user-personal-access-tokens';

/** The site as people read it: no `https://`, no trailing slash. */
function readableSite(site: string): string {
  return site.trim().replace(/^https:\/\//i, '').replace(/\/+$/, '');
}

/** Whether this build offers Sign in with Atlassian. A failed ask reads as no, leaving the token steps. */
function loadSignInAvailable(): Promise<boolean> {
  return window.electronAPI.backlog.jira.authStatus()
    .then((status) => status.signInAvailable)
    .catch((error: unknown) => {
      reportRendererFailure('jira-connect', 'auth-status', error);
      return false;
    });
}

/**
 * Connect Jira. Opens on the site a link named, asks the site whether it runs
 * Cloud or Data Center, and shows that deployment's ways in. Cloud offers Sign in
 * with Atlassian and the API token as two equal choices, or the token steps alone
 * in a build with no Atlassian client id. Data Center offers a personal access
 * token or a password. A dialog reopened for a sign-in that stopped working goes
 * back the way the user signed in: the browser sign-in again, or that method's steps.
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
  // Why the last browser sign-in failed, Atlassian's own text when it gave one. Shown on the choices.
  const [signInError, setSignInError] = useState<string | null>(null);
  const detectedSiteRef = useRef<string | null>(null);
  const [signInAvailable, setSignInAvailable] = useState(false);
  // Asked once, on the first detection, and shared by every later one. A detection
  // waits on it, so a reopen that goes straight back to the browser sign-in knows
  // whether this build offers one.
  const signInAvailableRef = useRef<Promise<boolean> | null>(null);
  const browserSignIn = useBrowserSignIn('jira');
  // A Connect still running when the user cancels must not carry the add on once it lands.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const signIn = async (signInSite: string) => {
    setFailure(null);
    setReopenReason(null);
    setSignInError(null);
    setPhase('waiting');
    const outcome = await browserSignIn.run(() => window.electronAPI.backlog.jira.signIn({ site: signInSite }));
    if (outcome.kind === 'saved') {
      onSaved();
      return;
    }
    if (outcome.kind === 'stale') return;
    setPhase('choices');
    if (outcome.kind === 'failed') setSignInError(outcome.error ?? t`Atlassian sign-in did not finish.`);
  };

  const handleClose = () => {
    browserSignIn.cancel();
    onClose();
  };

  // Ask the site which Jira it runs, then show that deployment's ways in. A dialog
  // reopened for a rejected sign-in (prefill carries a method) goes back the way it was made.
  const applyDetection = (typed: string, detected: JiraDetectSiteResult, openedOnSite: boolean, canSignIn: boolean) => {
    if (detectedSiteRef.current !== typed) return;
    setSiteBase(detected.site);
    setDeployment(detected.deployment);
    setSignInAvailable(canSignIn);
    const rememberedMethod = prefill?.method;
    if (detected.deployment === 'cloud') {
      if (canSignIn && rememberedMethod === 'oauth' && openedOnSite) {
        // Reconnect: the browser sign-in again, straight away.
        void signIn(detected.site);
      } else if (canSignIn && openedOnSite && rememberedMethod !== 'api-token') {
        // Two equal ways in: the browser sign-in or an API token.
        setPhase('choices');
      } else {
        // The API token steps: the only way in, the way a reopen last signed in,
        // or the steps the user is already on while editing the Site field.
        setMethod('api-token');
        setPhase('steps');
      }
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
    signInAvailableRef.current ??= loadSignInAvailable();
    Promise.all([window.electronAPI.backlog.jira.detectSite(typed), signInAvailableRef.current])
      .then(([detected, canSignIn]) => applyDetection(typed, detected, openedOnSite, canSignIn))
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
      if (!mountedRef.current) return;
      if (result.ok) {
        onSaved();
        return;
      }
      setFailure(result);
    } catch (error) {
      reportRendererFailure('jira-connect', 'connect', error);
      if (mountedRef.current) setFailure({ ok: false, code: 'unreachable', site: readableSite(site) });
    } finally {
      if (mountedRef.current) setSubmitting(false);
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

  const fieldsFooter = (
    <>
      <ConnectFootnote />
      <ConnectError message={errorLine} testId="jira-connect-error" />
    </>
  );

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
              {fieldsFooter}
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
              {fieldsFooter}
            </>
          ),
        },
      ];
    }
    return null;
  };

  const steps = stepsFor(method);
  const isDataCenter = deployment === 'datacenter';
  const isCloudWithSignIn = deployment === 'cloud' && signInAvailable;
  const backToChoices = isDataCenter || isCloudWithSignIn
    ? () => { setPhase('choices'); setFailure(null); setSecret(''); setReopenReason(null); }
    : undefined;
  const backFromWaiting = () => { browserSignIn.cancel(); setPhase('choices'); };
  const choicesError = signInError ?? reopenReason;

  const body = (() => {
    if (phase === 'detecting') {
      return (
        <div className="flex justify-center py-6" data-testid="jira-connect-detecting">
          <LoaderCircle size={20} className="animate-spin text-fg-faint" />
        </div>
      );
    }
    if (phase === 'waiting') {
      return (
        <ConnectWaiting
          message={<Trans>Waiting for Atlassian in your browser</Trans>}
          onReopen={browserSignIn.reopen}
          testIdPrefix="jira-connect"
        />
      );
    }
    if (phase === 'choices' && isCloudWithSignIn) {
      return (
        <div className="flex flex-col gap-2.5">
          <ConnectChoices
            onChoose={(choice) => {
              if (choice === 'oauth') {
                void signIn(siteBase ?? site);
                return;
              }
              setMethod('api-token');
              setPhase('steps');
              setFailure(null);
              setSignInError(null);
              setReopenReason(null);
            }}
            choices={[
              {
                id: 'oauth',
                icon: <ArtifactPlatformLogo platformId="jira" size={16} />,
                label: t`Sign in with Atlassian`,
                sublabel: t`Approve Kangentic in your browser`,
                accent: true,
                testId: 'jira-connect-choice-sign-in',
              },
              {
                id: 'api-token',
                icon: <KeyRound size={16} />,
                label: t`Use an API token`,
                sublabel: t`Paste a token from your Atlassian account`,
                testId: 'jira-connect-choice-api-token',
              },
            ]}
          />
          <ConnectError message={choicesError} testId="jira-connect-error" />
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
        {fieldsFooter}
      </div>
    );
  })();

  return (
    <BaseDialog
      onClose={handleClose}
      title={t`Connect Jira`}
      icon={<span className="flex text-accent"><ArtifactPlatformLogo platformId="jira" size={18} /></span>}
      testId="jira-connect-dialog"
      className="w-[480px]"
      save={phase === 'steps' ? { onSave: () => void connect(), disabled: !canConnect || submitting } : undefined}
      footer={
        <ConnectFooter
          onBack={phase === 'steps' ? backToChoices : phase === 'waiting' ? backFromWaiting : undefined}
          onCancel={handleClose}
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
