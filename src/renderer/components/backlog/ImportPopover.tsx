import React, { useState, useRef, useEffect } from 'react';
import { Download, Plus, Trash2, ChevronRight, ArrowLeft, Loader2, X, Settings } from 'lucide-react';
import { usePopoverPosition } from '../../hooks/usePopoverPosition';
import { PROVIDERS, getSourceLabel, getSourceIcon } from './import-providers';
import type { Provider, SourceTypeOption } from './import-providers';
import type { ImportSource } from '../../../shared/types';
import { AsanaSetupDialog } from '../asana/AsanaSetupDialog';

interface ImportPopoverProps {
  onOpenImportDialog: (source: ImportSource) => void;
}

// --- Add source flow phases ---
type AddPhase = 'provider' | 'auth' | 'sourceType' | 'url';

export function ImportPopover({ onOpenImportDialog }: ImportPopoverProps) {
  const [open, setOpen] = useState(false);
  const [sources, setSources] = useState<ImportSource[]>([]);

  // Add source state
  const [addPhase, setAddPhase] = useState<AddPhase | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<Provider | null>(null);
  const [selectedSourceType, setSelectedSourceType] = useState<SourceTypeOption | null>(null);
  const [newSourceUrl, setNewSourceUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Auth phase state (only used for providers with requiresAuth=true)
  const [authAppConfigured, setAuthAppConfigured] = useState(false);
  const [authPendingId, setAuthPendingId] = useState<string | null>(null);
  const [authCode, setAuthCode] = useState('');
  const [setupDialogOpen, setSetupDialogOpen] = useState(false);
  const [setupDialogInitialClientId, setSetupDialogInitialClientId] = useState('');
  const [setupDialogInitialClientSecretSet, setSetupDialogInitialClientSecretSet] = useState(false);

  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);

  const { style } = usePopoverPosition(
    buttonRef as React.RefObject<HTMLElement>,
    popoverRef as React.RefObject<HTMLElement>,
    open,
    { mode: 'dropdown' },
  );

  // Load sources when popover opens
  useEffect(() => {
    if (!open) return;
    window.electronAPI.backlog.importSourcesList().then(setSources).catch(() => {});
  }, [open]);

  // Focus URL input when entering URL phase
  useEffect(() => {
    if (addPhase === 'url') urlInputRef.current?.focus();
  }, [addPhase]);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handleClick = (event: MouseEvent) => {
      // When the AsanaSetupDialog is open, clicks land inside the dialog
      // (which renders as a sibling of popoverRef). Don't treat those as
      // outside the popover - the dialog owns its own dismissal behavior.
      if (setupDialogOpen) return;
      if (
        popoverRef.current && !popoverRef.current.contains(event.target as Node) &&
        buttonRef.current && !buttonRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
        resetAddFlow();
      }
    };
    document.addEventListener('mousedown', handleClick, true);
    return () => document.removeEventListener('mousedown', handleClick, true);
  }, [open, setupDialogOpen]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handleEscape = (event: KeyboardEvent) => {
      // While the AsanaSetupDialog is open, let it own Escape entirely.
      // Otherwise the popover would rewind its phase underneath the dialog.
      if (setupDialogOpen) return;
      if (event.key === 'Escape') {
        event.stopPropagation();
        if (addPhase === 'url') {
          setAddPhase('sourceType');
          setNewSourceUrl('');
          setError(null);
        } else if (addPhase === 'sourceType') {
          setAddPhase('provider');
          setSelectedProvider(null);
        } else if (addPhase === 'auth') {
          setAddPhase('provider');
          setSelectedProvider(null);
          setAuthPendingId(null);
          setAuthCode('');
          setError(null);
        } else if (addPhase === 'provider') {
          resetAddFlow();
        } else {
          setOpen(false);
        }
      }
    };
    document.addEventListener('keydown', handleEscape, true);
    return () => document.removeEventListener('keydown', handleEscape, true);
  }, [open, addPhase, setupDialogOpen]);

  const resetAddFlow = () => {
    setAddPhase(null);
    setSelectedProvider(null);
    setSelectedSourceType(null);
    setNewSourceUrl('');
    setError(null);
    setAuthPendingId(null);
    setAuthCode('');
    setAuthAppConfigured(false);
  };

  /**
   * Advance past the auth/provider selection step to either sourceType or
   * url, matching the single-sourceType fast-path in handleSelectProvider.
   */
  const advanceAfterProvider = (provider: Provider) => {
    if (provider.sourceTypes.length === 1) {
      setSelectedSourceType(provider.sourceTypes[0]);
      setAddPhase('url');
    } else {
      setAddPhase('sourceType');
    }
  };

  const handleSelectProvider = async (provider: Provider) => {
    if (!provider.available) return;
    setSelectedProvider(provider);
    setError(null);

    if (provider.requiresAuth && provider.id === 'asana') {
      try {
        const status = await window.electronAPI.backlog.asana.authStatus();
        setAuthAppConfigured(status.appConfigured);
        if (!status.appConfigured) {
          // First-time setup: open the wizard. The popover stays mounted and
          // picks up with the Connect step once the user saves credentials.
          const existing = await window.electronAPI.backlog.asana.getAppConfig();
          setSetupDialogInitialClientId(existing.clientId);
          setSetupDialogInitialClientSecretSet(existing.clientSecretSet);
          setAddPhase('auth');
          setSetupDialogOpen(true);
          return;
        }
        // Route to auth phase whenever we can't safely proceed: either the
        // user is not connected, or the build has no app config (so even a
        // "connected" token would fail on the next API call).
        if (!status.connected || !status.configured) {
          setAddPhase('auth');
          return;
        }
      } catch (statusError) {
        console.warn('[ImportPopover] Asana authStatus IPC failed; falling back to auth phase', statusError);
        setAuthAppConfigured(false);
        setAddPhase('auth');
        return;
      }
    }

    advanceAfterProvider(provider);
  };

  const handleSetupDialogSaved = async () => {
    setSetupDialogOpen(false);
    // Pull fresh auth state so the popover reflects the newly-set app config.
    try {
      const status = await window.electronAPI.backlog.asana.authStatus();
      setAuthAppConfigured(status.appConfigured);
    } catch {
      setAuthAppConfigured(true);
    }
  };

  const handleReconfigureAsana = async () => {
    try {
      const existing = await window.electronAPI.backlog.asana.getAppConfig();
      setSetupDialogInitialClientId(existing.clientId);
      setSetupDialogInitialClientSecretSet(existing.clientSecretSet);
    } catch {
      setSetupDialogInitialClientId('');
      setSetupDialogInitialClientSecretSet(false);
    }
    setAuthPendingId(null);
    setAuthCode('');
    setError(null);
    setSetupDialogOpen(true);
  };

  const handleStartAsanaOAuth = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.backlog.asana.oauthStart();
      setAuthPendingId(result.pendingId);
    } catch (startError: unknown) {
      setError(startError instanceof Error ? startError.message : 'Failed to start Asana sign-in');
    } finally {
      setLoading(false);
    }
  };

  const handleCompleteAsanaOAuth = async () => {
    if (!authPendingId || !authCode.trim() || !selectedProvider) return;
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.backlog.asana.oauthComplete({
        pendingId: authPendingId,
        code: authCode.trim(),
      });
      if (!result.ok) {
        setError(result.error ?? 'Asana authentication failed');
        return;
      }
      setAuthPendingId(null);
      setAuthCode('');
      advanceAfterProvider(selectedProvider);
    } catch (completeError: unknown) {
      setError(completeError instanceof Error ? completeError.message : 'Asana authentication failed');
    } finally {
      setLoading(false);
    }
  };

  const handleSelectSourceType = (sourceType: SourceTypeOption) => {
    setSelectedSourceType(sourceType);
    setAddPhase('url');
  };

  const handleConnect = async () => {
    if (!newSourceUrl.trim() || !selectedSourceType) return;
    setLoading(true);
    setError(null);

    try {
      // Check CLI availability first
      const cliStatus = await window.electronAPI.backlog.importCheckCli(selectedSourceType.value);
      if (!cliStatus.available || !cliStatus.authenticated) {
        setError(cliStatus.error ?? 'CLI not available or not authenticated');
        setLoading(false);
        return;
      }

      const source = await window.electronAPI.backlog.importSourcesAdd({
        source: selectedSourceType.value,
        url: newSourceUrl.trim(),
      });

      setSources((previous) => [...previous, source]);
      resetAddFlow();
      setOpen(false);
      onOpenImportDialog(source);
    } catch (addError: unknown) {
      setError(addError instanceof Error ? addError.message : 'Failed to add source');
    } finally {
      setLoading(false);
    }
  };

  const handleRemoveSource = async (sourceId: string) => {
    try {
      await window.electronAPI.backlog.importSourcesRemove(sourceId);
      setSources((previous) => previous.filter((source) => source.id !== sourceId));
    } catch { /* ignore */ }
  };

  const handleSourceClick = (source: ImportSource) => {
    setOpen(false);
    onOpenImportDialog(source);
  };

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-fg-muted hover:text-fg border border-edge/50 hover:bg-surface-hover/40 rounded transition-colors"
        data-testid="import-sources-btn"
      >
        <Download size={14} />
        Import Tasks
      </button>

      {open && (
        <div
          ref={popoverRef}
          style={style}
          className="absolute z-50 w-80 bg-surface border border-edge rounded-lg shadow-xl"
          data-testid="import-popover"
        >
          <div className="px-3 py-2 border-b border-edge">
            <span className="text-xs font-medium text-fg-muted uppercase tracking-wider">Import Sources</span>
          </div>

          {/* Saved sources */}
          {!addPhase && (
            <div className="max-h-48 overflow-y-auto">
              {sources.length === 0 && (
                <div className="px-3 py-4 text-center text-sm text-fg-faint">
                  No sources configured. Add one to start.
                </div>
              )}
              {sources.map((source) => (
                <div
                  key={source.id}
                  className="flex items-center gap-2.5 px-3 py-2 hover:bg-surface-hover/40 cursor-pointer group"
                  onClick={() => handleSourceClick(source)}
                  data-testid={`import-source-${source.id}`}
                >
                  <span className="w-5 flex justify-center text-fg-muted shrink-0">{getSourceIcon(source.source)}</span>
                  <div className="flex-1 min-w-0">
                    <span className="text-sm text-fg truncate block">{source.label}</span>
                    <span className="text-[11px] text-fg-faint">{getSourceLabel(source.source)}</span>
                  </div>
                  <button
                    type="button"
                    className="opacity-0 group-hover:opacity-100 p-1 text-fg-faint hover:text-danger transition-all"
                    onClick={(event) => {
                      event.stopPropagation();
                      handleRemoveSource(source.id);
                    }}
                    data-testid={`remove-source-${source.id}`}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Phase 1: Provider selection */}
          {addPhase === 'provider' && (
            <div>
              {PROVIDERS.map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  disabled={!provider.available}
                  onClick={() => handleSelectProvider(provider)}
                  className={`flex items-center gap-2.5 w-full px-3 py-2.5 text-left transition-colors ${
                    provider.available
                      ? 'hover:bg-surface-hover/40 cursor-pointer'
                      : 'opacity-40 cursor-not-allowed'
                  }`}
                >
                  <span className="w-5 flex justify-center text-fg-muted shrink-0">{provider.icon}</span>
                  <div className="flex-1 min-w-0">
                    <span className="text-sm text-fg">{provider.label}</span>
                    {provider.comingSoon && (
                      <span className="text-[11px] text-fg-faint ml-2">Coming soon</span>
                    )}
                  </div>
                  {provider.available && <ChevronRight size={14} className="text-fg-faint" />}
                </button>
              ))}
              <div className="border-t border-edge">
                <button
                  type="button"
                  onClick={resetAddFlow}
                  className="flex items-center gap-1.5 w-full px-3 py-2 text-sm text-fg-muted hover:text-fg hover:bg-surface-hover/40 transition-colors"
                >
                  <X size={14} />
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Phase 1.5: Auth (only when selected provider requires auth and is not connected) */}
          {addPhase === 'auth' && selectedProvider && (
            <div className="px-3 py-2.5" data-testid="import-auth-phase">
              <div className="flex items-center gap-2.5 mb-2">
                <span className="w-5 flex justify-center text-fg-muted shrink-0">{selectedProvider.icon}</span>
                <span className="text-xs font-medium text-fg">Connect {selectedProvider.label}</span>
              </div>

              {!authAppConfigured && (
                <>
                  <p className="text-[11px] text-fg-faint mb-2" data-testid="asana-needs-setup">
                    Kangentic needs a one-time {selectedProvider.label} app registration before it can connect.
                  </p>
                  <button
                    type="button"
                    onClick={() => setSetupDialogOpen(true)}
                    className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-accent-emphasis hover:bg-accent text-accent-on rounded transition-colors"
                    data-testid="asana-open-setup-btn"
                  >
                    <Settings size={14} />
                    Set up {selectedProvider.label}
                  </button>
                </>
              )}

              {authAppConfigured && authPendingId === null && (
                <>
                  <p className="text-[11px] text-fg-faint mb-2">
                    Click Connect to open {selectedProvider.label} in your browser, approve access, then paste the code back here.
                  </p>
                  <button
                    type="button"
                    onClick={handleStartAsanaOAuth}
                    disabled={loading}
                    className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-accent-emphasis hover:bg-accent text-accent-on rounded transition-colors disabled:opacity-50"
                    data-testid="asana-connect-btn"
                  >
                    {loading ? <Loader2 size={14} className="animate-spin" /> : null}
                    Connect {selectedProvider.label}
                  </button>
                  <button
                    type="button"
                    onClick={handleReconfigureAsana}
                    className="mt-2 w-full flex items-center justify-center gap-1 px-2 py-1 text-[11px] text-fg-faint hover:text-fg transition-colors"
                    data-testid="asana-reconfigure-btn"
                  >
                    <Settings size={11} />
                    Change {selectedProvider.label} app
                  </button>
                </>
              )}

              {authAppConfigured && authPendingId !== null && (
                <>
                  <p className="text-[11px] text-fg-faint mb-2">
                    Approved access? Paste the code {selectedProvider.label} displayed.
                  </p>
                  <input
                    type="text"
                    value={authCode}
                    onChange={(event) => setAuthCode(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') handleCompleteAsanaOAuth();
                    }}
                    placeholder="Paste authorization code"
                    className="w-full bg-surface/50 border border-edge/50 rounded text-sm text-fg placeholder-fg-disabled px-2.5 py-1.5 outline-none focus:border-edge-input mb-2"
                    data-testid="asana-auth-code-input"
                    autoFocus
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={handleCompleteAsanaOAuth}
                      disabled={loading || !authCode.trim()}
                      className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-accent-emphasis hover:bg-accent text-accent-on rounded transition-colors disabled:opacity-50"
                      data-testid="asana-auth-continue-btn"
                    >
                      {loading ? <Loader2 size={14} className="animate-spin" /> : null}
                      Continue
                    </button>
                    <button
                      type="button"
                      onClick={() => { setAuthPendingId(null); setAuthCode(''); setError(null); }}
                      className="flex items-center gap-1 px-3 py-1.5 text-xs text-fg-muted hover:text-fg border border-edge/50 rounded transition-colors"
                    >
                      <ArrowLeft size={12} />
                      Back
                    </button>
                  </div>
                </>
              )}

              {error && (
                <p className="text-xs text-danger mt-2" data-testid="asana-auth-error">{error}</p>
              )}

              <div className="px-0 py-2 border-t border-edge/50 mt-3">
                <button
                  type="button"
                  onClick={() => {
                    setAddPhase('provider');
                    setSelectedProvider(null);
                    setAuthPendingId(null);
                    setAuthCode('');
                    setError(null);
                  }}
                  className="flex items-center gap-1 text-xs text-fg-faint hover:text-fg transition-colors"
                >
                  <ArrowLeft size={12} />
                  Back
                </button>
              </div>
            </div>
          )}

          {/* Phase 2: Source type selection within provider */}
          {addPhase === 'sourceType' && selectedProvider && (
            <div>
              {selectedProvider.sourceTypes.map((sourceType) => (
                <button
                  key={sourceType.value}
                  type="button"
                  onClick={() => handleSelectSourceType(sourceType)}
                  className="flex items-center gap-2.5 w-full px-3 py-2.5 text-left hover:bg-surface-hover/40 transition-colors"
                >
                  <span className="w-5 flex justify-center text-fg-muted shrink-0">{sourceType.icon}</span>
                  <div className="flex-1 min-w-0">
                    <span className="text-sm text-fg">{sourceType.label}</span>
                    <span className="text-[11px] text-fg-faint block">{sourceType.description}</span>
                  </div>
                </button>
              ))}
              <div className="px-3 py-2 border-t border-edge/50">
                <button
                  type="button"
                  onClick={() => { setAddPhase('provider'); setSelectedProvider(null); }}
                  className="flex items-center gap-1 text-xs text-fg-faint hover:text-fg transition-colors"
                >
                  <ArrowLeft size={12} />
                  Back
                </button>
              </div>
            </div>
          )}

          {/* Phase 3: URL input */}
          {addPhase === 'url' && selectedSourceType && selectedProvider && (
            <div className="px-3 py-2.5">
              <div className="flex items-center gap-2.5 mb-2">
                <span className="w-5 flex justify-center text-fg-muted shrink-0">{selectedProvider.icon}</span>
                <span className="text-xs font-medium text-fg">{selectedSourceType.label}</span>
              </div>
              <input
                ref={urlInputRef}
                type="text"
                value={newSourceUrl}
                onChange={(event) => setNewSourceUrl(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') handleConnect();
                }}
                placeholder={selectedSourceType.placeholder}
                className="w-full bg-surface/50 border border-edge/50 rounded text-sm text-fg placeholder-fg-disabled px-2.5 py-1.5 outline-none focus:border-edge-input mb-1"
                data-testid="import-source-url-input"
              />
              <p className="text-[11px] text-fg-faint mb-2">{selectedSourceType.hint}</p>
              {error && (
                <p className="text-xs text-danger mb-2" data-testid="import-source-error">{error}</p>
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleConnect}
                  disabled={loading || !newSourceUrl.trim()}
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-accent-emphasis hover:bg-accent text-accent-on rounded transition-colors disabled:opacity-50"
                  data-testid="import-source-connect-btn"
                >
                  {loading ? <Loader2 size={14} className="animate-spin" /> : null}
                  Connect
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setNewSourceUrl('');
                    setError(null);
                    if (selectedProvider.sourceTypes.length === 1) {
                      setAddPhase('provider');
                      setSelectedProvider(null);
                    } else {
                      setAddPhase('sourceType');
                    }
                    setSelectedSourceType(null);
                  }}
                  className="flex items-center gap-1 px-3 py-1.5 text-xs text-fg-muted hover:text-fg border border-edge/50 rounded transition-colors"
                >
                  <ArrowLeft size={12} />
                  Back
                </button>
              </div>
            </div>
          )}

          {/* Add source button */}
          {!addPhase && (
            <div className="border-t border-edge">
              <button
                type="button"
                onClick={() => setAddPhase('provider')}
                className="flex items-center gap-1.5 w-full px-3 py-2 text-sm text-fg-muted hover:text-fg hover:bg-surface-hover/40 transition-colors"
                data-testid="add-import-source-btn"
              >
                <Plus size={14} />
                Add Source
              </button>
            </div>
          )}
        </div>
      )}

      {setupDialogOpen && (
        <AsanaSetupDialog
          onClose={() => setSetupDialogOpen(false)}
          onSaved={handleSetupDialogSaved}
          initialClientId={setupDialogInitialClientId}
          initialClientSecretSet={setupDialogInitialClientSecretSet}
        />
      )}
    </div>
  );
}
