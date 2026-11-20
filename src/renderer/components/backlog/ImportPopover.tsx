import React, { useState, useRef, useEffect } from 'react';
import { Download, Plus, Trash2, ChevronRight, ArrowLeft, X, MoreHorizontal, Pencil } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { translateText } from '../../i18n/translate';
import { usePopoverPosition } from '../../hooks/usePopoverPosition';
import { OverlayPopover } from '../OverlayPopover';
import { Tooltip } from '../Tooltip';
import { KebabMenu, KebabMenuItem } from '../KebabMenu';
import { PROVIDERS, getProviderForSource, getSavedSourceLabel, getSourceIcon, getSourceTypeOption } from './import-providers';
import type { Provider, SourceTypeOption } from './import-providers';
import { ImportSourceForm } from './ImportSourceForm';
import { labelFromSourceText } from './import-source-label';
import type { BoardConnectPrefill, ImportSource } from '../../../shared/types';
import type { ToolbarControlCollapse } from '../board/toolbar-collapse';
import { reportRendererFailure } from '../../utils/renderer-failure';
import { describeIpcError, ipcErrorClassName } from '../../lib/ipc-error';
import { SIGN_IN_REFUSED_ERROR_NAME } from '../../../shared/refusal';

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
// 'edit' is a saved source's form: its link or folder read-only, its Label editable.
type AddPhase = 'provider' | 'sourceType' | 'url' | 'edit';

/** The saved-source row menu, portaled to the body; the popover's own dismissals yield to it. */
const SOURCE_MENU_TEST_ID = 'import-source-menu';
const SOURCE_MENU_TRIGGER_PREFIX = 'import-source-menu-btn-';

/** True while a saved row's menu is open, so its Escape and its clicks stay the menu's. */
function sourceMenuIsOpen(): boolean {
  return document.querySelector(`[data-testid^="${SOURCE_MENU_TRIGGER_PREFIX}"][aria-expanded="true"]`) !== null;
}

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
  // The Label every task the source imports gets. Prefilled from the link or
  // folder until the user types in it.
  const [taskLabel, setTaskLabel] = useState('');
  const [taskLabelEdited, setTaskLabelEdited] = useState(false);
  // The saved source the edit form is for.
  const [editingSource, setEditingSource] = useState<ImportSource | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The picked provider's Connect dialog (`provider.auth.SetupDialog`). Opened
  // when the user picks a provider that signs in through Kangentic and is not
  // connected, or when a source picker's list fails on sign-in; the dialog
  // checks and saves the credential end to end. A provider whose sign-in belongs
  // to the site a link names (`checksPastedLink`, Jira) opens it from Connect.
  const [setupDialogOpen, setSetupDialogOpen] = useState(false);
  const [setupDialogError, setSetupDialogError] = useState<string | null>(null);
  const [setupDialogPrefill, setSetupDialogPrefill] = useState<BoardConnectPrefill | undefined>(undefined);
  // True when Connect opened the dialog for a pasted link: once it saves, the add continues.
  const connectAfterSignInRef = useRef(false);
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

  const clearSourceForm = () => {
    setNewSourceUrl('');
    setTaskLabel('');
    setTaskLabelEdited(false);
    setError(null);
  };

  // Declared ahead of the effects that call it. They only ran it from
  // listeners, after it existed, but that is a timing accident the compiler
  // rules read as a use before declaration.
  const resetAddFlow = () => {
    setAddPhase(null);
    setSelectedProvider(null);
    setSelectedSourceType(null);
    setEditingSource(null);
    // The form's setters inline, not `clearSourceForm()`: only setters keep this stable for the effects below.
    setNewSourceUrl('');
    setTaskLabel('');
    setTaskLabelEdited(false);
    setError(null);
  };

  const handleBackFromUrl = () => {
    clearSourceForm();
    if (selectedProvider?.sourceTypes.length === 1) {
      setAddPhase('provider');
      setSelectedProvider(null);
    } else {
      setAddPhase('sourceType');
    }
    setSelectedSourceType(null);
  };

  // Leaving the edit form is the same reset as leaving the add flow.
  const handleBackFromEdit = resetAddFlow;

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handleClick = (event: MouseEvent) => {
      // When a provider's Connect dialog is open, clicks land inside the dialog
      // (which renders as a sibling of popoverRef). Don't treat those as
      // outside the popover - the dialog owns its own dismissal behavior.
      if (setupDialogOpen) return;
      const target = event.target as Node;
      // A saved row's menu is portaled to the body, so a click in it is not outside.
      if (target instanceof Element && target.closest(`[data-testid="${SOURCE_MENU_TEST_ID}"]`)) return;
      if (
        popoverRef.current && !popoverRef.current.contains(target) &&
        buttonRef.current && !buttonRef.current.contains(target)
      ) {
        setOpen(false);
        resetAddFlow();
      }
    };
    document.addEventListener('mousedown', handleClick, true);
    return () => document.removeEventListener('mousedown', handleClick, true);
  }, [open, setupDialogOpen]);

  // Escape steps back one phase. The back arrow does the same.
  useEffect(() => {
    if (!open) return;
    const handleEscape = (event: KeyboardEvent) => {
      // While a provider's Connect dialog is open, let it own Escape entirely.
      // Otherwise the popover would rewind its phase underneath the dialog.
      if (setupDialogOpen) return;
      if (event.key !== 'Escape') return;
      // An open row menu takes this Escape (KebabMenu closes itself on it); this
      // listener was registered first, so it has to step aside by hand.
      if (sourceMenuIsOpen()) return;
      event.stopPropagation();
      if (addPhase === 'url') {
        handleBackFromUrl();
      } else if (addPhase === 'edit') {
        handleBackFromEdit();
      } else if (addPhase === 'sourceType') {
        setAddPhase('provider');
        setSelectedProvider(null);
        setError(null);
      } else if (addPhase === 'provider') {
        resetAddFlow();
      } else {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', handleEscape, true);
    return () => document.removeEventListener('keydown', handleEscape, true);
    // The back handlers are re-created each render and read only state setters and the current phase.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, addPhase, setupDialogOpen, selectedProvider]);

  /** Open the add form for `sourceType` with `value` filled in (a folder the system dialog picked). */
  const openSourceForm = (sourceType: SourceTypeOption, value = '') => {
    setSelectedSourceType(sourceType);
    setNewSourceUrl(value);
    setTaskLabel(labelFromSourceText(value));
    setTaskLabelEdited(false);
    setError(null);
    setAddPhase('url');
  };

  /**
   * Advance past the provider selection step to either sourceType or url,
   * matching the single-sourceType fast-path in handleSelectProvider.
   */
  const advanceAfterProvider = (provider: Provider) => {
    if (provider.sourceTypes.length === 1 && !provider.sourceTypes[0].folder) {
      openSourceForm(provider.sourceTypes[0]);
    } else {
      setAddPhase('sourceType');
    }
  };

  const handleSelectProvider = async (provider: Provider) => {
    if (!provider.available) return;
    setSelectedProvider(provider);
    setError(null);

    // A sign-in that belongs to a site is checked once the link is pasted (handleConnect).
    if (provider.auth && !provider.auth.checksPastedLink) {
      try {
        const status = await provider.auth.getStatus();
        if (!status.connected) {
          // Not connected yet: open the provider's Connect dialog. Once it
          // saves a working credential it calls onSaved and we advance.
          connectAfterSignInRef.current = false;
          setSetupDialogError(null);
          setSetupDialogPrefill(undefined);
          setSetupDialogOpen(true);
          return;
        }
      } catch (statusError) {
        reportRendererFailure('backlog', 'import-auth-status', statusError);
        connectAfterSignInRef.current = false;
        setSetupDialogError(null);
        setSetupDialogPrefill(undefined);
        setSetupDialogOpen(true);
        return;
      }
    }

    advanceAfterProvider(provider);
  };

  const handleSetupDialogSaved = () => {
    setSetupDialogOpen(false);
    setSetupDialogError(null);
    if (connectAfterSignInRef.current) {
      // Signed in for the pasted link's site: carry on adding that source.
      connectAfterSignInRef.current = false;
      void handleConnect();
      return;
    }
    if (addPhase === 'url') {
      // Reconnected from a source picker whose list failed: load it again.
      setPickerGeneration((previous) => previous + 1);
      return;
    }
    if (selectedProvider) advanceAfterProvider(selectedProvider);
  };

  const handleSetupDialogClosed = () => {
    setSetupDialogOpen(false);
    setSetupDialogError(null);
    if (connectAfterSignInRef.current) {
      // Opened from a pasted link: stay on the link so the user can try again.
      connectAfterSignInRef.current = false;
      return;
    }
    // User dismissed the Connect dialog without connecting. Drop the selection
    // so they're back on the bare provider list instead of a half-completed flow.
    setSelectedProvider(null);
    setSelectedSourceType(null);
    setAddPhase('provider');
  };

  const handlePickerAuthFailed = (message: string) => {
    connectAfterSignInRef.current = false;
    setSetupDialogError(message);
    setSetupDialogPrefill(undefined);
    setSetupDialogOpen(true);
  };

  const handleSelectSourceType = (sourceType: SourceTypeOption) => {
    if (sourceType.folder) {
      void handlePickFolder(sourceType);
      return;
    }
    openSourceForm(sourceType);
  };

  /**
   * A source added by folder opens the system folder dialog at once. The chosen
   * folder fills the form, which waits for Connect so its Label can be set. A
   * cancel leaves the source types up.
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
    if (folder) openSourceForm(sourceType, folder);
  };

  const handleSourceValueChange = (value: string) => {
    setNewSourceUrl(value);
    if (!taskLabelEdited) setTaskLabel(labelFromSourceText(value));
  };

  const handleTaskLabelChange = (value: string) => {
    setTaskLabel(value);
    setTaskLabelEdited(true);
  };

  /** Add the source at `url`: the form's link or folder, or the one a source picker hands over. */
  const handleConnect = async (pickedUrl?: string) => {
    const sourceUrl = (pickedUrl ?? newSourceUrl).trim();
    const sourceType = selectedSourceType;
    if (!sourceUrl || !sourceType || loading) return;
    setLoading(true);
    setError(null);

    // What Connect fills in again if the saved sign-in for this link's site turns out to be refused.
    let savedSignInPrefill: BoardConnectPrefill | undefined;
    const auth = selectedProvider?.auth;

    try {
      // A sign-in that belongs to a site is checked against the site the pasted link names.
      if (auth?.checksPastedLink) {
        const status = await auth.getStatus(sourceUrl);
        if (status.reason === 'ambiguous-site') {
          setError(t`Paste a search link so the site is known.`);
          return;
        }
        savedSignInPrefill = status.prefill;
        if (!status.connected) {
          connectAfterSignInRef.current = true;
          setSetupDialogError(null);
          setSetupDialogPrefill(status.prefill);
          setSetupDialogOpen(true);
          return;
        }
      }

      // Check CLI availability first
      const cliStatus = await window.electronAPI.backlog.importCheckCli(sourceType.value);
      if (!cliStatus.available || !cliStatus.authenticated) {
        setError(cliStatus.error ?? t`CLI not available or not authenticated`);
        setLoading(false);
        return;
      }

      // A source picker connects on pick and shows no Label; Edit source sets one later.
      const formTaskLabel = sourceType.picker ? '' : taskLabel.trim();
      const source = await window.electronAPI.backlog.importSourcesAdd({
        source: sourceType.value,
        url: sourceUrl,
        ...(formTaskLabel ? { taskLabel: formTaskLabel } : {}),
      });

      setSources((previous) => (previous.some((existing) => existing.id === source.id) ? previous : [...previous, source]));
      resetAddFlow();
      setOpen(false);
      onOpenImportDialog(source);
    } catch (addError: unknown) {
      const reason = describeIpcError(addError, t`Failed to add source`);
      setError(reason);
      // A sign-in is saved for this site and the provider refused it. `getStatus`
      // only says one is saved, so without this the popover showed the refusal and
      // had no way to replace the sign-in. Open Connect with the provider's reason,
      // as a source picker does when its list fails on sign-in.
      if (auth?.checksPastedLink && ipcErrorClassName(addError) === SIGN_IN_REFUSED_ERROR_NAME) {
        connectAfterSignInRef.current = true;
        setSetupDialogError(reason);
        setSetupDialogPrefill(savedSignInPrefill);
        setSetupDialogOpen(true);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleRemoveSource = async (sourceId: string) => {
    try {
      await window.electronAPI.backlog.importSourcesRemove(sourceId);
      setSources((previous) => previous.filter((source) => source.id !== sourceId));
    } catch (removeError) {
      reportRendererFailure('backlog', 'import-remove-source', removeError);
    }
  };

  const handleEditSource = (source: ImportSource) => {
    const provider = getProviderForSource(source.source);
    const sourceType = getSourceTypeOption(source.source);
    if (!provider || !sourceType) return;
    setSelectedProvider(provider);
    setSelectedSourceType(sourceType);
    setEditingSource(source);
    setNewSourceUrl(source.url);
    setTaskLabel(source.taskLabel ?? '');
    setTaskLabelEdited(true);
    setError(null);
    setAddPhase('edit');
  };

  const handleSaveEdit = async () => {
    if (!editingSource || loading) return;
    setLoading(true);
    setError(null);
    try {
      const updated = await window.electronAPI.backlog.importSourcesUpdate({ id: editingSource.id, taskLabel: taskLabel.trim() });
      setSources((previous) => previous.map((source) => (source.id === updated.id ? updated : source)));
      handleBackFromEdit();
    } catch (saveError: unknown) {
      reportRendererFailure('backlog', 'import-update-source', saveError);
      setError(describeIpcError(saveError, t`Couldn't save the source`));
    } finally {
      setLoading(false);
    }
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
                  className="flex items-center gap-2.5 px-3 py-2 hover:bg-surface-hover/40 cursor-pointer select-none"
                  onClick={() => handleSourceClick(source)}
                  data-testid={`import-source-${source.id}`}
                >
                  <span className="w-5 flex justify-center text-fg-muted shrink-0">{getSourceIcon(source.source)}</span>
                  <div className="flex-1 min-w-0">
                    <Tooltip label={getSourceTypeOption(source.source)?.folder ? source.url : ''}>
                      <span className="text-sm text-fg truncate block">{source.label}</span>
                    </Tooltip>
                    <span className="text-[11px] text-fg-faint">{getSavedSourceLabel(source)}</span>
                  </div>
                  {/* The row opens the source; a click on its menu, which React bubbles
                      out of the portal too, must not. */}
                  <span className="flex" onClick={(event) => event.stopPropagation()}>
                    <KebabMenu
                      icon={<MoreHorizontal size={14} />}
                      label={t`Source actions`}
                      triggerClassName="p-1 rounded text-fg-faint hover:text-fg-tertiary hover:bg-surface-hover transition-colors"
                      triggerTestId={`${SOURCE_MENU_TRIGGER_PREFIX}${source.id}`}
                      menuTestId={SOURCE_MENU_TEST_ID}
                    >
                      {(close) => (
                        <>
                          <KebabMenuItem
                            icon={<Pencil size={12} />}
                            label={t`Edit source`}
                            onClick={() => { close(); handleEditSource(source); }}
                            data-testid={`edit-source-${source.id}`}
                          />
                          <KebabMenuItem
                            icon={<Trash2 size={12} />}
                            label={t({ message: 'Remove', context: 'import source menu' })}
                            destructive
                            onClick={() => { close(); void handleRemoveSource(source.id); }}
                            data-testid={`remove-source-${source.id}`}
                          />
                        </>
                      )}
                    </KebabMenu>
                  </span>
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
                  data-testid={`import-provider-${provider.id}`}
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

          {/* Phase 3b: the link or folder, and its Label */}
          {addPhase === 'url' && selectedSourceType && !selectedSourceType.picker && selectedProvider && (
            <ImportSourceForm
              provider={selectedProvider}
              sourceType={selectedSourceType}
              mode="add"
              value={newSourceUrl}
              // A folder the system dialog picked is shown as picked; Back picks again.
              onValueChange={selectedSourceType.folder ? undefined : handleSourceValueChange}
              taskLabel={taskLabel}
              onTaskLabelChange={handleTaskLabelChange}
              busy={loading}
              error={error}
              onSubmit={() => void handleConnect()}
              onBack={handleBackFromUrl}
              valueInputRef={urlInputRef}
            />
          )}

          {/* A saved source's Label */}
          {addPhase === 'edit' && editingSource && selectedSourceType && selectedProvider && (
            <ImportSourceForm
              provider={selectedProvider}
              sourceType={selectedSourceType}
              mode="edit"
              value={editingSource.url}
              taskLabel={taskLabel}
              onTaskLabelChange={handleTaskLabelChange}
              busy={loading}
              error={error}
              onSubmit={() => void handleSaveEdit()}
              onBack={handleBackFromEdit}
            />
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
          prefill={setupDialogPrefill}
        />
      )}
    </div>
  );
}
