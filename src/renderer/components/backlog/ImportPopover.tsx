import React, { useState, useRef, useEffect } from 'react';
import { Download, Plus, Trash2, ChevronRight, ArrowLeft, LoaderCircle, X } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { translateText } from '../../i18n/translate';
import { usePopoverPosition } from '../../hooks/usePopoverPosition';
import { OverlayPopover } from '../OverlayPopover';
import { Tooltip } from '../Tooltip';
import { PROVIDERS, getSourceLabel, getSourceIcon, getSourceTypeOption } from './import-providers';
import type { Provider, SourceTypeOption } from './import-providers';
import type { ImportSource } from '../../../shared/types';
import type { ToolbarControlCollapse } from '../board/toolbar-collapse';
import { reportRendererFailure } from '../../utils/renderer-failure';
import { describeIpcError } from '../../lib/ipc-error';

interface ImportPopoverProps {
  onOpenImportDialog: (source: ImportSource) => void;
  /**
   * Passed only by the backlog toolbar, where the trigger sheds its text at the
   * row's collapse step (toolbar-collapse.ts). It is a prop rather than a class
   * baked into this component because this popover has a second mount site
   * (`BacklogView`'s empty state), outside the toolbar row, where the button
   * shows its label at every width.
   */
  collapse?: ToolbarControlCollapse;
  /** True while the collapse step hides the label, so the tip names the icon-only button. */
  labelHidden?: boolean;
}

// --- Add source flow phases ---
type AddPhase = 'provider' | 'sourceType' | 'url';

export function ImportPopover({ onOpenImportDialog, collapse, labelHidden = false }: ImportPopoverProps) {
  const { t } = useLingui();
  const importTasksLabel = t`Import Tasks`;
  const [open, setOpen] = useState(false);
  const [sources, setSources] = useState<ImportSource[]>([]);

  // Add source state
  const [addPhase, setAddPhase] = useState<AddPhase | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<Provider | null>(null);
  const [selectedSourceType, setSelectedSourceType] = useState<SourceTypeOption | null>(null);
  const [newSourceUrl, setNewSourceUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The picked provider's Connect dialog (`provider.auth.SetupDialog`). Opened
  // when the user picks a provider that signs in through Kangentic and is not
  // connected, or when a source picker's list fails on sign-in; the dialog
  // checks and saves the credential end to end.
  const [setupDialogOpen, setSetupDialogOpen] = useState(false);
  const [setupDialogError, setSetupDialogError] = useState<string | null>(null);
  // Bumped after a Connect so a source picker that failed on sign-in loads again.
  const [pickerGeneration, setPickerGeneration] = useState(0);

  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);

  // Portal + fixed: the BacklogView empty-state mount sits inside the backlog
  // content well's `overflow-hidden` (AppLayout), which clipped the in-flow
  // absolute popover. The ViewToggle toolbar mount is unclipped either way.
  const { style } = usePopoverPosition(
    buttonRef as React.RefObject<HTMLElement>,
    popoverRef as React.RefObject<HTMLElement>,
    open,
    { mode: 'dropdown', strategy: 'fixed' },
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

  // Declared ahead of the effects that call it. They only ran it from
  // listeners, after it existed, but that is a timing accident the compiler
  // rules read as a use before declaration.
  const resetAddFlow = () => {
    setAddPhase(null);
    setSelectedProvider(null);
    setSelectedSourceType(null);
    setNewSourceUrl('');
    setError(null);
  };

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handleClick = (event: MouseEvent) => {
      // When a provider's Connect dialog is open, clicks land inside the dialog
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
      // While a provider's Connect dialog is open, let it own Escape entirely.
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

  /**
   * Advance past the provider selection step to either sourceType or url,
   * matching the single-sourceType fast-path in handleSelectProvider.
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

    if (provider.auth) {
      try {
        const status = await provider.auth.getStatus();
        if (!status.connected) {
          // Not connected yet: open the provider's Connect dialog. Once it
          // saves a working credential it calls onSaved and we advance.
          setSetupDialogError(null);
          setSetupDialogOpen(true);
          return;
        }
      } catch (statusError) {
        reportRendererFailure('backlog', 'import-auth-status', statusError);
        setSetupDialogError(null);
        setSetupDialogOpen(true);
        return;
      }
    }

    advanceAfterProvider(provider);
  };

  const handleSetupDialogSaved = () => {
    setSetupDialogOpen(false);
    setSetupDialogError(null);
    if (addPhase === 'url') {
      // Reconnected from a source picker whose list failed: load it again.
      setPickerGeneration((previous) => previous + 1);
      return;
    }
    if (selectedProvider) advanceAfterProvider(selectedProvider);
  };

  const handleSetupDialogClosed = () => {
    // User dismissed the Connect dialog without connecting. Drop the selection
    // so they're back on the bare provider list instead of a half-completed flow.
    setSetupDialogOpen(false);
    setSetupDialogError(null);
    setSelectedProvider(null);
    setSelectedSourceType(null);
    setAddPhase('provider');
  };

  const handlePickerAuthFailed = (message: string) => {
    setSetupDialogError(message);
    setSetupDialogOpen(true);
  };

  const handleSelectSourceType = (sourceType: SourceTypeOption) => {
    if (sourceType.folder) {
      void handlePickFolder(sourceType);
      return;
    }
    setSelectedSourceType(sourceType);
    setAddPhase('url');
  };

  /**
   * A source added by folder skips the URL step: the system folder dialog opens
   * at once, and the chosen folder is added. A cancel leaves the source types up.
   */
  const handlePickFolder = async (sourceType: SourceTypeOption) => {
    if (!sourceType.folder || loading) return;
    setError(null);
    let folder: string | null;
    try {
      folder = await window.electronAPI.dialog.selectFolder({ title: translateText(sourceType.folder.dialogTitle) });
    } catch (pickError) {
      reportRendererFailure('backlog', 'import-select-folder', pickError);
      return;
    }
    if (folder) await handleConnect(folder, sourceType);
  };

  /** Add the source at `url`: the typed URL, or the one a source picker or folder dialog hands over. */
  const handleConnect = async (pickedUrl?: string, pickedSourceType?: SourceTypeOption) => {
    const sourceUrl = (pickedUrl ?? newSourceUrl).trim();
    const sourceType = pickedSourceType ?? selectedSourceType;
    if (!sourceUrl || !sourceType || loading) return;
    setLoading(true);
    setError(null);

    try {
      // Check CLI availability first
      const cliStatus = await window.electronAPI.backlog.importCheckCli(sourceType.value);
      if (!cliStatus.available || !cliStatus.authenticated) {
        setError(cliStatus.error ?? t`CLI not available or not authenticated`);
        setLoading(false);
        return;
      }

      const source = await window.electronAPI.backlog.importSourcesAdd({
        source: sourceType.value,
        url: sourceUrl,
      });

      setSources((previous) => (previous.some((existing) => existing.id === source.id) ? previous : [...previous, source]));
      resetAddFlow();
      setOpen(false);
      onOpenImportDialog(source);
    } catch (addError: unknown) {
      setError(describeIpcError(addError, t`Failed to add source`));
    } finally {
      setLoading(false);
    }
  };

  const handleBackFromUrl = () => {
    setNewSourceUrl('');
    setError(null);
    if (selectedProvider?.sourceTypes.length === 1) {
      setAddPhase('provider');
      setSelectedProvider(null);
    } else {
      setAddPhase('sourceType');
    }
    setSelectedSourceType(null);
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
    <div className="relative shrink-0">
      <Tooltip label={labelHidden ? importTasksLabel : ''} enabled={!open}>
        <button
          ref={buttonRef}
          type="button"
          onClick={() => setOpen(!open)}
          aria-label={importTasksLabel}
          className={`flex items-center gap-1.5 py-1.5 text-sm text-fg-muted hover:text-fg border border-edge/50 hover:bg-surface-hover/40 rounded transition-colors ${
            collapse ? collapse.button : 'px-3'
          }`}
          data-testid="import-sources-btn"
        >
          <Download size={14} className="shrink-0" />
          <span className={collapse?.label}>{importTasksLabel}</span>
        </button>
      </Tooltip>

      <OverlayPopover
        open={open}
        popoverRef={popoverRef}
        style={style}
        portal
        className="fixed z-[2147483646] w-80 bg-surface border border-edge rounded-lg shadow-xl"
        data-testid="import-popover"
      >
          <div className="px-3 py-2 border-b border-edge">
            <span className="text-xs font-medium text-fg-muted uppercase tracking-wider"><Trans>Import Sources</Trans></span>
          </div>

          {/* Saved sources */}
          {!addPhase && (
            <div className="max-h-48 overflow-y-auto">
              {sources.length === 0 && (
                <div className="px-3 py-4 text-center text-sm text-fg-faint">
                  <Trans>No sources configured. Add one to start.</Trans>
                </div>
              )}
              {sources.map((source) => (
                <div
                  key={source.id}
                  className="flex items-center gap-2.5 px-3 py-2 hover:bg-surface-hover/40 cursor-pointer select-none group"
                  onClick={() => handleSourceClick(source)}
                  data-testid={`import-source-${source.id}`}
                >
                  <span className="w-5 flex justify-center text-fg-muted shrink-0">{getSourceIcon(source.source)}</span>
                  <div className="flex-1 min-w-0">
                    <Tooltip label={getSourceTypeOption(source.source)?.folder ? source.url : ''}>
                      <span className="text-sm text-fg truncate block">{source.label}</span>
                    </Tooltip>
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
                    <span className="text-sm text-fg">{translateText(provider.label)}</span>
                    {provider.comingSoon && (
                      <span className="text-[11px] text-fg-faint ml-2"><Trans>Coming soon</Trans></span>
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
                  <Trans context="button">Cancel</Trans>
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
                  disabled={loading}
                  className="flex items-center gap-2.5 w-full px-3 py-2.5 text-left hover:bg-surface-hover/40 transition-colors disabled:opacity-50"
                  data-testid={`import-source-type-${sourceType.value}`}
                >
                  {sourceType.icon && <span className="w-5 flex justify-center text-fg-muted shrink-0">{sourceType.icon}</span>}
                  <div className="flex-1 min-w-0">
                    <span className="text-sm text-fg">{translateText(sourceType.label)}</span>
                    <span className="text-[11px] text-fg-faint block truncate">{translateText(sourceType.description)}</span>
                  </div>
                </button>
              ))}
              {error && (
                <p className="px-3 py-2 border-t border-edge/50 text-xs text-danger break-words" data-testid="import-source-error">{error}</p>
              )}
              <div className="px-3 py-2 border-t border-edge/50">
                <button
                  type="button"
                  onClick={() => { setAddPhase('provider'); setSelectedProvider(null); setError(null); }}
                  className="flex items-center gap-1 text-xs text-fg-faint hover:text-fg transition-colors"
                >
                  <ArrowLeft size={12} />
                  <Trans context="button">Back</Trans>
                </button>
              </div>
            </div>
          )}

          {/* Phase 3a: a provider that lists its sources (Linear's teams) */}
          {addPhase === 'url' && selectedSourceType?.picker && selectedProvider && (
            <selectedSourceType.picker
              key={pickerGeneration}
              existingSources={sources}
              onPick={(url) => void handleConnect(url)}
              onOpenExisting={handleSourceClick}
              onBack={handleBackFromUrl}
              onAuthFailed={handlePickerAuthFailed}
              busy={loading}
              error={error}
            />
          )}

          {/* Phase 3b: URL input */}
          {addPhase === 'url' && selectedSourceType && !selectedSourceType.picker && selectedProvider && (
            <div className="px-3 py-2.5">
              <div className="flex items-center gap-2.5 mb-2">
                <span className="w-5 flex justify-center text-fg-muted shrink-0">{selectedProvider.icon}</span>
                <span className="text-xs font-medium text-fg">{translateText(selectedSourceType.label)}</span>
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
                className="w-full bg-surface/50 border border-edge/50 rounded text-sm text-fg placeholder-fg-muted px-2.5 py-1.5 outline-none focus:border-edge-input mb-1"
                data-testid="import-source-url-input"
              />
              {selectedSourceType.hint && (
                <p className="text-[11px] text-fg-faint mb-2">{translateText(selectedSourceType.hint)}</p>
              )}
              {error && (
                <p className="text-xs text-danger mb-2" data-testid="import-source-error">{error}</p>
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void handleConnect()}
                  disabled={loading || !newSourceUrl.trim()}
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-accent-emphasis hover:bg-accent text-accent-on rounded transition-colors disabled:opacity-50"
                  data-testid="import-source-connect-btn"
                >
                  {loading ? <LoaderCircle size={14} className="animate-spin" /> : null}
                  <Trans>Connect</Trans>
                </button>
                <button
                  type="button"
                  onClick={handleBackFromUrl}
                  className="flex items-center gap-1 px-3 py-1.5 text-xs text-fg-muted hover:text-fg border border-edge/50 rounded transition-colors"
                >
                  <ArrowLeft size={12} />
                  <Trans context="button">Back</Trans>
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
                <Trans>Add Source</Trans>
              </button>
            </div>
          )}
      </OverlayPopover>

      {setupDialogOpen && selectedProvider?.auth && (
        <selectedProvider.auth.SetupDialog
          onClose={handleSetupDialogClosed}
          onSaved={handleSetupDialogSaved}
          initialError={setupDialogError}
        />
      )}
    </div>
  );
}
