import React, { useState, useRef, useEffect } from 'react';
import { Download, Plus, Trash2, ChevronRight, ArrowLeft, Loader2, X } from 'lucide-react';
import { usePopoverPosition } from '../../hooks/usePopoverPosition';
import { PROVIDERS, getSourceLabel, getSourceIcon } from './import-providers';
import type { Provider, SourceTypeOption } from './import-providers';
import type { ImportSource } from '../../../shared/types';

interface ImportPopoverProps {
  onOpenImportDialog: (source: ImportSource) => void;
}

// --- Add source flow phases ---
type AddPhase = 'provider' | 'sourceType' | 'url';

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
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handleEscape = (event: KeyboardEvent) => {
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
  }, [open, addPhase]);

  const resetAddFlow = () => {
    setAddPhase(null);
    setSelectedProvider(null);
    setSelectedSourceType(null);
    setNewSourceUrl('');
    setError(null);
  };

  const handleSelectProvider = (provider: Provider) => {
    if (!provider.available) return;
    setSelectedProvider(provider);
    if (provider.sourceTypes.length === 1) {
      // Skip source type selection if only one option
      setSelectedSourceType(provider.sourceTypes[0]);
      setAddPhase('url');
    } else {
      setAddPhase('sourceType');
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
    </div>
  );
}
