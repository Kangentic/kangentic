import React, { useState, useRef, useEffect } from 'react';
import { KanbanSquare, ExternalLink, Copy, Check, Loader2, Eye, EyeOff } from 'lucide-react';
import { BaseDialog } from '../dialogs/BaseDialog';

interface AsanaSetupDialogProps {
  onClose: () => void;
  /** Called after credentials are persisted. Dialog closes on success. */
  onSaved: () => void;
  /** Prefill for the Client ID input (empty = first-time setup). */
  initialClientId?: string;
  /** Whether a Client Secret is already stored. The wizard shows a placeholder when true. */
  initialClientSecretSet?: boolean;
}

const REDIRECT_URL = 'urn:ietf:wg:oauth:2.0:oob';
const REQUIRED_SCOPES = [
  'projects:read',
  'tasks:read',
  'users:read',
  'attachments:read',
  'workspaces:read',
  'custom_fields:read',
];
const ASANA_APPS_URL = 'https://app.asana.com/0/my-apps';

export function AsanaSetupDialog({
  onClose,
  onSaved,
  initialClientId = '',
  initialClientSecretSet = false,
}: AsanaSetupDialogProps) {
  const [clientId, setClientId] = useState(initialClientId);
  const [clientSecret, setClientSecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (inputRef.current) inputRef.current.focus();
  }, []);

  const copyToClipboard = async (text: string, fieldKey: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(fieldKey);
      window.setTimeout(() => {
        setCopiedField((current) => (current === fieldKey ? null : current));
      }, 1500);
    } catch {
      /* clipboard blocked; user can still select/copy manually */
    }
  };

  const openAsanaDeveloperConsole = async () => {
    try {
      await window.electronAPI.shell.openExternal(ASANA_APPS_URL);
    } catch (openError) {
      console.warn('[AsanaSetupDialog] openExternal failed', openError);
    }
  };

  const handleSave = async () => {
    const trimmedClientId = clientId.trim();
    const trimmedClientSecret = clientSecret.trim();
    if (trimmedClientId.length === 0) {
      setError('Paste the Client ID from Asana to continue.');
      return;
    }
    if (trimmedClientSecret.length === 0 && !initialClientSecretSet) {
      setError('Paste the Client Secret from Asana to continue.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      // If the user left the secret blank and one is already stored, we
      // can't legally send empty - so for V1 require re-pasting on re-open.
      // The UI discourages this via placeholder + validation above.
      const result = await window.electronAPI.backlog.asana.setAppConfig({
        clientId: trimmedClientId,
        clientSecret: trimmedClientSecret,
      });
      if (!result.ok) {
        setError(result.error ?? 'Could not save credentials.');
        return;
      }
      onSaved();
    } catch (saveError: unknown) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save credentials.');
    } finally {
      setSubmitting(false);
    }
  };

  const copyButton = (text: string, fieldKey: string, label = 'Copy') => (
    <button
      type="button"
      onClick={() => copyToClipboard(text, fieldKey)}
      className="flex items-center gap-1 px-2 py-1 text-[11px] text-fg-muted hover:text-fg hover:bg-surface-hover rounded border border-edge/50 transition-colors shrink-0"
      data-testid={`asana-setup-copy-${fieldKey}`}
    >
      {copiedField === fieldKey ? <Check size={12} /> : <Copy size={12} />}
      <span>{copiedField === fieldKey ? 'Copied' : label}</span>
    </button>
  );

  const numberBadge = (n: number) => (
    <span className="flex items-center justify-center w-5 h-5 rounded-full bg-accent-bg/30 text-accent text-xs font-bold shrink-0">
      {n}
    </span>
  );

  return (
    <BaseDialog
      onClose={onClose}
      title="Set up Asana"
      icon={<KanbanSquare size={18} className="text-accent" />}
      testId="asana-setup-dialog"
      className="w-[520px]"
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-fg-muted hover:text-fg border border-edge/50 rounded transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={submitting || clientId.trim().length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-accent-emphasis hover:bg-accent text-accent-on rounded transition-colors disabled:opacity-50"
            data-testid="asana-setup-save-btn"
          >
            {submitting ? <Loader2 size={14} className="animate-spin" /> : null}
            Continue
          </button>
        </div>
      }
    >
      <div className="flex flex-col gap-5 text-sm">
        <p className="text-fg-muted">
          Kangentic connects to Asana through an OAuth app you register once. The whole setup takes under a minute.
        </p>

        {/* Step 1 */}
        <section className="flex flex-col gap-2">
          <h4 className="flex items-center gap-2 text-sm font-semibold text-fg">
            {numberBadge(1)}
            Open the Asana developer console
          </h4>
          <div className="ml-7">
            <button
              type="button"
              onClick={openAsanaDeveloperConsole}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-surface hover:bg-surface-hover border border-edge rounded transition-colors"
              data-testid="asana-setup-open-console-btn"
            >
              <ExternalLink size={12} />
              Open app.asana.com/0/my-apps
            </button>
          </div>
        </section>

        {/* Step 2 */}
        <section className="flex flex-col gap-2">
          <h4 className="flex items-center gap-2 text-sm font-semibold text-fg">
            {numberBadge(2)}
            Create a new app
          </h4>
          <p className="ml-7 text-xs text-fg-muted">
            Click <span className="text-fg">Create new app</span>. Choose the <span className="text-fg">API app</span> option (not MCP).
            Name it anything you like &ndash; &ldquo;Kangentic&rdquo; works.
          </p>
        </section>

        {/* Step 3 */}
        <section className="flex flex-col gap-2">
          <h4 className="flex items-center gap-2 text-sm font-semibold text-fg">
            {numberBadge(3)}
            Configure the app
          </h4>
          <div className="ml-7 flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <p className="text-xs text-fg-muted">
                In the <span className="text-fg">Redirect URL</span> field, paste:
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 px-2 py-1 text-xs bg-surface border border-edge/50 rounded font-mono text-fg select-all">
                  {REDIRECT_URL}
                </code>
                {copyButton(REDIRECT_URL, 'redirect')}
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <p className="text-xs text-fg-muted">
                Under <span className="text-fg">Permission scopes</span>, check these five boxes:
              </p>
              <ul className="grid grid-cols-2 gap-x-3 gap-y-1">
                {REQUIRED_SCOPES.map((scope) => (
                  <li key={scope} className="flex items-center gap-1.5 text-xs font-mono text-fg">
                    <Check size={12} className="text-accent shrink-0" />
                    {scope}
                  </li>
                ))}
              </ul>
              <div>{copyButton(REQUIRED_SCOPES.join(' '), 'scopes', 'Copy all')}</div>
            </div>
          </div>
        </section>

        {/* Step 4 */}
        <section className="flex flex-col gap-2">
          <h4 className="flex items-center gap-2 text-sm font-semibold text-fg">
            {numberBadge(4)}
            Paste your credentials
          </h4>
          <div className="ml-7 flex flex-col gap-3">
            <p className="text-xs text-fg-muted">
              Asana shows the Client ID and Client Secret on your app&rsquo;s settings page.
            </p>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs text-fg-muted" htmlFor="asana-setup-client-id">
                Client ID
              </label>
              <input
                ref={inputRef}
                id="asana-setup-client-id"
                type="text"
                value={clientId}
                onChange={(event) => { setClientId(event.target.value); setError(null); }}
                onKeyDown={(event) => { if (event.key === 'Enter') handleSave(); }}
                placeholder="e.g. 1208123456789012"
                className="w-full bg-surface/50 border border-edge/50 rounded text-sm text-fg placeholder-fg-disabled px-2.5 py-1.5 outline-none focus:border-edge-input font-mono"
                data-testid="asana-setup-client-id-input"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs text-fg-muted" htmlFor="asana-setup-client-secret">
                Client Secret
                {initialClientSecretSet && (
                  <span className="ml-2 text-[11px] text-fg-faint">(re-paste to change)</span>
                )}
              </label>
              <div className="relative">
                <input
                  id="asana-setup-client-secret"
                  type={showSecret ? 'text' : 'password'}
                  value={clientSecret}
                  onChange={(event) => { setClientSecret(event.target.value); setError(null); }}
                  onKeyDown={(event) => { if (event.key === 'Enter') handleSave(); }}
                  placeholder={initialClientSecretSet ? '(stored - leave blank to keep)' : 'Paste the Client Secret'}
                  className="w-full bg-surface/50 border border-edge/50 rounded text-sm text-fg placeholder-fg-disabled px-2.5 py-1.5 pr-9 outline-none focus:border-edge-input font-mono"
                  data-testid="asana-setup-client-secret-input"
                />
                <button
                  type="button"
                  onClick={() => setShowSecret((prev) => !prev)}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 text-fg-faint hover:text-fg rounded"
                  aria-label={showSecret ? 'Hide secret' : 'Show secret'}
                  data-testid="asana-setup-toggle-secret-btn"
                >
                  {showSecret ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>

            <p className="text-[11px] text-fg-faint">
              Your credentials are stored locally and encrypted. Kangentic never sends them anywhere except Asana.
            </p>

            {error && (
              <p className="text-xs text-danger" data-testid="asana-setup-error">{error}</p>
            )}
          </div>
        </section>
      </div>
    </BaseDialog>
  );
}
