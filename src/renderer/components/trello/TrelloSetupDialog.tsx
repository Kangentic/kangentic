import { useState, useRef, useEffect, type ReactNode } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { ArrowLeft, ChevronRight, ExternalLink, Eye, EyeOff, KeyRound, LoaderCircle } from 'lucide-react';
import { BaseDialog } from '../dialogs/BaseDialog';
import { FIELD_CONTROL_CLASS } from '../Field';
import { ArtifactPlatformLogo } from '../VendorMark';
import { reportRendererFailure } from '../../utils/renderer-failure';
import type { ProviderSetupDialogProps } from '../backlog/import-providers';
import type { TrelloConnectKind } from '../../../shared/types';

const TRELLO_APP_ADMIN_URL = 'https://trello.com/apps/admin';

type View = 'loading' | 'choice' | 'sign-in' | 'own-key';
type Field = 'apiKey' | 'token';

/** The dialog field fill (ui-conventions.md, Control fill), in a monospace face for pasted keys. */
const CREDENTIAL_INPUT_CLASS = `${FIELD_CONTROL_CLASS} font-mono`;
const LINK_BUTTON_CLASS = 'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-surface hover:bg-surface-hover border border-edge rounded transition-colors disabled:opacity-50';

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <button
      type="button"
      onClick={onBack}
      className="flex items-center gap-1 px-3 py-1.5 text-sm text-fg-muted hover:text-fg border border-edge/50 rounded transition-colors"
      data-testid="trello-setup-back-btn"
    >
      <ArrowLeft size={12} />
      <Trans context="button">Back</Trans>
    </button>
  );
}

function StepBadge({ step }: { step: number }) {
  return (
    <span className="flex items-center justify-center w-5 h-5 rounded-full bg-accent-bg/30 text-accent text-xs font-bold shrink-0">
      {step}
    </span>
  );
}

/**
 * Connect Trello: two ways in, chosen on the first screen. "Sign in with Trello" opens Trello's
 * approval page for Kangentic's own API key, and Trello shows the token to paste back. "Use your
 * own API key" walks through making a Trello app, pasting its key, and approving it for a token.
 * A build with no Kangentic key offers only the user's own, so the dialog opens on its steps.
 * Connect checks the key and token with Trello before saving, and shows Trello's own text under
 * the field it refused.
 */
export function TrelloSetupDialog({ onClose, onSaved, initialError }: ProviderSetupDialogProps) {
  const { t } = useLingui();
  const [view, setView] = useState<View>('loading');
  const [signInAvailable, setSignInAvailable] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [errorField, setErrorField] = useState<Field>('token');
  const firstInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.backlog.trello.authStatus().then((status) => {
      if (cancelled) return;
      setSignInAvailable(status.signInAvailable);
      setView(status.signInAvailable ? 'choice' : 'own-key');
    }).catch((statusError: unknown) => {
      reportRendererFailure('trello', 'auth-status', statusError);
      if (!cancelled) setView('own-key');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (view === 'sign-in' || view === 'own-key') firstInputRef.current?.focus();
  }, [view]);

  const kind: TrelloConnectKind = view === 'sign-in' ? 'kangentic-key' : 'own-key';
  const canConnect = token.trim().length > 0 && (kind === 'kangentic-key' || apiKey.trim().length > 0) && !submitting;

  const showView = (next: View) => {
    setError(null);
    setView(next);
  };

  const handleConnect = async () => {
    if (!canConnect) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await window.electronAPI.backlog.trello.connect({
        kind,
        apiKey: kind === 'own-key' ? apiKey.trim() : undefined,
        token: token.trim(),
      });
      if (!result.ok) {
        setErrorField(result.field ?? 'token');
        setError(result.error ?? t`Couldn't save the token.`);
        return;
      }
      onSaved();
    } catch (connectError: unknown) {
      reportRendererFailure('trello', 'connect', connectError);
      setErrorField('token');
      setError(connectError instanceof Error ? connectError.message : t`Couldn't save the token.`);
    } finally {
      setSubmitting(false);
    }
  };

  const openApproval = () => {
    window.electronAPI.backlog.trello.openApproval({
      kind,
      apiKey: kind === 'own-key' ? apiKey.trim() : undefined,
    }).catch((openError: unknown) => {
      reportRendererFailure('trello', 'open-approval', openError);
      setErrorField(kind === 'own-key' ? 'apiKey' : 'token');
      setError(openError instanceof Error ? openError.message : String(openError));
    });
  };

  const openAppAdmin = () => {
    window.electronAPI.shell.openExternal(TRELLO_APP_ADMIN_URL).catch((openError: unknown) => {
      reportRendererFailure('trello', 'open-app-admin', openError);
    });
  };

  const fieldError = (field: Field) => (error && errorField === field
    ? <p className="text-xs text-danger" data-testid={`trello-setup-${field === 'apiKey' ? 'key' : 'token'}-error`}>{error}</p>
    : null);

  const tokenField = (
    <>
      <label className="text-xs text-fg-muted" htmlFor="trello-setup-token">
        <Trans>Token</Trans>
      </label>
      <div className="relative">
        <input
          ref={view === 'sign-in' ? firstInputRef : undefined}
          id="trello-setup-token"
          type={showToken ? 'text' : 'password'}
          value={token}
          onChange={(event) => { setToken(event.target.value); setError(null); }}
          onKeyDown={(event) => { if (event.key === 'Enter') void handleConnect(); }}
          placeholder={t`Paste the token Trello shows`}
          autoComplete="off"
          spellCheck={false}
          className={`${CREDENTIAL_INPUT_CLASS} pr-9`}
          data-testid="trello-setup-token-input"
        />
        <button
          type="button"
          onClick={() => setShowToken((previous) => !previous)}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 text-fg-faint hover:text-fg rounded"
          aria-label={showToken ? t`Hide token` : t`Show token`}
          data-testid="trello-setup-toggle-token-btn"
        >
          {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
      <p className="text-[11px] text-fg-faint"><Trans>Stored encrypted in your OS keychain.</Trans></p>
      {fieldError('token')}
    </>
  );

  const approvalButton = (disabled: boolean) => (
    <button
      type="button"
      onClick={openApproval}
      disabled={disabled}
      className={`self-start ${LINK_BUTTON_CLASS}`}
      data-testid="trello-setup-open-approval-btn"
    >
      <ExternalLink size={12} />
      <Trans>Open Trello's approval page</Trans>
    </button>
  );

  const cancelButton = (
    <button
      type="button"
      onClick={onClose}
      className="px-3 py-1.5 text-sm text-fg-muted hover:text-fg border border-edge/50 rounded transition-colors"
      data-testid="trello-setup-cancel-btn"
    >
      <Trans context="button">Cancel</Trans>
    </button>
  );

  const backTarget: View | null = view === 'sign-in' || (view === 'own-key' && signInAvailable) ? 'choice' : null;

  let footer: ReactNode;
  if (view === 'sign-in' || view === 'own-key') {
    footer = (
      <div className="flex items-center justify-between gap-2">
        <div>{backTarget ? <BackButton onBack={() => showView(backTarget)} /> : null}</div>
        <div className="flex gap-2">
          {cancelButton}
          <button
            type="button"
            onClick={() => void handleConnect()}
            disabled={!canConnect}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-accent-emphasis hover:bg-accent text-accent-on rounded transition-colors disabled:opacity-50"
            data-testid="trello-setup-save-btn"
          >
            {submitting ? <LoaderCircle size={14} className="animate-spin" /> : null}
            <Trans>Connect</Trans>
          </button>
        </div>
      </div>
    );
  } else {
    footer = <div className="flex justify-end">{cancelButton}</div>;
  }

  return (
    <BaseDialog
      onClose={onClose}
      title={t`Connect Trello`}
      icon={<span className="text-accent flex"><ArtifactPlatformLogo platformId="trello" size={16} /></span>}
      testId="trello-setup-dialog"
      className={view === 'own-key' || view === 'sign-in' ? 'w-[480px]' : 'w-[400px]'}
      save={view === 'own-key' || view === 'sign-in' ? { onSave: () => void handleConnect(), disabled: !canConnect } : undefined}
      footer={footer}
    >
      {view === 'loading' && (
        <div className="flex justify-center py-6" data-testid="trello-setup-loading">
          <LoaderCircle size={20} className="animate-spin text-fg-faint" />
        </div>
      )}

      {view === 'choice' && (
        <div className="flex flex-col gap-2.5">
          {error && <p className="text-xs text-danger" data-testid="trello-setup-error">{error}</p>}
          <button
            type="button"
            onClick={() => showView('sign-in')}
            className="flex items-center gap-3 w-full p-3 text-left bg-surface border border-edge rounded-md hover:bg-surface-hover/40 transition-colors"
            data-testid="trello-setup-sign-in-btn"
          >
            <span className="flex items-center justify-center w-8 h-8 shrink-0 rounded-md bg-accent-bg/20 text-accent-fg">
              <ArtifactPlatformLogo platformId="trello" size={15} />
            </span>
            <span className="flex-1 min-w-0 flex flex-col gap-0.5">
              <span className="text-sm font-semibold text-fg"><Trans>Sign in with Trello</Trans></span>
              <span className="text-xs text-fg-muted truncate"><Trans>Approve Kangentic in your browser</Trans></span>
            </span>
            <ChevronRight size={14} className="text-fg-faint shrink-0" />
          </button>
          <button
            type="button"
            onClick={() => showView('own-key')}
            className="flex items-center gap-3 w-full p-3 text-left bg-surface border border-edge rounded-md hover:bg-surface-hover/40 transition-colors"
            data-testid="trello-setup-own-key-btn"
          >
            <span className="flex items-center justify-center w-8 h-8 shrink-0 rounded-md bg-surface-hover/60 text-fg-muted">
              <KeyRound size={16} />
            </span>
            <span className="flex-1 min-w-0 flex flex-col gap-0.5">
              <span className="text-sm font-semibold text-fg"><Trans>Use your own API key</Trans></span>
              <span className="text-xs text-fg-muted truncate"><Trans>A key from a Trello app you make</Trans></span>
            </span>
            <ChevronRight size={14} className="text-fg-faint shrink-0" />
          </button>
        </div>
      )}

      {view === 'sign-in' && (
        <div className="flex flex-col gap-5 text-sm">
          <section className="flex flex-col gap-2">
            <h4 className="flex items-center gap-2 text-sm font-semibold text-fg">
              <StepBadge step={1} />
              <Trans>Approve Kangentic and paste the token</Trans>
            </h4>
            <div className="ml-7 flex flex-col gap-2">
              {approvalButton(false)}
              {tokenField}
            </div>
          </section>
        </div>
      )}

      {view === 'own-key' && (
        <div className="flex flex-col gap-5 text-sm">
          <section className="flex flex-col gap-2">
            <h4 className="flex items-center gap-2 text-sm font-semibold text-fg">
              <StepBadge step={1} />
              <Trans>Make a Trello app and generate a key</Trans>
            </h4>
            <div className="ml-7 flex flex-col gap-2">
              <button
                type="button"
                onClick={openAppAdmin}
                className={`self-start ${LINK_BUTTON_CLASS}`}
                data-testid="trello-setup-open-app-admin-btn"
              >
                <ExternalLink size={12} />
                <Trans>Open trello.com/apps/admin</Trans>
              </button>
              <p className="text-xs text-fg-muted">
                <Trans comment="Generate a new API Key and Trello Auth are labels in Trello's own English interface. Keep them as written.">
                  Make an app, then use Generate a new API Key on its Trello Auth tab.
                </Trans>
              </p>
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <h4 className="flex items-center gap-2 text-sm font-semibold text-fg">
              <StepBadge step={2} />
              <Trans>Paste the API key</Trans>
            </h4>
            <div className="ml-7 flex flex-col gap-2">
              <label className="text-xs text-fg-muted" htmlFor="trello-setup-api-key">
                <Trans>API key</Trans>
              </label>
              <input
                ref={firstInputRef}
                id="trello-setup-api-key"
                type="text"
                value={apiKey}
                onChange={(event) => { setApiKey(event.target.value); setError(null); }}
                placeholder={t`Paste your key`}
                autoComplete="off"
                spellCheck={false}
                className={CREDENTIAL_INPUT_CLASS}
                data-testid="trello-setup-key-input"
              />
              {fieldError('apiKey')}
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <h4 className="flex items-center gap-2 text-sm font-semibold text-fg">
              <StepBadge step={3} />
              <Trans>Approve it and paste the token</Trans>
            </h4>
            <div className="ml-7 flex flex-col gap-2">
              {approvalButton(apiKey.trim().length === 0)}
              {tokenField}
            </div>
          </section>
        </div>
      )}
    </BaseDialog>
  );
}
