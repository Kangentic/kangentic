import { useEffect, useRef, useState } from 'react';
import { KeyRound, LoaderCircle } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { BaseDialog } from '../../dialogs/BaseDialog';
import { ArtifactPlatformLogo } from '../../VendorMark';
import {
  ConnectChoices,
  ConnectError,
  ConnectField,
  ConnectFooter,
  ConnectFootnote,
  ConnectOpenLink,
  ConnectStepText,
  ConnectSteps,
} from '../connect/ConnectParts';
import type { ProviderSetupDialogProps } from '../import-providers';
import { reportRendererFailure } from '../../../utils/renderer-failure';
import type { GitLabConnectResult, GitLabDetectServerResult } from '../../../../shared/types';

type Phase = 'detecting' | 'choices' | 'waiting' | 'steps';

const GITLAB_COM = 'gitlab.com'; // i18n-ok: a host name
const SERVER_PLACEHOLDER = 'gitlab.example.com'; // i18n-ok: an example host
const TOKEN_PAGE_PATH = '/-/user_settings/personal_access_tokens';

/** The server as people read it: no `https://`, no trailing slash. */
function readableServer(server: string): string {
  return server.trim().replace(/^https:\/\//i, '').replace(/\/+$/, '');
}

/** The token page with the name and the one scope filled in, on the server's own base. */
function tokenPageUrl(base: string): string {
  return `${base}${TOKEN_PAGE_PATH}?name=Kangentic&scopes=read_api`;
}

/**
 * Connect GitLab. Opens on the server a pasted link named (gitlab.com when none
 * did). On gitlab.com, in a build that carries Kangentic's OAuth client id, it
 * offers two equal ways in: a browser sign-in and a personal access token. Any
 * other server opens straight on the token steps, with a Server field, because
 * a browser sign-in there needs an OAuth app that server's admin registers.
 * GitLab's own refusal text is shown as sent.
 */
export function GitLabConnectDialog({ prefill, initialError, onClose, onSaved }: ProviderSetupDialogProps) {
  const { t } = useLingui();
  const initialServer = readableServer(prefill?.site ?? '') || GITLAB_COM;
  const [server, setServer] = useState(initialServer);
  const [detected, setDetected] = useState<Extract<GitLabDetectServerResult, { ok: true }> | null>(null);
  const [phase, setPhase] = useState<Phase>('detecting');
  const [cameFromChoices, setCameFromChoices] = useState(false);
  const [token, setToken] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Why the dialog was reopened (GitLab refused the saved sign-in), shown until the user's own try.
  const [reopenReason, setReopenReason] = useState<string | null>(initialError ?? null);
  const [failure, setFailure] = useState<Extract<GitLabConnectResult, { ok: false }> | null>(null);
  const detectedServerRef = useRef<string | null>(null);
  // A Connect still running when the user cancels must not carry the add on once it lands.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  /** Ask the server whether it runs GitLab, once per server text. */
  const detect = (serverText: string, openedOnServer: boolean) => {
    const typed = serverText.trim();
    if (!typed || detectedServerRef.current === typed) return;
    detectedServerRef.current = typed;
    window.electronAPI.backlog.gitlab.detectServer(typed)
      .then((result) => {
        if (detectedServerRef.current !== typed) return;
        if (!result.ok) {
          setDetected(null);
          setFailure({ ok: false, code: result.code, site: result.site, detail: result.detail });
          setPhase('steps');
          return;
        }
        setDetected(result);
        setFailure(null);
        // The two choices show only when the dialog opened on a server that offers both.
        if (openedOnServer && result.signInAvailable) setPhase('choices');
        else setPhase('steps');
      })
      .catch((error: unknown) => {
        reportRendererFailure('gitlab-connect', 'detect-server', error);
        if (detectedServerRef.current !== typed) return;
        detectedServerRef.current = null;
        setFailure({ ok: false, code: 'invalid' });
        setPhase('steps');
      });
  };

  useEffect(() => {
    detect(initialServer, true);
    // The first check runs once, for the server the dialog opened on.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- detect reads state the dialog sets after it
  }, []);

  const base = detected?.site ?? `https://${readableServer(server)}`;
  const shownServer = readableServer(detected?.site ?? server);
  const isGitLabCom = detected?.isGitLabCom ?? readableServer(server).toLowerCase() === GITLAB_COM;
  const canConnect = server.trim().length > 0 && token.trim().length > 0;

  const connectWithToken = async () => {
    if (!canConnect || submitting) return;
    setSubmitting(true);
    setFailure(null);
    setReopenReason(null);
    try {
      const result = await window.electronAPI.backlog.gitlab.connectToken({ site: server, token });
      if (!mountedRef.current) return;
      if (result.ok) {
        onSaved();
        return;
      }
      setFailure(result);
    } catch (error) {
      reportRendererFailure('gitlab-connect', 'connect-token', error);
      if (mountedRef.current) setFailure({ ok: false, code: 'unreachable', site: shownServer });
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  };

  const signIn = async () => {
    setPhase('waiting');
    setFailure(null);
    setReopenReason(null);
    try {
      const result = await window.electronAPI.backlog.gitlab.signIn(base);
      if (!mountedRef.current) return;
      if (result.ok) {
        onSaved();
        return;
      }
      if (result.code === 'cancelled') return;
      setFailure(result);
      setPhase('choices');
    } catch (error) {
      reportRendererFailure('gitlab-connect', 'sign-in', error);
      if (mountedRef.current) {
        setFailure({ ok: false, code: 'unreachable', site: shownServer });
        setPhase('choices');
      }
    }
  };

  const leaveWaiting = (next: 'choices' | 'close') => {
    window.electronAPI.backlog.gitlab.cancelSignIn().catch((error: unknown) => {
      reportRendererFailure('gitlab-connect', 'cancel-sign-in', error);
    });
    if (next === 'close') onClose();
    else setPhase('choices');
  };

  const reopenSignInPage = () => {
    window.electronAPI.backlog.gitlab.reopenSignIn().catch((error: unknown) => {
      reportRendererFailure('gitlab-connect', 'reopen-sign-in', error);
    });
  };

  const failureLine = (result: Extract<GitLabConnectResult, { ok: false }>): string | null => {
    const failedServer = result.site ?? shownServer;
    switch (result.code) {
      case 'rejected':
        // GitLab's own text, as sent.
        return result.message ?? t`GitLab rejected this token.`;
      case 'sign-in-failed':
        return result.message ?? t`GitLab sign-in did not finish.`;
      case 'unreachable':
        return result.detail ? t`Couldn't reach ${failedServer}: ${result.detail}.` : t`Couldn't reach ${failedServer}.`;
      case 'not-gitlab':
        return t`${failedServer} is not a GitLab instance.`;
      case 'invalid':
        return t`Check the server address.`;
      case 'cancelled':
        return null;
    }
  };

  const errorLine = failure ? failureLine(failure) : reopenReason;

  const tokenSteps = [
    {
      title: <Trans>Open your GitLab access tokens</Trans>,
      content: (
        <ConnectOpenLink href={tokenPageUrl(base)} label={t`Open access tokens on ${shownServer}`} testId="gitlab-connect-open-tokens-btn" />
      ),
    },
    {
      title: <Trans>Create a personal access token</Trans>,
      content: (
        <ConnectStepText>
          <Trans comment="read_api is GitLab's own name for the scope. Keep it as written.">
            The name and <span className="text-fg">read_api</span> scope are filled in. Create it, then copy it.
          </Trans>
        </ConnectStepText>
      ),
    },
    {
      title: <Trans>Paste it here</Trans>,
      content: (
        <>
          {!isGitLabCom && (
            <ConnectField
              id="gitlab-connect-server"
              label={t`Server`}
              value={server}
              onChange={(value) => { setServer(value); setFailure(null); }}
              onBlur={() => detect(server, false)}
              placeholder={SERVER_PLACEHOLDER}
              testId="gitlab-connect-server-input"
            />
          )}
          <ConnectField
            id="gitlab-connect-token"
            label={t`Personal access token`}
            value={token}
            onChange={(value) => { setToken(value); setFailure(null); }}
            onEnter={() => void connectWithToken()}
            placeholder={t`Paste your token`}
            secret
            autoFocus
            testId="gitlab-connect-token-input"
          />
          <ConnectFootnote />
          <ConnectError message={errorLine} testId="gitlab-connect-error" />
        </>
      ),
    },
  ];

  const body = (() => {
    if (phase === 'detecting') {
      return (
        <div className="flex justify-center py-6" data-testid="gitlab-connect-detecting">
          <LoaderCircle size={20} className="animate-spin text-fg-faint" />
        </div>
      );
    }
    if (phase === 'waiting') {
      return (
        <div className="flex flex-col items-center gap-2.5 py-6 text-sm text-center" data-testid="gitlab-connect-waiting">
          <LoaderCircle size={24} className="animate-spin text-fg-faint" />
          <span><Trans>Waiting for GitLab in your browser</Trans></span>
          <button
            type="button"
            onClick={reopenSignInPage}
            className="text-xs text-accent-fg hover:underline"
            data-testid="gitlab-connect-reopen-btn"
          >
            <Trans>Open the page again</Trans>
          </button>
        </div>
      );
    }
    if (phase === 'choices') {
      return (
        <div className="flex flex-col gap-2.5">
          <ConnectChoices
            onChoose={(choice) => {
              setFailure(null);
              if (choice === 'sign-in') {
                void signIn();
                return;
              }
              setCameFromChoices(true);
              setPhase('steps');
            }}
            choices={[
              {
                id: 'sign-in',
                icon: <ArtifactPlatformLogo platformId="gitlab" size={16} />,
                label: t`Sign in with GitLab`,
                sublabel: t`Approve Kangentic in your browser`,
                accent: true,
                testId: 'gitlab-connect-choice-sign-in',
              },
              {
                id: 'token',
                icon: <KeyRound size={16} />,
                label: t`Use a personal access token`,
                sublabel: t`Paste a token from your GitLab settings`,
                testId: 'gitlab-connect-choice-token',
              },
            ]}
          />
          <ConnectError message={errorLine} testId="gitlab-connect-error" />
        </div>
      );
    }
    return <ConnectSteps steps={tokenSteps} />;
  })();

  const footer = phase === 'waiting'
    ? (
      <ConnectFooter
        onBack={() => leaveWaiting('choices')}
        onCancel={() => leaveWaiting('close')}
        testIdPrefix="gitlab-connect"
      />
    )
    : (
      <ConnectFooter
        onBack={phase === 'steps' && cameFromChoices ? () => { setPhase('choices'); setFailure(null); setToken(''); } : undefined}
        onCancel={onClose}
        onConnect={phase === 'steps' ? () => void connectWithToken() : undefined}
        connectDisabled={!canConnect}
        submitting={submitting}
        testIdPrefix="gitlab-connect"
      />
    );

  return (
    <BaseDialog
      onClose={phase === 'waiting' ? () => leaveWaiting('close') : onClose}
      title={t`Connect GitLab`}
      icon={<span className="flex text-accent"><ArtifactPlatformLogo platformId="gitlab" size={18} /></span>}
      testId="gitlab-connect-dialog"
      className="w-[480px]"
      save={phase === 'steps' ? { onSave: () => void connectWithToken(), disabled: !canConnect || submitting } : undefined}
      footer={footer}
    >
      {body}
    </BaseDialog>
  );
}
